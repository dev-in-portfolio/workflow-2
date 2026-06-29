const { assertExecutionResult } = require('../module-contracts');
const {
  loadPartialFillState,
  savePartialFillState,
  summarizePartialFillState,
  updatePartialFillStateFromOrder,
} = require('../partial-fill-state');
const { nowIso, safeNumber, resolveRepoRoot } = require('../util');
const { normalizeOrderStatus } = require('./signal-processor');

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
      ?? order.filled_qty
      ?? order.external_order?.filled_qty
      ?? order.external_order?.filled_quantity
      ?? order.qty
      ?? order.quantity
      ?? paperOrderRequest.quantity
      ?? 0,
    0,
  );
  const submittedQuantity = safeNumber(order.qty ?? order.quantity ?? paperOrderRequest.quantity ?? null, null);
  const remainingQuantity = safeNumber(
    order.remaining_qty
      ?? order.leaves_qty
      ?? order.external_order?.leaves_qty
      ?? order.external_order?.remaining_qty
      ?? (Number.isFinite(submittedQuantity) ? Math.max(0, submittedQuantity - filledQuantity) : null),
    null,
  );

  return {
    order_id: order.order_id || paperOrder.order_id || paperOrderRequest.request_id || signal.signal_id || null,
    status,
    filled_at: filledAt,
    average_fill_price: Number.isFinite(averageFillPrice) ? averageFillPrice : null,
    filled_quantity: Number.isFinite(filledQuantity) ? filledQuantity : null,
    submitted_quantity: Number.isFinite(submittedQuantity) ? submittedQuantity : null,
    remaining_quantity: Number.isFinite(remainingQuantity) ? remainingQuantity : null,
    estimated_fees: safeNumber(order.fill?.estimated_fees ?? order.estimated_fees ?? 0, 0),
    original_signal: signal,
    paper_order_request: paperOrderRequest,
  };
}

function buildPartialFillMetadata(paperResult = {}) {
  const submitted = safeNumber(paperResult.submitted_quantity, null);
  const filled = safeNumber(paperResult.filled_quantity, null);
  const remaining = safeNumber(paperResult.remaining_quantity, null);
  const fillPct = Number.isFinite(submitted) && submitted > 0 && Number.isFinite(filled)
    ? filled / submitted
    : null;
  return {
    status: paperResult.status || null,
    submitted_quantity: submitted,
    filled_quantity: filled,
    remaining_quantity: remaining,
    fill_percentage: Number.isFinite(fillPct) ? fillPct : null,
    state_summary: paperResult.partial_fill_state || null,
  };
}

async function executeOrder(paperOrderRequest, signal, options = {}) {
  const paperOrder = await options.executionAdapter.submitOrder(paperOrderRequest, {
    market: options.reconciledMarketContext,
    requireHumanApproval: options.policy?.requireHumanApproval,
  });
  assertExecutionResult(paperOrder);

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

  let partialFillState = options.partialFillState || loadPartialFillState({ env: options.env || process.env, repoRoot: options.repoRoot || resolveRepoRoot() });
  partialFillState = updatePartialFillStateFromOrder(partialFillState, {
    ...paperOrder,
    ...(confirmation?.order || {}),
    status: paperResult.status,
    filled_quantity: paperResult.filled_quantity,
    average_fill_price: paperResult.average_fill_price,
    remaining_qty: paperResult.remaining_quantity,
    symbol: paperOrderRequest.symbol,
    side: paperOrderRequest.side,
  }, {
    request: paperOrderRequest,
    now: paperResult.filled_at || nowIso(),
  });
  const updatedPartialFillSummary = summarizePartialFillState(partialFillState);
  if (options.savePartialFillState !== false) {
    savePartialFillState(partialFillState, { env: options.env || process.env, repoRoot: options.repoRoot || resolveRepoRoot() });
  }
  paperResult.partial_fill_state = updatedPartialFillSummary;

  return {
    paperOrder,
    confirmation,
    paperResult,
    updatedPartialFillSummary,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  buildPaperResultFromOrder,
  buildPartialFillMetadata,
  confirmBrokerOrder,
  detectOpenOrderConflict,
  executeOrder,
  sleep,
};
