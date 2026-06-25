const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateRiskBudgetSize } = require('../src/risk-budget-sizing');

test('risk-budget sizing accepts fractional quantity when stop and broker state are valid', () => {
  const sizing = calculateRiskBudgetSize({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    stopPrice: 99,
    maxRiskDollars: 2,
    accountEquity: 1000,
    buyingPower: 500,
    cash: 500,
    maxNotional: 250,
    minNotional: 25,
    allowFractionalShares: true,
  });

  assert.equal(sizing.accepted, true);
  assert.equal(sizing.quantity, 2);
  assert.equal(sizing.notional, 200);
  assert.equal(sizing.effective_risk_dollars, 2);
  assert.equal(sizing.risk_pct_equity, 0.2);
});

test('risk-budget sizing rejects missing price or stop', () => {
  const sizing = calculateRiskBudgetSize({
    symbol: 'MU',
    side: 'buy',
    maxRiskDollars: 2,
    accountEquity: 1000,
    buyingPower: 500,
    cash: 500,
  });

  assert.equal(sizing.accepted, false);
  assert(sizing.reason_codes.includes('RISK_BUDGET_PRICE_UNAVAILABLE'));
  assert(sizing.reason_codes.includes('RISK_BUDGET_STOP_UNAVAILABLE'));
});

test('risk-budget sizing rejects too-small and too-large stop distance', () => {
  const tooSmall = calculateRiskBudgetSize({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    stopPrice: 99.99,
    maxRiskDollars: 2,
    accountEquity: 1000,
    buyingPower: 500,
    cash: 500,
    minStopDistanceDollars: 0.05,
  });
  const tooLarge = calculateRiskBudgetSize({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    stopPrice: 90,
    maxRiskDollars: 2,
    accountEquity: 1000,
    buyingPower: 500,
    cash: 500,
    maxStopDistanceDollars: 5,
  });

  assert.equal(tooSmall.accepted, false);
  assert(tooSmall.reason_codes.includes('RISK_BUDGET_STOP_DISTANCE_TOO_SMALL'));
  assert.equal(tooLarge.accepted, false);
  assert(tooLarge.reason_codes.includes('RISK_BUDGET_STOP_DISTANCE_TOO_LARGE'));
});

test('risk-budget sizing requires broker equity and buying power when strict', () => {
  const sizing = calculateRiskBudgetSize({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    stopPrice: 99,
    maxRiskDollars: 2,
  });

  assert.equal(sizing.accepted, false);
  assert(sizing.reason_codes.includes('RISK_BUDGET_EQUITY_UNAVAILABLE'));
  assert(sizing.reason_codes.includes('RISK_BUDGET_BUYING_POWER_UNAVAILABLE'));
});

test('risk-budget sizing rejects below-minimum notional and zero whole-share quantity', () => {
  const belowMinimum = calculateRiskBudgetSize({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    stopPrice: 99,
    maxRiskDollars: 0.1,
    accountEquity: 1000,
    buyingPower: 500,
    cash: 500,
    minNotional: 25,
    allowFractionalShares: true,
  });
  const zeroWholeShare = calculateRiskBudgetSize({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    stopPrice: 99,
    maxRiskDollars: 0.5,
    accountEquity: 1000,
    buyingPower: 500,
    cash: 500,
    allowFractionalShares: false,
  });

  assert.equal(belowMinimum.accepted, false);
  assert(belowMinimum.reason_codes.includes('RISK_BUDGET_BELOW_MIN_NOTIONAL'));
  assert.equal(zeroWholeShare.accepted, false);
  assert(zeroWholeShare.reason_codes.includes('RISK_BUDGET_QUANTITY_ZERO'));
});

test('risk-budget sizing caps by buying power, max notional, and max quantity', () => {
  const buyingPowerCap = calculateRiskBudgetSize({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    stopPrice: 99,
    maxRiskDollars: 10,
    accountEquity: 1000,
    buyingPower: 250,
    cash: 250,
    allowFractionalShares: true,
  });
  const maxNotionalCap = calculateRiskBudgetSize({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    stopPrice: 99,
    maxRiskDollars: 10,
    accountEquity: 1000,
    buyingPower: 1000,
    cash: 1000,
    maxNotional: 300,
    allowFractionalShares: true,
  });
  const maxQuantityCap = calculateRiskBudgetSize({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    stopPrice: 99,
    maxRiskDollars: 10,
    accountEquity: 1000,
    buyingPower: 1000,
    cash: 1000,
    maxQuantity: 4,
    allowFractionalShares: true,
  });

  assert.equal(buyingPowerCap.accepted, true);
  assert(buyingPowerCap.capped_by.includes('buying_power'));
  assert.equal(buyingPowerCap.notional, 250);
  assert.equal(maxNotionalCap.capped_by.includes('max_notional'), true);
  assert.equal(maxNotionalCap.notional, 300);
  assert.equal(maxQuantityCap.capped_by.includes('max_quantity'), true);
  assert.equal(maxQuantityCap.quantity, 4);
});
