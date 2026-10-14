const { safeNumber } = require('./util');

function normalizeBrokerSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes('/')) return raw;
  if (raw.endsWith('USDT')) return `${raw.slice(0, -4)}/USDT`;
  if (raw.endsWith('USD') && raw.length > 3) return `${raw.slice(0, -3)}/USD`;
  return raw;
}

function buildPortfolioSnapshot({ positions = [], openOrders = [], account = null, maxOpenPositions = null, partialFillSummary = null } = {}) {
  const livePositions = Array.isArray(positions) ? positions.filter((position) => {
    const qty = safeNumber(position.qty ?? position.quantity ?? position.qty_available, 0);
    return Number.isFinite(qty) && Math.abs(qty) > 0;
  }) : [];
  const liveOpenOrders = Array.isArray(openOrders) ? openOrders : [];
  const openBuyOrders = liveOpenOrders.filter((order) => String(order.side || '').toLowerCase() === 'buy');
  const partialBuyCount = Array.isArray(partialFillSummary?.partial_buys) ? partialFillSummary.partial_buys.length : 0;
  const partialReservedBuyNotional = safeNumber(partialFillSummary?.reserved_buy_notional, 0);
  const cap = safeNumber(maxOpenPositions, null);
  const occupiedSlots = livePositions.length + openBuyOrders.length + partialBuyCount;
  const remainingSlots = Number.isFinite(cap) ? Math.max(0, cap - occupiedSlots) : null;
  return {
    available: true,
    source: 'alpaca-live',
    account,
    cash: safeNumber(account?.cash, null),
    buying_power: safeNumber(account?.buying_power, null),
    open_positions_count: livePositions.length,
    open_position_count: livePositions.length,
    open_order_count: liveOpenOrders.length,
    open_buy_order_count: openBuyOrders.length,
    partial_buy_order_count: partialBuyCount,
    partial_reserved_buy_notional: partialReservedBuyNotional,
    max_open_positions: Number.isFinite(cap) ? cap : null,
    remaining_position_slots: remainingSlots,
    occupied_position_slots: occupiedSlots,
    positions: livePositions,
    open_orders: liveOpenOrders,
    symbols_held: livePositions.map((position) => normalizeBrokerSymbol(position.symbol)).filter(Boolean),
    symbols_with_open_buy_orders: [
      ...openBuyOrders.map((order) => normalizeBrokerSymbol(order.symbol)).filter(Boolean),
      ...(partialFillSummary?.blocked_symbols || []).map(normalizeBrokerSymbol).filter(Boolean),
    ],
  };
}

