const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertExecutionResult,
  assertSignalCandidate,
  assertBrokerOrder,
  assertBrokerPosition,
} = require('../src');

test('contract validators accept valid objects', () => {
  assert.equal(assertSignalCandidate({ signal_id: 'sig-1', symbol: 'MU', side: 'buy', notional: 150 }), true);
  assert.equal(assertExecutionResult({ order_id: 'ord-1', status: 'filled' }), true);
  assert.equal(assertBrokerPosition({ symbol: 'MU', qty: '1' }), true);
  assert.equal(assertBrokerOrder({ id: 'ord-1', symbol: 'MU', side: 'buy' }), true);
});

test('contract validators reject malformed signal candidate', () => {
  assert.throws(
    () => assertSignalCandidate({ side: 'buy', notional: 150 }),
    /Signal candidate contract failed/,
  );
});

test('contract validators reject malformed execution result', () => {
  assert.throws(
    () => assertExecutionResult({ status: 'filled' }),
    /Execution result contract failed/,
  );
});
