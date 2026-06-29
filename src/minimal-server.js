const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { InMemoryAuditStore } = require('./audit');
const { PerformanceStore } = require('./feedback-loop');
const { resolveExecutionQualityStatePath } = require('./execution-quality-state');
const { PaperTradeAdapter } = require('./paper-adapter');
const { processMarketInput, processTradingSignal } = require('./trading-loop');
const { nowIso } = require('./util');

function createMinimalTradingServer(options = {}) {
  const state = {
    audit: options.audit || new InMemoryAuditStore(),
    executionAdapter: options.executionAdapter || options.paperAdapter || new PaperTradeAdapter({ dryRun: true }),
    startedAt: options.startedAt || nowIso(),
    requestCount: 0,
    heartbeatCount: 0,
    lastRequestAt: null,
    performance: options.performance || new PerformanceStore({
      historyPath: options.performanceHistoryPath || null,
      policyPath: options.policyPath || null,
      policyHistoryPath: options.policyHistoryPath || null,
      executionQualityPath: options.executionQualityPath || resolveExecutionQualityStatePath({ repoRoot: options.repoRoot || process.cwd() }),
      startupPolicyPatch: options.startupPolicyPatch || null,
      initialPolicySnapshot: options.initialPolicySnapshot || null,
    }),
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

  const server = http.createServer(async (req, res) => {
    const send = (statusCode, payload) => {
      res.statusCode = statusCode;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };

    try {
      const url = new URL(req.url, 'http://localhost');
      const body = await readJsonBody(req);
      state.requestCount += 1;
      state.lastRequestAt = nowIso();

      if (req.method === 'GET' && url.pathname === '/health') {
        const payload = buildStatusSnapshot(state, {
          status: 'ok',
          mode: 'minimal-v1',
        });
        writeStatusSnapshot(state, payload);
        return send(200, payload);
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        const payload = buildStatusSnapshot(state, {
          status: 'ok',
          mode: 'minimal-v1',
          paper_outcome_count: state.performance.paperOutcomes.length,
          signal_count: state.performance.signals.length,
          review_queue_length: 0,
        });
        writeStatusSnapshot(state, payload);
        return send(200, payload);
      }

      if (req.method === 'GET' && url.pathname === '/daily-live-results') {
        const payload = buildStatusSnapshot(state, state.performance.getDailyReport(url.searchParams.get('date') || undefined));
        writeStatusSnapshot(state, payload);
        return send(200, payload);
      }

      if (req.method === 'GET' && url.pathname === '/risk-policy') {
        const payload = buildStatusSnapshot(state, {
          accepted: true,
          policy_snapshot: state.performance.getPolicySnapshot(),
        });
        writeStatusSnapshot(state, payload);
        return send(200, payload);
      }

      if (req.method === 'GET' && url.pathname === '/performance/tuning') {
        const payload = buildStatusSnapshot(state, {
          accepted: true,
          tuning: state.performance.suggestTuning(),
        });
        writeStatusSnapshot(state, payload);
        return send(200, payload);
      }

      if (req.method === 'GET' && url.pathname === '/overnight-status') {
        const report = state.performance.getDailyReport(url.searchParams.get('date') || undefined);
        const tuning = state.performance.suggestTuning();
        const payload = buildStatusSnapshot(state, {
          accepted: true,
          status: 'ok',
          mode: 'minimal-v1',
          latest_activity_date: state.performance.getLatestActivityDate(),
          report_date: report.date,
          signal_count: report.signal_count,
          blocked_count: report.blocked_count,
          approved_count: report.approved_count,
          paper_outcome_count: report.paper_outcome_count,
          paper_pnl: report.paper_pnl,
          drawdown: report.drawdown,
          dominant_block_reason: report.dominant_block_reason,
          top_block_reasons: report.top_block_reasons,
          policy_snapshot: report.policy_snapshot,
          tuning_suggestions: tuning.suggestions,
          recommended_max_open_positions: report.recommended_max_open_positions,
        });
        writeStatusSnapshot(state, payload);
        return send(200, payload);
      }

      if (req.method === 'POST' && url.pathname === '/policy-refresh') {
        const snapshot = state.performance.refreshPolicyFromLearning({
          source: body.source || 'minimal-manual-refresh',
          reportDate: body.report_date || body.reportDate || null,
        });
        const payload = buildStatusSnapshot(state, {
          accepted: true,
          policy_snapshot: snapshot,
          learning_report: snapshot.learning_report || state.performance.getDailyReport(body.report_date || body.reportDate || undefined),
        });
        writeStatusSnapshot(state, payload);
        return send(200, payload);
      }

      if (req.method === 'POST' && (url.pathname === '/signal' || url.pathname === '/signal-created' || url.pathname === '/webhooks/signal-created')) {
        const result = await processTradingSignal({
          ...body,
          signal: body.signal || body,
          portfolio: body.portfolio || body.portfolio_context || {},
          market_context: body.market_context || body.marketContext || {},
        }, {
          audit: state.audit,
          executionAdapter: state.executionAdapter,
          performance: state.performance,
          policySnapshot: state.performance.getPolicySnapshot(),
          buyNotionalTarget: options.buyNotionalTarget,
          minBuyNotional: options.minBuyNotional,
          source: 'minimal-v1',
          confirmationAttempts: options.confirmationAttempts || 6,
          confirmationDelayMs: options.confirmationDelayMs || 500,
          confirmationMaxDelayMs: options.confirmationMaxDelayMs || 1500,
        });
        const payload = buildStatusSnapshot(state, serializeMinimalResult(result));
        writeStatusSnapshot(state, payload);
        return send(result.accepted ? 200 : 400, payload);
      }

      if (req.method === 'POST' && (url.pathname === '/market-ingest' || url.pathname === '/webhooks/market-ingest')) {
        const result = await processMarketInput(body, {
          audit: state.audit,
          executionAdapter: state.executionAdapter,
          performance: state.performance,
          policySnapshot: state.performance.getPolicySnapshot(),
          buyNotionalTarget: options.buyNotionalTarget,
          minBuyNotional: options.minBuyNotional,
          source: 'minimal-v1',
          confirmationAttempts: options.confirmationAttempts || 6,
          confirmationDelayMs: options.confirmationDelayMs || 500,
          confirmationMaxDelayMs: options.confirmationMaxDelayMs || 1500,
        });
        const payload = buildStatusSnapshot(state, serializeMinimalResult(result));
        writeStatusSnapshot(state, payload);
        return send(result.accepted ? 200 : 400, payload);
      }

      if (req.method === 'POST' && (url.pathname === '/paper-order' || url.pathname === '/paper-order-request')) {
        const result = await processTradingSignal({
          ...body,
          signal: body.signal || body.order || body,
          portfolio: body.portfolio || body.portfolio_context || {},
          market_context: body.market_context || body.marketContext || {},
        }, {
          audit: state.audit,
          executionAdapter: state.executionAdapter,
          performance: state.performance,
          policySnapshot: state.performance.getPolicySnapshot(),
          buyNotionalTarget: options.buyNotionalTarget,
          minBuyNotional: options.minBuyNotional,
          source: 'minimal-v1',
          confirmationAttempts: options.confirmationAttempts || 6,
          confirmationDelayMs: options.confirmationDelayMs || 500,
          confirmationMaxDelayMs: options.confirmationMaxDelayMs || 1500,
        });
        const payload = buildStatusSnapshot(state, serializeMinimalResult(result));
        writeStatusSnapshot(state, payload);
        return send(result.accepted ? 200 : 400, payload);
      }

      if (req.method === 'POST' && url.pathname === '/paper-outcomes') {
        const outcome = state.performance.recordPaperExecution(body);
        const payload = buildStatusSnapshot(state, { accepted: true, outcome });
        writeStatusSnapshot(state, payload);
        return send(200, payload);
      }

      const payload = buildStatusSnapshot(state, {
        accepted: false,
        error: 'not_found',
      });
      writeStatusSnapshot(state, payload);
      return send(404, payload);
    } catch (error) {
      const payload = buildStatusSnapshot(state, {
        accepted: false,
        error: 'internal_error',
        message: error.message,
      });
      writeStatusSnapshot(state, payload);
      return send(500, payload);
    }
  });

  server.on('close', () => {
    if (statusHeartbeatTimer) {
      clearInterval(statusHeartbeatTimer);
    }
  });

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
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
  });
}

module.exports = {
  createMinimalTradingServer,
  serializeMinimalResult,
};
