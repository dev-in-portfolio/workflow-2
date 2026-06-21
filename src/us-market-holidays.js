function isUsMarketHoliday(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const holidays = buildHolidaySet(year);
  return holidays.has(`${year}-${pad2(month)}-${pad2(day)}`);
}

function buildHolidaySet(year) {
  const holidays = new Set();
  holidays.add(observedFixedHoliday(year, 1, 1));
  holidays.add(nthWeekdayOfMonth(year, 1, 1, 3));
  holidays.add(nthWeekdayOfMonth(year, 2, 1, 3));
  holidays.add(easterFriday(year));
  holidays.add(lastWeekdayOfMonth(year, 5, 1));
  holidays.add(observedFixedHoliday(year, 6, 19));
  holidays.add(observedFixedHoliday(year, 7, 4));
  holidays.add(nthWeekdayOfMonth(year, 9, 1, 1));
  holidays.add(nthWeekdayOfMonth(year, 11, 4, 4));
  holidays.add(observedFixedHoliday(year, 12, 25));
  return holidays;
}

function observedFixedHoliday(year, month, day) {
  const actual = Date.UTC(year, month - 1, day);
  const weekday = new Date(actual).getUTCDay();
  if (weekday === 0) {
    return `${year}-${pad2(month)}-${pad2(day + 1)}`;
  }
  if (weekday === 6) {
    return `${year}-${pad2(month)}-${pad2(day - 1)}`;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function nthWeekdayOfMonth(year, month, weekday, nth) {
  let count = 0;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= daysInMonth; day += 1) {
    const current = new Date(Date.UTC(year, month - 1, day));
    if (current.getUTCDay() === weekday) {
      count += 1;
      if (count === nth) {
        return `${year}-${pad2(month)}-${pad2(day)}`;
      }
    }
  }
  return null;
}

function lastWeekdayOfMonth(year, month, weekday) {
  for (let day = new Date(Date.UTC(year, month, 0)).getUTCDate(); day >= 1; day -= 1) {
    const current = new Date(Date.UTC(year, month - 1, day));
    if (current.getUTCDay() === weekday) {
      return `${year}-${pad2(month)}-${pad2(day)}`;
    }
  }
  return null;
}

function easterFriday(year) {
  const easterSunday = calculateEasterSunday(year);
  const goodFriday = new Date(easterSunday.getTime() - 2 * 24 * 60 * 60 * 1000);
  return `${goodFriday.getUTCFullYear()}-${pad2(goodFriday.getUTCMonth() + 1)}-${pad2(goodFriday.getUTCDate())}`;
}

function calculateEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

module.exports = {
  buildHolidaySet,
  isUsMarketHoliday,
};
