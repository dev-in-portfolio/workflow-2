const path = require('path');
const { nowIso, safeNumber, resolveRepoRoot } = require('./util');
const { JsonFileStore } = require('./storage');

const PartialFillReason = {
  PARTIAL_FILL_PENDING: 'PARTIAL_FILL_PENDING',
  PARTIAL_FILL_RECONCILIATION_REQUIRED: 'PARTIAL_FILL_RECONCILIATION_REQUIRED',
  PARTIAL_BUY_OPEN_RESIDUAL: 'PARTIAL_BUY_OPEN_RESIDUAL',
  PARTIAL_SELL_REMAINING_EXPOSURE: 'PARTIAL_SELL_REMAINING_EXPOSURE',
  PARTIAL_ORDER_STALE: 'PARTIAL_ORDER_STALE',
  PARTIAL_ORDER_FILLED: 'PARTIAL_ORDER_FILLED',
  PARTIAL_ORDER_CANCELED: 'PARTIAL_ORDER_CANCELED',
  PARTIAL_ORDER_REJECTED: 'PARTIAL_ORDER_REJECTED',
  PARTIAL_STATE_MISMATCH: 'PARTIAL_STATE_MISMATCH',
};

function defaultPartialFillStatePath({ env = process.env, repoRoot = resolveRepoRoot() } = {}) {
  return env.PARTIAL_FILL_STATE_PATH || path.join(repoRoot, 'data', 'state', 'partial-fill-state.json');
}

function loadPartialFillState(filePathOrOptions = {}) {
  const filePath = typeof filePathOrOptions === 'string'
    ? filePathOrOptions
    : defaultPartialFillStatePath(filePathOrOptions);
  const store = new JsonFileStore(path.dirname(filePath));
  const name = path.basename(filePath);
  try {
    const data = store.read(name);
    return data ? normalizeState(data) : normalizeState({});
  } catch {
    return normalizeState({});
  }
}

function savePartialFillState(state, filePathOrOptions = {}) {
  const filePath = typeof filePathOrOptions === 'string'
    ? filePathOrOptions
    : defaultPartialFillStatePath(filePathOrOptions);
  const store = new JsonFileStore(path.dirname(filePath));
  const payload = normalizeState(state);
  payload.updated_at = nowIso();
  store.write(path.basename(filePath), payload);
  return payload;
}

function updatePartialFillStateFromOrder(state, order, options = {}) {
  const now = options.now || nowIso();
  const next = normalizeState(state);
  const normalized = normalizeOrder(order, options.request);
  if (!normalized.order_id && !normalized.client_order_id) return next;
  const key = normalized.order_id || normalized.client_order_id;
  const previous = next.orders[key] || {};
  const submittedQty = firstFinite(normalized.submitted_qty, previous.submitted_qty, 0);
  const filledQty = firstFinite(normalized.filled_qty, previous.filled_qty, 0);
  const remainingQty = firstFinite(
    normalized.remaining_qty,
    Number.isFinite(submittedQty) ? Math.max(0, submittedQty - filledQty) : previous.remaining_qty,
    0,
  );
  const submittedNotional = firstFinite(normalized.submitted_notional, previous.submitted_notional, 0);
  const filledNotional = firstFinite(
    normalized.filled_notional,
    Number.isFinite(normalized.average_fill_price) && Number.isFinite(filledQty) ? normalized.average_fill_price * filledQty : previous.filled_notional,
    0,
  );
  const record = {
    order_id: normalized.order_id || previous.order_id || null,
    client_order_id: normalized.client_order_id || previous.client_order_id || null,
    symbol: normalized.symbol || previous.symbol || null,
    side: normalized.side || previous.side || null,
    submitted_qty: roundQty(submittedQty),
    filled_qty: roundQty(filledQty),
    remaining_qty: roundQty(remainingQty),
    submitted_notional: roundCurrency(submittedNotional),
    filled_notional: roundCurrency(filledNotional),
    average_fill_price: Number.isFinite(normalized.average_fill_price) ? normalized.average_fill_price : previous.average_fill_price ?? null,
    status: normalized.status || previous.status || 'unknown',
    first_seen_at: previous.first_seen_at || now,
    last_seen_at: now,
    last_reconciled_at: options.reconciled ? now : previous.last_reconciled_at || null,
    action_required: false,
    recommended_action: null,
    stale: false,
    warnings: [],
    reason_codes: [],
    history: [
      ...(Array.isArray(previous.history) ? previous.history : []),
      {
        at: now,
        status: normalized.status || previous.status || 'unknown',
        filled_qty: roundQty(filledQty),
        remaining_qty: roundQty(remainingQty),
      },
    ].slice(-20),
  };
  classifyPartialRecord(record, { now, staleMinutes: options.staleMinutes });
  next.orders[key] = record;
  next.updated_at = now;
  return next;
}

