const { computePaperOutcome } = require('./paper-outcomes');
const { deriveMarketActivitySignal } = require('./market-activity');
const { evaluateRiskGate } = require('./risk-gate');
const { buildPaperOrderRequestFromSignal, resolveBuyOrderSizing, validatePaperOrderWebhookPayload } = require('./webhooks');
const { nowIso, safeNumber } = require('./util');

function normalizeOrderStatus(order) {
  return String(order?.status || order?.order_status || order?.fill_status || '').trim().toLowerCase();
}

async function processTradingSignal(signalOrRequest = {}, options = {}) {
  const signal = signalOrRequest.signal || signalOrRequest;
  const marketContext = {
    ...(signalOrRequest.market_context || signalOrRequest.marketContext || {}),
    ...(options.marketContext || {}),
  };
  const performance = options.performance || null;
  const audit = options.audit || null;
  const policySnapshot = options.policySnapshot || performance?.getPolicySnapshot?.() || { policy: {} };
  const policy = policySnapshot.policy || {};
  const portfolio = signalOrRequest.portfolio || signalOrRequest.portfolio_context || {};

  const validation = validatePaperOrderWebhookPayload(signal);
  if (!validation.pass) {
    return {
      accepted: false,
      stage: 'validation',
      reason_codes: validation.reason_codes,
      signal,
      market_context: marketContext,
    };
  }

  const riskDecision = evaluateRiskGate(signal, portfolio, policy, marketContext);
  if (performance?.recordSignal) {
    performance.recordSignal(signal);
  }
  if (performance?.recordRiskDecision) {
    performance.recordRiskDecision({
      ...riskDecision,
      signal_id: signal.signal_id || null,
      timestamp: signal.created_at || riskDecision.timestamp || nowIso(),
      policy_snapshot: policySnapshot,
    });
  }

  if (riskDecision.decision !== 'APPROVED_FOR_PAPER') {
    return {
      accepted: false,
      stage: 'decision',
      reason_codes: riskDecision.reason_codes || [],
      signal,
      riskDecision,
      market_context: marketContext,
    };
  }

  const requestedBuyNotionalTarget = policy.buyNotionalTarget ?? options.buyNotionalTarget ?? 200;
  const minBuyNotional = Math.max(1, Number(policy.minBuyNotional ?? options.minBuyNotional ?? 25) || 25);
  const liveBuyBudget = isBuySignal(signal)
    ? await resolveLiveBuyNotionalTarget(options.executionAdapter, requestedBuyNotionalTarget)
    : { target: requestedBuyNotionalTarget, requested: requestedBuyNotionalTarget, cash_limited: false };
  const effectiveBuyNotionalTarget = liveBuyBudget.target;
  if (isBuySignal(signal) && effectiveBuyNotionalTarget < minBuyNotional) {
    return {
      accepted: false,
      stage: 'decision',
      reason_codes: ['CASH_TOO_LOW_FOR_TARGET_SIZE'],
      signal,
      riskDecision,
      market_context: marketContext,
      sizing: {
        requested_notional: requestedBuyNotionalTarget,
        submitted_notional: effectiveBuyNotionalTarget,
        min_buy_notional: minBuyNotional,
        cash_limited: Boolean(liveBuyBudget.cash_limited),
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
  }
  if (!paperOrderRequest) {
    if (isBuySignal(signal)) {
      const buySizing = resolveBuyOrderSizing(signal, {
        buyNotionalTarget: effectiveBuyNotionalTarget,
      });
      if (buySizing && buySizing.reason_codes?.length) {
        return {
          accepted: false,
          stage: 'decision',
          reason_codes: buySizing.reason_codes,
          signal,
          riskDecision,
          market_context: marketContext,
        };
      }
    }
    return {
      accepted: false,
      stage: 'decision',
      reason_codes: ['NON_TRADE_DECISION'],
      signal,
      riskDecision,
      market_context: marketContext,
    };
  }

  const openOrderCheck = await detectOpenOrderConflict(options.executionAdapter, paperOrderRequest);
  if (!openOrderCheck.pass) {
    return {
      accepted: false,
      stage: 'pre_submit',
      reason_codes: openOrderCheck.reason_codes,
      signal,
      riskDecision,
      paperOrderRequest,
      market_context: marketContext,
      open_orders: openOrderCheck.open_orders || [],
    };
  }

  const paperOrder = await options.executionAdapter.submitOrder(paperOrderRequest, {
    market: marketContext,
    requireHumanApproval: policy.requireHumanApproval,
  });

  const confirmation = await confirmBrokerOrder(options.executionAdapter, paperOrder.order_id, {
    attempts: options.confirmationAttempts,
    delayMs: options.confirmationDelayMs,
    maxDelayMs: options.confirmationMaxDelayMs,
  });

  const paperResult = buildPaperResultFromOrder({
    signal,
    paperOrderRequest,
    paperOrder,
    confirmation,
  });

  const paperOutcome = recordPaperOutcome(performance, signal, paperResult, options.outcomeSnapshot || null);

  if (audit?.writeEvent) {
    audit.writeEvent({
      event_type: 'trading_signal_processed',
      related_entity_id: paperOrder.order_id || signal.signal_id || null,
      payload: {
        signal,
        riskDecision,
        paperOrderRequest,
        paperOrder,
        confirmation,
        paperResult,
        paperOutcome,
      },
      source: options.source || 'server',
      severity: 'info',
    });
  }

  return {
    accepted: true,
    stage: 'order_confirmed',
    signal,
    riskDecision,
    paperOrderRequest,
    paperOrder,
    confirmation,
    paperResult,
    paperOutcome,
    market_context: marketContext,
  };
}

function isBuySignal(signal = {}) {
  return String(signal.side || signal.direction || '').trim().toLowerCase() === 'buy';
}

async function resolveLiveBuyNotionalTarget(executionAdapter, desiredTarget) {
  const fallbackTarget = Math.max(1, Number(desiredTarget) || 200);
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
    const maxSafeBudget = Math.max(1, Math.floor(Math.min(...availableNumbers) * 0.95 * 100) / 100);
    const target = Math.min(fallbackTarget, maxSafeBudget);
    return { target, requested: fallbackTarget, cash_limited: target < fallbackTarget, max_safe_budget: maxSafeBudget };
  } catch {
    return { target: fallbackTarget, requested: fallbackTarget, cash_limited: false };
  }
}

async function processMarketInput(rawInput = {}, options = {}) {
  const policySnapshot = options.policySnapshot || options.performance?.getPolicySnapshot?.() || { policy: {} };
  const policy = policySnapshot.policy || {};
  const derived = deriveMarketActivitySignal(rawInput, { policy });
  if (!derived.accepted || !derived.signal) {
    return {
      accepted: false,
      stage: 'validation',
      reason_codes: derived.reason_codes || ['NON_TRADE_DECISION'],
      normalized_market_data: derived.normalized_market_data || null,
      signal: derived.signal || null,
      market_context: rawInput.market_context || rawInput.marketContext || {},
    };
  }

  const normalizedSignal = {
    ...derived.signal,
    side: derived.signal.side
      || (derived.signal.action_candidate === 'paper_sell' || derived.signal.direction === 'bearish'
        ? 'sell'
        : 'buy'),
  };

  return processTradingSignal({
    ...rawInput,
    signal: normalizedSignal,
    market_context: {
      ...(rawInput.market_context || rawInput.marketContext || {}),
      primary_quote: derived.normalized_market_data,
      provider_confirmation: derived.provider_confirmation || null,
    },
  }, {
    ...options,
    policySnapshot,
  });
}

async function detectOpenOrderConflict(executionAdapter, paperOrderRequest) {
  if (!executionAdapter || typeof executionAdapter.getOpenOrders !== 'function') {
    return { pass: true, reason_codes: [], open_orders: [] };
  }

  let openOrders = [];
  try {
    openOrders = await executionAdapter.getOpenOrders();
  } catch (error) {
    return {
      pass: false,
      reason_codes: ['OPEN_ORDER_CHECK_UNAVAILABLE'],
      open_orders: [],
      error: error.message,
    };
  }

  const symbol = String(paperOrderRequest.symbol || '').trim().toUpperCase();
  const desiredSide = String(paperOrderRequest.side || '').trim().toLowerCase();
  const oppositeSide = desiredSide === 'buy' ? 'sell' : desiredSide === 'sell' ? 'buy' : null;
  const openOrderStatuses = new Set([
    'new',
    'accepted',
    'pending_new',
    'partially_filled',
    'submitted_to_paper',
    'approved',
    'proposal',
    'proposed',
    'approval_required',
    'risk_checked',
  ]);
  const conflictingOpenOrders = (Array.isArray(openOrders) ? openOrders : []).filter((order) => {
    const orderSymbol = String(order.symbol || '').trim().toUpperCase();
    const orderSide = String(order.side || '').trim().toLowerCase();
    const orderStatus = String(order.status || '').trim().toLowerCase();
    return orderSymbol === symbol && oppositeSide && orderSide === oppositeSide && openOrderStatuses.has(orderStatus);
  });

  if (conflictingOpenOrders.length > 0) {
    return {
      pass: false,
      reason_codes: ['OPEN_ORDER_CONFLICT', 'WASH_TRADE_RISK'],
      open_orders: conflictingOpenOrders,
    };
  }

  return { pass: true, reason_codes: [], open_orders: [] };
}

async function confirmBrokerOrder(executionAdapter, orderId, options = {}) {
  if (!executionAdapter || typeof executionAdapter.getOrder !== 'function') {
    return {
      confirmed: false,
      terminal: false,
      confirmation_status: 'unavailable',
      order: null,
      attempts: 0,
    };
  }

  const attempts = Math.max(1, Number(options.attempts || 3) || 3);
  const delayMs = Math.max(0, Number(options.delayMs || 150) || 150);
  const maxDelayMs = Math.max(delayMs, Number(options.maxDelayMs || 750) || 750);
  let lastOrder = null;
  let lastStatus = 'pending';
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastOrder = await executionAdapter.getOrder(orderId);
      lastError = null;
    } catch (error) {
      lastError = error;
      lastOrder = null;
    }
    if (!lastOrder) {
      if (attempt < attempts - 1) {
        await sleep(Math.min(maxDelayMs, delayMs * (attempt + 1)));
        continue;
      }
      break;
    }
    lastStatus = normalizeOrderStatus(lastOrder);
    if (['filled', 'partially_filled', 'reconciled'].includes(lastStatus)) {
      return {
        confirmed: true,
        terminal: true,
        confirmation_status: lastStatus,
        order: lastOrder,
        attempts: attempt + 1,
      };
    }
    if (['rejected', 'cancelled', 'canceled', 'expired', 'failed'].includes(lastStatus)) {
      return {
        confirmed: false,
        terminal: true,
        confirmation_status: lastStatus,
        order: lastOrder,
        attempts: attempt + 1,
      };
    }
    if (attempt < attempts - 1) {
      await sleep(Math.min(maxDelayMs, delayMs * (attempt + 1)));
    }
  }

  return {
    confirmed: false,
    terminal: false,
    confirmation_status: lastStatus || 'pending',
    order: lastOrder,
    attempts,
    error: lastError ? lastError.message : null,
  };
}

