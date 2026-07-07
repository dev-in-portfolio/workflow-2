const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateBuyingPowerSize } = require('../src/buying-power-sizing');
const { calculateRiskBudgetSize } = require('../src/risk-budget-sizing');

test('buying-power sizing uses nearly all available buying power', () => {
  const sizing = calculateBuyingPowerSize({
    symbol: 'MTAL',
    side: 'buy',
    price: 5.08,
    buyingPower: 194.68,
    cash: 194.68,
    deploymentPct: 100,
    allowFractionalShares: false,
    minNotional: 25,
  });

  assert.equal(sizing.accepted, true);
  assert.equal(sizing.method, 'buying_power');
  assert.equal(sizing.quantity, 38);
  assert.equal(sizing.notional, 193.04);
  assert.equal(sizing.deployable_notional, 194.68);
});

test('buying-power sizing rounds whole-share assets down', () => {
  const sizing = calculateBuyingPowerSize({
    symbol: 'AAPL',
    side: 'buy',
    price: 48.25,
    buyingPower: 150,
    cash: 150,
    deploymentPct: 100,
    allowFractionalShares: false,
  });

  assert.equal(sizing.accepted, true);
  assert.equal(sizing.quantity, 3);
  assert.equal(sizing.notional, 144.75);
});

test('buying-power sizing respects cash reserve', () => {
  const sizing = calculateBuyingPowerSize({
    symbol: 'AAPL',
    side: 'buy',
    price: 48.25,
    buyingPower: 150,
    cash: 150,
    cashReserve: 50,
    deploymentPct: 100,
    allowFractionalShares: false,
  });

  assert.equal(sizing.accepted, true);
  assert.equal(sizing.quantity, 2);
  assert.equal(sizing.notional, 96.5);
  assert.equal(sizing.deployable_notional, 100);
  assert(sizing.capped_by.includes('cash_reserve'));
});

test('buying-power sizing leaves a market-order validation buffer', () => {
  const sizing = calculateBuyingPowerSize({
    symbol: 'AIVI',
    side: 'buy',
    price: 28.465,
    buyingPower: 179.37,
    cash: 179.37,
    deploymentPct: 100,
    marketOrderBufferPct: 5,
    allowFractionalShares: false,
  });

  assert.equal(sizing.accepted, true);
  assert.equal(sizing.quantity, 5);
  assert.equal(sizing.notional, 142.32);
  assert.equal(sizing.deployable_notional, 170.4);
  assert.equal(sizing.market_order_buffer_pct, 5);
  assert(sizing.capped_by.includes('market_order_buffer'));
});

test('risk-budget sizing still behaves as before', () => {
  const sizing = calculateRiskBudgetSize({
    symbol: 'MTAL',
    side: 'buy',
    price: 5.08,
    stopPrice: 4.83,
    maxRiskPctEquity: 1,
    accountEquity: 194.68,
    buyingPower: 194.68,
    cash: 194.68,
    allowFractionalShares: false,
  });

  assert.equal(sizing.accepted, true);
  assert.equal(sizing.method, 'risk_budget');
  assert.equal(sizing.quantity, 7);
  assert.equal(sizing.notional, 35.56);
});