async function reconcilePartialFills({
  executionAdapter = null,
  previousState = {},
  openOrders = null,
  positions = null,
  now = nowIso(),
  options = {},
} = {}) {
  const state = normalizeState(previousState);
  const brokerOpenOrders = Array.isArray(openOrders)
    ? openOrders
    : executionAdapter?.getOpenOrders
      ? await executionAdapter.getOpenOrders()
      : [];
  const brokerPositions = Array.isArray(positions)
    ? positions
    : executionAdapter?.getPositions
      ? await executionAdapter.getPositions()
      : [];
  let next = state;
  for (const order of brokerOpenOrders) {
    next = updatePartialFillStateFromOrder(next, order, { now, reconciled: true, staleMinutes: options.staleMinutes });
  }
  for (const [key, record] of Object.entries(next.orders)) {
    const foundOpen = brokerOpenOrders.some((order) => orderMatchesRecord(order, record));
    const status = String(record.status || '').toLowerCase();
    if (!foundOpen && isActivePartialStatus(status)) {
      const detailedOrder = await fetchKnownOrder(executionAdapter, record);
      if (detailedOrder) {
        next = updatePartialFillStateFromOrder(next, detailedOrder, { now, reconciled: true, staleMinutes: options.staleMinutes });
      } else if (options.authoritativeOpenOrders && Array.isArray(openOrders)) {
        next.orders[key] = {
          ...record,
          status: 'canceled',
          remaining_qty: 0,
          last_reconciled_at: now,
          action_required: false,
          recommended_action: null,
          stale: false,
          reason_codes: mergeCodes(record.reason_codes, [PartialFillReason.PARTIAL_ORDER_CANCELED]),
          warnings: [],
        };
      } else {
        next.orders[key] = {
          ...record,
          last_reconciled_at: now,
          action_required: true,
          recommended_action: 'Verify partial order status at Alpaca.',
          reason_codes: mergeCodes(record.reason_codes, [PartialFillReason.PARTIAL_FILL_RECONCILIATION_REQUIRED]),
        };
      }
    }
  }
  for (const [key, record] of Object.entries(next.orders)) {
    const position = brokerPositions.find((item) => normalizeSymbol(item.symbol) === record.symbol);
    const positionQty = Math.abs(safeNumber(position?.qty ?? position?.quantity ?? position?.qty_available, 0));
    const side = String(record.side || '').toLowerCase();
    const codes = [];
    if (side === 'buy' && record.filled_qty > 0 && record.remaining_qty > 0) codes.push(PartialFillReason.PARTIAL_BUY_OPEN_RESIDUAL);
    if (side === 'sell' && record.remaining_qty > 0 && positionQty > 0) codes.push(PartialFillReason.PARTIAL_SELL_REMAINING_EXPOSURE);
    if (record.filled_qty > 0 && position && positionQty + 1e-6 < record.filled_qty && side === 'buy') codes.push(PartialFillReason.PARTIAL_STATE_MISMATCH);
    next.orders[key] = {
      ...record,
      reason_codes: mergeCodes(record.reason_codes, codes),
      action_required: record.action_required || codes.includes(PartialFillReason.PARTIAL_STATE_MISMATCH),
      recommended_action: record.recommended_action || (codes.length ? 'Review partial-fill exposure before submitting another order.' : null),
    };
  }
  next.updated_at = now;
  next.last_reconciled_at = now;
  return next;
}

