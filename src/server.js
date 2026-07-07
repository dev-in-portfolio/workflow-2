const http = require('http');
const { URL } = require('url');
const { createLogger } = require('./logger');
const { InMemoryAuditStore } = require('./audit');
const { PerformanceStore } = require('./feedback-loop');
const { AlpacaTradeAdapter } = require('./alpaca-adapter');
const { PaperTradeAdapter } = require('./paper-adapter');
const { buildReviewItem } = require('./review');
const { comparePolicyPerformance } = require('./walk-forward');
const { validatePaperOrderWebhookPayload } = require('./webhooks');
const { processMarketInput, processTradingSignal } = require('./trading-loop');
const { resolveExecutionQualityStatePath } = require('./execution-quality-state');
const { resolveRepoRoot } = require('./util');
const { isLiveModeSelected } = require('./execution-mode');

function resolveExecutionAdapter(options = {}) {
  if (options.executionAdapter) return options.executionAdapter;
  const intentConfig = options.config || options.env || process.env;
  if (isLiveModeSelected(intentConfig)) {
    const error = new Error('Live trading server requires an explicit broker-backed execution adapter; refusing paper fallback.');
    error.code = 'LIVE_EXECUTION_ADAPTER_REQUIRED';
    error.reason_codes = ['LIVE_MODE_REQUIRES_BROKER_EXECUTION_ADAPTER'];
    throw error;
  }
  return options.paperAdapter || new PaperTradeAdapter({ dryRun: true });
}

