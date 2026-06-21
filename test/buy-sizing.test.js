const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../src/config');
const { buildPaperOrderRequestFromSignal, resolveBuyOrderSizing } = require('../src/webhooks');

test('buy sizing targets about $150 for crypto and stays within budget', () => {
  const sizing = resolveBuyOrderSizing({
    signal_id: 'sig-fractional',
    action_candidate: 'paper_buy',
    symbol: 'AVAX/USD',
    asset_type: 'crypto',
    price: 6.87,
  });

  assert.equal(sizing.pass, true);
  assert.equal(sizing.supports_fractional_shares, true);
  assert.equal(sizing.sizing_mode, 'fractional_qty');
  assert(sizing.quantity > 0);
  assert.equal(sizing.notional <= 150, true);
  assert.equal(sizing.quantity * sizing.price <= 150, true);
});

test('buy sizing floors whole-share stock orders and never exceeds the budget', () => {
  const sizing = resolveBuyOrderSizing({
    signal_id: 'sig-whole',
    action_candidate: 'paper_buy',
    symbol: 'AAPL',
    asset_type: 'stock',
    price: 48.25,
  });

  assert.equal(sizing.pass, true);
  assert.equal(sizing.supports_fractional_shares, false);
  assert.equal(sizing.sizing_mode, 'whole_share_qty');
  assert.equal(sizing.quantity, 3);
  assert.equal(sizing.notional, 144.75);

  const order = buildPaperOrderRequestFromSignal({
    signal_id: 'sig-size',
    action_candidate: 'paper_buy',
    symbol: 'AAPL',
    asset_type: 'stock',
    price: 48.25,
  });

  assert.equal(order.quantity, 3);
  assert.equal(order.notional, 144.75);
  assert.equal(order.time_in_force, 'day');
});

test('buy sizing blocks stock orders that cannot fit a single share inside the budget', () => {
  const sizing = resolveBuyOrderSizing({
    signal_id: 'sig-too-expensive',
    action_candidate: 'paper_buy',
    symbol: 'AAPL',
    asset_type: 'stock',
    price: 250,
  });

  assert.equal(sizing.pass, false);
  assert(sizing.reason_codes.includes('BUY_BUDGET_TOO_SMALL_FOR_WHOLE_SHARES'));
  assert.equal(
    buildPaperOrderRequestFromSignal({
      signal_id: 'sig-too-expensive',
      action_candidate: 'paper_buy',
      symbol: 'AAPL',
      asset_type: 'stock',
      price: 250,
    }),
    null,
  );
});

test('buy notional target is configurable with a sane default', () => {
  const defaultConfig = loadConfig({});
  assert.equal(defaultConfig.BUY_NOTIONAL_TARGET, 150);
  assert.equal(defaultConfig.MIN_CRYPTO_PROVIDER_CONFIRMATION_SCORE, 35);

  const customConfig = loadConfig({
    BUY_NOTIONAL_TARGET: '150',
    MIN_CRYPTO_PROVIDER_CONFIRMATION_SCORE: '40',
  });
  assert.equal(customConfig.BUY_NOTIONAL_TARGET, 150);
  assert.equal(customConfig.MIN_CRYPTO_PROVIDER_CONFIRMATION_SCORE, 40);

  const customSizing = resolveBuyOrderSizing({
    signal_id: 'sig-custom-target',
    action_candidate: 'paper_buy',
    symbol: 'AAPL',
    asset_type: 'stock',
    price: 48.25,
  }, {
    buyNotionalTarget: customConfig.BUY_NOTIONAL_TARGET,
  });

  assert.equal(customSizing.quantity, 3);
  assert.equal(customSizing.notional, 144.75);
});
