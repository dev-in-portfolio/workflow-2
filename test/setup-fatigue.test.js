const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reconcileSetupFatigueState,
  resolveSetupKey,
  summarizeSetupFatigueState,
} = require('../src');

function outcomeFixture(overrides = {}) {
  return {
    record: {
      symbol: 'MU',
      side: 'buy',
      recorded_at: '2026-06-16T14:00:00.000Z',
      net_pnl: 0,
      pnl: 0,
      execution_drag: 0,
      exit_reason: 'TAKE_PROFIT',
      market_context: {
        setup_key: 'mu-breakout',
        regime: 'regular',
      },
      original_signal: {
        market_context: {
          setup_key: 'mu-breakout',
          regime: 'regular',
        },
      },
      paper_result: {
        status: 'filled',
        filled_at: '2026-06-16T14:00:00.000Z',
      },
      ...overrides,
    },
  };
}

test('setup fatigue key resolution is deterministic', () => {
  const first = resolveSetupKey({
    original_signal: { market_context: { setup_key: ' Mu-Breakout ' } },
  });
  const second = resolveSetupKey({
    market_context: { setup_key: 'mu-breakout' },
  });
  assert.equal(first, 'mu-breakout');
  assert.equal(second, 'mu-breakout');
});

test('setup fatigue increases after repeated losses and stopouts', async () => {
  const state = await reconcileSetupFatigueState({
    paperOutcomes: [
      outcomeFixture({
        recorded_at: '2026-06-16T14:00:00.000Z',
        net_pnl: -1.2,
        pnl: -1.2,
        exit_reason: 'STOP_LOSS_DOLLARS',
        stop_exit: true,
      }),
      outcomeFixture({
        recorded_at: '2026-06-16T14:12:00.000Z',
        net_pnl: -1.6,
        pnl: -1.6,
        exit_reason: 'STOP_LOSS_DOLLARS',
        stop_exit: true,
      }),
    ],
    now: '2026-06-16T14:20:00.000Z',
    env: {
      SETUP_FATIGUE_ENABLED: 'true',
      SETUP_FATIGUE_THRESHOLD: '20',
      SETUP_FATIGUE_DECAY_PER_HOUR: '1',
      SETUP_FATIGUE_STOPOUT_POINTS: '18',
      SETUP_FATIGUE_BAD_LOSS_POINTS: '12',
      SETUP_FATIGUE_GOOD_LOSS_POINTS: '4',
      SETUP_FATIGUE_CLEAN_WIN_RECOVERY_POINTS: '8',
      SETUP_FATIGUE_PAUSE_SECONDS: '900',
      SETUP_FATIGUE_MAX_PAUSE_SECONDS: '3600',
    },
  });

  const entry = state.setups['mu-breakout'];
  assert(entry);
  assert.equal(entry.recent_losses, 2);
  assert.equal(entry.recent_stopouts, 2);
  assert(entry.fatigue_score >= 20);
  assert.equal(entry.active, true);
  assert.equal(entry.reason_codes.includes('SETUP_FATIGUE_ACTIVE'), true);
});

test('repeated stopouts sharpen the pause window', async () => {
  const oneStopout = await reconcileSetupFatigueState({
    paperOutcomes: [outcomeFixture({
      recorded_at: '2026-06-16T14:00:00.000Z',
      net_pnl: -1.1,
      pnl: -1.1,
      exit_reason: 'STOP_LOSS_DOLLARS',
      stop_exit: true,
    })],
    now: '2026-06-16T14:10:00.000Z',
    env: {
      SETUP_FATIGUE_ENABLED: 'true',
      SETUP_FATIGUE_THRESHOLD: '10',
      SETUP_FATIGUE_DECAY_PER_HOUR: '0',
      SETUP_FATIGUE_STOPOUT_POINTS: '14',
      SETUP_FATIGUE_BAD_LOSS_POINTS: '8',
      SETUP_FATIGUE_GOOD_LOSS_POINTS: '2',
      SETUP_FATIGUE_CLEAN_WIN_RECOVERY_POINTS: '6',
      SETUP_FATIGUE_PAUSE_SECONDS: '600',
      SETUP_FATIGUE_MAX_PAUSE_SECONDS: '3600',
    },
  });
  const twoStopouts = await reconcileSetupFatigueState({
    paperOutcomes: [
      outcomeFixture({
        recorded_at: '2026-06-16T14:00:00.000Z',
        net_pnl: -1.1,
        pnl: -1.1,
        exit_reason: 'STOP_LOSS_DOLLARS',
        stop_exit: true,
      }),
      outcomeFixture({
        recorded_at: '2026-06-16T14:05:00.000Z',
        net_pnl: -1.4,
        pnl: -1.4,
        exit_reason: 'STOP_LOSS_DOLLARS',
        stop_exit: true,
      }),
    ],
    now: '2026-06-16T14:10:00.000Z',
    env: {
      SETUP_FATIGUE_ENABLED: 'true',
      SETUP_FATIGUE_THRESHOLD: '10',
      SETUP_FATIGUE_DECAY_PER_HOUR: '0',
      SETUP_FATIGUE_STOPOUT_POINTS: '14',
      SETUP_FATIGUE_BAD_LOSS_POINTS: '8',
      SETUP_FATIGUE_GOOD_LOSS_POINTS: '2',
      SETUP_FATIGUE_CLEAN_WIN_RECOVERY_POINTS: '6',
      SETUP_FATIGUE_PAUSE_SECONDS: '600',
      SETUP_FATIGUE_MAX_PAUSE_SECONDS: '3600',
    },
  });

  const one = oneStopout.setups['mu-breakout'];
  const two = twoStopouts.setups['mu-breakout'];
  assert(one);
  assert(two);
  assert(two.fatigue_score > one.fatigue_score);
  assert(new Date(two.paused_until).getTime() > new Date(one.paused_until).getTime());
});

