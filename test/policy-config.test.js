const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, normalizePolicySnapshot } = require('../src');

test('policy snapshots preserve explicit settings and allow volatility to be omitted', () => {
  const config = loadConfig({
    BUY_NOTIONAL_TARGET: '2500',
    MAX_OPEN_POSITIONS: '2',
  });

  assert.equal(config.VOLATILITY_THRESHOLD_PCT, undefined);
  assert.equal(config.BUY_NOTIONAL_TARGET, 2500);
  assert.equal(config.MAX_OPEN_POSITIONS, 2);
  assert.equal(config.POSITION_STOP_LOSS_NOTIONAL_PCT, 0.75);
  assert.equal(config.POSITION_STOP_LOSS_MAX_DOLLARS, 2.5);

  const snapshot = normalizePolicySnapshot({
    source: 'manual-operator',
    captured_at: '2026-06-19T19:00:00.000Z',
    policy: {
      maxOpenPositions: 2,
      buyNotionalTarget: 2500,
      minBuyNotional: 25,
      approvedSymbols: ['SPCX', 'SMCI', 'FDX', 'MU', 'DFTX', 'APGE', 'NVDA', 'WDC', 'IBM', 'INTC', 'MRVL', 'MARA', 'IREN', 'GOOGL', 'FCEL', 'CBRS', 'ABSI', 'VIX', 'AMO', 'SNDK', 'VTAK'],
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
  assert.deepEqual(snapshot.policy.approvedSymbols, ['SPCX', 'SMCI', 'FDX', 'MU', 'DFTX', 'APGE', 'NVDA', 'WDC', 'IBM', 'INTC', 'MRVL', 'MARA', 'IREN', 'GOOGL', 'FCEL', 'CBRS', 'ABSI', 'VIX', 'AMO', 'SNDK', 'VTAK']);
  assert.equal(snapshot.policy.positionStopLossDollars, 1);
  assert.equal(snapshot.policy.positionStopLossNotionalPct, 0.75);
  assert.equal(snapshot.policy.positionStopLossMaxDollars, 2.5);
  assert.equal(snapshot.policy.trailingProfitStartDollars, 0.5);
  assert.equal(snapshot.policy.trailingProfitGivebackDollars, 0.3);
});
