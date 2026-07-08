const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { createLogger } = require('./logger');
const { InMemoryAuditStore } = require('./audit');
const { PerformanceStore } = require('./feedback-loop');
const { resolveExecutionQualityStatePath } = require('./execution-quality-state');
const { PaperTradeAdapter } = require('./paper-adapter');
const { processMarketInput, processTradingSignal } = require('./trading-loop');
const { nowIso, resolveRepoRoot } = require('./util');
const { isLiveModeSelected } = require('./execution-mode');

function resolveExecutionAdapter(options = {}) {
  if (options.executionAdapter) return options.executionAdapter;
  const intentConfig = options.config || options.env || process.env;
  if (isLiveModeSelected(intentConfig)) {
    const error = new Error('Live minimal server requires an explicit broker-backed execution adapter; refusing paper fallback.');
    error.code = 'LIVE_EXECUTION_ADAPTER_REQUIRED';
    error.reason_codes = ['LIVE_MODE_REQUIRES_BROKER_EXECUTION_ADAPTER'];
    throw error;
  }
  return options.paperAdapter || new PaperTradeAdapter({ dryRun: true });
}

function createMinimalTradingServer(options = {}) {
  const log = options.logger || createLogger();
  const state = {
    audit: options.audit || new InMemoryAuditStore(),
    executionAdapter: resolveExecutionAdapter(options),
    startedAt: options.startedAt || nowIso(),
    requestCount: 0,
    heartbeatCount: 0,
    lastRequestAt: null,
    performance: options.performance || new PerformanceStore({
      historyPath: options.performanceHistoryPath || null,
      policyPath: options.policyPath || null,
      policyHistoryPath: options.policyHistoryPath || null,
      executionQualityPath: options.executionQualityPath || resolveExecutionQualityStatePath({ repoRoot: options.repoRoot || resolveRepoRoot() }),
      startupPolicyPatch: options.startupPolicyPatch || null,
      initialPolicySnapshot: options.initialPolicySnapshot || null,
    }),
    policyPath: options.policyPath || null,
    statusSnapshotPath: options.statusSnapshotPath || null,
  };
  const statusHeartbeatIntervalMs = Math.max(0, Number(options.statusHeartbeatIntervalMs || 0) || 0);
  const statusHeartbeatTimer = statusHeartbeatIntervalMs > 0 && state.statusSnapshotPath
    ? setInterval(() => {
      state.heartbeatCount += 1;
      writeStatusSnapshot(state, buildStatusSnapshot(state, {
        snapshot_type: 'heartbeat',
        status: 'ok',
        mode: 'minimal-v1',
      }));
    }, statusHeartbeatIntervalMs)
    : null;
  if (statusHeartbeatTimer?.unref) {
    statusHeartbeatTimer.unref();
  }

  const send = (res, statusCode, payload) => {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  };

  function respond(state, res, statusCode, data) {
    const payload = buildStatusSnapshot(state, data);
    writeStatusSnapshot(state, payload);
    send(res, statusCode, payload);
  }

  function getActivePolicySnapshot() {
    if (state.policyPath) {
      state.performance.loadPolicyFromDisk(state.policyPath);
    }
    return state.performance.getPolicySnapshot();
  }

  const TRADING_OPTIONS = {
    audit: state.audit,
    executionAdapter: state.executionAdapter,
    performance: state.performance,
    buyNotionalTarget: options.buyNotionalTarget,
    minBuyNotional: options.minBuyNotional,
    source: 'minimal-v1',
    confirmationAttempts: options.confirmationAttempts || 6,
    confirmationDelayMs: options.confirmationDelayMs || 500,
    confirmationMaxDelayMs: options.confirmationMaxDelayMs || 1500,
  };

  const routes = [
    { method: 'GET', pattern: '/health', handle: async () => {
      const health = { status: 'ok', mode: 'minimal-v1' };
      if (state.executionAdapter && typeof state.executionAdapter.getAccount === 'function') {
        try {
          const account = await state.executionAdapter.getAccount();
          health.alpaca = { reachable: true, account_status: account.status || account.account_status || 'available' };
        } catch (err) {
          health.alpaca = { reachable: false, error: err.message };
          health.status = 'degraded';
        }
      }
      return { status: 200, data: health };
    } },
    { method: 'GET', pattern: '/status', handle: () => ({ status: 200, data: { status: 'ok', mode: 'minimal-v1', paper_outcome_count: state.performance.paperOutcomes.length, signal_count: state.performance.signals.length, review_queue_length: 0 } }) },
    { method: 'GET', pattern: '/daily-live-results', handle: ({ url }) => ({ status: 200, data: state.performance.getDailyReport(url.searchParams.get('date') || undefined) }) },
    { method: 'GET', pattern: '/risk-policy', handle: () => ({ status: 200, data: { accepted: true, policy_snapshot: getActivePolicySnapshot() } }) },
    { method: 'GET', pattern: '/performance/tuning', handle: () => ({ status: 200, data: { accepted: true, tuning: state.performance.suggestTuning() } }) },
    { method: 'GET', pattern: '/overnight-status', handle: ({ url }) => {
      const report = state.performance.getDailyReport(url.searchParams.get('date') || undefined);
      const tuning = state.performance.suggestTuning();
      return { status: 200, data: { accepted: true, status: 'ok', mode: 'minimal-v1', latest_activity_date: state.performance.getLatestActivityDate(), report_date: report.date, signal_count: report.signal_count, blocked_count: report.blocked_count, approved_count: report.approved_count, paper_outcome_count: report.paper_outcome_count, paper_pnl: report.paper_pnl, drawdown: report.drawdown, dominant_block_reason: report.dominant_block_reason, top_block_reasons: report.top_block_reasons, policy_snapshot: report.policy_snapshot, tuning_suggestions: tuning.suggestions, recommended_max_open_positions: report.recommended_max_open_positions } };
    } },
    { method: 'POST', pattern: '/policy-refresh', handle: ({ body }) => {
      const snapshot = state.performance.refreshPolicyFromLearning({ source: body.source || 'minimal-manual-refresh', reportDate: body.report_date || body.reportDate || null });
      return { status: 200, data: { accepted: true, policy_snapshot: snapshot, learning_report: snapshot.learning_report || state.performance.getDailyReport(body.report_date || body.reportDate || undefined) } };
    } },
    { method: 'POST', patterns: ['/signal', '/signal-created', '/webhooks/signal-created'], handle: async ({ body }) => {
      const result = await processTradingSignal({ ...body, signal: body.signal || body, portfolio: body.portfolio || body.portfolio_context || {}, market_context: body.market_context || body.marketContext || {} }, { ...TRADING_OPTIONS, policySnapshot: getActivePolicySnapshot() });
      return { status: result.accepted ? 200 : 400, data: serializeMinimalResult(result) };
    } },
    { method: 'POST', patterns: ['/market-ingest', '/webhooks/market-ingest'], handle: async ({ body }) => {
      const result = await processMarketInput(body, { ...TRADING_OPTIONS, policySnapshot: getActivePolicySnapshot() });
      return { status: result.accepted ? 200 : 400, data: serializeMinimalResult(result) };
    } },
    { method: 'POST', patterns: ['/paper-order', '/paper-order-request'], handle: async ({ body }) => {
      const result = await processTradingSignal({ ...body, signal: body.signal || body.order || body, portfolio: body.portfolio || body.portfolio_context || {}, market_context: body.market_context || body.marketContext || {} }, { ...TRADING_OPTIONS, policySnapshot: getActivePolicySnapshot() });
      return { status: result.accepted ? 200 : 400, data: serializeMinimalResult(result) };
    } },
    { method: 'POST', pattern: '/paper-outcomes', handle: ({ body }) => {
      const outcome = state.performance.recordPaperExecution(body);
      return { status: 200, data: { accepted: true, outcome } };
    } },
  ];

  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    try {
      const url = new URL(req.url, 'http://localhost');
      const body = await readJsonBody(req);
      state.requestCount += 1;
      state.lastRequestAt = nowIso();

      for (const route of routes) {
        if (req.method !== route.method) continue;
        const patterns = route.patterns || [route.pattern];
        if (!patterns.includes(url.pathname)) continue;
        const result = await route.handle({ body, url, req });
        log({ level: 'info', event: 'http_request', message: `${req.method} ${url.pathname} ${result.status} ${Date.now() - start}ms` });
        return respond(state, res, result.status, result.data);
      }

      log({ level: 'warn', event: 'http_request', message: `${req.method} ${url.pathname} 404 ${Date.now() - start}ms` });
      return respond(state, res, 404, { accepted: false, error: 'not_found' });
    } catch (error) {
      const pathname = (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch { return '/unknown'; } })();
      if (error?.code === 'INVALID_JSON') {
        log({ level: 'warn', event: 'http_request_error', message: `${req.method} ${pathname} 400 ${Date.now() - start}ms - invalid_json` });
        return respond(state, res, 400, { accepted: false, error: 'invalid_json' });
      }
      log({ level: 'error', event: 'http_request_error', message: `${req.method} ${pathname} 500 ${Date.now() - start}ms - ${error.message}` });
      return respond(state, res, 500, { accepted: false, error: 'internal_error', message: error.message });
    }
  });

  function shutdown(signal) {
    log({ level: 'info', event: 'shutdown', message: `Received ${signal}, shutting down...` });
    server.close(() => {
      if (statusHeartbeatTimer) {
        clearInterval(statusHeartbeatTimer);
      }
      log({ level: 'info', event: 'shutdown_complete', message: 'Server closed' });
    });
    setTimeout(() => {
      process.stderr.write('Forced shutdown after timeout\n');
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  writeStatusSnapshot(state, buildStatusSnapshot(state, {
    snapshot_type: 'startup',
    status: 'ok',
    mode: 'minimal-v1',
  }));

  return server;
}

function writeStatusSnapshot(state, payload) {
  if (!state.statusSnapshotPath) return;
  try {
    const snapshot = {
      ...payload,
      timestamp: nowIso(),
    };
    fs.mkdirSync(path.dirname(state.statusSnapshotPath), { recursive: true });
    fs.writeFileSync(state.statusSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  } catch {
    // Best-effort only.
  }
}

function buildStatusSnapshot(state, payload = {}) {
  const startedAt = state.startedAt || payload.started_at || nowIso();
  const timestamp = nowIso();
  return {
    ...payload,
    started_at: startedAt,
    uptime_minutes: Math.max(0, (new Date(timestamp).getTime() - new Date(startedAt).getTime()) / 60000),
    request_count: state.requestCount || 0,
    heartbeat_count: state.heartbeatCount || 0,
    last_request_at: state.lastRequestAt || null,
    timestamp,
  };
}

function serializeMinimalResult(result) {
  if (!result.accepted) {
    return {
      accepted: false,
      stage: result.stage,
      reason_codes: result.reason_codes || [],
      signal: result.signal || null,
      market_context: result.market_context || null,
      risk_decision: result.riskDecision || null,
    };
  }

  return {
    accepted: true,
    stage: result.stage,
    signal: result.signal || null,
    risk_decision: result.riskDecision || null,
    paper_order_request: result.paperOrderRequest || null,
    paper_order: result.paperOrder || null,
    order_confirmation: result.confirmation || null,
    paper_result: result.paperResult || null,
    paper_outcome: result.paperOutcome || null,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const error = new Error('invalid_json');
        error.code = 'INVALID_JSON';
        error.status = 400;
        reject(error);
      }
    });
  });
}

module.exports = {
  createMinimalTradingServer,
  serializeMinimalResult,
};
