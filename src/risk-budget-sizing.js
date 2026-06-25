const { safeNumber } = require('./util');

function roundCurrency(value) {
  return Number(value.toFixed(2));
}

function floorToDecimals(value, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

function positiveNumber(value, fallback = null) {
  const parsed = safeNumber(value, fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function calculateRiskBudgetSize(options = {}) {
  const symbol = String(options.symbol || '').trim().toUpperCase() || null;
  const side = String(options.side || 'buy').trim().toLowerCase();
  const price = positiveNumber(options.price, null);
  const stopPrice = positiveNumber(options.stopPrice, null);
  const explicitDistance = positiveNumber(options.stopDistance, null);
  const minStopDistance = Math.max(0, safeNumber(options.minStopDistanceDollars, 0.01));
  const maxStopDistance = positiveNumber(options.maxStopDistanceDollars, Number.POSITIVE_INFINITY);
  const allowFractional = Boolean(options.allowFractionalShares);
  const requireBrokerEquity = options.requireBrokerEquity !== false;
  const reasons = [];
  const cappedBy = [];

  if (!['buy', 'sell'].includes(side)) reasons.push('RISK_BUDGET_SIDE_INVALID');
  if (!price) reasons.push('RISK_BUDGET_PRICE_UNAVAILABLE');
  if (!stopPrice && !explicitDistance) reasons.push('RISK_BUDGET_STOP_UNAVAILABLE');

  let stopDistance = explicitDistance;
  if (!stopDistance && price && stopPrice) {
    stopDistance = Math.abs(price - stopPrice);
  }
  if (price && stopPrice) {
    if (side === 'buy' && stopPrice >= price) reasons.push('RISK_BUDGET_STOP_NOT_BELOW_ENTRY');
    if (side === 'sell' && stopPrice <= price) reasons.push('RISK_BUDGET_STOP_NOT_ABOVE_ENTRY');
  }
  if (!stopDistance || stopDistance <= 0) reasons.push('RISK_BUDGET_STOP_DISTANCE_INVALID');
  if (stopDistance && stopDistance < minStopDistance) reasons.push('RISK_BUDGET_STOP_DISTANCE_TOO_SMALL');
  if (stopDistance && Number.isFinite(maxStopDistance) && stopDistance > maxStopDistance) {
    reasons.push('RISK_BUDGET_STOP_DISTANCE_TOO_LARGE');
  }

  const accountEquity = positiveNumber(options.accountEquity, null);
  if (requireBrokerEquity && !accountEquity) reasons.push('RISK_BUDGET_EQUITY_UNAVAILABLE');
  const maxRiskDollars = positiveNumber(options.maxRiskDollars, null);
  const maxRiskPctEquity = positiveNumber(options.maxRiskPctEquity, null);
  const pctRiskDollars = accountEquity && maxRiskPctEquity ? accountEquity * (maxRiskPctEquity / 100) : null;
  const riskBudgetCandidates = [maxRiskDollars, pctRiskDollars].filter((value) => Number.isFinite(value) && value > 0);
  const riskBudgetDollars = riskBudgetCandidates.length ? Math.min(...riskBudgetCandidates) : null;
  if (!riskBudgetDollars) reasons.push('RISK_BUDGET_DOLLARS_UNAVAILABLE');

  const buyingPower = positiveNumber(options.buyingPower, null);
  const cash = positiveNumber(options.cash, null);
  const spendableCandidates = [buyingPower, cash].filter((value) => Number.isFinite(value) && value > 0);
  const spendableBuyingPower = spendableCandidates.length ? Math.min(...spendableCandidates) : null;
  if (!spendableBuyingPower) reasons.push('RISK_BUDGET_BUYING_POWER_UNAVAILABLE');

  const maxNotional = positiveNumber(options.maxNotional, null);
  const maxQuantity = positiveNumber(options.maxQuantity, null);
  const minNotional = Math.max(0, safeNumber(options.minNotional, 0));

  if (reasons.length) {
    return rejected({ symbol, side, price, stopPrice, stopDistance, riskBudgetDollars, reasons, cappedBy });
  }

  let rawQuantity = riskBudgetDollars / stopDistance;
  if (spendableBuyingPower && price && rawQuantity * price > spendableBuyingPower) {
    rawQuantity = spendableBuyingPower / price;
    cappedBy.push('buying_power');
  }
  if (maxNotional && price && rawQuantity * price > maxNotional) {
    rawQuantity = maxNotional / price;
    cappedBy.push('max_notional');
  }
  if (maxQuantity && rawQuantity > maxQuantity) {
    rawQuantity = maxQuantity;
    cappedBy.push('max_quantity');
  }

  const quantity = allowFractional ? floorToDecimals(rawQuantity, 6) : Math.floor(rawQuantity);
  if (!(quantity > 0)) reasons.push('RISK_BUDGET_QUANTITY_ZERO');
  const notional = quantity > 0 && price ? roundCurrency(quantity * price) : 0;
  if (quantity > 0 && minNotional > 0 && notional < minNotional) {
    reasons.push('RISK_BUDGET_BELOW_MIN_NOTIONAL');
  }

  if (reasons.length) {
    return rejected({ symbol, side, price, stopPrice, stopDistance, riskBudgetDollars, reasons, cappedBy, quantity, notional });
  }

  const effectiveRiskDollars = roundCurrency(quantity * stopDistance);
  return {
    accepted: true,
    method: 'risk_budget',
    symbol,
    side,
    price,
    stop_price: stopPrice,
    stop_distance: Number(stopDistance.toFixed(6)),
    quantity,
    notional,
    risk_budget_dollars: roundCurrency(riskBudgetDollars),
    effective_risk_dollars: effectiveRiskDollars,
    risk_pct_equity: accountEquity ? Number(((effectiveRiskDollars / accountEquity) * 100).toFixed(4)) : null,
    account_equity: accountEquity,
    buying_power: buyingPower,
    cash,
    spendable_buying_power: spendableBuyingPower,
    min_notional: minNotional,
    max_notional: maxNotional,
    max_quantity: maxQuantity,
    allow_fractional_shares: allowFractional,
    capped_by: Array.from(new Set(cappedBy)),
    reason_codes: cappedBy.map((reason) => `RISK_BUDGET_CAPPED_BY_${reason.toUpperCase()}`),
    rejected_reason_codes: [],
  };
}

function rejected({ symbol, side, price, stopPrice, stopDistance, riskBudgetDollars, reasons, cappedBy, quantity = null, notional = null }) {
  return {
    accepted: false,
    method: 'risk_budget',
    symbol,
    side,
    price,
    stop_price: stopPrice,
    stop_distance: Number.isFinite(stopDistance) ? Number(stopDistance.toFixed(6)) : null,
    quantity,
    notional,
    risk_budget_dollars: Number.isFinite(riskBudgetDollars) ? roundCurrency(riskBudgetDollars) : null,
    capped_by: Array.from(new Set(cappedBy)),
    reason_codes: Array.from(new Set(reasons)),
    rejected_reason_codes: Array.from(new Set(reasons)),
  };
}

module.exports = {
  calculateRiskBudgetSize,
};
