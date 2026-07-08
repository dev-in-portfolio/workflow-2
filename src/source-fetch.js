const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { hashObject, nowIso, safeNumber } = require('./util');

const REDACT_QUERY_KEYS = new Set([
  'apikey',
  'api_key',
  'access_token',
  'token',
  'secret',
  'client_secret',
  'password',
  'key',
]);

const REDACT_TEXT_PATTERNS = [
  /(authorization\s*:\s*)(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b((?:apikey|api_key|access_token|client_secret|password|token|secret))=([^&\s]+)/gi,
];

function redactSourceUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    for (const [key] of url.searchParams.entries()) {
      if (REDACT_QUERY_KEYS.has(key.trim().toLowerCase())) {
        url.searchParams.set(key, 'REDACTED');
      }
    }
    return url.toString();
  } catch {
    return String(value).replace(/([?&](?:apikey|api_key|access_token|token|secret|client_secret|password|key)=)[^&]*/gi, '$1REDACTED');
  }
}

function redactSourceMessage(value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string'
    ? value
    : typeof value === 'object'
      ? extractMessage(value) || JSON.stringify(value)
      : String(value);
  let redacted = redactSourceUrl(text);
  for (const pattern of REDACT_TEXT_PATTERNS) {
    if (pattern.source.includes('authorization')) {
      redacted = redacted.replace(pattern, '$1$2 REDACTED');
    } else if (pattern.source.includes('bearer') || pattern.source.includes('basic')) {
      redacted = redacted.replace(pattern, '$1 REDACTED');
    } else {
      redacted = redacted.replace(pattern, '$1=REDACTED');
    }
  }
  return redacted;
}

async function fetchJsonWithTimeout(fetchImpl, url, options = {}) {
  const cache = options.cache ? readSourceCache(options.cache) : null;
  if (cache?.fresh) {
    return {
      response: buildCachedResponse(cache.payload, 200),
      ok: true,
      status: 200,
      body: cache.payload,
      text: typeof cache.payload === 'string' ? cache.payload : JSON.stringify(cache.payload ?? {}),
      cache: {
        used: true,
        hit: true,
        ageSeconds: cache.ageSeconds,
        ttlSeconds: cache.ttlSeconds,
        stale: false,
      },
      url: redactSourceUrl(url),
    };
  }
  const response = await fetchWithTimeout(fetchImpl, url, options);
  const text = await readResponseText(response);
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (options.cache && response.ok) {
    writeSourceCache(options.cache, body);
  }
  return {
    response,
    ok: response.ok,
    status: response.status,
    body,
    text,
    cache: options.cache ? buildCacheMetaAfterFetch(options.cache) : defaultCacheMeta(),
    url: redactSourceUrl(url),
  };
}

async function fetchTextWithTimeout(fetchImpl, url, options = {}) {
  const cache = options.cache ? readSourceCache(options.cache) : null;
  if (cache?.fresh) {
    return {
      response: buildCachedResponse(cache.payload, 200),
      ok: true,
      status: 200,
      text: typeof cache.payload === 'string' ? cache.payload : JSON.stringify(cache.payload ?? {}),
      cache: {
        used: true,
        hit: true,
        ageSeconds: cache.ageSeconds,
        ttlSeconds: cache.ttlSeconds,
        stale: false,
      },
      url: redactSourceUrl(url),
    };
  }
  const response = await fetchWithTimeout(fetchImpl, url, options);
  const text = await readResponseText(response);
  if (options.cache && response.ok) {
    writeSourceCache(options.cache, text);
  }
  return {
    response,
    ok: response.ok,
    status: response.status,
    text,
    cache: options.cache ? buildCacheMetaAfterFetch(options.cache) : defaultCacheMeta(),
    url: redactSourceUrl(url),
  };
}

