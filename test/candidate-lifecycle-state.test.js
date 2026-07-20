const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  CandidateLifecycleReason,
  decayCandidateRank,
  loadCandidateLifecycleState,
  reconcileCandidateLifecycleState,
  saveCandidateLifecycleState,
  summarizeCandidateLifecycleState,
} = require('../src/candidate-lifecycle-state');

function candidate(symbol, setupKey, rankScore) {
  return {
    symbol,
    setupKey,
    rankScore,
    payload: {
      side: 'buy',
      market_context: {
        scanner: {
          rank_score: rankScore,
          adjusted_rank_score: rankScore,
        },
      },
    },
  };
}

test('exceptional fresh momentum can use the bounded adaptive fast path', () => {
  const fast = candidate('FAST', 'breakout', 98);
  fast.payload.market_context.scanner.adaptive_confirmation = {
    fast_path_eligible: true,
    fast_path_reason_codes: [],
  };
  const result = reconcileCandidateLifecycleState({
    previousState: {}, candidates: [fast], now: '2026-06-19T15:00:00.000Z',
    queueEnabled: true, confirmationRequired: true, minScansBeforeEntry: 2,
    minSecondsBeforeEntry: 30, rankFloor: 60, scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false, adaptiveConfirmationEnabled: true,
  });
  const entry = result.state.candidates['FAST::breakout'];
  assert.equal(entry.status, 'selected');
  assert.equal(entry.confirmation_path, 'fast');
  assert(entry.reason_codes.includes('ADAPTIVE_FAST_MOMENTUM_CONFIRMED'));
});

test('ordinary candidates retain the configured normal scan and time confirmation', () => {
  const result = reconcileCandidateLifecycleState({
    previousState: {}, candidates: [candidate('NORMAL', 'breakout', 98)], now: '2026-06-19T15:00:00.000Z',
    queueEnabled: true, confirmationRequired: true, minScansBeforeEntry: 2,
    minSecondsBeforeEntry: 8, rankFloor: 60, scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false, adaptiveConfirmationEnabled: true,
  });
  const entry = result.state.candidates['NORMAL::breakout'];
  assert.equal(entry.status, 'watching');
  assert.equal(entry.confirmation_path, 'normal');
  assert.equal(entry.confirmation_seconds_required, 8);
});

test('an expired symbol starts a fresh confirmation window when it reappears', () => {
  const result = reconcileCandidateLifecycleState({
    previousState: { candidates: { 'REAL::breakout': {
      candidate_key: 'REAL::breakout', symbol: 'REAL', setup_key: 'breakout',
      status: 'expired', first_seen_at: '2026-06-18T15:00:00.000Z',
      last_seen_at: '2026-06-18T15:01:00.000Z', scans_seen: 12,
      rank_history: [{ at: '2026-06-18T15:01:00.000Z', decayed_rank: 90, status: 'expired' }],
      reason_codes: ['CANDIDATE_QUEUE_EXPIRED', 'CANDIDATE_MAX_AGE_EXCEEDED'],
    } } },
    candidates: [candidate('REAL', 'breakout', 88)],
    now: '2026-06-19T15:00:00.000Z', queueEnabled: true,
    confirmationRequired: true, minScansBeforeEntry: 2,
    minSecondsBeforeEntry: 8, maxAgeSeconds: 600, rankFloor: 60,
    scannerMode: 'hunt', huntToMonitorLatchEnabled: false,
  });
  const entry = result.state.candidates['REAL::breakout'];
  assert.equal(entry.status, 'watching');
  assert.equal(entry.scans_seen, 1);
  assert.equal(entry.first_seen_at, '2026-06-19T15:00:00.000Z');
  assert(!entry.reason_codes.includes('CANDIDATE_MAX_AGE_EXCEEDED'));
});

test('candidate lifecycle resets confirmation state at the New York trading-date boundary', () => {
  const previous = reconcileCandidateLifecycleState({
    previousState: {}, candidates: [candidate('RESET', 'breakout', 88)],
    now: '2026-06-18T19:59:00.000Z', queueEnabled: true,
    confirmationRequired: true, minScansBeforeEntry: 2,
    minSecondsBeforeEntry: 8, rankFloor: 60, scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false,
  }).state;
  const next = reconcileCandidateLifecycleState({
    previousState: previous, candidates: [candidate('RESET', 'breakout', 89)],
    now: '2026-06-19T13:30:00.000Z', queueEnabled: true,
    confirmationRequired: true, minScansBeforeEntry: 2,
    minSecondsBeforeEntry: 8, rankFloor: 60, scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false,
  });
  const entry = next.state.candidates['RESET::breakout'];
  assert.equal(next.state.trading_date, '2026-06-19');
  assert.equal(entry.first_seen_at, '2026-06-19T13:30:00.000Z');
  assert.equal(entry.scans_seen, 1);
  assert.equal(entry.status, 'watching');
});

