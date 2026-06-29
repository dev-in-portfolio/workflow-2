const { assertSignalCandidate } = require('../module-contracts');
const { loadPartialFillState, summarizePartialFillState } = require('../partial-fill-state');
const { resolveRepoRoot } = require('../util');
const { validatePaperOrderWebhookPayload } = require('../webhooks');
const { ok, fail } = require('../result');
const { TradingError } = require('../errors');

function normalizeOrderStatus(order) {
  return String(order?.status || order?.order_status || order?.fill_status || '').trim().toLowerCase();
}

function isBuySignal(signal = {}) {
  return String(signal.side || signal.direction || '').trim().toLowerCase() === 'buy';
}

function processSignal(signalOrRequest = {}, options = {}) {
  const signal = signalOrRequest.signal || signalOrRequest;
  const marketContext = {
    ...(signalOrRequest.market_context || signalOrRequest.marketContext || {}),
    ...(options.marketContext || {}),
  };
  const performance = options.performance || null;
  const audit = options.audit || null;
  const policySnapshot = options.policySnapshot || performance?.getPolicySnapshot?.() || { policy: {} };
  const policy = policySnapshot.policy || {};
  const requestedPortfolio = signalOrRequest.portfolio || signalOrRequest.portfolio_context || {};
  const partialFillState = options.partialFillState || loadPartialFillState({ env: options.env || process.env, repoRoot: options.repoRoot || resolveRepoRoot() });
  const partialFillSummary = summarizePartialFillState(partialFillState);

  const validation = validatePaperOrderWebhookPayload(signal);
  if (!validation.pass) {
    return fail(new TradingError('Signal validation failed', {
      stage: 'validation',
      reasonCodes: validation.reason_codes,
      data: { signal, marketContext },
    }), validation.reason_codes);
  }
  assertSignalCandidate(signal);

  return ok({
    signal,
    marketContext,
    performance,
    audit,
    policySnapshot,
    policy,
    requestedPortfolio,
    partialFillState,
    partialFillSummary,
  });
}

module.exports = {
  isBuySignal,
  normalizeOrderStatus,
  processSignal,
};