async function reconcilePartialFillState(options = {}) {
  const filePath = options.filePath || defaultPartialFillStatePath(options);
  const previousState = options.previousState || loadPartialFillState(filePath);
  const state = await reconcilePartialFills({ ...options, previousState });
  if (options.writeLatest !== false) savePartialFillState(state, filePath);
  return state;
}

function summarizePartialFillState(state = {}) {
  const normalized = normalizeState(state);
  const orders = Object.values(normalized.orders);
  const active = orders.filter((order) => isActivePartialStatus(order.status) || (order.remaining_qty > 0 && !isTerminalPartialStatus(order.status)));
  const partialBuys = active.filter((order) => order.side === 'buy');
  const partialSells = active.filter((order) => order.side === 'sell');
  const stale = active.filter((order) => order.stale);
  const blockedSymbols = [...new Set(partialBuys.map((order) => order.symbol).filter(Boolean))];
  const warnings = [...new Set(active.flatMap((order) => [...(order.warnings || []), ...(order.reason_codes || [])]))];
  const recommendedActions = [...new Set(active.map((order) => order.recommended_action).filter(Boolean))];
  const reservedNotional = partialBuys.reduce((sum, order) => sum + remainingNotional(order), 0);
  const repeatedSymbols = [...orders.reduce((map, order) => {
    if (!order.symbol) return map;
    map.set(order.symbol, (map.get(order.symbol) || 0) + 1);
    return map;
  }, new Map()).entries()].filter(([, count]) => count > 1).map(([symbol, count]) => ({ symbol, count }));
  const totalSubmitted = orders.reduce((sum, order) => sum + safeNumber(order.submitted_qty, 0), 0);
  const totalFilled = orders.reduce((sum, order) => sum + safeNumber(order.filled_qty, 0), 0);
  return {
    count: active.length,
    total_count: orders.length,
    partial_buys: partialBuys,
    partial_sells: partialSells,
    stale_partials: stale,
    blocked_symbols: blockedSymbols,
    partial_sell_remaining_exposure: partialSells.filter((order) => order.remaining_qty > 0),
    reserved_buy_notional: roundCurrency(reservedNotional),
    warnings,
    recommended_actions: recommendedActions,
    last_reconciled_at: normalized.last_reconciled_at || null,
    average_fill_percentage: totalSubmitted > 0 ? roundQty(totalFilled / totalSubmitted) : null,
    repeated_partial_fill_symbols: repeatedSymbols,
  };
}

function normalizeState(state = {}) {
  return {
    version: state.version || '2026-06-25.partial-fill-state.1',
    updated_at: state.updated_at || null,
    last_reconciled_at: state.last_reconciled_at || null,
    orders: state.orders && typeof state.orders === 'object' ? state.orders : {},
  };
}

function normalizeOrder(order = {}, request = {}) {
  const external = order.external_order || {};
  const fill = order.fill || {};
  const submittedQty = firstFinite(order.qty, order.quantity, request.quantity, external.qty, null);
  const filledQty = firstFinite(fill.filled_quantity, order.filled_quantity, order.filled_qty, external.filled_qty, external.filled_quantity, 0);
  const status = String(order.status || order.order_status || external.status || '').trim().toLowerCase();
  return {
    order_id: String(order.id || order.order_id || external.id || '').trim() || null,
    client_order_id: String(order.client_order_id || request.request_id || request.signal_id || external.client_order_id || '').trim() || null,
    symbol: normalizeSymbol(order.symbol || request.symbol || external.symbol),
    side: String(order.side || request.side || external.side || '').trim().toLowerCase() || null,
    submitted_qty: submittedQty,
    filled_qty: filledQty,
    remaining_qty: firstFinite(order.remaining_qty, order.leaves_qty, external.leaves_qty, Number.isFinite(submittedQty) ? submittedQty - filledQty : null),
    submitted_notional: firstFinite(order.notional, request.notional, external.notional, null),
    filled_notional: firstFinite(order.filled_notional, null),
    average_fill_price: firstFinite(fill.average_fill_price, order.average_fill_price, order.filled_avg_price, external.filled_avg_price, external.avg_fill_price, null),
    status,
  };
}

