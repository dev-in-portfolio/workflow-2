const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SetupClassification,
  ReasonCode,
  buildSelectionV2Score,
  buildBoundedPriorityOverrideBonus,
  buildBoundedRegularWatchBonus,
} = require('../src/scanner-selection-v2');
const { recordScannerDecisionCycle, recordScannerSelectionShadow } = require('../src/scanner-outcome-shadow');
const { summarizeScannerSelectionValidation } = require('../src/scanner-selection-validation');
const { updateScannerCandidateOutcomes } = require('../src/scanner-selection-outcomes');

function snapshot({ price = 11, previousClose = 10, open = 10.1, high = 11.1, low = 9.95, minuteOpen = 10.8, minuteLow = 10.75, minuteHigh = 11.1, minuteVolume = 50_000, volume = 1_000_000, averageVolume = 2_000_000 } = {}) {
  return {
    averageVolume,
    latestTrade: { p: price, t: '2026-07-07T14:30:00.000Z' },
    latestQuote: { bp: price - 0.01, ap: price + 0.01, t: '2026-07-07T14:30:00.000Z' },
    minuteBar: { o: minuteOpen, h: minuteHigh, l: minuteLow, c: price, v: minuteVolume, vw: (minuteOpen + price) / 2, t: '2026-07-07T14:30:00.000Z' },
    dailyBar: { o: open, h: high, l: low, c: price, v: volume, vw: 10.6 },
    prevDailyBar: { c: previousClose, v: averageVolume },
  };
}

test('selection v2 positive momentum outranks equal negative collapse for continuation', () => {
  const up = buildSelectionV2Score({
    symbol: 'UP',
    snapshot: snapshot({ price: 11, previousClose: 10 }),
    currentPrice: 11,
    previousClose: 10,
    spreadPct: 0.2,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });
  const down = buildSelectionV2Score({
    symbol: 'DOWN',
    snapshot: snapshot({ price: 9, previousClose: 10, open: 9.8, high: 10, low: 8.8, minuteOpen: 9.2, minuteHigh: 9.25, minuteLow: 8.9 }),
    currentPrice: 9,
    previousClose: 10,
    spreadPct: 0.2,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });

  assert.equal(up.setup_classification, SetupClassification.BREAKOUT_CONTINUATION);
  assert(up.final_opportunity_score > down.final_opportunity_score);
});

test('selection v2 reversal requires stabilization', () => {
  const stabilizing = buildSelectionV2Score({
    symbol: 'REV',
    snapshot: snapshot({ price: 9.4, previousClose: 10, open: 9.8, high: 10, low: 9, minuteOpen: 9.1, minuteHigh: 9.45, minuteLow: 9.05 }),
    currentPrice: 9.4,
    previousClose: 10,
    spreadPct: 0.3,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });
  const falling = buildSelectionV2Score({
    symbol: 'FALL',
    snapshot: snapshot({ price: 9.1, previousClose: 10, open: 9.8, high: 10, low: 9, minuteOpen: 9.4, minuteHigh: 9.45, minuteLow: 9.05 }),
    currentPrice: 9.1,
    previousClose: 10,
    spreadPct: 0.3,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });

  assert.equal(stabilizing.setup_classification, SetupClassification.MEAN_REVERSION);
  assert.notEqual(falling.setup_classification, SetupClassification.MEAN_REVERSION);
});

test('selection v2 relative volume beats raw high volume without unusual activity', () => {
  const relative = buildSelectionV2Score({
    symbol: 'RVOL',
    snapshot: snapshot({ volume: 250_000, averageVolume: 300_000 }),
    currentPrice: 11,
    previousClose: 10,
    spreadPct: 0.2,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });
  const raw = buildSelectionV2Score({
    symbol: 'RAW',
    snapshot: snapshot({ volume: 5_000_000, averageVolume: 25_000_000 }),
    currentPrice: 11,
    previousClose: 10,
    spreadPct: 0.2,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });

  assert(relative.components.relative_volume_score > raw.components.relative_volume_score);
});

