const http = require('http');
const { URL } = require('url');
const { InMemoryAuditStore } = require('./audit');
const { PerformanceStore } = require('./feedback-loop');
const { AlpacaTradeAdapter } = require('./alpaca-adapter');
const { PaperTradeAdapter } = require('./paper-adapter');
const { buildReviewItem } = require('./review');
const { comparePolicyPerformance } = require('./walk-forward');
const { validatePaperOrderWebhookPayload } = require('./webhooks');
const { processMarketInput, processTradingSignal } = require('./trading-loop');

function createTradingControlServer(options = {}) {
  const state = {
    audit: options.audit || new InMemoryAuditStore(),
    executionAdapter: options.executionAdapter || options.paperAdapter || new PaperTradeAdapter({ dryRun: true }),
    reviewQueue: options.reviewQueue || [],
    performance: options.performance || new PerformanceStore({
      historyPath: options.performanceHistoryPath || null,
      policyPath: options.policyPath || null,
      policyHistoryPath: options.policyHistoryPath || null,
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

  return http.createServer(async (req, res) => {
    const send = (statusCode, payload) => {
      res.statusCode = statusCode;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };

    try {
      const url = new URL(req.url, 'http://localhost');
      const body = await readJsonBody(req);

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(200, { status: 'ok', mode: 'paper', timestamp: new Date().toISOString() });
      }

      if (req.method === 'GET' && url.pathname === '/readiness') {
        return send(200, {
          ready: true,
          checks: [
            { name: 'audit', pass: !!state.audit },
            { name: 'execution_adapter', pass: !!state.executionAdapter },
          ],
        });
      }

      if (req.method === 'GET' && url.pathname === '/review-items') {
        return send(200, { items: state.reviewQueue });
      }

      if (req.method === 'GET' && url.pathname === '/daily-live-results') {
        return send(200, state.performance.getDailyReport(url.searchParams.get('date') || undefined));
      }

      if (req.method === 'GET' && url.pathname === '/performance/tuning') {
        return send(200, state.performance.suggestTuning());
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        return send(200, {
          status: 'ok',
          mode: 'direct',
          timestamp: new Date().toISOString(),
          review_queue_length: state.reviewQueue.length,
          paper_outcome_count: state.performance.paperOutcomes.length,
        });
      }

      if (req.method === 'GET' && url.pathname === '/risk-policy') {
        return send(200, {
          accepted: true,
          policy_snapshot: state.performance.getPolicySnapshot(),
        });
      }

      if (req.method === 'GET' && url.pathname === '/policy-effectiveness') {
        return send(200, {
          accepted: true,
          policy_effectiveness: state.performance.getPolicyEffectiveness({
            dateFrom: url.searchParams.get('dateFrom') || null,
            dateTo: url.searchParams.get('dateTo') || null,
            limit: Number(url.searchParams.get('limit') || 20) || 20,
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/paper-order') {
        const candidate = body.signal || body.order || body;
        const validation = validatePaperOrderWebhookPayload(candidate);
        if (!validation.pass) {
          return send(400, { accepted: false, error: validation.reason_codes[0], reason_codes: validation.reason_codes });
        }
        const policySnapshot = state.performance.getPolicySnapshot();
        const result = await processTradingSignal({
          ...body,
          signal: candidate,
          market_context: {
            ...(body.market_context || body.marketContext || candidate.market_context || candidate.marketContext || {}),
            ...resolveExecutionQualityContext(state.performance, candidate.created_at || body.created_at || undefined),
          },
        }, {
          audit: state.audit,
          executionAdapter: state.executionAdapter,
          performance: state.performance,
          policySnapshot,
          buyNotionalTarget: options.buyNotionalTarget,
          minBuyNotional: options.minBuyNotional,
          source: 'direct',
          confirmationAttempts: 6,
          confirmationDelayMs: 500,
          confirmationMaxDelayMs: 1500,
        });
        if (!result.accepted) {
          return send(400, {
            accepted: false,
            stage: result.stage,
            error: result.reason_codes?.[0] || 'NON_TRADE_DECISION',
            reason_codes: result.reason_codes || [],
          });
        }
        return send(200, {
          accepted: true,
          stage: result.stage,
          signal: result.signal,
          risk_decision: result.riskDecision,
          paper_order_request: result.paperOrderRequest,
          paper_order: result.paperOrder,
          order_confirmation: result.confirmation,
          paper_result: result.paperResult,
          paper_outcome: result.paperOutcome,
        });
      }

      const webhookType = resolveInboundEventType(url.pathname);
      if (req.method === 'POST' && webhookType) {
        if (webhookType === 'paper-order-request') {
          const validation = validatePaperOrderWebhookPayload(body);
          if (!validation.pass) {
            return send(400, { accepted: false, error: validation.reason_codes[0], reason_codes: validation.reason_codes });
          }
        }
        const record = state.audit.writeEvent({
          event_type: webhookType,
          related_entity_id: body.signal_id || body.request_id || body.event_id || null,
          payload: body,
          source: url.pathname.startsWith('/webhooks/') ? 'webhook' : 'direct',
        });
        if (webhookType === 'market-ingest') {
          const policySnapshot = state.performance.getPolicySnapshot();
          const result = await processMarketInput(body, {
            audit: state.audit,
            executionAdapter: state.executionAdapter,
            performance: state.performance,
            policySnapshot,
            buyNotionalTarget: options.buyNotionalTarget,
            minBuyNotional: options.minBuyNotional,
            source: 'webhook',
            confirmationAttempts: 6,
            confirmationDelayMs: 500,
            confirmationMaxDelayMs: 1500,
          });
          if (!result.accepted) {
            state.performance.recordEvent({
              event_type: 'market_ingest_rejected',
              related_entity_id: result.signal?.signal_id || body.signal_id || null,
              payload: {
                input: body,
                normalized_market_data: result.normalized_market_data,
                reason_codes: result.reason_codes,
              },
              source: 'server',
              severity: 'warning',
            });
            return send(400, {
              accepted: false,
              normalized: false,
              stage: result.stage,
              reason_codes: result.reason_codes,
              normalized_market_data: result.normalized_market_data,
            });
          }
          state.reviewQueue.push(buildReviewItem({
            signal: result.signal,
            riskDecision: result.riskDecision,
          }));
          return send(200, {
            accepted: true,
            normalized: true,
            event_id: record.event_id,
            webhook_type: webhookType,
            stage: result.stage,
            signal_id: result.signal?.signal_id || null,
            final_decision: result.signal?.final_decision || null,
            reason_codes: result.signal?.decision_reasons || [],
            paper_order: result.paperOrder,
            order_confirmation: result.confirmation,
          });
        }
        if (webhookType === 'signal-created') {
          const policySnapshot = state.performance.getPolicySnapshot();
          const result = await processTradingSignal({
            ...body,
            signal: body.signal || body,
            market_context: {
              ...(body.market_context || body.marketContext || {}),
              ...resolveExecutionQualityContext(state.performance, (body.signal || body).created_at || body.created_at || undefined),
            },
          }, {
            audit: state.audit,
            executionAdapter: state.executionAdapter,
            performance: state.performance,
            policySnapshot,
            buyNotionalTarget: options.buyNotionalTarget,
            minBuyNotional: options.minBuyNotional,
            source: 'webhook',
            confirmationAttempts: 6,
            confirmationDelayMs: 500,
            confirmationMaxDelayMs: 1500,
          });
          if (result.signal && result.riskDecision) {
            state.reviewQueue.push(buildReviewItem({
              signal: result.signal,
              riskDecision: result.riskDecision,
            }));
          }
          if (result.accepted) {
            maybeRefreshPolicyFromLearning(result.signal.created_at || body.created_at || undefined, 'signal-created');
          }
          if (!result.accepted) {
            return send(400, {
              accepted: false,
              stage: result.stage,
              reason_codes: result.reason_codes || [],
            });
          }
          return send(200, {
            accepted: true,
            stage: result.stage,
            signal: result.signal,
            risk_decision: result.riskDecision,
            paper_order: result.paperOrder,
            order_confirmation: result.confirmation,
            paper_result: result.paperResult,
            paper_outcome: result.paperOutcome,
          });
        }
        if (webhookType === 'risk-decision') {
          state.performance.recordRiskDecision(body.riskDecision || body);
          maybeRefreshPolicyFromLearning(body.riskDecision?.timestamp || body.timestamp || undefined, 'risk-decision');
        }
        if (webhookType === 'paper-fill-event') {
          const outcome = body.paperOutcome || body.outcome || body;
          state.performance.recordPaperOutcome(outcome);
          maybeRefreshPolicyFromLearning(outcome.recorded_at || outcome.paper_result?.filled_at || undefined, 'paper-fill-event');
        }
        return send(200, { accepted: true, event_id: record.event_id, webhook_type: webhookType });
      }

      if (req.method === 'POST' && url.pathname === '/review-actions') {
        const reviewItemId = body.review_item_id;
        const action = body.action;
        state.audit.writeEvent({
          event_type: 'human_review_action',
          related_entity_id: reviewItemId,
          payload: body,
          source: 'operator',
        });
        return send(200, { accepted: true, review_item_id: reviewItemId, action });
      }

      if (req.method === 'POST' && url.pathname === '/paper-outcomes') {
        const outcome = state.performance.recordPaperExecution(body);
        maybeRefreshPolicyFromLearning(outcome.recorded_at || outcome.paper_result?.filled_at || undefined, 'paper-outcomes');
        return send(200, { accepted: true, outcome });
      }

      if (req.method === 'POST' && url.pathname === '/walk-forward-comparison') {
        const fixtures = Array.isArray(body.fixtures) ? body.fixtures : [];
        const comparison = comparePolicyPerformance(fixtures, {
          baselinePolicy: body.baseline_policy || body.baselinePolicy || {},
          date: body.date || undefined,
          performanceStore: state.performance,
          dateFrom: body.dateFrom || null,
          dateTo: body.dateTo || null,
          limit: body.limit || 1000,
        });
        return send(200, { accepted: true, comparison });
      }

      if (req.method === 'POST' && url.pathname === '/risk-policy') {
        const snapshot = state.performance.setPolicySnapshot(body.policy_snapshot || body);
        return send(200, { accepted: true, policy_snapshot: snapshot });
      }

      if (req.method === 'POST' && url.pathname === '/policy-refresh') {
        const snapshot = state.performance.refreshPolicyFromLearning({
          source: body.source || 'learning-refresh',
          reportDate: body.report_date || body.reportDate || null,
        });
        return send(200, {
          accepted: true,
          policy_snapshot: snapshot,
          learning_report: snapshot.learning_report || state.performance.getDailyReport(body.report_date || body.reportDate || undefined),
        });
      }

      if (req.method === 'POST' && url.pathname === '/policy-rollback') {
        const rollback = state.performance.rollbackToBestPolicy({
          dateFrom: body.dateFrom || null,
          dateTo: body.dateTo || null,
          limit: body.limit || 20,
        });
        return send(rollback.accepted ? 200 : 400, rollback);
      }

      if (req.method === 'POST' && url.pathname === '/policy-size-rebalance') {
        const rebalance = state.performance.rebalancePolicySize({
          dateFrom: body.dateFrom || null,
          dateTo: body.dateTo || null,
          limit: body.limit || 20,
        });
        return send(rebalance.accepted ? 200 : 400, rebalance);
      }

      if (req.method === 'POST' && url.pathname === '/policy-capacity-rebalance') {
        const rebalance = state.performance.rebalancePolicyCapacity({
          dateFrom: body.dateFrom || null,
          dateTo: body.dateTo || null,
          limit: body.limit || 20,
        });
        return send(rebalance.accepted ? 200 : 400, rebalance);
      }

      return send(404, { error: 'not_found' });
    } catch (error) {
      return send(500, {
        accepted: false,
        error: 'internal_error',
        message: error.message,
      });
    }
  });
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
  createTradingControlServer,
  resolveInboundEventType,
};
