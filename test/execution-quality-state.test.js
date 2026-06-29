const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  calculateExecutionPenalty,
  classifyExecutionQuality,
  loadExecutionQualityState,
  saveExecutionQualityState,
  summarizeExecutionQualityState,
  updateExecutionQualityState,
} = require('../src');

test('execution quality classification and penalty math stay deterministic', () => {
  const assessment = classifyExecutionQuality({
    submitted_price: 100,
    filled_avg_price: 101,
    execution_drag: 0.4,
    submitted_qty: 2,
    filled_qty: 2,
  }, {
    highSlippageThresholdPct: 0.5,
    badFillThresholdPct: 2,
    minSizeMultiplier: 0.5,
  });

  const alias = calculateExecutionPenalty({
    submitted_price: 100,
    filled_avg_price: 101,
    execution_drag: 0.4,
    submitted_qty: 2,
    filled_qty: 2,
  }, {
    highSlippageThresholdPct: 0.5,
    badFillThresholdPct: 2,
    minSizeMultiplier: 0.5,
  });

  assert.equal(assessment.classification, 'high_slippage');
  assert.equal(alias.classification, assessment.classification);
  assert.equal(alias.execution_penalty_points, assessment.execution_penalty_points);
  assert.equal(alias.execution_quality_score, assessment.execution_quality_score);
});

test('execution quality state aggregates trade counts and penalty summaries', () => {
  const initial = updateExecutionQualityState({}, {
    symbol: 'MU',
    setup_key: 'breakout',
    side: 'buy',
    time_regime: 'regular',
    timestamp: '2026-06-25T13:00:00.000Z',
    execution_quality: {
      classification: 'bad_fill',
      execution_quality_score: 52,
      execution_penalty_points: 48,
      slippage: 2.4,
      execution_drag: 0.8,
      reason_codes: ['BAD_FILL_SLIPPAGE'],
    },
  }, {
    now: '2026-06-25T13:00:00.000Z',
    decayPerHour: 0,
    minSizeMultiplier: 0.5,
  });

  const updated = updateExecutionQualityState(initial.state, {
    symbol: 'MU',
    setup_key: 'breakout',
    side: 'buy',
    time_regime: 'regular',
    timestamp: '2026-06-25T13:10:00.000Z',
    execution_quality: {
      classification: 'excellent_fill',
      execution_quality_score: 100,
      execution_penalty_points: 0,
      slippage: 0.05,
      execution_drag: 0.01,
      reason_codes: [],
    },
  }, {
    now: '2026-06-25T13:10:00.000Z',
    decayPerHour: 0,
    minSizeMultiplier: 0.5,
  });

  const summary = summarizeExecutionQualityState(updated.state, {
    now: '2026-06-25T13:10:00.000Z',
    decayPerHour: 0,
    minSizeMultiplier: 0.5,
  });

  assert.equal(summary.total_trades, 2);
  assert.equal(summary.total_entries, 1);
  assert.equal(summary.by_symbol[0].symbol, 'MU');
  assert.equal(summary.by_symbol[0].trade_count, 2);
  assert(summary.penalty_symbols.length >= 1);
  assert(summary.size_reduction_symbols.length >= 1);
  assert.equal(summary.by_symbol[0].classifications.bad_fill, 1);
});

test('execution quality state saves and loads from disk', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-quality-state-'));
  const filePath = path.join(tempDir, 'execution-quality-state.json');
  const state = updateExecutionQualityState({}, {
    symbol: 'NVDA',
    setup_key: 'breakout',
    side: 'buy',
    time_regime: 'regular',
    timestamp: '2026-06-25T13:30:00.000Z',
    execution_quality: {
      classification: 'partial_fill',
      execution_quality_score: 71,
      execution_penalty_points: 29,
      slippage: 0.8,
      execution_drag: 0.2,
      reason_codes: ['PARTIAL_FILL'],
    },
  }, {
    now: '2026-06-25T13:30:00.000Z',
    decayPerHour: 0,
    minSizeMultiplier: 0.5,
  });

  saveExecutionQualityState(state.state, filePath);
  const loaded = loadExecutionQualityState(filePath);
  const summary = summarizeExecutionQualityState(loaded, {
    now: '2026-06-25T13:30:00.000Z',
    decayPerHour: 0,
    minSizeMultiplier: 0.5,
  });

  assert.equal(summary.total_trades, 1);
  assert.equal(summary.by_symbol[0].symbol, 'NVDA');
  assert.equal(summary.by_symbol[0].classifications.partial_fill, 1);
});
