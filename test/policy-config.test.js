const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, normalizePolicySnapshot } = require('../src');

test('volatility threshold is configurable and preserved in policy snapshots', () => {
  const config = loadConfig({
    VOLATILITY_THRESHOLD_PCT: '8',
    BUY_NOTIONAL_TARGET: '2500',
    MAX_OPEN_POSITIONS: '2',
  });

  assert.equal(config.VOLATILITY_THRESHOLD_PCT, 8);
  assert.equal(config.BUY_NOTIONAL_TARGET, 2500);
  assert.equal(config.MAX_OPEN_POSITIONS, 2);

  const snapshot = normalizePolicySnapshot({
    source: 'manual-operator',
    captured_at: '2026-06-19T19:00:00.000Z',
    policy: {
      maxOpenPositions: 2,
      buyNotionalTarget: 2500,
      volatilityThresholdPct: 8,
    },
  });

  assert.equal(snapshot.policy.maxOpenPositions, 2);
  assert.equal(snapshot.policy.buyNotionalTarget, 2500);
  assert.equal(snapshot.policy.volatilityThresholdPct, 8);
});
