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

  assert.equal(second.summary.entered_count, 1);
  assert.equal(second.state.candidates['MU::mu-breakout'].status, 'entered');
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
  assert.equal(next.state.candidates['WDC::wdc-breakout'].status, 'entered');
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