test('candidate lifecycle progresses from watching to eligible after enough scans and time', () => {
  const first = reconcileCandidateLifecycleState({
    previousState: {},
    candidates: [candidate('MU', 'mu-breakout', 70)],
    now: '2026-06-19T15:00:00.000Z',
    queueEnabled: true,
    minScansBeforeEntry: 2,
    minSecondsBeforeEntry: 30,
    maxAgeSeconds: 600,
    confirmationRequired: true,
    rankFloor: 60,
    decayEnabled: false,
    scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false,
    softBandPoints: 4,
    hardBandPoints: 12,
    minHoldScans: 1,
  });

  assert.equal(first.summary.watched_count, 1);
  assert.equal(first.summary.eligible_count, 0);
  assert.equal(first.state.candidates['MU::mu-breakout'].status, 'watching');

  const second = reconcileCandidateLifecycleState({
    previousState: first.state,
    candidates: [candidate('MU', 'mu-breakout', 72)],
    now: '2026-06-19T15:00:45.000Z',
    queueEnabled: true,
    minScansBeforeEntry: 2,
    minSecondsBeforeEntry: 30,
    maxAgeSeconds: 600,
    confirmationRequired: true,
    rankFloor: 60,
    decayEnabled: false,
    scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false,
    softBandPoints: 4,
    hardBandPoints: 12,
    minHoldScans: 1,
  });

  assert.equal(second.summary.selected_count, 1);
  assert.equal(second.state.candidates['MU::mu-breakout'].status, 'selected');
  assert.equal(second.state.selected_key, 'MU::mu-breakout');
});

test('candidate lifecycle expires stale candidates', () => {
  const first = reconcileCandidateLifecycleState({
    previousState: {},
    candidates: [candidate('WDC', 'wdc-breakout', 71)],
    now: '2026-06-19T15:00:00.000Z',
    queueEnabled: true,
    minScansBeforeEntry: 1,
    minSecondsBeforeEntry: 0,
    maxAgeSeconds: 10,
    confirmationRequired: false,
    rankFloor: 60,
    decayEnabled: false,
    scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false,
  });
  const second = reconcileCandidateLifecycleState({
    previousState: first.state,
    candidates: [],
    now: '2026-06-19T15:00:20.000Z',
    queueEnabled: true,
    minScansBeforeEntry: 1,
    minSecondsBeforeEntry: 0,
    maxAgeSeconds: 10,
    confirmationRequired: false,
    rankFloor: 60,
    decayEnabled: false,
    scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false,
  });

  assert.equal(second.summary.expired_count, 1);
  assert.equal(second.state.candidates['WDC::wdc-breakout'].status, 'expired');
});

test('rank confidence decay lowers rank over time', () => {
  const result = decayCandidateRank({
    rawRank: 80,
    firstSeenAt: '2026-06-19T15:00:00.000Z',
    lastSeenAt: '2026-06-19T15:00:00.000Z',
    now: '2026-06-19T15:05:00.000Z',
    enabled: true,
    halfLifeSeconds: 60,
    maxStaleSeconds: 600,
  });

  assert(result.decayed_rank < 80);
  assert(result.reason_codes.includes(CandidateLifecycleReason.RANK_CONFIDENCE_DECAYED));
});

test('micro rotation guard keeps the current candidate when scores are close', () => {
  const previousState = reconcileCandidateLifecycleState({
    previousState: {},
    candidates: [candidate('MU', 'mu-breakout', 70), candidate('WDC', 'wdc-breakout', 68.5)],
    now: '2026-06-19T15:00:00.000Z',
    queueEnabled: true,
    minScansBeforeEntry: 1,
    minSecondsBeforeEntry: 0,
    maxAgeSeconds: 600,
    confirmationRequired: false,
    rankFloor: 60,
    decayEnabled: false,
    scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false,
    softBandPoints: 4,
    hardBandPoints: 12,
    minHoldScans: 1,
  }).state;
  previousState.selected_key = 'MU::mu-breakout';
  previousState.selection_state = {
    selected_key: 'MU::mu-breakout',
    selected_symbol: 'MU',
    selected_rank: 70,
    selected_decayed_rank: 70,
    selected_at: '2026-06-19T15:00:00.000Z',
    hold_scans: 1,
  };
  previousState.candidates['MU::mu-breakout'].status = 'entered';

  const next = reconcileCandidateLifecycleState({
    previousState,
    candidates: [candidate('MU', 'mu-breakout', 70.1), candidate('WDC', 'wdc-breakout', 72.0)],
    now: '2026-06-19T15:01:00.000Z',
    queueEnabled: true,
    minScansBeforeEntry: 1,
    minSecondsBeforeEntry: 0,
    maxAgeSeconds: 600,
    confirmationRequired: false,
    rankFloor: 60,
    decayEnabled: false,
    scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false,
    softBandPoints: 4,
    hardBandPoints: 12,
    minHoldScans: 1,
  });

  assert.equal(next.state.selected_key, 'MU::mu-breakout');
  assert(next.summary.rotation_decision.last_rotation_reason_codes.includes(CandidateLifecycleReason.MICRO_ROTATION_GUARD_ACTIVE));
});

