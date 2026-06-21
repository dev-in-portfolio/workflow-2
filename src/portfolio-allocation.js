const { safeNumber } = require('./util');

function normalizeBrokerSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes('/')) return raw;
  if (raw.endsWith('USDT')) return `${raw.slice(0, -4)}/USDT`;
  if (raw.endsWith('USD') && raw.length > 3) return `${raw.slice(0, -3)}/USD`;
  return raw;
}

function buildPortfolioSnapshot({ positions = [], openOrders = [], account = null, maxOpenPositions = null } = {}) {
  const livePositions = Array.isArray(positions) ? positions.filter((position) => {
    const qty = safeNumber(position.qty_available ?? position.qty ?? position.quantity, 0);
    return Number.isFinite(qty) && Math.abs(qty) > 0;
  }) : [];
  const liveOpenOrders = Array.isArray(openOrders) ? openOrders : [];
  const openBuyOrders = liveOpenOrders.filter((order) => String(order.side || '').toLowerCase() === 'buy');
  const cap = safeNumber(maxOpenPositions, null);
  const occupiedSlots = livePositions.length + openBuyOrders.length;
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
    max_open_positions: Number.isFinite(cap) ? cap : null,
    remaining_position_slots: remainingSlots,
    occupied_position_slots: occupiedSlots,
    positions: livePositions,
    open_orders: liveOpenOrders,
    symbols_held: livePositions.map((position) => normalizeBrokerSymbol(position.symbol)).filter(Boolean),
    symbols_with_open_buy_orders: openBuyOrders.map((order) => normalizeBrokerSymbol(order.symbol)).filter(Boolean),
  };
}

function allocateBuyNotional({ targetNotional, minBuyNotional = 25, portfolio = {} } = {}) {
  const requested = Math.max(1, safeNumber(targetNotional, 150));
  const floor = Math.max(1, safeNumber(minBuyNotional, 25));
  const remainingSlots = safeNumber(portfolio.remaining_position_slots, null);
  if (Number.isFinite(remainingSlots) && remainingSlots <= 0) {
    return { accepted: false, reason: 'MAX_POSITION_SLOTS_FILLED', requested, notional: 0, floor, remaining_slots: 0, slot_budget: 0, cash_source: null };
  }
  const cashCandidates = [portfolio.buying_power, portfolio.cash]
    .map((value) => safeNumber(value, null))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!cashCandidates.length) {
    return { accepted: true, reason: null, requested, notional: requested, floor, remaining_slots: remainingSlots, slot_budget: requested, cash_source: 'unavailable_fallback' };
  }
  const cash = safeNumber(portfolio.cash, null);
  const buyingPower = safeNumber(portfolio.buying_power, null);
  const limitingCash = Math.min(...cashCandidates);
  const cashSource = Number.isFinite(cash) && Number.isFinite(buyingPower)
    ? (cash <= buyingPower ? 'cash' : 'buying_power')
    : (Number.isFinite(cash) ? 'cash' : 'buying_power');
  const spendableCash = limitingCash * 0.95;
  const slotBudget = Number.isFinite(remainingSlots) && remainingSlots > 0
    ? spendableCash / remainingSlots
    : spendableCash;
  const notional = Math.min(requested, Math.floor(slotBudget * 100) / 100);
  if (notional < floor) {
    return {
      accepted: false,
      reason: 'CASH_TOO_LOW_FOR_TARGET_SIZE',
      requested,
      notional,
      floor,
      remaining_slots: remainingSlots,
      spendable_cash: spendableCash,
      slot_budget: Math.floor(slotBudget * 100) / 100,
      cash_source: cashSource,
    };
  }
  return {
    accepted: true,
    reason: null,
    requested,
    notional,
    floor,
    remaining_slots: remainingSlots,
    spendable_cash: spendableCash,
    slot_budget: Math.floor(slotBudget * 100) / 100,
    cash_source: cashSource,
  };
}

module.exports = {
  allocateBuyNotional,
  buildPortfolioSnapshot,
  normalizeBrokerSymbol,
};
