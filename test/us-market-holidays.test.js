const test = require('node:test');
const assert = require('node:assert/strict');
const { isUsMarketHoliday } = require('../src/us-market-holidays');
const { isRegularUsMarketHours } = require('../src/market-hours');

test('US market holiday helper blocks a known 2026 holiday', () => {
  assert.equal(isUsMarketHoliday(new Date('2026-06-19T15:00:00Z')), true);
  assert.equal(isRegularUsMarketHours(new Date('2026-06-19T15:00:00Z')), false);
});

test('US market holiday helper blocks an observed holiday', () => {
  assert.equal(isUsMarketHoliday(new Date('2026-07-03T15:00:00Z')), true);
  assert.equal(isRegularUsMarketHours(new Date('2026-07-03T15:00:00Z')), false);
});
