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

test('buy sizing applies the policy size multiplier to whole-share orders', () => {
  const sizing = resolveBuyOrderSizing({
    signal_id: 'sig-size-multiplier',
    action_candidate: 'paper_buy',
    symbol: 'AAPL',
    asset_type: 'stock',
    price: 48.25,
  }, {
    policy: {
      positionSizeMultiplier: 0.5,
    },
  });

  assert.equal(sizing.pass, true);
  assert.equal(sizing.size_multiplier, 0.5);
  assert.equal(sizing.quantity, 1);
  assert.equal(sizing.notional, 48.25);
  assert.equal(sizing.target_notional, 75);
});

test('buy sizing uses fractional shares for stock orders when explicitly enabled', () => {
  const sizing = resolveBuyOrderSizing({
    signal_id: 'sig-fractional-stock',
    action_candidate: 'paper_buy',
    symbol: 'NVDA',
    asset_type: 'stock',
    price: 129.16,
    supports_fractional_shares: true,
  });

  assert.equal(sizing.pass, true);
  assert.equal(sizing.supports_fractional_shares, true);
  assert.equal(sizing.sizing_mode, 'fractional_qty');
  assert(sizing.quantity > 0);
  assert.equal(sizing.quantity < 2, true);
  assert.equal(sizing.notional <= 150, true);

  const order = buildPaperOrderRequestFromSignal({
    signal_id: 'sig-fractional-stock-order',
    action_candidate: 'paper_buy',
    symbol: 'NVDA',
    asset_type: 'stock',
    price: 129.16,
    supports_fractional_shares: true,
  });

  assert.equal(order.quantity > 0, true);
  assert.equal(order.notional <= 150, true);
  assert.equal(order.supports_fractional_shares, true);
  assert.equal(order.time_in_force, 'day');
});

test('buy sizing preserves scanner-provided whole-share risk-budget quantity', () => {
  const order = buildPaperOrderRequestFromSignal({
    signal_id: 'sig-risk-budget-whole',
    action_candidate: 'paper_buy',
    symbol: 'VRM',
    asset_type: 'stock',
    entry_price: 4.045,
    quantity: 8,
    notional: 32.36,
    supports_fractional_shares: false,
    sizing_method: 'risk_budget',
  }, {
    buyNotionalTarget: 150,
  });

  assert.equal(order.quantity, 8);
  assert.equal(order.notional, 32.36);
  assert.equal(order.supports_fractional_shares, false);
});

test('buy sizing ignores stale scanner quantity for buying-power orders', () => {
  const order = buildPaperOrderRequestFromSignal({
    signal_id: 'sig-buying-power-stale',
    action_candidate: 'paper_buy',
    symbol: 'KQQQ',
    asset_type: 'stock',
    price: 14.78,
    quantity: 11,
    notional: 162.58,
    supports_fractional_shares: false,
    sizing_method: 'buying_power',
  }, {
    buyNotionalTarget: 150,
    policy: {
      positionSizeMultiplier: 1,
    },
  });

  assert.equal(order.quantity, 10);
  assert.equal(order.notional, 147.8);
  assert.equal(order.sizing_method, 'buying_power');
});

test('buy order requests retain the scale-in flag for broker-side conflict checks', () => {
  const order = buildPaperOrderRequestFromSignal({
    signal_id: 'sig-scale-in',
    action_candidate: 'paper_buy',
    symbol: 'NVDA',
    asset_type: 'stock',
    price: 129.16,
    allow_scale_in: true,
  });

  assert.equal(order.allow_scale_in, true);
});

test('sell exit requests keep whole-share quantity unchanged', () => {
  const order = buildPaperOrderRequestFromSignal({
    signal_id: 'sig-sell-exit',
    action_candidate: 'paper_sell',
    symbol: 'VTAK',
    asset_type: 'stock',
    quantity: 105,
    notional: null,
    entry_price: 1.58,
    sizing_method: 'trailing_exit',
  }, {
    policy: {
      positionSizeMultiplier: 0.5,
    },
  });

  assert.equal(order.side, 'sell');
  assert.equal(order.quantity, 105);
  assert.equal(order.notional, null);
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
