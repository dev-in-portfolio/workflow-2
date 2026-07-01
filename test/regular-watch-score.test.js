const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreRegularWatchSymbol } = require('../src/regular-watch/regular-watch-score');

test('regular watch score stays deterministic for a basic market confirmation context', () => {
  const result = scoreRegularWatchSymbol('AAA', {
    currentPrice: 10.25,
    previousClose: 9.75,
    volume: 1_500_000,
    averageVolume: 900_000,
    bid: 10.2,
    ask: 10.3,
    tradable: true,
    halted: false,
    marketConfirmationScore: 80,
  });

  assert.equal(result.symbol, 'AAA');
  assert.equal(result.status, 'watching');
  assert(result.reasonCodes.includes('market_confirmation_passed'));
});

