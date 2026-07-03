const crypto = require('crypto');
const path = require('path');

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

function resolveRepoRoot(cwd) {
  return path.resolve(cwd || path.resolve(__dirname, '..'));
}

function resolveDataPath(...segments) {
  return path.resolve(resolveRepoRoot(), 'data', ...segments);
}

function resolveLogsPath(...segments) {
  return resolveDataPath('logs', ...segments);
}

function resolveStatePath(...segments) {
  return resolveDataPath('state', ...segments);
}

function resolveHistoryPath(...segments) {
  return resolveDataPath('history', ...segments);
}

function resolveLockPath(name) {
  return resolveDataPath('locks', `${name}.lock.json`);
}

function roundCurrency(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function roundScore(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function roundEquityPrice(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  const decimals = Math.abs(numericValue) >= 1 ? 2 : 4;
  return Number(numericValue.toFixed(decimals));
}

async function fetchWithTimeout(fetchImpl, url, { timeoutMs = 5000, headers = {}, cache: _cache, ...init } = {}) {
  // New external source adapters should prefer src/source-fetch.js so cache,
  // status classification, and redaction stay consistent across the app.
  const controller = new AbortController();
  const resolvedTimeoutMs = Math.max(1000, Number(timeoutMs) || 5000);
  const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'user-agent': 'workflow-2-meme-monitor',
        ...headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  asArray,
  clamp,
  hashObject,
  minutesBetween,
  nowIso,
  resolveDataPath,
  resolveHistoryPath,
  resolveLockPath,
  resolveLogsPath,
  resolveRepoRoot,
  resolveStatePath,
  roundCurrency,
  roundEquityPrice,
  roundScore,
  safeNumber,
  fetchWithTimeout,
  stableStringify,
};
