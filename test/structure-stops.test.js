const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateStructureAwareStop } = require('../src/structure-stops');

test('structure-aware stops select a valid swing low before fallback', () => {
  const stop = calculateStructureAwareStop({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    marketData: { recent_swing_low: 98.5 },
    fixedStopDollars: 1,
    minStopDistanceDollars: 0.25,
    maxStopDistanceDollars: 3,
  });

  assert.equal(stop.accepted, true);
  assert.equal(stop.method, 'swing_low');
  assert.equal(stop.stop_price, 98.5);
  assert.equal(stop.stop_distance, 1.5);
});

test('structure-aware stops reject swing lows that are too close or too far and use fallback', () => {
  const tooClose = calculateStructureAwareStop({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    marketData: { recent_swing_low: 99.99 },
    fixedStopDollars: 1,
    minStopDistanceDollars: 0.25,
    maxStopDistanceDollars: 3,
  });
  const tooFar = calculateStructureAwareStop({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    marketData: { recent_swing_low: 90 },
    fixedStopDollars: 1,
    minStopDistanceDollars: 0.25,
    maxStopDistanceDollars: 3,
  });

  assert.equal(tooClose.accepted, true);
  assert.equal(tooClose.candidates[0].accepted, false);
  assert(tooClose.candidates[0].reason_codes.includes('STRUCTURE_STOP_DISTANCE_TOO_SMALL'));
  assert.equal(tooClose.method, 'fixed_dollar');
  assert.equal(tooFar.accepted, true);
  assert.equal(tooFar.candidates[0].accepted, false);
  assert(tooFar.candidates[0].reason_codes.includes('STRUCTURE_STOP_DISTANCE_TOO_LARGE'));
  assert.equal(tooFar.method, 'fixed_dollar');
});

test('structure-aware stops use safe fallback when structure data is unavailable', () => {
  const stop = calculateStructureAwareStop({
    symbol: 'MU',
    side: 'buy',
    price: 100,
    marketData: {},
    minStopDistanceDollars: 0.5,
    maxStopDistanceDollars: 2,
  });

  assert.equal(stop.accepted, true);
  assert.equal(stop.method, 'safe_fallback');
  assert.equal(stop.stop_price, 99.5);
  assert.equal(stop.stop_distance, 0.5);
});