test('selection v2 stale watch data and priority override are bounded', () => {
  const staleBonus = buildBoundedRegularWatchBonus({ score: 100, ageSeconds: 600 }, { selectionV2RegularWatchMaxAgeSeconds: 180 });
  const freshBonus = buildBoundedRegularWatchBonus({ score: 100, ageSeconds: 30 }, { selectionV2RegularWatchMaxBonus: 12 });
  const priorityBonus = buildBoundedPriorityOverrideBonus({
    priorityOverride: { eligible: true, legacy_applied: true },
    features: { spread_pct: 0.2, relative_volume: 1.2 },
    setup: { setup_classification: SetupClassification.MOMENTUM_CONTINUATION },
    options: { selectionV2PriorityOverrideMaxBonus: 15 },
  });

  assert.equal(staleBonus.bonus, 0);
  assert.equal(freshBonus.bonus, 12);
  assert.equal(priorityBonus.bonus, 15);
});

test('selection v2 flags wide spread, failed breakout, and overextension', () => {
  const scored = buildSelectionV2Score({
    symbol: 'WIDE',
    snapshot: {
      ...snapshot({ price: 12, previousClose: 10, high: 13, low: 10, minuteOpen: 12.5, minuteHigh: 12.6, minuteLow: 11.9 }),
      minuteBar: { o: 12.5, h: 12.6, l: 11.9, c: 12, v: 50_000, vw: 10.5, t: '2026-07-07T14:30:00.000Z' },
      dailyBar: { o: 10.1, h: 13, l: 10, c: 12, v: 1_000_000, vw: 10.5 },
    },
    currentPrice: 12,
    previousClose: 10,
    spreadPct: 6,
    receivedAt: '2026-07-07T14:30:00.000Z',
    options: { selectionV2MaxVwapExtensionPct: 3 },
  });

  assert.equal(scored.qualified, false);
  assert(scored.reason_codes.includes(ReasonCode.SPREAD_TOO_WIDE_FOR_EXPECTED_GAIN));
  assert(scored.reason_codes.includes(ReasonCode.ENTRY_OVEREXTENDED_FROM_VWAP));
  assert(scored.reason_codes.includes(ReasonCode.MOMENTUM_DECELERATING));
});

test('shadow outcome tracker records candidates without order side effects', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-v2-shadow-'));
  const filePath = path.join(tempDir, 'outcomes.jsonl');
  const result = recordScannerSelectionShadow({
    filePath,
    receivedAt: '2026-07-07T14:30:00.000Z',
    candidates: [{
      symbol: 'AAA',
      rankScore: 88,
      payload: {
        side: 'buy',
        entry_price: 10,
        market_context: {
          scanner: {
            current_price: 10,
            selection_v2: {
              final_opportunity_score: 72,
              qualified: true,
              setup_classification: SetupClassification.MOMENTUM_CONTINUATION,
              reason_codes: [],
            },
          },
        },
      },
    }],
  });
  const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
  const record = JSON.parse(lines[0]);

  assert.equal(result.recorded, 1);
  assert.equal(record.symbol, 'AAA');
  assert.equal(record.observed, false);
  assert.equal(record.horizons.length, 6);
});

