const { isUsMarketHoliday } = require('./us-market-holidays');

const LIVE_MARKET_START_MINUTES = 8 * 60 + 30;
const LIVE_MARKET_STOP_MINUTES = 16 * 60 + 15;
const NEW_YORK_TIME_ZONE = 'America/New_York';

function getNewYorkCalendarParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK_TIME_ZONE,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const resolved = {};
  for (const part of parts) {
    if (part.type === 'weekday') resolved.weekday = part.value;
    if (part.type === 'year') resolved.year = Number(part.value);
    if (part.type === 'month') resolved.month = Number(part.value);
    if (part.type === 'day') resolved.day = Number(part.value);
    if (part.type === 'hour') resolved.hour = Number(part.value);
    if (part.type === 'minute') resolved.minute = Number(part.value);
  }
  return {
    weekday: resolved.weekday || null,
    year: Number.isFinite(resolved.year) ? resolved.year : null,
    month: Number.isFinite(resolved.month) ? resolved.month : null,
    day: Number.isFinite(resolved.day) ? resolved.day : null,
    hour: Number.isFinite(resolved.hour) ? resolved.hour : null,
    minute: Number.isFinite(resolved.minute) ? resolved.minute : null,
  };
}

function isUsMarketWeekday(date = new Date()) {
  const weekday = getNewYorkCalendarParts(date).weekday;
  return weekday === 'Mon' || weekday === 'Tue' || weekday === 'Wed' || weekday === 'Thu' || weekday === 'Fri';
}

function resolveLiveMarketAutomationSchedule(now = new Date()) {
  const current = getNewYorkCalendarParts(now);
  const currentMinutes = Number.isFinite(current.hour) && Number.isFinite(current.minute)
    ? current.hour * 60 + current.minute
    : null;
  const marketDay = isUsMarketWeekday(now) && !isUsMarketHoliday(now);
  const nextStartDay = resolveNextMarketDay(current, {
    includeToday: marketDay && currentMinutes !== null && currentMinutes < LIVE_MARKET_START_MINUTES,
  });
  const nextStopDay = resolveNextMarketDay(current, {
    includeToday: marketDay && currentMinutes !== null && currentMinutes < LIVE_MARKET_STOP_MINUTES,
  });

  const start = buildScheduleMoment(nextStartDay, LIVE_MARKET_START_MINUTES, now);
  const stop = buildScheduleMoment(nextStopDay, LIVE_MARKET_STOP_MINUTES, now);

  return {
    timezone: NEW_YORK_TIME_ZONE,
    current: {
      weekday: current.weekday,
      date: formatCalendarDate(makeCalendarDate(current.year, current.month, current.day)),
      market_day: marketDay,
      holiday: Boolean(isUsMarketHoliday(now)),
      minutes_since_midnight: currentMinutes,
    },
    start,
    stop,
    note: buildScheduleNote({ current, marketDay, start, stop }),
  };
}

function resolveNextMarketDay(current, options = {}) {
  let cursor = makeCalendarDate(current.year, current.month, current.day);
  if (!options.includeToday) {
    cursor = addDays(cursor, 1);
  }
  while (!isMarketCalendarDay(cursor)) {
    cursor = addDays(cursor, 1);
  }
  return getCalendarPartsFromDate(cursor);
}

function buildScheduleMoment(dateParts, minutesSinceMidnight, now = new Date()) {
  const current = getNewYorkCalendarParts(now);
  const labelDate = formatScheduleDate(dateParts);
  return {
    date: dateParts.date,
    weekday: dateParts.weekday,
    label: `${labelDate}, ${formatMinutes(minutesSinceMidnight)} ET`,
    time: formatMinutes(minutesSinceMidnight),
    market_day: true,
    today: current.year === dateParts.year && current.month === dateParts.month && current.day === dateParts.day,
  };
}

function buildScheduleNote({ current, marketDay, start, stop }) {
  const currentMinutes = Number.isFinite(current.hour) && Number.isFinite(current.minute)
    ? current.hour * 60 + current.minute
    : null;
  if (!marketDay) {
    return `Market is closed today in New York; next start is ${start.label} and next stop is ${stop.label}.`;
  }
  if (currentMinutes !== null && currentMinutes < LIVE_MARKET_START_MINUTES) {
    return `Market opens later today; start is queued for ${start.label} and stop for ${stop.label}.`;
  }
  if (currentMinutes !== null && currentMinutes < LIVE_MARKET_STOP_MINUTES) {
    return `Market is open; today's stop is ${stop.label}.`;
  }
  return `Today's run has passed; next start is ${start.label} and next stop is ${stop.label}.`;
}

function isMarketCalendarDay(date) {
  const weekday = getNewYorkCalendarParts(date).weekday;
  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }
  return !isUsMarketHoliday(date);
}

function buildScheduleDateString(dateParts) {
  return `${String(dateParts.year).padStart(4, '0')}-${String(dateParts.month).padStart(2, '0')}-${String(dateParts.day).padStart(2, '0')}`;
}

function makeCalendarDate(year, month, day) {
  if (![year, month, day].every(Number.isFinite)) {
    return new Date();
  }
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function addDays(date, amount) {
  return new Date(date.getTime() + amount * 24 * 60 * 60 * 1000);
}

function getCalendarPartsFromDate(date) {
  const parts = getNewYorkCalendarParts(date);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    weekday: parts.weekday,
    date: buildScheduleDateString(parts),
  };
}

function formatScheduleDate(dateParts) {
  const date = makeCalendarDate(dateParts.year, dateParts.month, dateParts.day);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK_TIME_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatCalendarDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: NEW_YORK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return '-';
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const hour12 = hour % 12 || 12;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

module.exports = {
  LIVE_MARKET_START_MINUTES,
  LIVE_MARKET_STOP_MINUTES,
  NEW_YORK_TIME_ZONE,
  addDays,
  buildScheduleDateString,
  buildScheduleMoment,
  buildScheduleNote,
  formatCalendarDate,
  formatMinutes,
  formatScheduleDate,
  getCalendarPartsFromDate,
  getNewYorkCalendarParts,
  isMarketCalendarDay,
  isUsMarketWeekday,
  makeCalendarDate,
  resolveLiveMarketAutomationSchedule,
  resolveNextMarketDay,
};
