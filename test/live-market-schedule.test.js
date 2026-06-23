const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveLiveMarketAutomationSchedule,
  isUsMarketWeekday,
} = require('../src/live-market-schedule');

test('live market schedule shows same-day start and stop before open on a weekday', () => {
  const schedule = resolveLiveMarketAutomationSchedule(new Date('2026-06-17T12:00:00Z'));
  assert.equal(isUsMarketWeekday(new Date('2026-06-17T12:00:00Z')), true);
  assert.equal(schedule.current.market_day, true);
  assert.equal(schedule.current.holiday, false);
  assert.equal(schedule.start.today, true);
  assert.equal(schedule.stop.today, true);
  assert(schedule.start.label.includes('8:30 AM ET'));
  assert(schedule.stop.label.includes('4:15 PM ET'));
});

test('live market schedule skips holidays to the next market day', () => {
  const schedule = resolveLiveMarketAutomationSchedule(new Date('2026-06-19T15:00:00Z'));
  assert.equal(schedule.current.market_day, false);
  assert.equal(schedule.current.holiday, true);
  assert.equal(schedule.start.today, false);
  assert.equal(schedule.stop.today, false);
  assert(schedule.note.includes('Market is closed today in New York'));
  assert(schedule.start.label.includes('Mon'));
  assert(schedule.stop.label.includes('Mon'));
});
