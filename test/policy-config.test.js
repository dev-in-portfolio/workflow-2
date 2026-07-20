const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, normalizePolicySnapshot } = require('../src');

test('config preserves explicit settings while live policy snapshots retain the canonical loss cap', () => {
  const config = loadConfig({
    BUY_NOTIONAL_TARGET: '2500',
    MAX_OPEN_POSITIONS: '2',
    STOCK_SCANNER_MIN_PRICE: '10',
  });

  assert.equal(config.VOLATILITY_THRESHOLD_PCT, undefined);
  assert.equal(config.BUY_NOTIONAL_TARGET, 2500);
  assert.equal(config.MAX_OPEN_POSITIONS, 2);
  assert.equal(config.STOCK_SCANNER_MIN_PRICE, 10);
  assert.equal(config.POSITION_STOP_LOSS_NOTIONAL_PCT, 0.75);
  assert.equal(config.POSITION_STOP_LOSS_MAX_DOLLARS, 2.5);

  const snapshot = normalizePolicySnapshot({
    source: 'manual-operator',
    captured_at: '2026-06-19T19:00:00.000Z',
    policy: {
      maxOpenPositions: 2,
      buyNotionalTarget: 2500,
      minBuyNotional: 25,
      approvedSymbols: [],
      positionStopLossDollars: 1,
      positionStopLossNotionalPct: 0.75,
      positionStopLossMaxDollars: 2.5,
      trailingProfitStartDollars: 0.5,
      trailingProfitGivebackDollars: 0.3,
    },
  });

  assert.equal(snapshot.policy.maxOpenPositions, 2);
  assert.equal(snapshot.policy.buyNotionalTarget, 2500);
  assert.equal(snapshot.policy.minBuyNotional, 25);
  assert.equal(snapshot.policy.volatilityThresholdPct, null);
  assert.deepEqual(snapshot.policy.approvedSymbols, []);
  assert.equal(snapshot.policy.positionStopLossDollars, 1);
  assert.equal(snapshot.policy.positionStopLossNotionalPct, 0.75);
  assert.equal(snapshot.policy.positionStopLossMaxDollars, 1.5);
  assert.equal(snapshot.policy.trailingProfitStartDollars, 0.5);
  assert.equal(snapshot.policy.trailingProfitGivebackDollars, 0.3);
});

test('Twelve Data stays disabled by default and requires a key only when explicitly enabled', () => {
  const disabled = loadConfig({ TWELVE_DATA_ENABLED: 'false', TWELVE_DATA_API_KEY: '' });
  assert.equal(disabled.TWELVE_DATA_ENABLED, false);
  assert.equal(disabled.TWELVE_DATA_API_KEY, '');
  assert.throws(
    () => loadConfig({ TWELVE_DATA_ENABLED: 'true', TWELVE_DATA_API_KEY: '' }),
    /TWELVE_DATA_API_KEY_REQUIRED/,
  );
  const enabled = loadConfig({ TWELVE_DATA_ENABLED: 'true', TWELVE_DATA_API_KEY: 'test-only' });
  assert.equal(enabled.TWELVE_DATA_ENABLED, true);
});
