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
  const allowScaleIn = Boolean(paperOrderRequest.allow_scale_in || paperOrderRequest.allowScaleIn);
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
    return orderSymbol === symbol
      && ((oppositeSide && orderSide === oppositeSide) || (!allowScaleIn && orderSide === desiredSide))
      && openOrderStatuses.has(orderStatus);
  });

  if (conflictingOpenOrders.length > 0) {
    const hasSameSideConflict = conflictingOpenOrders.some((order) => String(order.side || '').trim().toLowerCase() === desiredSide);
    const hasOppositeSideConflict = conflictingOpenOrders.some((order) => String(order.side || '').trim().toLowerCase() === oppositeSide);
    return {
      pass: false,
      reason_codes: [
        'OPEN_ORDER_CONFLICT',
        ...(hasSameSideConflict ? ['SAME_SIDE_OPEN_ORDER_BLOCKED'] : []),
        ...(hasOppositeSideConflict ? ['WASH_TRADE_RISK'] : []),
      ],
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
  const paperOrder = await submitOrderWithWholeShareFallback(paperOrderRequest, signal, options);
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

async function submitOrderWithWholeShareFallback(paperOrderRequest, signal, options = {}) {
  const adapter = options.executionAdapter;
  const submitOptions = {
    market: options.reconciledMarketContext,
    requireHumanApproval: options.policy?.requireHumanApproval,
  };
  const preflightRequest = await maybeSelectWholeShareFromAssetMetadata(paperOrderRequest, signal, options);
  if (preflightRequest !== paperOrderRequest) {
    return await submitFallbackRequest(adapter, preflightRequest, submitOptions, {
      reason_codes: ['WHOLE_SHARE_FALLBACK_SELECTED', 'WHOLE_SHARE_FALLBACK_SUBMITTED'],
      source: 'asset_metadata',
    });
  }

  try {
    return await adapter.submitOrder(paperOrderRequest, submitOptions);
  } catch (error) {
    if (!isRecoverableFractionalShareError(error) || !isBuyStockOrder(paperOrderRequest)) {
      throw error;
    }
    const existingOriginal = await findExistingOrder(adapter, paperOrderRequest);
    if (existingOriginal) {
      return {
        order_id: existingOriginal.id || existingOriginal.order_id || paperOrderRequest.request_id || paperOrderRequest.signal_id || null,
        status: existingOriginal.status || 'accepted',
        external_order: existingOriginal,
        request: paperOrderRequest,
        whole_share_fallback: {
          attempted: false,
          reason_codes: ['FRACTIONAL_ORDER_NOT_SUPPORTED', 'WHOLE_SHARE_FALLBACK_DUPLICATE_PREVENTED'],
          original_rejection: error.message,
        },
      };
    }
    const fallbackRequest = buildWholeShareFallbackRequest(paperOrderRequest, signal, options, {
      originalError: error,
    });
    await validateWholeShareFallback(fallbackRequest, paperOrderRequest, signal, options);
    return await submitFallbackRequest(adapter, fallbackRequest, submitOptions, {
      reason_codes: ['FRACTIONAL_ORDER_NOT_SUPPORTED', 'WHOLE_SHARE_FALLBACK_SELECTED', 'WHOLE_SHARE_FALLBACK_SUBMITTED'],
      source: 'broker_rejection',
      original_rejection: error.message,
    });
  }
}

async function maybeSelectWholeShareFromAssetMetadata(paperOrderRequest, signal, options = {}) {
  const adapter = options.executionAdapter;
  if (!isBuyStockOrder(paperOrderRequest)) return paperOrderRequest;
  if (!isFractionalRequest(paperOrderRequest)) return paperOrderRequest;
  if (!adapter || typeof adapter.getAsset !== 'function') return paperOrderRequest;
  try {
    const asset = await adapter.getAsset(paperOrderRequest.symbol);
    if (asset && asset.fractionable === false) {
      const fallbackRequest = buildWholeShareFallbackRequest(paperOrderRequest, signal, options, {
        originalError: null,
      });
      await validateWholeShareFallback(fallbackRequest, paperOrderRequest, signal, options);
      fallbackRequest.whole_share_fallback = {
        ...(fallbackRequest.whole_share_fallback || {}),
        reason_codes: ['WHOLE_SHARE_FALLBACK_SELECTED'],
        source: 'asset_metadata',
      };
      return fallbackRequest;
    }
  } catch {
    // Metadata is a preference, not a dependency; rejection fallback still protects the path.
  }
  return paperOrderRequest;
}

function buildWholeShareFallbackRequest(paperOrderRequest, signal, options = {}, context = {}) {
  const approvedNotional = resolveApprovedNotional(paperOrderRequest, signal);
  const validatedPrice = resolveValidatedPrice(paperOrderRequest, signal, options);
  const originalQuantity = safeNumber(paperOrderRequest.quantity, null);
  const wholeShareQuantity = Number.isFinite(approvedNotional) && Number.isFinite(validatedPrice) && validatedPrice > 0
    ? Math.floor(approvedNotional / validatedPrice)
    : 0;
  if (wholeShareQuantity < 1) {
    const error = new Error('Whole-share fallback cannot buy at least one share within the approved notional.');
    error.code = 'WHOLE_SHARE_FALLBACK_BELOW_ONE_SHARE';
    error.reason_codes = ['WHOLE_SHARE_FALLBACK_BELOW_ONE_SHARE'];
    error.fallback = {
      symbol: paperOrderRequest.symbol,
      approved_notional: approvedNotional,
      validated_price: validatedPrice,
      original_fractional_quantity: originalQuantity,
      calculated_whole_share_quantity: wholeShareQuantity,
      estimated_whole_share_notional: 0,
      original_broker_rejection: context.originalError?.message || null,
    };
    throw error;
  }
  const estimatedNotional = wholeShareQuantity * validatedPrice;
  return {
    ...paperOrderRequest,
    quantity: wholeShareQuantity,
    notional: null,
    supports_fractional_shares: false,
    request_id: appendWholeShareSuffix(paperOrderRequest.request_id || paperOrderRequest.signal_id || signal.signal_id),
    client_order_id: appendWholeShareSuffix(paperOrderRequest.client_order_id || paperOrderRequest.idempotency_key || null),
    idempotency_key: appendWholeShareSuffix(paperOrderRequest.idempotency_key || null),
    whole_share_fallback: {
      symbol: paperOrderRequest.symbol,
      approved_notional: roundCurrency(approvedNotional),
      validated_price: validatedPrice,
      original_fractional_quantity: originalQuantity,
      calculated_whole_share_quantity: wholeShareQuantity,
      estimated_whole_share_notional: roundCurrency(estimatedNotional),
      original_broker_rejection: context.originalError?.message || null,
      reason_codes: ['WHOLE_SHARE_FALLBACK_SELECTED'],
    },
  };
}

async function validateWholeShareFallback(fallbackRequest, originalRequest, signal, options = {}) {
  if (typeof options.validateWholeShareFallback === 'function') {
    const result = await options.validateWholeShareFallback(fallbackRequest, {
      originalRequest,
      signal,
      market: options.reconciledMarketContext,
    });
    if (result === false || result?.pass === false || result?.accepted === false) {
      const error = new Error(result?.message || 'Whole-share fallback was blocked by safety validation.');
      error.code = 'WHOLE_SHARE_FALLBACK_RISK_BLOCKED';
      error.reason_codes = ['WHOLE_SHARE_FALLBACK_RISK_BLOCKED', ...(result?.reason_codes || [])];
      error.fallback = fallbackRequest.whole_share_fallback || null;
      throw error;
    }
  }
  return true;
}

async function submitFallbackRequest(adapter, fallbackRequest, submitOptions, fallbackMetadata = {}) {
  const existingFallback = await findExistingOrder(adapter, fallbackRequest);
  if (existingFallback) {
    return {
      order_id: existingFallback.id || existingFallback.order_id || fallbackRequest.request_id || fallbackRequest.signal_id || null,
      status: existingFallback.status || 'accepted',
      external_order: existingFallback,
      request: fallbackRequest,
      whole_share_fallback: {
        ...(fallbackRequest.whole_share_fallback || {}),
        ...fallbackMetadata,
        reason_codes: mergeCodes(
          fallbackRequest.whole_share_fallback?.reason_codes,
          fallbackMetadata.reason_codes,
          ['WHOLE_SHARE_FALLBACK_DUPLICATE_PREVENTED'],
        ),
      },
    };
  }
  try {
    const result = await adapter.submitOrder(fallbackRequest, submitOptions);
    return {
      ...result,
      request: fallbackRequest,
      whole_share_fallback: {
        ...(fallbackRequest.whole_share_fallback || {}),
        ...fallbackMetadata,
        reason_codes: mergeCodes(
          fallbackRequest.whole_share_fallback?.reason_codes,
          fallbackMetadata.reason_codes,
          ['WHOLE_SHARE_FALLBACK_ACCEPTED'],
        ),
      },
    };
  } catch (error) {
    error.code = error.code || 'WHOLE_SHARE_FALLBACK_REJECTED';
    error.reason_codes = mergeCodes(error.reason_codes, ['WHOLE_SHARE_FALLBACK_REJECTED']);
    error.fallback = {
      ...(fallbackRequest.whole_share_fallback || {}),
      ...fallbackMetadata,
    };
    throw error;
  }
}

async function findExistingOrder(adapter, request) {
  if (!adapter || typeof adapter.findExistingOrderForRequest !== 'function') return null;
  try {
    return await adapter.findExistingOrderForRequest(request);
  } catch {
    return null;
  }
}

function isRecoverableFractionalShareError(error) {
  const text = String(error?.message || error?.response?.message || error?.response?.error || '').toLowerCase();
  if (!text) return false;
  if (/(insufficient|buying power|not tradable|non-tradable|halted|suspended|market closed|wash trade)/.test(text)) return false;
  return /(fraction|fractionable|whole number|whole share|qty must be integer|quantity must be integer|time[_ -]?in[_ -]?force.*fraction)/.test(text);
}

function isBuyStockOrder(request = {}) {
  const side = String(request.side || '').toLowerCase();
  const assetType = String(request.asset_type || request.assetType || 'stock').toLowerCase();
  const symbol = String(request.symbol || '');
  return side === 'buy' && assetType !== 'crypto' && !symbol.includes('/');
}

function isFractionalRequest(request = {}) {
  const quantity = safeNumber(request.quantity, null);
  const notional = safeNumber(request.notional, null);
  return (Number.isFinite(quantity) && quantity > 0 && !Number.isInteger(quantity))
    || (Number.isFinite(notional) && notional > 0 && !Number.isFinite(quantity));
}

function resolveApprovedNotional(request = {}, signal = {}) {
  const quantity = safeNumber(request.quantity, null);
  const price = resolveValidatedPrice(request, signal, {});
  return safeNumber(
    request.approved_notional
      ?? request.approvedNotional
      ?? request.submitted_notional
      ?? request.notional
      ?? signal.approved_notional
      ?? signal.submitted_notional
      ?? signal.notional
      ?? (Number.isFinite(quantity) && Number.isFinite(price) ? quantity * price : null),
    null,
  );
}

function resolveValidatedPrice(request = {}, signal = {}, options = {}) {
  return safeNumber(
    options.reconciledMarketContext?.price
      ?? options.reconciledMarketContext?.current_price
      ?? request.current_price
      ?? request.entry_price
      ?? request.limit_price
      ?? signal.current_price
      ?? signal.entry_price
      ?? signal.price,
    null,
  );
}

function appendWholeShareSuffix(value) {
  const id = String(value || '').trim();
  if (!id) return id;
  return id.endsWith('-whole') ? id : `${id}-whole`;
}

function mergeCodes(...groups) {
  return [...new Set(groups.flatMap((group) => Array.isArray(group) ? group : []).filter(Boolean))];
}

function roundCurrency(value) {
  const numeric = safeNumber(value, 0);
  return Math.round(numeric * 10000) / 10000;
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
  isRecoverableFractionalShareError,
  submitOrderWithWholeShareFallback,
  sleep,
};
