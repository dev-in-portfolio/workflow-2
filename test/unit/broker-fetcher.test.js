const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkSymbols, filterApprovedPositions, buildPositionLookup } = require('../../src/scanner/broker-fetcher');

test('chunkSymbols splits array into chunks of given size', () => {
  const result = chunkSymbols(['A', 'B', 'C', 'D', 'E'], 2);
  assert.deepEqual(result, [['A', 'B'], ['C', 'D'], ['E']]);
});

test('chunkSymbols returns empty for empty input', () => {
  assert.deepEqual(chunkSymbols([], 3), []);
});

test('chunkSymbols handles chunk size larger than array', () => {
  assert.deepEqual(chunkSymbols(['A', 'B'], 10), [['A', 'B']]);
});

test('chunkSymbols handles single element', () => {
  assert.deepEqual(chunkSymbols(['A'], 1), [['A']]);
});

test('chunkSymbols handles exact division', () => {
  assert.deepEqual(chunkSymbols(['A', 'B', 'C', 'D'], 2), [['A', 'B'], ['C', 'D']]);
});

test('filterApprovedPositions filters to approved symbols only', () => {
  const positions = [
    { symbol: 'AAPL', qty: '10' },
    { symbol: 'TSLA', qty: '5' },
    { symbol: 'NOTREAL', qty: '1' },
  ];
  const result = filterApprovedPositions(positions, ['AAPL', 'TSLA', 'MSFT']);
  assert.equal(result.length, 2);
  assert.equal(result[0].symbol, 'AAPL');
  assert.equal(result[1].symbol, 'TSLA');
});

test('filterApprovedPositions returns empty array for null positions', () => {
  assert.deepEqual(filterApprovedPositions(null, ['AAPL']), []);
});

test('filterApprovedPositions returns empty array for undefined positions', () => {
  assert.deepEqual(filterApprovedPositions(undefined, ['AAPL']), []);
});

test('filterApprovedPositions is case insensitive', () => {
  const positions = [{ symbol: 'aapl' }];
  const result = filterApprovedPositions(positions, ['AAPL']);
  assert.equal(result.length, 1);
});

test('buildPositionLookup creates map keyed by symbol', () => {
  const positions = [
    { symbol: 'AAPL', qty: '10' },
    { symbol: 'MSFT', qty: '5' },
  ];
  const lookup = buildPositionLookup(positions);
  assert.equal(lookup.get('AAPL').qty, '10');
  assert.equal(lookup.get('MSFT').qty, '5');
  assert.equal(lookup.size, 2);
});

test('buildPositionLookup returns empty map for empty array', () => {
  const lookup = buildPositionLookup([]);
  assert.equal(lookup.size, 0);
});
