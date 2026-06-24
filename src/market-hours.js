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

function resolveIntradayStockRegime(date = new Date(), options = {}) {
  const openingNoiseMinutes = Math.max(0, Number(options.openingNoiseMinutes ?? 5) || 0);
  const nearCloseMinutes = Math.max(0, Number(options.nearCloseMinutes ?? 15) || 0);
  const parts = getNewYorkMarketParts(date);
  const minutesSinceMidnight = Number.isFinite(parts.hour) && Number.isFinite(parts.minute)
    ? parts.hour * 60 + parts.minute
    : null;
  const marketOpen = isRegularUsMarketHours(date);
  if (!marketOpen || !Number.isFinite(minutesSinceMidnight)) {
    return {
      regime: 'closed',
      market_open: false,
      manage_only: true,
      buys_allowed: false,
      sells_allowed: true,
      reason_code: 'MARKET_CLOSED',
      minutes_since_open: null,
      minutes_until_close: null,
    };
  }
  const minutesSinceOpen = minutesSinceMidnight - MARKET_OPEN_MINUTES;
  const minutesUntilClose = MARKET_CLOSE_MINUTES - minutesSinceMidnight;
  if (minutesSinceOpen < openingNoiseMinutes) {
    return {
      regime: 'opening_noise',
      market_open: true,
      manage_only: true,
      buys_allowed: false,
      sells_allowed: true,
      reason_code: 'OPENING_NOISE_MANAGE_ONLY',
      minutes_since_open: minutesSinceOpen,
      minutes_until_close: minutesUntilClose,
    };
  }
  if (minutesUntilClose <= nearCloseMinutes) {
    return {
      regime: 'near_close_manage_only',
      market_open: true,
      manage_only: true,
      buys_allowed: false,
      sells_allowed: true,
      reason_code: 'NEAR_CLOSE_MANAGE_ONLY',
      minutes_since_open: minutesSinceOpen,
      minutes_until_close: minutesUntilClose,
    };
  }
  return {
    regime: 'regular',
    market_open: true,
    manage_only: false,
    buys_allowed: true,
    sells_allowed: true,
    reason_code: null,
    minutes_since_open: minutesSinceOpen,
    minutes_until_close: minutesUntilClose,
  };
}

module.exports = {
  MARKET_CLOSE_MINUTES,
  MARKET_OPEN_MINUTES,
  getNewYorkMarketParts,
  isRegularUsMarketHours,
  resolveIntradayStockRegime,
  resolveMarketRegime,
};
