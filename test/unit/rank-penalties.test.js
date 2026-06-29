const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateSpreadRankPenalty } = require('../../src/scanner/rank-penalties');

test('calculateSpreadRankPenalty returns 0 when spread is below threshold', () => {
  assert.equal(calculateSpreadRankPenalty(0.5), 0);
});

test('calculateSpreadRankPenalty returns 0 when spread equals threshold', () => {
  assert.equal(calculateSpreadRankPenalty(0.75), 0);
});

test('calculateSpreadRankPenalty scales with excess above threshold', () => {
  const result = calculateSpreadRankPenalty(1.0);
  assert.equal(result, 6.25);
});

test('calculateSpreadRankPenalty caps at configured maximum', () => {
  const result = calculateSpreadRankPenalty(10, { cap: 80 });
  assert.equal(result, 80);
});

test('calculateSpreadRankPenalty respects custom threshold', () => {
  const result = calculateSpreadRankPenalty(2.0, { thresholdPct: 1.5, penaltyPerPct: 10 });
  assert.equal(result, 5);
});

test('calculateSpreadRankPenalty handles zero spread', () => {
  assert.equal(calculateSpreadRankPenalty(0), 0);
});

test('calculateSpreadRankPenalty handles negative spread as 0', () => {
  assert.equal(calculateSpreadRankPenalty(-1), 0);
});

test('calculateSpreadRankPenalty handles null spread as 0', () => {
  assert.equal(calculateSpreadRankPenalty(null), 0);
});
