const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isUsMarketWeekday,
  resolveRegularStockAutomationSchedule,
} = require('../src/regular-stock-schedule');

test('regular stock schedule shows same-day start and stop on a weekday before the open', () => {
  const schedule = resolveRegularStockAutomationSchedule(new Date('2026-06-17T08:00:00Z'));
  assert.equal(isUsMarketWeekday(new Date('2026-06-17T08:00:00Z')), true);
  assert.equal(schedule.current.market_day, true);
  assert.equal(schedule.current.holiday, false);
  assert.equal(schedule.start.today, true);
  assert.equal(schedule.stop.today, true);
  assert(schedule.start.label.includes('5:00 AM ET'));
  assert(schedule.stop.label.includes('5:00 PM ET'));
});

test('regular stock schedule skips holidays to the next market day', () => {
  const schedule = resolveRegularStockAutomationSchedule(new Date('2026-06-19T15:00:00Z'));
  assert.equal(schedule.current.market_day, false);
  assert.equal(schedule.current.holiday, true);
  assert.equal(schedule.start.today, false);
  assert.equal(schedule.stop.today, false);
  assert(schedule.note.includes('Market is closed today in New York'));
  assert(schedule.start.label.includes('Mon'));
  assert(schedule.stop.label.includes('Mon'));
});