function buildPaperResultFromOrder({ signal, paperOrderRequest, paperOrder, confirmation }) {
  const order = confirmation?.order || paperOrder || {};
  const status = normalizeOrderStatus(order) || normalizeOrderStatus(paperOrder) || confirmation?.confirmation_status || 'unknown';
  const filledAt = order.fill?.at
    || order.filled_at
    || order.external_order?.filled_at
    || order.updated_at
    || signal.created_at
    || nowIso();
  const averageFillPrice = safeNumber(
    order.fill?.average_fill_price
      ?? order.average_fill_price
      ?? order.external_order?.filled_avg_price
      ?? order.external_order?.avg_fill_price
      ?? order.limit_price
      ?? paperOrderRequest.entry_price
      ?? paperOrderRequest.limit_price
      ?? signal.entry_price
      ?? signal.price,
    null,
  );
  const filledQuantity = safeNumber(
    order.fill?.filled_quantity
      ?? order.filled_quantity
      ?? order.qty
      ?? order.quantity
      ?? paperOrderRequest.quantity
      ?? 0,
    0,
  );

  return {
    order_id: order.order_id || paperOrder.order_id || paperOrderRequest.request_id || signal.signal_id || null,
    status,
    filled_at: filledAt,
    average_fill_price: Number.isFinite(averageFillPrice) ? averageFillPrice : null,
    filled_quantity: Number.isFinite(filledQuantity) ? filledQuantity : null,
    estimated_fees: safeNumber(order.fill?.estimated_fees ?? order.estimated_fees ?? 0, 0),
    original_signal: signal,
    paper_order_request: paperOrderRequest,
  };
}