async function fetchWithTimeout(fetchImpl, url, { timeoutMs = 5000, headers = {}, cache: _cache, ...init } = {}) {
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

function classifyHttpSourceStatus(statusCode, payload = null, fallback = 'source_not_found_or_inaccessible') {
  const code = Number(statusCode);
  const message = redactSourceMessage(payload) || `HTTP ${code}`;
  if (code === 401) return { status: 'missing_credentials', blockedReason: 'missing_credentials', lastError: message || 'Credentials rejected', available: false };
  if (code === 403) {
    const text = String(message || '').toLowerCase();
    const blockedReason = /quarant|restrict/.test(text) ? 'quarantined_or_restricted' : 'source_private_or_banned';
    return { status: blockedReason, blockedReason, lastError: message || 'Source inaccessible', available: false };
  }
  if (code === 404) return { status: 'source_not_found_or_inaccessible', blockedReason: 'source_not_found_or_inaccessible', lastError: message || 'Source not found', available: false };
  if (code === 429) return { status: 'rate_limited', blockedReason: 'rate_limited', lastError: message || 'Rate limited', available: false };
  if (code >= 500) return { status: 'error', blockedReason: fallback, lastError: message || `HTTP ${code}`, available: false };
  return { status: 'source_not_found_or_inaccessible', blockedReason: fallback, lastError: message || `HTTP ${code}`, available: false };
}

function buildSourceStatus(input = {}) {
  return {
    source: input.source || null,
    enabled: Boolean(input.enabled),
    available: Boolean(input.available),
    status: String(input.status || 'off').toLowerCase(),
    lastRunAt: input.lastRunAt || null,
    lastScanAt: input.lastScanAt || input.lastRunAt || null,
    lastError: input.lastError || null,
    blockedReason: input.blockedReason || null,
    cache: normalizeCacheMeta(input.cache),
    ...stripKnownFields(input),
  };
}

function normalizeCacheMeta(cache = null) {
  if (!cache) {
    return defaultCacheMeta();
  }
  return {
    used: Boolean(cache.used),
    hit: Boolean(cache.hit),
    ageSeconds: Number.isFinite(Number(cache.ageSeconds)) ? Number(cache.ageSeconds) : null,
    ttlSeconds: Number.isFinite(Number(cache.ttlSeconds)) ? Number(cache.ttlSeconds) : null,
    stale: Boolean(cache.stale),
  };
}

function defaultCacheMeta() {
  return {
    used: false,
    hit: false,
    ageSeconds: null,
    ttlSeconds: null,
    stale: false,
  };
}

function stripKnownFields(input = {}) {
  const out = { ...input };
  delete out.source;
  delete out.enabled;
  delete out.available;
  delete out.status;
  delete out.lastRunAt;
  delete out.lastScanAt;
  delete out.lastError;
  delete out.blockedReason;
  delete out.cache;
  return out;
}

function resolveCacheResult(cache = {}) {
  const entry = readSourceCache(cache);
  if (!entry) return defaultCacheMeta();
  return {
    used: true,
    hit: entry.fresh,
    ageSeconds: entry.ageSeconds,
    ttlSeconds: entry.ttlSeconds,
    stale: Boolean(entry.stale),
  };
}

function buildCacheMetaAfterFetch(cache = {}) {
  if (!cache) return defaultCacheMeta();
  const existing = readSourceCache(cache);
  const stale = Boolean(existing?.stale);
  return {
    used: false,
    hit: false,
    ageSeconds: existing?.ageSeconds ?? null,
    ttlSeconds: Number.isFinite(Number(cache.ttlSeconds)) ? Number(cache.ttlSeconds) : existing?.ttlSeconds ?? null,
    stale,
  };
}

function readSourceCache(cache = {}) {
  const filePath = resolveSourceCachePath(cache);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const storedAt = new Date(payload.storedAt || payload.stored_at || 0).getTime();
    if (!Number.isFinite(storedAt)) return null;
    const ttlSeconds = Math.max(0, Number(cache.ttlSeconds ?? payload.ttlSeconds ?? payload.ttl_seconds ?? 0) || 0);
    if (ttlSeconds <= 0) return null;
    const ageSeconds = Math.max(0, (Date.now() - storedAt) / 1000);
    return {
      ...payload,
      fresh: ageSeconds <= ttlSeconds,
      stale: ageSeconds > ttlSeconds,
      ageSeconds,
      ttlSeconds,
    };
  } catch {
    return null;
  }
}

function writeSourceCache(cache = {}, payload = {}) {
  const filePath = resolveSourceCachePath(cache);
  if (!filePath) return null;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const entry = {
    storedAt: nowIso(),
    source: cache.source || payload.source || null,
    category: cache.category || null,
    cacheKey: cache.key || null,
    ttlSeconds: Number(cache.ttlSeconds || 0) || 0,
    payload,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  return entry;
}

function buildCachedResponse(payload, status = 200) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return typeof payload === 'string' ? JSON.parse(payload) : payload;
    },
    async text() {
      return text;
    },
  };
}

function resolveSourceCachePath(cache = {}) {
  const cacheDir = cache.cacheDir || cache.dir || null;
  const source = String(cache.source || '').trim();
  const category = String(cache.category || '').trim();
  const key = String(cache.key || '').trim();
  if (!cacheDir || !source || !category || !key) return null;
  const digest = hashObject({ source, category, key });
  return path.join(path.resolve(cacheDir), source, category, `${digest}.json`);
}

function stableCacheKey(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function extractMessage(payload = null) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  return payload.message || payload.error || payload.detail || payload.raw || null;
}

async function readResponseText(response) {
  if (response && typeof response.text === 'function') {
    return response.text();
  }
  if (response && typeof response.json === 'function') {
    try {
      const payload = await response.json();
      return typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
    } catch {
      return '';
    }
  }
  return '';
}

module.exports = {
  buildSourceStatus,
  classifyHttpSourceStatus,
  defaultCacheMeta,
  fetchJsonWithTimeout,
  fetchTextWithTimeout,
  fetchWithTimeout,
  normalizeCacheMeta,
  readSourceCache,
  redactSourceMessage,
  redactSourceUrl,
  resolveSourceCachePath,
  resolveCacheResult,
  stableCacheKey,
  writeSourceCache,
};
