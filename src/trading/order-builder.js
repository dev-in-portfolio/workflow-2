const { isBrokerBackedExecutionAdapter } = require('../broker-reconciliation');
const { assertExecutionRequest } = require('../module-contracts');
const { allocateBuyNotional } = require('../portfolio-allocation');
const { safeNumber } = require('../util');
const { buildPaperOrderRequestFromSignal, resolveBuyOrderSizing } = require('../webhooks');
const { isBuySignal } = require('./signal-processor');

function buildPaperOrder(signal, riskDecision, options = {}) {
  const policy = options.policy || {};
  const portfolio = options.portfolio || {};
  const executionAdapter = options.executionAdapter;

  const requestedBuyNotionalTarget = policy.buyNotionalTarget ?? options.buyNotionalTarget ?? 150;
  const minBuyNotional = Math.max(1, Number(policy.minBuyNotional ?? options.minBuyNotional ?? 25) || 25);
  const strictBrokerCash = isBuySignal(signal) && isBrokerBackedExecutionAdapter(executionAdapter);
  const liveBuyBudget = isBuySignal(signal)
    ? allocateBuyNotional({
      targetNotional: requestedBuyNotionalTarget,
      minBuyNotional,
      portfolio,
      requireBrokerCash: strictBrokerCash,
    })
    : { target: requestedBuyNotionalTarget, requested: requestedBuyNotionalTarget, cash_limited: false };
  const effectiveBuyNotionalTarget = liveBuyBudget.notional ?? liveBuyBudget.target;
  if (isBuySignal(signal) && (!liveBuyBudget.accepted || effectiveBuyNotionalTarget < minBuyNotional)) {
    return {
      accepted: false,
      reason_codes: [liveBuyBudget.reason || 'CASH_TOO_LOW_FOR_TARGET_SIZE'],
      sizing: {
        requested_notional: requestedBuyNotionalTarget,
        submitted_notional: effectiveBuyNotionalTarget,
        min_buy_notional: minBuyNotional,
        cash_limited: Boolean(liveBuyBudget.cash_limited),
        allocation: liveBuyBudget,
      },
    };
  }
  const paperOrderRequest = buildPaperOrderRequestFromSignal(signal, {
    policy,
    positionSizeMultiplier: policy.positionSizeMultiplier,
    buyNotionalTarget: effectiveBuyNotionalTarget,
  });
  if (paperOrderRequest && isBuySignal(signal)) {
    paperOrderRequest.requested_notional = requestedBuyNotionalTarget;
    paperOrderRequest.submitted_notional = effectiveBuyNotionalTarget;
    paperOrderRequest.min_buy_notional = minBuyNotional;
    if (strictBrokerCash) paperOrderRequest.require_idempotency = true;
  }
  if (paperOrderRequest) assertExecutionRequest(paperOrderRequest);
  if (!paperOrderRequest) {
    if (isBuySignal(signal)) {
      const buySizing = resolveBuyOrderSizing(signal, {
        buyNotionalTarget: effectiveBuyNotionalTarget,
      });
      if (buySizing && buySizing.reason_codes?.length) {
        return {
          accepted: false,
          reason_codes: buySizing.reason_codes,
        };
      }
    }
    return {
      accepted: false,
      reason_codes: ['NON_TRADE_DECISION'],
    };
  }

  return {
    accepted: true,
    paperOrderRequest,
  };
}

function findPendingPartialConflict(partialFillSummary = {}, request = {}) {
  const symbol = String(request.symbol || '').trim().toUpperCase();
  const side = String(request.side || '').trim().toLowerCase();
  if (!symbol || !side) return null;
  const active = [
    ...(Array.isArray(partialFillSummary.partial_buys) ? partialFillSummary.partial_buys : []),
    ...(Array.isArray(partialFillSummary.partial_sells) ? partialFillSummary.partial_sells : []),
  ];
  return active.find((order) => String(order.symbol || '').toUpperCase() === symbol && String(order.side || '').toLowerCase() === side) || null;
}

async function resolveLiveBuyNotionalTarget(executionAdapter, desiredTarget) {
  const fallbackTarget = Math.max(1, Number(desiredTarget) || 150);
  if (!executionAdapter || typeof executionAdapter.getAccount !== 'function') {
    return { target: fallbackTarget, requested: fallbackTarget, cash_limited: false };
  }

  try {
    const account = await executionAdapter.getAccount();
    const availableNumbers = [
      account?.buying_power,
      account?.cash,
      account?.available_buying_power,
    ]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (!availableNumbers.length) {
      return { target: fallbackTarget, requested: fallbackTarget, cash_limited: false };
    }
    const maxSafeBudget = Math.max(1, Math.floor(Math.min(...availableNumbers) * 0.99 * 100) / 100);
    const target = Math.min(fallbackTarget, maxSafeBudget);
    return { target, requested: fallbackTarget, cash_limited: target < fallbackTarget, max_safe_budget: maxSafeBudget };
  } catch {
    return { target: fallbackTarget, requested: fallbackTarget, cash_limited: false };
  }
}

module.exports = {
  buildPaperOrder,
  findPendingPartialConflict,
  resolveLiveBuyNotionalTarget,
};