test('decision recorder preserves old and v2 candidate leaderboards', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-v2-decision-'));
  const filePath = path.join(tempDir, 'decisions.jsonl');
  const candidates = [
    decisionCandidate('OLD', 90, 35, false, -4),
    decisionCandidate('NEW', 70, 82, true, 3),
    decisionCandidate('MID', 65, 55, true, 1),
  ];

  const result = recordScannerDecisionCycle({
    filePath,
    receivedAt: '2026-07-07T14:30:00.000Z',
    approvedSymbols: ['OLD', 'NEW', 'MID'],
    candidates,
    selectedCandidates: [candidates[0]],
    skipSummary: { TEST_SKIP: 1 },
  });
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());

  assert.equal(result.recorded, 1);
  assert.match(record.decision_id, /^scanner_/);
  assert.equal(record.candidate_count, 3);
  assert(record.candidates.every((entry) => entry.candidate_id && entry.candidate_key));
  assert.equal(record.old_model_top.symbol, 'OLD');
  assert.equal(record.new_model_top.symbol, 'NEW');
  assert.equal(record.new_model_top_any.symbol, 'NEW');
  assert.equal(record.new_model_top_qualified.symbol, 'NEW');
  assert.deepEqual(record.old_model_top_three.map((entry) => entry.symbol), ['OLD', 'NEW', 'MID']);
  assert.deepEqual(record.new_model_top_three.map((entry) => entry.symbol), ['NEW', 'MID', 'OLD']);
  assert.deepEqual(record.new_model_top_three_qualified.map((entry) => entry.symbol), ['NEW', 'MID']);
  assert.equal(record.candidates.find((entry) => entry.symbol === 'OLD').selected_for_submission, true);
});

test('decision recorder excludes unqualified v2 candidates from qualified leaderboard', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-v2-qualified-'));
  const filePath = path.join(tempDir, 'decisions.jsonl');
  recordScannerDecisionCycle({
    filePath,
    receivedAt: '2026-07-07T14:30:00.000Z',
    candidates: [
      decisionCandidate('HIGH', 50, 99, false, 4),
      decisionCandidate('QUAL', 49, 70, true, 2),
    ],
  });
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());

  assert.equal(record.new_model_top_any.symbol, 'HIGH');
  assert.equal(record.new_model_top_qualified.symbol, 'QUAL');
});

test('decision recorder returns null qualified leaderboard when no v2 candidate qualifies', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-v2-no-qualified-'));
  const filePath = path.join(tempDir, 'decisions.jsonl');
  recordScannerDecisionCycle({
    filePath,
    receivedAt: '2026-07-07T14:30:00.000Z',
    candidates: [decisionCandidate('HIGH', 50, 99, false, 4)],
  });
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());

  assert.equal(record.new_model_top_qualified, null);
  assert.equal(record.new_model_no_qualified_reason, 'NO_V2_QUALIFIED_CANDIDATE');
});

test('selection validation summarizes recorded decision data', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-v2-validation-'));
  const filePath = path.join(tempDir, 'decisions.jsonl');
  recordScannerDecisionCycle({
    filePath,
    receivedAt: '2026-07-07T14:30:00.000Z',
    candidates: [
      decisionCandidate('OLD', 90, 35, false, -4),
      decisionCandidate('NEW', 70, 82, true, 3),
    ],
  });
  const summary = summarizeScannerSelectionValidation({ filePath });

  assert.equal(summary.scanner_cycles, 1);
  assert.equal(summary.candidates, 2);
  assert.equal(summary.cycles_with_multiple_candidates, 1);
  assert.equal(summary.old_new_top_pick_disagreements, 1);
  assert.equal(summary.old_model.positive_score_negative_move_count, 1);
  assert.equal(summary.new_model.qualified_count, 1);
  assert.equal(summary.recommendation, 'CONTINUE_SHADOW_TEST_COLLECT_MORE_DATA');
});

test('selection v2 missing volume baseline does not fabricate neutral relative volume', () => {
  const scored = buildSelectionV2Score({
    symbol: 'NOVOL',
    snapshot: {
      latestQuote: { bp: 10, ap: 10.05, t: '2026-07-07T14:30:00.000Z' },
      minuteBar: { o: 10, h: 10.1, l: 9.95, c: 10.05, v: 1000, t: '2026-07-07T14:30:00.000Z' },
      dailyBar: { o: 10, h: 10.1, l: 9.95, c: 10.05, v: 2000 },
    },
    currentPrice: 10.05,
    previousClose: 10,
    spreadPct: 0.2,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });

  assert.equal(scored.features.relative_volume, null);
  assert.equal(scored.features.relative_volume_available, false);
  assert.equal(scored.features.relative_volume_method, 'unavailable');
  assert(scored.reason_codes.includes('RELATIVE_VOLUME_BASELINE_UNAVAILABLE'));
  assert.equal(scored.components.relative_volume_score, 0);
});