function classifyPartialRecord(record, { now = nowIso(), staleMinutes = 30 } = {}) {
  const status = String(record.status || '').toLowerCase();
  const ageMinutes = (new Date(now).getTime() - new Date(record.first_seen_at || now).getTime()) / 60000;
  const stale = isActivePartialStatus(status) && Number.isFinite(ageMinutes) && ageMinutes >= Math.max(1, safeNumber(staleMinutes, 30));
  const codes = [];
  const warnings = [];
  if (isActivePartialStatus(status)) codes.push(PartialFillReason.PARTIAL_FILL_PENDING);
  if (stale) {
    codes.push(PartialFillReason.PARTIAL_ORDER_STALE);
    warnings.push(PartialFillReason.PARTIAL_ORDER_STALE);
  }
  if (status === 'filled') codes.push(PartialFillReason.PARTIAL_ORDER_FILLED);
  if (['cancelled', 'canceled', 'expired'].includes(status)) codes.push(PartialFillReason.PARTIAL_ORDER_CANCELED);
  if (['rejected', 'failed'].includes(status)) codes.push(PartialFillReason.PARTIAL_ORDER_REJECTED);
  record.stale = stale;
  record.reason_codes = mergeCodes(record.reason_codes, codes);
  record.warnings = mergeCodes(record.warnings, warnings);
  record.action_required = record.action_required || stale || ['rejected', 'failed'].includes(status);
  record.recommended_action = record.recommended_action || (stale ? 'Review stale partial order at Alpaca before new entries.' : null);
}

function isActivePartialStatus(status) {
  return ['partially_filled', 'accepted', 'new', 'pending_new'].includes(String(status || '').toLowerCase());
}

function isTerminalPartialStatus(status) {
  return ['filled', 'cancelled', 'canceled', 'expired', 'rejected', 'failed'].includes(String(status || '').toLowerCase());
}

function remainingNotional(order) {
  const avg = safeNumber(order.average_fill_price, null);
  const remainingQty = safeNumber(order.remaining_qty, 0);
  const submittedNotional = safeNumber(order.submitted_notional, null);
  const filledNotional = safeNumber(order.filled_notional, 0);
  if (Number.isFinite(avg) && remainingQty > 0) return avg * remainingQty;
  if (Number.isFinite(submittedNotional)) return Math.max(0, submittedNotional - filledNotional);
  return 0;
}

async function fetchKnownOrder(adapter, record) {
  try {
    if (adapter?.getOrder && record.order_id) return await adapter.getOrder(record.order_id);
    if (adapter?.getOrderByClientOrderId && record.client_order_id) return await adapter.getOrderByClientOrderId(record.client_order_id);
  } catch {
    return null;
  }
  return null;
}

function orderMatchesRecord(order, record) {
  const normalized = normalizeOrder(order);
  return Boolean(
    (record.order_id && normalized.order_id === record.order_id)
    || (record.client_order_id && normalized.client_order_id === record.client_order_id)
    || (record.symbol && normalized.symbol === record.symbol && record.side && normalized.side === record.side),
  );
}

function normalizeSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  return raw;
}

function mergeCodes(existing = [], next = []) {
  return [...new Set([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(next) ? next : [])].filter(Boolean))];
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = safeNumber(value, null);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function roundQty(value) {
  const numeric = safeNumber(value, 0);
  return Math.round(numeric * 1_000_000) / 1_000_000;
}

function roundCurrency(value) {
  const numeric = safeNumber(value, 0);
  return Math.round(numeric * 10000) / 10000;
}

module.exports = {
  PartialFillReason,
  defaultPartialFillStatePath,
  loadPartialFillState,
  reconcilePartialFills,
  reconcilePartialFillState,
  savePartialFillState,
  summarizePartialFillState,
  updatePartialFillStateFromOrder,
};