test('hard band allows meaningful rotation', () => {
  const previousState = reconcileCandidateLifecycleState({
    previousState: {},
    candidates: [candidate('MU', 'mu-breakout', 70), candidate('WDC', 'wdc-breakout', 68.5)],
    now: '2026-06-19T15:00:00.000Z',
    queueEnabled: true,
    minScansBeforeEntry: 1,
    minSecondsBeforeEntry: 0,
    maxAgeSeconds: 600,
    confirmationRequired: false,
    rankFloor: 60,
    decayEnabled: false,
    scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false,
    softBandPoints: 4,
    hardBandPoints: 12,
    minHoldScans: 1,
  }).state;
  previousState.selected_key = 'MU::mu-breakout';
  previousState.selection_state = {
    selected_key: 'MU::mu-breakout',
    selected_symbol: 'MU',
    selected_rank: 70,
    selected_decayed_rank: 70,
    selected_at: '2026-06-19T15:00:00.000Z',
    hold_scans: 1,
  };
  previousState.candidates['MU::mu-breakout'].status = 'entered';

  const next = reconcileCandidateLifecycleState({
    previousState,
    candidates: [candidate('MU', 'mu-breakout', 70.1), candidate('WDC', 'wdc-breakout', 86.5)],
    now: '2026-06-19T15:01:00.000Z',
    queueEnabled: true,
    minScansBeforeEntry: 1,
    minSecondsBeforeEntry: 0,
    maxAgeSeconds: 600,
    confirmationRequired: false,
    rankFloor: 60,
    decayEnabled: false,
    scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false,
    softBandPoints: 4,
    hardBandPoints: 12,
    minHoldScans: 1,
  });

  assert.equal(next.state.selected_key, 'WDC::wdc-breakout');
  assert.equal(next.state.candidates['WDC::wdc-breakout'].status, 'selected');
});

test('hunt mode changes to monitor and manage-only blocks buys', () => {
  const monitor = reconcileCandidateLifecycleState({
    previousState: {},
    candidates: [candidate('MU', 'mu-breakout', 70)],
    now: '2026-06-19T15:00:00.000Z',
    queueEnabled: true,
    minScansBeforeEntry: 1,
    minSecondsBeforeEntry: 0,
    maxAgeSeconds: 600,
    confirmationRequired: false,
    rankFloor: 60,
    decayEnabled: false,
    scannerMode: 'hunt',
    huntToMonitorLatchEnabled: true,
    portfolio: { open_positions_count: 1 },
    softBandPoints: 4,
    hardBandPoints: 12,
    minHoldScans: 1,
  });

  const blocked = reconcileCandidateLifecycleState({
    previousState: {},
    candidates: [candidate('MU', 'mu-breakout', 70)],
    now: '2026-06-19T15:00:00.000Z',
    queueEnabled: true,
    minScansBeforeEntry: 1,
    minSecondsBeforeEntry: 0,
    maxAgeSeconds: 600,
    confirmationRequired: false,
    rankFloor: 60,
    decayEnabled: false,
    scannerMode: 'hunt',
    huntToMonitorLatchEnabled: true,
    sessionGuards: { manage_only: true, buy_blocked: true },
    manageOnlyBlocksBuys: true,
    softBandPoints: 4,
    hardBandPoints: 12,
    minHoldScans: 1,
  });

  assert.equal(monitor.current_mode, 'monitor');
  assert.equal(blocked.current_mode, 'manage_only');
  assert.equal(blocked.state.candidates['MU::mu-breakout'].status, 'blocked');
  assert(blocked.state.candidates['MU::mu-breakout'].reason_codes.includes(CandidateLifecycleReason.MANAGE_ONLY_MODE_ACTIVE));
});

test('candidate lifecycle state persists to disk and loads back', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-lifecycle-'));
  const filePath = path.join(tempDir, 'candidate-lifecycle-state.json');
  const state = reconcileCandidateLifecycleState({
    previousState: {},
    candidates: [candidate('MU', 'mu-breakout', 70)],
    now: '2026-06-19T15:00:00.000Z',
    queueEnabled: true,
    minScansBeforeEntry: 1,
    minSecondsBeforeEntry: 0,
    maxAgeSeconds: 600,
    confirmationRequired: false,
    rankFloor: 60,
    decayEnabled: false,
    scannerMode: 'hunt',
    huntToMonitorLatchEnabled: false,
    softBandPoints: 4,
    hardBandPoints: 12,
    minHoldScans: 1,
  }).state;
  saveCandidateLifecycleState(state, filePath);
  const loaded = loadCandidateLifecycleState(filePath);
  const summary = summarizeCandidateLifecycleState(loaded);

  assert.equal(loaded.candidates['MU::mu-breakout'].symbol, 'MU');
  assert.equal(summary.total_count, 1);
  assert.equal(summary.queue_enabled, true);
});