function allocateBuyNotional({
  targetNotional,
  minBuyNotional = 25,
  portfolio = {},
  requireBrokerCash = false,
  dynamicSizing = false,
  maxBuyNotional = null,
} = {}) {
  const cashBufferFactor = 0.99;
  const isDynamic = Boolean(
    dynamicSizing
    || targetNotional === null
    || targetNotional === 'dynamic'
    || (portfolio && portfolio.dynamicSizing)
    || (typeof process !== 'undefined' && process.env && (process.env.DYNAMIC_BUY_SIZING_ENABLED === 'true' || process.env.DYNAMIC_BUY_SIZING_ENABLED === '1')),
  );
  const requested = Math.max(1, safeNumber(targetNotional, 150));
  const floor = Math.max(1, safeNumber(minBuyNotional, 25));
  const remainingSlots = safeNumber(portfolio.remaining_position_slots, null);
  if (Number.isFinite(remainingSlots) && remainingSlots <= 0) {
    return {
      accepted: false,
      reason: 'MAX_POSITION_SLOTS_FILLED',
      requested: isDynamic ? 0 : requested,
      notional: 0,
      floor,
      remaining_slots: 0,
      slot_budget: 0,
      cash_source: null,
      dynamic_sizing: isDynamic,
    };
  }
  const cashCandidates = [portfolio.buying_power, portfolio.cash]
    .map((value) => safeNumber(value, null))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!cashCandidates.length) {
    if (requireBrokerCash) {
      return {
        accepted: false,
        reason: 'BUYING_POWER_UNAVAILABLE',
        requested: isDynamic ? 0 : requested,
        notional: 0,
        floor,
        remaining_slots: remainingSlots,
        slot_budget: 0,
        cash_source: null,
        dynamic_sizing: isDynamic,
      };
    }
    return {
      accepted: true,
      reason: null,
      requested,
      notional: requested,
      floor,
      remaining_slots: remainingSlots,
      slot_budget: requested,
      cash_source: 'unavailable_fallback',
      dynamic_sizing: isDynamic,
    };
  }
  const cash = safeNumber(portfolio.cash, null);
  const buyingPower = safeNumber(portfolio.buying_power, null);
  const reservedNotional = Math.max(0, safeNumber(portfolio.partial_reserved_buy_notional, 0));
  const limitingCash = Math.max(0, Math.min(...cashCandidates) - reservedNotional);
  if (reservedNotional > 0 && limitingCash < floor) {
    return {
      accepted: false,
      reason: 'PARTIAL_FILL_RESERVES_BUYING_POWER',
      reason_codes: ['OPEN_ORDER_RESERVES_BUYING_POWER', 'PARTIAL_FILL_RESERVES_BUYING_POWER', 'BUYING_POWER_REDUCED_BY_OPEN_ORDERS'],
      requested: isDynamic ? 0 : requested,
      notional: 0,
      floor,
      remaining_slots: remainingSlots,
      reserved_notional: reservedNotional,
      slot_budget: 0,
      cash_source: null,
      dynamic_sizing: isDynamic,
    };
  }
  const cashSource = Number.isFinite(cash) && Number.isFinite(buyingPower)
    ? (cash <= buyingPower ? 'cash' : 'buying_power')
    : (Number.isFinite(cash) ? 'cash' : 'buying_power');
  const spendableCash = limitingCash * cashBufferFactor;
  const slotBudget = Number.isFinite(remainingSlots) && remainingSlots > 0
    ? spendableCash / remainingSlots
    : spendableCash;
  const roundedSlotBudget = Math.floor(slotBudget * 100) / 100;
  const ceiling = safeNumber(maxBuyNotional, null);
  const cappedSlotBudget = Number.isFinite(ceiling) && ceiling > 0
    ? Math.min(ceiling, roundedSlotBudget)
    : roundedSlotBudget;
  const notional = isDynamic ? cappedSlotBudget : Math.min(requested, roundedSlotBudget);
  const effectiveRequested = isDynamic ? cappedSlotBudget : requested;
  if (notional < floor) {
    return {
      accepted: false,
      reason: 'CASH_TOO_LOW_FOR_TARGET_SIZE',
      requested: effectiveRequested,
      notional,
      floor,
      remaining_slots: remainingSlots,
      spendable_cash: spendableCash,
      slot_budget: roundedSlotBudget,
      cash_source: cashSource,
      dynamic_sizing: isDynamic,
    };
  }
  return {
    accepted: true,
    reason: null,
    requested: effectiveRequested,
    notional,
    floor,
    remaining_slots: remainingSlots,
    spendable_cash: spendableCash,
    reserved_notional: reservedNotional,
    reason_codes: reservedNotional > 0
      ? ['OPEN_ORDER_RESERVES_BUYING_POWER', 'PARTIAL_FILL_RESERVES_BUYING_POWER', 'BUYING_POWER_REDUCED_BY_OPEN_ORDERS']
      : [],
    slot_budget: roundedSlotBudget,
    cash_source: cashSource,
    dynamic_sizing: isDynamic,
  };
}

module.exports = {
  allocateBuyNotional,
  buildPortfolioSnapshot,
  normalizeBrokerSymbol,
};
