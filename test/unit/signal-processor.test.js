const test = require('node:test');
const assert = require('node:assert/strict');
const { isBuySignal, normalizeOrderStatus } = require('../../src/trading/signal-processor');

test('isBuySignal returns true for buy side', () => {
  assert.equal(isBuySignal({ side: 'buy' }), true);
});

test('isBuySignal returns true for buy direction', () => {
  assert.equal(isBuySignal({ direction: 'buy' }), true);
});

test('isBuySignal returns false for sell side', () => {
  assert.equal(isBuySignal({ side: 'sell' }), false);
});

test('isBuySignal returns false for empty signal', () => {
  assert.equal(isBuySignal({}), false);
});

test('isBuySignal returns false for undefined', () => {
  assert.equal(isBuySignal(undefined), false);
});

test('isBuySignal is case insensitive', () => {
  assert.equal(isBuySignal({ side: 'BUY' }), true);
  assert.equal(isBuySignal({ side: 'Buy' }), true);
});

test('normalizeOrderStatus extracts status from order object', () => {
  assert.equal(normalizeOrderStatus({ status: 'filled' }), 'filled');
});

test('normalizeOrderStatus extracts order_status as fallback', () => {
  assert.equal(normalizeOrderStatus({ order_status: 'partial_fill' }), 'partial_fill');
});

test('normalizeOrderStatus extracts fill_status as fallback', () => {
  assert.equal(normalizeOrderStatus({ fill_status: 'pending' }), 'pending');
});

test('normalizeOrderStatus returns empty string for empty', () => {
  assert.equal(normalizeOrderStatus({}), '');
});

test('normalizeOrderStatus returns empty string for null', () => {
  assert.equal(normalizeOrderStatus(null), '');
});

test('normalizeOrderStatus lowercases result', () => {
  assert.equal(normalizeOrderStatus({ status: 'FILLED' }), 'filled');
});
