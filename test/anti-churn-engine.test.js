const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  AntiChurnClassification,
  calculateAntiChurnPenalty,
  classifyExitOutcome,
  evaluateChurnGuard,
  loadAntiChurnState,
  reconcileAntiChurnState,
  saveAntiChurnState,
  summarizeAntiChurnState,
} = require('../src');

test('anti-churn classifies clean wins, trailing wins, and small wins distinctly', () => {
  const clean = calculateAntiChurnPenalty({
    symbol: 'MU',
    net_pnl: 1.5,
    exit_reason: 'TARGET_HIT',
  });
  const trailing = calculateAntiChurnPenalty({
    symbol: 'MU',
    net_pnl: 1.25,
    trailing_exit: true,
    exit_reason: 'TRAILING_PROFIT_GIVEBACK',
  });
  const smallWin = classifyExitOutcome({
    symbol: 'MU',
    net_pnl: 0.2,
  });

  assert.equal(clean.classification, AntiChurnClassification.CLEAN_WIN);
  assert.equal(clean.penalty_points, 0);
  assert(clean.reason_codes.includes('CLEAN_WIN_NO_PENALTY'));
  assert.equal(clean.recent_winner_protected, true);
  assert.equal(trailing.classification, AntiChurnClassification.TRAILING_WIN);
  assert(trailing.reason_codes.includes('TRAILING_WIN_LIGHT_PENALTY'));
  assert.equal(trailing.recent_winner_protected, true);
  assert.equal(smallWin.classification, AntiChurnClassification.SMALL_WIN);
});

test('anti-churn classifies execution losses and partial-fill problems', () => {
  const executionLoss = classifyExitOutcome({
    symbol: 'NVDA',
    net_pnl: -2.5,
    gross_pnl: -0.5,
    execution_drag: 2.25,
  });
  const partialFill = classifyExitOutcome({
    symbol: 'NVDA',
    partial_fill: {
      remaining_quantity: 1,
      filled_quantity: 1,
      submitted_quantity: 2,
    },
    net_pnl: -0.1,
  });

  assert.equal(executionLoss.classification, AntiChurnClassification.EXECUTION_BAD_LOSS);
  assert.equal(partialFill.classification, AntiChurnClassification.PARTIAL_FILL_PROBLEM);
});

test('anti-churn does not classify completed fill metadata as a partial-fill problem', () => {
  const completedFill = classifyExitOutcome({
    symbol: 'OPTU',
    net_pnl: 0.5,
    partial_fill: {
      status: 'filled',
      remaining_quantity: 0,
      filled_quantity: 32,
      submitted_quantity: 32,
    },
    partial_fill_state: {
      count: 0,
      partial_buys: [],
      partial_sells: [],
      reserved_buy_notional: 0,
    },
  });

  assert.notEqual(completedFill.classification, AntiChurnClassification.PARTIAL_FILL_PROBLEM);
});

test('anti-churn reconciliation ignores buy fills that are not exits', async () => {
  const state = await reconcileAntiChurnState({
    paperOutcomes: [
      {
        symbol: 'OPTU',
        side: 'buy',
        recorded_at: '2026-07-08T18:53:33.403Z',
        paper_result: {
          status: 'filled',
          side: 'buy',
          filled_quantity: 32,
          submitted_quantity: 32,
          remaining_quantity: 0,
        },
        partial_fill: {
          status: 'filled',
          remaining_quantity: 0,
          filled_quantity: 32,
          submitted_quantity: 32,
        },
      },
    ],
    now: '2026-07-08T18:58:00.000Z',
    retentionHours: 24,
  });
  const summary = summarizeAntiChurnState(state);

  assert.equal(summary.recent_exit_count, 0);
  assert.equal(summary.symbols_under_cooldown.length, 0);
});

test('anti-churn gives hard stopouts stronger and capped cooldowns', () => {
  const first = calculateAntiChurnPenalty({
    symbol: 'MU',
    stopped_out: true,
    net_pnl: -2.25,
  });
  const repeated = calculateAntiChurnPenalty({
    symbol: 'MU',
    stopped_out: true,
    net_pnl: -2.25,
    prior_history: [{ symbol: 'MU', classification: 'hard_stopout', stop_exit: true }],
  });
  const capped = calculateAntiChurnPenalty({
    symbol: 'MU',
    stopped_out: true,
    net_pnl: -2.25,
    prior_history: Array.from({ length: 8 }, () => ({ symbol: 'MU', classification: 'hard_stopout', stop_exit: true })),
    max_cooldown_seconds: 600,
  });

  assert.equal(first.classification, AntiChurnClassification.HARD_STOPOUT);
  assert(repeated.cooldown_seconds > first.cooldown_seconds);
  assert(capped.cooldown_seconds <= 600);
});

test('churn guard activates on rapid repeated exits', () => {
  const now = '2026-06-25T14:00:00.000Z';
  const paperOutcomes = Array.from({ length: 4 }, (_, index) => ({
    symbol: index % 2 === 0 ? 'MU' : 'WDC',
    recorded_at: new Date(Date.parse(now) - (index * 2 * 60_000)).toISOString(),
    trade_duration_seconds: 60,
    net_pnl: -0.12,
    exit_reason: 'STOP_LOSS_DOLLARS',
  }));
  const guard = evaluateChurnGuard({
    paperOutcomes,
    now,
    window_seconds: 60 * 60,
  });

  assert.equal(guard.active, true);
  assert(guard.reason_codes.includes('CHURN_RATE_GUARD_ACTIVE'));
});

test('anti-churn state persists and reloads cleanly', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-churn-state-'));
  const filePath = path.join(tempDir, 'anti-churn-state.json');
  const now = new Date();
  const nowIso = now.toISOString();
  const cleanWinAt = new Date(now.getTime() - 5 * 60_000).toISOString();
  const stopoutAt = new Date(now.getTime() - 3 * 60_000).toISOString();
  const paperOutcomes = [
    {
      symbol: 'MU',
      recorded_at: cleanWinAt,
      net_pnl: 1.25,
      exit_reason: 'TARGET_HIT',
    },
    {
      symbol: 'NVDA',
      recorded_at: stopoutAt,
      net_pnl: -2.75,
      stopped_out: true,
      exit_reason: 'STOP_LOSS_DOLLARS',
    },
  ];
  const reconciled = await reconcileAntiChurnState({
    paperOutcomes,
    now: nowIso,
    retentionHours: 24,
  });
  const saved = saveAntiChurnState(reconciled, filePath);
  const loaded = loadAntiChurnState(filePath);
  const summary = summarizeAntiChurnState(loaded);

  assert.equal(saved.version, loaded.version);
  assert.equal(summary.recent_exit_count, 2);
  assert.equal(summary.symbols_under_cooldown.length, 1);
  assert.equal(summary.recent_winner_protection.length, 1);
});