test('selection v2 labels previous-day volume as time-adjusted approximation', () => {
  const approxSnapshot = snapshot();
  delete approxSnapshot.averageVolume;
  const scored = buildSelectionV2Score({
    symbol: 'APPROX',
    snapshot: approxSnapshot,
    currentPrice: 11,
    previousClose: 10,
    spreadPct: 0.2,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });

  assert.equal(scored.features.baseline_volume_source, 'previous_day_full_volume');
  assert.equal(scored.features.relative_volume_method, 'previous_day_time_adjusted_approximation');
  assert.equal(scored.features.relative_volume_approximation, true);
});

test('selection v2 exposes momentum heuristic instead of measured acceleration', () => {
  const scored = buildSelectionV2Score({
    symbol: 'MOMO',
    snapshot: snapshot(),
    currentPrice: 11,
    previousClose: 10,
    spreadPct: 0.2,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });

  assert.equal(scored.features.momentum_acceleration_pct, null);
  assert.equal(scored.features.momentum_data_quality, 'single_bar_heuristic');
  assert.equal(scored.features.momentum_bar_count, 1);
  assert.equal(typeof scored.features.momentum_vs_daily_move_heuristic, 'number');
});

test('outcome updater writes separate idempotent records and preserves decisions', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-v2-outcome-'));
  const decisionPath = path.join(tempDir, 'decisions.jsonl');
  const outcomePath = path.join(tempDir, 'outcomes.jsonl');
  recordScannerDecisionCycle({
    filePath: decisionPath,
    receivedAt: '2026-07-07T14:30:00.000Z',
    candidates: [decisionCandidate('AAA', 50, 80, true, 2)],
  });
  const before = fs.readFileSync(decisionPath, 'utf8');
  const barProvider = async () => [
    { t: '2026-07-07T14:30:00.000Z', o: 10, h: 10.1, l: 9.9, c: 10 },
    { t: '2026-07-07T14:31:00.000Z', o: 10, h: 10.4, l: 9.8, c: 10.3 },
    { t: '2026-07-07T14:35:00.000Z', o: 10.3, h: 10.6, l: 10.1, c: 10.5 },
  ];

  const first = await updateScannerCandidateOutcomes({
    decisionFilePath: decisionPath,
    outcomeFilePath: outcomePath,
    now: '2026-07-07T14:40:00.000Z',
    barProvider,
  });
  const second = await updateScannerCandidateOutcomes({
    decisionFilePath: decisionPath,
    outcomeFilePath: outcomePath,
    now: '2026-07-07T14:40:00.000Z',
    barProvider,
  });
  const outcomes = fs.readFileSync(outcomePath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);

  assert.equal(fs.readFileSync(decisionPath, 'utf8'), before);
  assert.equal(first.written_outcomes, 2);
  assert.equal(second.written_outcomes, 0);
  assert.equal(outcomes[0].status, 'complete');
  assert.equal(outcomes[0].window, '1m');
  assert.equal(outcomes[0].observed_price, 10.3);
  assert.equal(outcomes[0].maximum_favorable_price, 10.4);
  assert.equal(outcomes[0].maximum_adverse_price, 9.8);
});

test('outcome updater does not use a pre-decision bar for a future window', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-v2-no-lookahead-'));
  const decisionPath = path.join(tempDir, 'decisions.jsonl');
  const outcomePath = path.join(tempDir, 'outcomes.jsonl');
  recordScannerDecisionCycle({
    filePath: decisionPath,
    receivedAt: '2026-07-07T14:30:00.000Z',
    candidates: [decisionCandidate('AAA', 50, 80, true, 2)],
  });

  await updateScannerCandidateOutcomes({
    decisionFilePath: decisionPath,
    outcomeFilePath: outcomePath,
    now: '2026-07-07T14:40:00.000Z',
    barProvider: async () => [{ t: '2026-07-07T14:29:00.000Z', h: 99, l: 1, c: 50 }],
  });
  const outcomes = fs.readFileSync(outcomePath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);

  assert.equal(outcomes[0].status, 'unavailable');
  assert(outcomes[0].reason_codes.includes('OUTCOME_BAR_UNAVAILABLE'));
});

