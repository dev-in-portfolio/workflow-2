const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSessionGuards, summarizeSessionGuards } = require('../src');

test('session guards block buys but keep sells allowed', async () => {
  const guards = await evaluateSessionGuards({
    now: '2026-06-16T15:00:00.000Z',
    paperOutcomes: [
      {
        recorded_at: '2026-06-16T14:10:00.000Z',
        net_pnl: -1.5,
        pnl: -1.5,
        exit_reason: 'STOP_LOSS_DOLLARS',
        stop_exit: true,
        market_context: { setup_key: 'mu-breakout', regime: 'regular' },
      },
      {
        recorded_at: '2026-06-16T14:20:00.000Z',
        net_pnl: -1.1,
        pnl: -1.1,
        exit_reason: 'STOP_LOSS_DOLLARS',
        stop_exit: true,
        market_context: { setup_key: 'mu-breakout', regime: 'regular' },
      },
    ],
    setupFatigueSummary: {
      setup_count: 1,
      active_setup_count: 1,
      paused_setup_count: 1,
      active_setups: [{
        setup_key: 'mu-breakout',
        paused_until: '2026-06-16T15:30:00.000Z',
        fatigue_score: 70,
        active: true,
        reason_codes: ['SETUP_FATIGUE_ACTIVE'],
      }],
      paused_setups: [],
      warnings: [],
      recommended_actions: [],
      last_reconciled_at: '2026-06-16T15:00:00.000Z',
    },
    intradayRegime: {
      regime: 'opening_noise',
      market_open: true,
      manage_only: true,
      buys_allowed: false,
      sells_allowed: true,
      reason_code: 'OPENING_NOISE_MANAGE_ONLY',
      minutes_until_close: 300,
    },
    dailyDrawdownEnabled: true,
    maxDailyDrawdownDollars: 5,
    rollingDrawdownEnabled: true,
    maxRollingDrawdownDollars: 6,
    consecutiveLossEnabled: true,
    maxConsecutiveLosses: 2,
    stopoutClusterEnabled: true,
    stopoutClusterWindowSeconds: 3600,
    stopoutClusterMaxStopouts: 2,
    stopoutClusterCooldownSeconds: 1800,
    badSessionEnabled: true,
    lowProfitHighChurnEnabled: true,
  });

  assert.equal(guards.buy_blocked, true);
  assert.equal(guards.sells_allowed, true);
  assert.equal(guards.manage_only, true);
  assert(guards.reason_codes.includes('MANAGE_ONLY_MODE_ACTIVE'));
  assert(guards.reason_codes.includes('SETUP_FATIGUE_ACTIVE'));
  assert(Array.isArray(guards.active_guards));
  assert(guards.active_guards.some((guard) => guard.guard === 'setup_fatigue'));
  assert(guards.active_guards.some((guard) => guard.guard === 'market_outcome'));
});

test('session guard summary keeps the display shape compact', async () => {
  const guards = await evaluateSessionGuards({
    now: '2026-06-16T15:00:00.000Z',
    paperOutcomes: [],
    intradayRegime: {
      regime: 'regular',
      market_open: true,
      manage_only: false,
      buys_allowed: true,
      sells_allowed: true,
      reason_code: null,
      minutes_until_close: 240,
    },
    setupFatigueSummary: {
      setup_count: 0,
      active_setup_count: 0,
      paused_setup_count: 0,
      active_setups: [],
      paused_setups: [],
      warnings: [],
      recommended_actions: [],
      last_reconciled_at: '2026-06-16T15:00:00.000Z',
    },
    dailyDrawdownEnabled: false,
    rollingDrawdownEnabled: false,
    consecutiveLossEnabled: false,
    stopoutClusterEnabled: false,
    badSessionEnabled: false,
    lowProfitHighChurnEnabled: false,
  });

  const summary = summarizeSessionGuards(guards);
  assert.equal(summary.status, 'CLEAR');
  assert.equal(summary.buy_blocked, false);
  assert.equal(summary.active_guard_count, 0);
  assert.equal(summary.manage_only, false);
});
