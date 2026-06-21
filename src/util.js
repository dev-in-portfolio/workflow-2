const crypto = require('crypto');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashObject(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function minutesBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60000;
}

module.exports = {
  asArray,
  clamp,
  hashObject,
  minutesBetween,
  nowIso,
  safeNumber,
  stableStringify,
};