function recordPaperOutcome(performance, signal, paperResult, exitSnapshot = null) {
  if (!performance) return null;

  const exit = exitSnapshot || {};
  const sellSide = String(signal.side || signal.direction || '').trim().toLowerCase() === 'sell'
    || String(signal.direction || '').trim().toLowerCase() === 'bearish';
  const costBasis = safeNumber(signal.position_avg_entry_price ?? signal.position_entry_price ?? signal.avg_entry_price ?? null, null);
  const entryPrice = sellSide && Number.isFinite(costBasis)
    ? costBasis
    : safeNumber(paperResult.average_fill_price ?? signal.entry_price ?? signal.price, null);
  const exitPrice = sellSide
    ? safeNumber(paperResult.average_fill_price ?? signal.entry_price ?? signal.price, null)
    : exit.exit_price ?? null;
  const outcome = computePaperOutcome({
    original_signal: signal,
    paper_result: paperResult,
    entry_price: entryPrice,
    exit_price: exitPrice,
    high_price: exit.high_price ?? null,
    low_price: exit.low_price ?? null,
    quantity: exit.quantity ?? paperResult.filled_quantity ?? signal.quantity ?? 0,
    side: sellSide ? 'sell' : 'buy',
    position_exit: sellSide,
    false_positive: exit.false_positive,
  });

  if (typeof performance.recordPaperOutcome === 'function') {
    return performance.recordPaperOutcome({
      ...outcome,
      signal_id: signal.signal_id || null,
      symbol: signal.symbol || null,
      recorded_at: paperResult.filled_at || nowIso(),
    });
  }

  if (typeof performance.recordEvent === 'function') {
    return performance.recordEvent({
      event_type: 'paper_outcome_recorded',
      payload: outcome,
      source: 'server',
    });
  }

  return outcome;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  buildPaperResultFromOrder,
  confirmBrokerOrder,
  detectOpenOrderConflict,
  processMarketInput,
  processTradingSignal,
  recordPaperOutcome,
};
