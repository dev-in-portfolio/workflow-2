const MARKET_OPEN_MINUTES = 9 * 60 + 30;
const MARKET_CLOSE_MINUTES = 16 * 60;
const REGULAR_WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
const { isUsMarketHoliday } = require('./us-market-holidays');

function getNewYorkMarketParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const resolved = {};
  for (const part of parts) {
    if (part.type === 'weekday') resolved.weekday = part.value;
    if (part.type === 'hour') resolved.hour = Number(part.value);
    if (part.type === 'minute') resolved.minute = Number(part.value);
  }
  return {
    weekday: resolved.weekday || null,
    hour: Number.isFinite(resolved.hour) ? resolved.hour : null,
    minute: Number.isFinite(resolved.minute) ? resolved.minute : null,
  };
}

function isRegularUsMarketHours(date = new Date()) {
  const parts = getNewYorkMarketParts(date);
  if (!parts.weekday || !REGULAR_WEEKDAYS.has(parts.weekday)) return false;
  if (isUsMarketHoliday(date)) return false;
  if (!Number.isFinite(parts.hour) || !Number.isFinite(parts.minute)) return false;
  const minutesSinceMidnight = parts.hour * 60 + parts.minute;
  return minutesSinceMidnight >= MARKET_OPEN_MINUTES && minutesSinceMidnight < MARKET_CLOSE_MINUTES;
}

function resolveMarketRegime(date = new Date()) {
  return isRegularUsMarketHours(date) ? 'stocks' : 'crypto';
}

module.exports = {
  MARKET_CLOSE_MINUTES,
  MARKET_OPEN_MINUTES,
  getNewYorkMarketParts,
  isRegularUsMarketHours,
  resolveMarketRegime,
};
