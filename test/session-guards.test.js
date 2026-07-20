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

test('churn guard counts completed exits only and expires from the last exit', async () => {
  const buys = Array.from({ length: 8 }, (_, index) => ({
    recorded_at: `2026-06-16T14:0${index}:00.000Z`,
    exit_at: `2026-06-16T14:0${index}:01.000Z`,
    net_pnl: null,
    original_signal: { side: 'buy', position_exit: false },
    paper_result: { side: 'buy' },
  }));
  const exits = Array.from({ length: 5 }, (_, index) => ({
    recorded_at: `2026-06-16T14:1${index}:00.000Z`,
    net_pnl: -0.1,
    exit_reason: 'STOP_LOSS_DOLLARS',
    original_signal: { side: 'sell', position_exit: true },
  }));
  const guards = await evaluateSessionGuards({
    now: '2026-06-16T15:00:00.000Z', paperOutcomes: [...buys, ...exits],
    intradayRegime: { regime: 'regular', market_open: true, manage_only: false },
    setupFatigueSummary: { active_setup_count: 0 },
    dailyDrawdownEnabled: false, rollingDrawdownEnabled: false,
    consecutiveLossEnabled: false, stopoutClusterEnabled: false,
    badSessionEnabled: false, lowProfitHighChurnEnabled: true,
    highChurnTradeCount: 5, lowProfitThresholdDollars: 0.5,
    lowProfitHighChurnCooldownSeconds: 1800,
  });
  assert.equal(guards.metrics.recent_trade_count, 5);
  assert.equal(guards.active_guards.some((guard) => guard.guard === 'low_profit_high_churn'), false);
  assert.equal(guards.buy_blocked, false);
});

test('consecutive-loss guard pauses briefly from the latest loss instead of blocking until day end', async () => {
  const outcomes = [
    { recorded_at: '2026-06-16T14:50:00.000Z', net_pnl: -0.4, exit_reason: 'STOP_LOSS_DOLLARS' },
    { recorded_at: '2026-06-16T14:55:00.000Z', net_pnl: -0.3, exit_reason: 'STOP_LOSS_DOLLARS' },
  ];
  const common = {
    paperOutcomes: outcomes,
    intradayRegime: { regime: 'regular', market_open: true, manage_only: false },
    setupFatigueSummary: { active_setup_count: 0 },
    dailyDrawdownEnabled: false,
    rollingDrawdownEnabled: false,
    consecutiveLossEnabled: true,
    maxConsecutiveLosses: 2,
    consecutiveLossCooldownSeconds: 900,
    stopoutClusterEnabled: false,
    badSessionEnabled: false,
    lowProfitHighChurnEnabled: false,
  };

  const coolingDown = await evaluateSessionGuards({ ...common, now: '2026-06-16T15:05:00.000Z' });
  assert.equal(coolingDown.buy_blocked, true);
  assert.equal(coolingDown.expires_at, '2026-06-16T15:10:00.000Z');
  assert(coolingDown.reason_codes.includes('CONSECUTIVE_LOSS_GUARD_ACTIVE'));

  const recovered = await evaluateSessionGuards({ ...common, now: '2026-06-16T15:11:00.000Z' });
  assert.equal(recovered.buy_blocked, false);
  assert.equal(recovered.reason_codes.includes('CONSECUTIVE_LOSS_GUARD_ACTIVE'), false);
});

test('pattern cooldown guards do not silently activate without explicit opt-in', async () => {
  const guards = await evaluateSessionGuards({
    now: '2026-06-16T15:00:00.000Z',
    paperOutcomes: [
      { recorded_at: '2026-06-16T14:50:00.000Z', net_pnl: -0.4, exit_reason: 'STOP_LOSS_DOLLARS' },
      { recorded_at: '2026-06-16T14:55:00.000Z', net_pnl: -0.3, exit_reason: 'STOP_LOSS_DOLLARS' },
    ],
    intradayRegime: { regime: 'regular', market_open: true, manage_only: false },
    setupFatigueSummary: { active_setup_count: 0 },
    dailyDrawdownEnabled: false,
    rollingDrawdownEnabled: false,
    badSessionEnabled: false,
  });
  assert.equal(guards.buy_blocked, false);
  assert.equal(guards.reason_codes.includes('CONSECUTIVE_LOSS_GUARD_ACTIVE'), false);
  assert.equal(guards.reason_codes.includes('STOPOUT_CLUSTER_GUARD_ACTIVE'), false);
  assert.equal(guards.reason_codes.includes('LOW_PROFIT_HIGH_CHURN_GUARD_ACTIVE'), false);
});

test('bad-session assessment is advisory unless explicitly enabled', async () => {
  const common = {
    now: '2026-06-16T15:00:00.000Z',
    paperOutcomes: [
      { recorded_at: '2026-06-16T14:10:00.000Z', net_pnl: -0.4, exit_reason: 'STOP_LOSS_DOLLARS' },
      { recorded_at: '2026-06-16T14:20:00.000Z', net_pnl: -0.3, exit_reason: 'STOP_LOSS_DOLLARS' },
      { recorded_at: '2026-06-16T14:30:00.000Z', net_pnl: 0.1, exit_reason: 'TRAILING_PROFIT_GIVEBACK' },
      { recorded_at: '2026-06-16T14:40:00.000Z', net_pnl: -0.2, exit_reason: 'STOP_LOSS_DOLLARS' },
    ],
    intradayRegime: { regime: 'regular', market_open: true, manage_only: false },
    setupFatigueSummary: { active_setup_count: 0 },
    dailyDrawdownEnabled: false,
    rollingDrawdownEnabled: false,
    consecutiveLossEnabled: false,
    stopoutClusterEnabled: false,
    lowProfitHighChurnEnabled: false,
  };

  const advisory = await evaluateSessionGuards(common);
  assert.equal(advisory.buy_blocked, false);
  assert.equal(advisory.reason_codes.includes('BAD_SESSION_GUARD_ACTIVE'), false);

  const enforced = await evaluateSessionGuards({ ...common, badSessionEnabled: true });
  assert.equal(enforced.buy_blocked, true);
  assert(enforced.reason_codes.includes('BAD_SESSION_GUARD_ACTIVE'));
});
