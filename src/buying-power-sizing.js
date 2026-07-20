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

function calculateSlotAwareDeploymentPct({ baseDeploymentPct = 100, maxSlots = null, remainingSlots = null } = {}) {
  const base = Math.max(0, Math.min(100, safeNumber(baseDeploymentPct, 100)));
  const maximum = Math.max(1, Math.floor(safeNumber(maxSlots, 1)));
  const remaining = Math.max(1, Math.min(maximum, Math.floor(safeNumber(remainingSlots, maximum))));
  return Math.max(0, Math.min(100, base * (maximum / remaining)));
}

function calculateBuyingPowerSize(options = {}) {
  const symbol = String(options.symbol || '').trim().toUpperCase() || null;
  const side = String(options.side || 'buy').trim().toLowerCase();
  const price = positiveNumber(options.price, null);
  const allowFractional = Boolean(options.allowFractionalShares);
  const deploymentPct = Math.max(0, Math.min(100, safeNumber(options.deploymentPct, 100)));
  const marketOrderBufferPct = Math.max(0, Math.min(50, safeNumber(options.marketOrderBufferPct, 0)));
  const cashReserve = Math.max(0, safeNumber(options.cashReserve, 0));
  const minNotional = Math.max(0, safeNumber(options.minNotional, 0));
  const maxNotional = positiveNumber(options.maxNotional, null);
  const reasons = [];
  const cappedBy = [];

  if (!['buy'].includes(side)) reasons.push('BUYING_POWER_SIZING_SIDE_INVALID');
  if (!price) reasons.push('BUYING_POWER_PRICE_UNAVAILABLE');
  if (!(deploymentPct > 0)) reasons.push('BUYING_POWER_DEPLOYMENT_PCT_ZERO');

  const buyingPower = positiveNumber(options.buyingPower, null);
  const cash = positiveNumber(options.cash, null);
  const spendableCandidates = [buyingPower, cash].filter((value) => Number.isFinite(value) && value > 0);
  const rawSpendable = spendableCandidates.length ? Math.min(...spendableCandidates) : null;
  if (!rawSpendable) reasons.push('BUYING_POWER_UNAVAILABLE');

  if (reasons.length) {
    return rejected({ symbol, side, price, buyingPower, cash, cashReserve, deploymentPct, marketOrderBufferPct, minNotional, maxNotional, reasons, cappedBy });
  }

  const afterReserve = Math.max(0, rawSpendable - cashReserve);
  if (cashReserve > 0) cappedBy.push('cash_reserve');
  let deployableNotional = afterReserve * (deploymentPct / 100);
  if (deploymentPct < 100) cappedBy.push('deployment_pct');
  if (marketOrderBufferPct > 0) {
    deployableNotional *= (1 - marketOrderBufferPct / 100);
    cappedBy.push('market_order_buffer');
  }
  if (maxNotional && deployableNotional > maxNotional) {
    deployableNotional = maxNotional;
    cappedBy.push('max_notional');
  }

  const rawQuantity = deployableNotional / price;
  const quantity = allowFractional ? floorToDecimals(rawQuantity, 6) : Math.floor(rawQuantity);
  if (!(quantity > 0)) reasons.push('BUYING_POWER_QUANTITY_ZERO');
  const notional = quantity > 0 ? roundCurrency(quantity * price) : 0;
  if (quantity > 0 && minNotional > 0 && notional < minNotional) {
    reasons.push('BUYING_POWER_BELOW_MIN_NOTIONAL');
  }

  if (reasons.length) {
    return rejected({
      symbol,
      side,
      price,
      buyingPower,
      cash,
      cashReserve,
      deploymentPct,
      marketOrderBufferPct,
      minNotional,
      maxNotional,
      reasons,
      cappedBy,
      quantity,
      notional,
      deployableNotional,
      spendableBuyingPower: rawSpendable,
    });
  }

  return {
    accepted: true,
    method: 'buying_power',
    symbol,
    side,
    price,
    quantity,
    notional,
    requested_notional: roundCurrency(rawSpendable),
    deployable_notional: roundCurrency(deployableNotional),
    deployment_pct: deploymentPct,
    market_order_buffer_pct: marketOrderBufferPct,
    buying_power: buyingPower,
    cash,
    cash_reserve: cashReserve,
    spendable_buying_power: rawSpendable,
    min_notional: minNotional,
    max_notional: maxNotional,
    allow_fractional_shares: allowFractional,
    capped_by: Array.from(new Set(cappedBy)),
    reason_codes: cappedBy.map((reason) => `BUYING_POWER_CAPPED_BY_${reason.toUpperCase()}`),
    rejected_reason_codes: [],
  };
}

function rejected({
  symbol,
  side,
  price,
  buyingPower,
  cash,
  cashReserve,
  deploymentPct,
  marketOrderBufferPct = 0,
  minNotional,
  maxNotional,
  reasons,
  cappedBy,
  quantity = null,
  notional = null,
  deployableNotional = null,
  spendableBuyingPower = null,
}) {
  return {
    accepted: false,
    method: 'buying_power',
    symbol,
    side,
    price,
    quantity,
    notional,
    deployment_pct: deploymentPct,
    market_order_buffer_pct: marketOrderBufferPct,
    deployable_notional: Number.isFinite(deployableNotional) ? roundCurrency(deployableNotional) : null,
    buying_power: buyingPower,
    cash,
    cash_reserve: cashReserve,
    spendable_buying_power: spendableBuyingPower,
    min_notional: minNotional,
    max_notional: maxNotional,
    capped_by: Array.from(new Set(cappedBy)),
    reason_codes: Array.from(new Set(reasons)),
    rejected_reason_codes: Array.from(new Set(reasons)),
  };
}

module.exports = {
  calculateBuyingPowerSize,
  calculateSlotAwareDeploymentPct,
};