function createTradingControlServer(options = {}) {
  const log = options.logger || createLogger();
  const state = {
    audit: options.audit || new InMemoryAuditStore(),
    executionAdapter: resolveExecutionAdapter(options),
    reviewQueue: options.reviewQueue || [],
    performance: options.performance || new PerformanceStore({
      historyPath: options.performanceHistoryPath || null,
      policyPath: options.policyPath || null,
      policyHistoryPath: options.policyHistoryPath || null,
      executionQualityPath: options.executionQualityPath || resolveExecutionQualityStatePath({ repoRoot: options.repoRoot || resolveRepoRoot() }),
      startupPolicyPatch: options.startupPolicyPatch || null,
      initialPolicySnapshot: options.initialPolicySnapshot || null,
    }),
    autoPolicyRefresh: options.autoPolicyRefresh === true,
    autoPolicyRefreshMinBlockedCount: Math.max(1, Number(options.autoPolicyRefreshMinBlockedCount || 2) || 2),
    autoPolicyRefreshMinRejectionPressureScore: Math.max(0, Number(options.autoPolicyRefreshMinRejectionPressureScore || 50) || 50),
    autoPolicyRefreshMinPaperOutcomes: Math.max(1, Number(options.autoPolicyRefreshMinPaperOutcomes || 1) || 1),
    lastPolicyRefreshKey: null,
  };

  function maybeRefreshPolicyFromLearning(reportDate = undefined, trigger = 'auto') {
    if (!state.autoPolicyRefresh) return null;
    const normalizedReportDate = reportDate ? String(reportDate).slice(0, 10) : undefined;
    const report = state.performance.getDailyReport(normalizedReportDate || undefined);
    const refreshKey = `${report.date}:${report.paper_outcome_count}:${report.blocked_count}:${report.dominant_block_reason?.reason || 'none'}:${report.rejection_pressure_score}`;
    if (state.lastPolicyRefreshKey === refreshKey) return null;
    const shouldRefresh = report.paper_outcome_count >= state.autoPolicyRefreshMinPaperOutcomes
      && (
        report.blocked_count >= state.autoPolicyRefreshMinBlockedCount
        || report.rejection_pressure_score >= state.autoPolicyRefreshMinRejectionPressureScore
        || ['MAX_OPEN_POSITIONS_EXCEEDED', 'STALE_DATA', 'INVALID_TIMESTAMP', 'MULTI_SOURCE_CONFIRMATION_FAILED'].includes(report.dominant_block_reason?.reason)
      );
    if (!shouldRefresh) return null;
    const snapshot = state.performance.refreshPolicyFromLearning({
      source: `auto-${trigger}`,
      reportDate: report.date,
    });
    state.lastPolicyRefreshKey = refreshKey;
    state.audit.writeEvent({
      event_type: 'policy_auto_refreshed_from_learning',
      related_entity_id: snapshot.captured_at,
      payload: {
        trigger,
        learning_report: report,
        policy_snapshot: snapshot,
      },
      source: 'server',
    });
    return snapshot;
  }

  const send = (res, statusCode, payload) => {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  };

  const routes = [
    { method: 'GET', pattern: '/health', handle: async () => {
      const health = { status: 'ok', mode: 'paper', timestamp: new Date().toISOString() };
      if (state.executionAdapter && typeof state.executionAdapter.getAccount === 'function') {
        try {
          const account = await state.executionAdapter.getAccount();
          health.alpaca = { reachable: true, account_status: account.status || account.account_status || 'available' };
        } catch (err) {
          health.alpaca = { reachable: false, error: err.message };
          health.status = 'degraded';
        }
      }
      return { status: 200, body: health };
    } },
    { method: 'GET', pattern: '/readiness', handle: () => ({ status: 200, body: { ready: true, checks: [{ name: 'audit', pass: !!state.audit }, { name: 'execution_adapter', pass: !!state.executionAdapter }] } }) },
    { method: 'GET', pattern: '/review-items', handle: () => ({ status: 200, body: { items: state.reviewQueue } }) },
    { method: 'GET', pattern: '/daily-live-results', handle: ({ url }) => ({ status: 200, body: state.performance.getDailyReport(url.searchParams.get('date') || undefined) }) },
    { method: 'GET', pattern: '/performance/tuning', handle: () => ({ status: 200, body: state.performance.suggestTuning() }) },
    { method: 'GET', pattern: '/status', handle: () => ({ status: 200, body: { status: 'ok', mode: 'direct', timestamp: new Date().toISOString(), review_queue_length: state.reviewQueue.length, paper_outcome_count: state.performance.paperOutcomes.length } }) },
    { method: 'GET', pattern: '/risk-policy', handle: () => ({ status: 200, body: { accepted: true, policy_snapshot: state.performance.getPolicySnapshot() } }) },
    { method: 'GET', pattern: '/policy-effectiveness', handle: ({ url }) => ({ status: 200, body: { accepted: true, policy_effectiveness: state.performance.getPolicyEffectiveness({ dateFrom: url.searchParams.get('dateFrom') || null, dateTo: url.searchParams.get('dateTo') || null, limit: Number(url.searchParams.get('limit') || 20) || 20 }) } }) },

    { method: 'POST', pattern: '/paper-order', handle: async ({ body }) => {
      const candidate = body.signal || body.order || body;
      const validation = validatePaperOrderWebhookPayload(candidate);
      if (!validation.pass) return { status: 400, body: { accepted: false, error: validation.reason_codes[0], reason_codes: validation.reason_codes } };
      const policySnapshot = state.performance.getPolicySnapshot();
      const result = await processTradingSignal({
        ...body, signal: candidate,
        market_context: { ...(body.market_context || body.marketContext || candidate.market_context || candidate.marketContext || {}), ...resolveExecutionQualityContext(state.performance, candidate.created_at || body.created_at || undefined) },
      }, { audit: state.audit, executionAdapter: state.executionAdapter, performance: state.performance, policySnapshot, buyNotionalTarget: options.buyNotionalTarget, minBuyNotional: options.minBuyNotional, source: 'direct', confirmationAttempts: 6, confirmationDelayMs: 500, confirmationMaxDelayMs: 1500 });
      if (!result.accepted) return { status: 400, body: { accepted: false, stage: result.stage, error: result.reason_codes?.[0] || 'NON_TRADE_DECISION', reason_codes: result.reason_codes || [] } };
      return { status: 200, body: { accepted: true, stage: result.stage, signal: result.signal, risk_decision: result.riskDecision, paper_order_request: result.paperOrderRequest, paper_order: result.paperOrder, order_confirmation: result.confirmation, paper_result: result.paperResult, paper_outcome: result.paperOutcome } };
    } },

    { method: 'POST', pattern: '/review-actions', handle: ({ body }) => {
      state.audit.writeEvent({ event_type: 'human_review_action', related_entity_id: body.review_item_id, payload: body, source: 'operator' });
      return { status: 200, body: { accepted: true, review_item_id: body.review_item_id, action: body.action } };
    } },

    { method: 'POST', pattern: '/paper-outcomes', handle: ({ body }) => {
      const outcome = state.performance.recordPaperExecution(body);
      maybeRefreshPolicyFromLearning(outcome.recorded_at || outcome.paper_result?.filled_at || undefined, 'paper-outcomes');
      return { status: 200, body: { accepted: true, outcome } };
    } },

    { method: 'POST', pattern: '/walk-forward-comparison', handle: ({ body }) => {
      const fixtures = Array.isArray(body.fixtures) ? body.fixtures : [];
      const comparison = comparePolicyPerformance(fixtures, { baselinePolicy: body.baseline_policy || body.baselinePolicy || {}, date: body.date || undefined, performanceStore: state.performance, dateFrom: body.dateFrom || null, dateTo: body.dateTo || null, limit: body.limit || 1000 });
      return { status: 200, body: { accepted: true, comparison } };
    } },

    { method: 'POST', pattern: '/risk-policy', handle: ({ body }) => {
      const snapshot = state.performance.setPolicySnapshot(body.policy_snapshot || body);
      return { status: 200, body: { accepted: true, policy_snapshot: snapshot } };
    } },

    { method: 'POST', pattern: '/policy-refresh', handle: ({ body }) => {
      const snapshot = state.performance.refreshPolicyFromLearning({ source: body.source || 'learning-refresh', reportDate: body.report_date || body.reportDate || null });
      return { status: 200, body: { accepted: true, policy_snapshot: snapshot, learning_report: snapshot.learning_report || state.performance.getDailyReport(body.report_date || body.reportDate || undefined) } };
    } },

    { method: 'POST', pattern: '/policy-rollback', handle: ({ body }) => {
      const rollback = state.performance.rollbackToBestPolicy({ dateFrom: body.dateFrom || null, dateTo: body.dateTo || null, limit: body.limit || 20 });
      return { status: rollback.accepted ? 200 : 400, body: rollback };
    } },

    { method: 'POST', pattern: '/policy-size-rebalance', handle: ({ body }) => {
      const rebalance = state.performance.rebalancePolicySize({ dateFrom: body.dateFrom || null, dateTo: body.dateTo || null, limit: body.limit || 20 });
      return { status: rebalance.accepted ? 200 : 400, body: rebalance };
    } },

    { method: 'POST', pattern: '/policy-capacity-rebalance', handle: ({ body }) => {
      const rebalance = state.performance.rebalancePolicyCapacity({ dateFrom: body.dateFrom || null, dateTo: body.dateTo || null, limit: body.limit || 20 });
      return { status: rebalance.accepted ? 200 : 400, body: rebalance };
    } },
  ];

  const webhookEventHandlers = {
    'market-ingest': async ({ body, record, webhookType, url }) => {
      const policySnapshot = state.performance.getPolicySnapshot();
      const result = await processMarketInput(body, { audit: state.audit, executionAdapter: state.executionAdapter, performance: state.performance, policySnapshot, buyNotionalTarget: options.buyNotionalTarget, minBuyNotional: options.minBuyNotional, source: 'webhook', confirmationAttempts: 6, confirmationDelayMs: 500, confirmationMaxDelayMs: 1500 });
      if (!result.accepted) {
        state.performance.recordEvent({ event_type: 'market_ingest_rejected', related_entity_id: result.signal?.signal_id || body.signal_id || null, payload: { input: body, normalized_market_data: result.normalized_market_data, reason_codes: result.reason_codes }, source: 'server', severity: 'warning' });
        return { status: 400, body: { accepted: false, normalized: false, stage: result.stage, reason_codes: result.reason_codes, normalized_market_data: result.normalized_market_data } };
      }
      state.reviewQueue.push(buildReviewItem({ signal: result.signal, riskDecision: result.riskDecision }));
      return { status: 200, body: { accepted: true, normalized: true, event_id: record.event_id, webhook_type: webhookType, stage: result.stage, signal_id: result.signal?.signal_id || null, final_decision: result.signal?.final_decision || null, reason_codes: result.signal?.decision_reasons || [], paper_order: result.paperOrder, order_confirmation: result.confirmation } };
    },
    'signal-created': async ({ body, record }) => {
      const policySnapshot = state.performance.getPolicySnapshot();
      const result = await processTradingSignal({ ...body, signal: body.signal || body, market_context: { ...(body.market_context || body.marketContext || {}), ...resolveExecutionQualityContext(state.performance, (body.signal || body).created_at || body.created_at || undefined) } }, { audit: state.audit, executionAdapter: state.executionAdapter, performance: state.performance, policySnapshot, buyNotionalTarget: options.buyNotionalTarget, minBuyNotional: options.minBuyNotional, source: 'webhook', confirmationAttempts: 6, confirmationDelayMs: 500, confirmationMaxDelayMs: 1500 });
      if (result.signal && result.riskDecision) state.reviewQueue.push(buildReviewItem({ signal: result.signal, riskDecision: result.riskDecision }));
      if (result.accepted) maybeRefreshPolicyFromLearning(result.signal.created_at || body.created_at || undefined, 'signal-created');
      if (!result.accepted) return { status: 400, body: { accepted: false, stage: result.stage, reason_codes: result.reason_codes || [] } };
      return { status: 200, body: { accepted: true, stage: result.stage, signal: result.signal, risk_decision: result.riskDecision, paper_order: result.paperOrder, order_confirmation: result.confirmation, paper_result: result.paperResult, paper_outcome: result.paperOutcome } };
    },
    'risk-decision': ({ body }) => {
      state.performance.recordRiskDecision(body.riskDecision || body);
      maybeRefreshPolicyFromLearning(body.riskDecision?.timestamp || body.timestamp || undefined, 'risk-decision');
      return null;
    },
    'paper-fill-event': ({ body }) => {
      const outcome = body.paperOutcome || body.outcome || body;
      state.performance.recordPaperOutcome(outcome);
      maybeRefreshPolicyFromLearning(outcome.recorded_at || outcome.paper_result?.filled_at || undefined, 'paper-fill-event');
      return null;
    },
  };

  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    try {
      const url = new URL(req.url, 'http://localhost');
      const body = await readJsonBody(req);

      for (const route of routes) {
        if (req.method !== route.method || url.pathname !== route.pattern) continue;
        const result = await route.handle({ body, url, req });
        log({ level: 'info', event: 'http_request', message: `${req.method} ${url.pathname} ${result.status} ${Date.now() - start}ms` });
        return send(res, result.status, result.body);
      }

      const webhookType = resolveInboundEventType(url.pathname);
      if (req.method === 'POST' && webhookType) {
        const handler = webhookEventHandlers[webhookType];
        let record = null;
        if (handler) {
          if (webhookType === 'paper-order-request') {
            const validation = validatePaperOrderWebhookPayload(body);
            if (!validation.pass) {
              log({ level: 'warn', event: 'http_request', message: `${req.method} ${url.pathname} 400 ${Date.now() - start}ms` });
              return send(res, 400, { accepted: false, error: validation.reason_codes[0], reason_codes: validation.reason_codes });
            }
          }
          record = state.audit.writeEvent({ event_type: webhookType, related_entity_id: body.signal_id || body.request_id || body.event_id || null, payload: body, source: url.pathname.startsWith('/webhooks/') ? 'webhook' : 'direct' });
          const result = await handler({ body, record, webhookType, url });
          if (result) {
            log({ level: 'info', event: 'http_request', message: `${req.method} ${url.pathname} ${result.status} ${Date.now() - start}ms` });
            return send(res, result.status, result.body);
          }
        }
        if (!handler || webhookType === 'paper-order-request') {
          record = state.audit.writeEvent({ event_type: webhookType, related_entity_id: body.signal_id || body.request_id || body.event_id || null, payload: body, source: url.pathname.startsWith('/webhooks/') ? 'webhook' : 'direct' });
          log({ level: 'info', event: 'http_request', message: `${req.method} ${url.pathname} 200 ${Date.now() - start}ms` });
          return send(res, 200, { accepted: true, event_id: record.event_id, webhook_type: webhookType });
        }
        log({ level: 'info', event: 'http_request', message: `${req.method} ${url.pathname} 200 ${Date.now() - start}ms` });
        return send(res, 200, { accepted: true, event_id: record.event_id, webhook_type: webhookType });
      }

      log({ level: 'warn', event: 'http_request', message: `${req.method} ${url.pathname} 404 ${Date.now() - start}ms` });
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      const pathname = (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch { return '/unknown'; } })();
      if (error?.code === 'INVALID_JSON') {
        log({ level: 'warn', event: 'http_request_error', message: `${req.method} ${pathname} 400 ${Date.now() - start}ms - invalid_json` });
        return send(res, 400, { accepted: false, error: 'invalid_json' });
      }
      log({ level: 'error', event: 'http_request_error', message: `${req.method} ${pathname} 500 ${Date.now() - start}ms - ${error.message}` });
      return send(res, 500, { accepted: false, error: 'internal_error', message: error.message });
    }
  });

  function shutdown(signal) {
    log({ level: 'info', event: 'shutdown', message: `Received ${signal}, shutting down...` });
    server.close(() => {
      log({ level: 'info', event: 'shutdown_complete', message: 'Server closed' });
    });
    setTimeout(() => {
      process.stderr.write('Forced shutdown after timeout\n');
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

function resolveExecutionQualityContext(performanceStore, timestamp) {
  if (!performanceStore || typeof performanceStore.getDailyReport !== 'function') return {};
  const reportDate = timestamp ? String(timestamp).slice(0, 10) : undefined;
  const report = performanceStore.getDailyReport(reportDate);
  const fillQualitySummary = report?.fill_quality_summary;
  if (!fillQualitySummary || fillQualitySummary.count <= 0) return {};
  return { fill_quality_summary: fillQualitySummary };
}

function resolveInboundEventType(pathname) {
  if (!pathname) return null;
  if (pathname.startsWith('/webhooks/')) {
    return pathname.replace('/webhooks/', '');
  }
  const directRoutes = {
    '/signal': 'signal-created',
    '/signals': 'signal-created',
    '/paper-order': 'paper-order-request',
    '/paper-order-request': 'paper-order-request',
      '/paper-fill': 'paper-fill-event',
      '/paper-fill-event': 'paper-fill-event',
      '/risk-decision': 'risk-decision',
      '/daily-summary': 'daily-summary',
      '/market-ingest': 'market-ingest',
    '/research-completed': 'research-completed',
    '/human-approval': 'human-approval',
    '/error-alert': 'error-alert',
  };
  return directRoutes[pathname] || null;
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
  createTradingControlServer,
  resolveInboundEventType,
};
