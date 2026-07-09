const test = require('node:test');
const assert = require('node:assert/strict');
const { PerformanceStore } = require('../src');

test('performance store does not penalize fully filled orders as partial fills', () => {
  const performance = new PerformanceStore();
  const outcome = performance.recordPaperOutcome({
    signal_id: 'filled-arec',
    symbol: 'AREC',
    side: 'buy',
    quantity: 81,
    paper_result: {
      symbol: 'AREC',
      side: 'buy',
      status: 'filled',
      submitted_quantity: 81,
      filled_quantity: 81,
      remaining_quantity: 0,
      average_fill_price: 1.835,
      filled_at: '2026-07-08T18:39:38.860Z',
    },
    original_signal: {
      symbol: 'AREC',
      side: 'buy',
      quantity: 81,
      price: 1.835,
    },
  });

  assert.notEqual(outcome.execution_quality_classification, 'partial_fill');
  assert.equal(outcome.execution_quality.partial_fill, false);
  assert.equal(performance.executionQualityState.entries['AREC::unknown::buy::unknown'].partial_fill_count, 0);
});