test('wins reduce setup fatigue', async () => {
  const lossOnly = await reconcileSetupFatigueState({
    paperOutcomes: [outcomeFixture({
      recorded_at: '2026-06-16T14:00:00.000Z',
      net_pnl: -1.3,
      pnl: -1.3,
      exit_reason: 'FAILED_BREAKOUT',
    })],
    now: '2026-06-16T14:20:00.000Z',
    env: {
      SETUP_FATIGUE_ENABLED: 'true',
      SETUP_FATIGUE_THRESHOLD: '10',
      SETUP_FATIGUE_DECAY_PER_HOUR: '0',
      SETUP_FATIGUE_STOPOUT_POINTS: '18',
      SETUP_FATIGUE_BAD_LOSS_POINTS: '12',
      SETUP_FATIGUE_GOOD_LOSS_POINTS: '4',
      SETUP_FATIGUE_CLEAN_WIN_RECOVERY_POINTS: '8',
      SETUP_FATIGUE_PAUSE_SECONDS: '900',
      SETUP_FATIGUE_MAX_PAUSE_SECONDS: '3600',
    },
  });
  const lossPlusWin = await reconcileSetupFatigueState({
    paperOutcomes: [
      outcomeFixture({
        recorded_at: '2026-06-16T14:00:00.000Z',
        net_pnl: -1.3,
        pnl: -1.3,
        exit_reason: 'FAILED_BREAKOUT',
      }),
      outcomeFixture({
        recorded_at: '2026-06-16T14:12:00.000Z',
        net_pnl: 1.4,
        pnl: 1.4,
        exit_reason: 'TAKE_PROFIT',
      }),
    ],
    now: '2026-06-16T14:20:00.000Z',
    env: {
      SETUP_FATIGUE_ENABLED: 'true',
      SETUP_FATIGUE_THRESHOLD: '10',
      SETUP_FATIGUE_DECAY_PER_HOUR: '0',
      SETUP_FATIGUE_STOPOUT_POINTS: '18',
      SETUP_FATIGUE_BAD_LOSS_POINTS: '12',
      SETUP_FATIGUE_GOOD_LOSS_POINTS: '4',
      SETUP_FATIGUE_CLEAN_WIN_RECOVERY_POINTS: '8',
      SETUP_FATIGUE_PAUSE_SECONDS: '900',
      SETUP_FATIGUE_MAX_PAUSE_SECONDS: '3600',
    },
  });

  assert(lossOnly.setups['mu-breakout'].fatigue_score > lossPlusWin.setups['mu-breakout'].fatigue_score);
});

test('expired pause unblocks the setup', async () => {
  const state = await reconcileSetupFatigueState({
    previousState: {
      setups: {
        'mu-breakout': {
          setup_key: 'mu-breakout',
          fatigue_score: 90,
          active: true,
          paused_until: '2026-06-16T14:05:00.000Z',
          recent_trades: 4,
          recent_losses: 3,
          recent_stopouts: 2,
          recent_wins: 1,
          net_pnl: -4,
          updated_at: '2026-06-16T13:00:00.000Z',
        },
      },
    },
    now: '2026-06-16T20:30:00.000Z',
    paperOutcomes: [],
    env: {
      SETUP_FATIGUE_ENABLED: 'true',
      SETUP_FATIGUE_THRESHOLD: '60',
      SETUP_FATIGUE_DECAY_PER_HOUR: '12',
      SETUP_FATIGUE_PAUSE_SECONDS: '900',
      SETUP_FATIGUE_MAX_PAUSE_SECONDS: '3600',
    },
  });

  const entry = state.setups['mu-breakout'];
  assert(entry);
  assert.equal(entry.active, false);
  assert.equal(entry.paused_until, null);
  assert(entry.fatigue_score < 60);
});

test('setup fatigue summary exposes paused setups and counts', async () => {
  const state = await reconcileSetupFatigueState({
    paperOutcomes: [outcomeFixture({
      recorded_at: '2026-06-16T14:00:00.000Z',
      net_pnl: -1.3,
      pnl: -1.3,
      exit_reason: 'STOP_LOSS_DOLLARS',
      stop_exit: true,
    })],
    now: '2026-06-16T14:20:00.000Z',
    env: {
      SETUP_FATIGUE_ENABLED: 'true',
      SETUP_FATIGUE_THRESHOLD: '10',
      SETUP_FATIGUE_DECAY_PER_HOUR: '0',
      SETUP_FATIGUE_STOPOUT_POINTS: '18',
      SETUP_FATIGUE_BAD_LOSS_POINTS: '12',
      SETUP_FATIGUE_GOOD_LOSS_POINTS: '4',
      SETUP_FATIGUE_CLEAN_WIN_RECOVERY_POINTS: '8',
      SETUP_FATIGUE_PAUSE_SECONDS: '900',
      SETUP_FATIGUE_MAX_PAUSE_SECONDS: '3600',
    },
  });
  const summary = summarizeSetupFatigueState(state);
  assert.equal(summary.setup_count, 1);
  assert.equal(summary.active_setup_count, 1);
  assert.equal(summary.paused_setup_count, 1);
  assert.deepEqual(summary.paused_setups.map((setup) => setup.setup_key), ['mu-breakout']);
});