test('outcome updater reports same-bar stop and target as ambiguous', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-v2-ambiguous-'));
  const decisionPath = path.join(tempDir, 'decisions.jsonl');
  const outcomePath = path.join(tempDir, 'outcomes.jsonl');
  const candidate = decisionCandidate('AAA', 50, 80, true, 2);
  candidate.payload.market_context.scanner.structure_stop = { stop_price: 9.5, target_price: 10.5 };
  recordScannerDecisionCycle({
    filePath: decisionPath,
    receivedAt: '2026-07-07T14:30:00.000Z',
    candidates: [candidate],
  });
  await updateScannerCandidateOutcomes({
    decisionFilePath: decisionPath,
    outcomeFilePath: outcomePath,
    now: '2026-07-07T14:32:00.000Z',
    barProvider: async () => [{ t: '2026-07-07T14:31:00.000Z', h: 10.6, l: 9.4, c: 10.1 }],
  });
  const outcome = JSON.parse(fs.readFileSync(outcomePath, 'utf8').trim());

  assert.equal(outcome.first_threshold_touched, 'AMBIGUOUS_SAME_BAR');
  assert.equal(outcome.simulated_trade_result, 'AMBIGUOUS_SAME_BAR');
});

test('selection validation calculates regret from completed outcome windows', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-v2-regret-'));
  const decisionPath = path.join(tempDir, 'decisions.jsonl');
  const outcomePath = path.join(tempDir, 'outcomes.jsonl');
  recordScannerDecisionCycle({
    filePath: decisionPath,
    receivedAt: '2026-07-07T14:30:00.000Z',
    candidates: [
      decisionCandidate('OLD', 90, 35, false, -4),
      decisionCandidate('NEW', 70, 82, true, 3),
    ],
  });
  await updateScannerCandidateOutcomes({
    decisionFilePath: decisionPath,
    outcomeFilePath: outcomePath,
    now: '2026-07-07T14:40:00.000Z',
    barProvider: async ({ symbol }) => [
      { t: '2026-07-07T14:31:00.000Z', h: symbol === 'NEW' ? 10.5 : 10.1, l: 9.9, c: symbol === 'NEW' ? 10.5 : 10.1 },
    ],
  });
  const summary = summarizeScannerSelectionValidation({ filePath: decisionPath, outcomeFilePath: outcomePath });

  assert.equal(summary.selection_regret.measurable, true);
  assert.equal(summary.selection_regret.by_window['1m'].measurable_cycles, 1);
  assert(summary.selection_regret.by_window['1m'].old_model_average_regret > summary.selection_regret.by_window['1m'].new_model_average_regret);
});

function decisionCandidate(symbol, legacyScore, v2Score, qualified, movePct) {
  return {
    symbol,
    rankScore: legacyScore,
    regularWatchSortScore: legacyScore,
    payload: {
      side: 'buy',
      entry_price: 10,
      volume: 100000,
      market_context: {
        scanner: {
          current_price: 10,
          previous_close: 9.7,
          move_pct: movePct,
          spread_pct: 0.2,
          selection_v2: {
            final_opportunity_score: v2Score,
            qualified,
            setup_classification: qualified ? 'MOMENTUM_CONTINUATION' : 'UNCLASSIFIED',
            components: { momentum_score: v2Score },
            penalties: {},
            reason_codes: qualified ? ['MOMENTUM_CONTINUATION_CONFIRMED'] : ['SETUP_UNCLASSIFIED'],
          },
        },
      },
    },
  };
}
