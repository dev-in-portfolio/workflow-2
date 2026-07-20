const fs = require('fs');
const path = require('path');
const { normalizeMarketData } = require('./market-data');
const { nowIso, safeNumber, resolveRepoRoot } = require('./util');

const TwelveDataReason = Object.freeze({
  DISABLED: 'TWELVE_DATA_DISABLED',
  NOT_CONFIGURED: 'TWELVE_DATA_NOT_CONFIGURED',
  CONFIRMATION_PASSED: 'TWELVE_DATA_CONFIRMATION_PASSED',
  PRICE_MISMATCH: 'TWELVE_DATA_PRICE_MISMATCH',
  STALE: 'TWELVE_DATA_STALE',
  UNAVAILABLE: 'TWELVE_DATA_UNAVAILABLE',
  MINUTE_LIMIT: 'TWELVE_DATA_MINUTE_LIMIT',
  DAILY_BUDGET: 'TWELVE_DATA_DAILY_BUDGET_REACHED',
  RATE_LIMITED: 'TWELVE_DATA_RATE_LIMITED',
  AUTH_FAILED: 'TWELVE_DATA_AUTH_FAILED',
  TIMEOUT: 'TWELVE_DATA_TIMEOUT',
  PROVIDER_ERROR: 'TWELVE_DATA_PROVIDER_ERROR',
  MALFORMED: 'TWELVE_DATA_MALFORMED_RESPONSE',
});

function createTwelveDataClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const clock = options.clock || (() => new Date());
  const logger = options.logger || (() => {});
  const enabled = options.enabled ?? parseBoolish(env.TWELVE_DATA_ENABLED, false);
  const apiKey = String(options.apiKey ?? env.TWELVE_DATA_API_KEY ?? '').trim();
  const configured = apiKey.length > 0;
  const baseUrl = trimTrailingSlash(options.baseUrl || env.TWELVE_DATA_BASE_URL || 'https://api.twelvedata.com');
  const timeoutMs = boundedInt(options.timeoutMs ?? env.TWELVE_DATA_TIMEOUT_MS, 5000, 100, 30000);
  const cacheMs = boundedInt(options.cacheSeconds ?? env.TWELVE_DATA_CACHE_SECONDS, 60, 0, 3600) * 1000;
  const minuteLimit = boundedInt(options.maxRequestsPerMinute ?? env.TWELVE_DATA_MAX_REQUESTS_PER_MINUTE, 8, 1, 1000);
  const dailyLimit = boundedInt(options.maxDailyCredits ?? env.TWELVE_DATA_MAX_DAILY_CREDITS, 800, 1, 1000000);
  const reserve = boundedInt(options.dailyReserveCredits ?? env.TWELVE_DATA_DAILY_RESERVE_CREDITS, 40, 0, dailyLimit);
  const maxSymbolsPerCycle = boundedInt(options.maxSymbolsPerCycle ?? env.TWELVE_DATA_MAX_SYMBOLS_PER_CYCLE, 2, 0, 50);
  const maxStalenessSeconds = boundedInt(options.maxStalenessSeconds ?? env.TWELVE_DATA_MAX_STALENESS_SECONDS, 90, 1, 3600);
  const maxPriceDifferencePct = Math.max(0, safeNumber(options.maxPriceDifferencePct ?? env.TWELVE_DATA_MAX_PRICE_DIFFERENCE_PCT, 0.5));
  const statePath = path.resolve(options.statePath || env.TWELVE_DATA_USAGE_STATE_PATH || path.join(options.repoRoot || resolveRepoRoot(), 'data', 'runtime', 'twelve-data-usage.json'));
  const cache = new Map();
  const inflight = new Map();
  const minuteRequests = [];
  let usage = loadUsage(statePath, providerDay(clock()));
  let health = initialHealth({ enabled, configured, usage, dailyLimit, reserve });

  function refreshDay() {
    const day = providerDay(clock());
    if (usage.provider_day !== day) {
      usage = { schema_version: 1, provider_day: day, estimated_daily_credits_used: 0, updated_at: iso(clock()) };
      persistUsage(statePath, usage);
    }
    const cutoff = clock().getTime() - 60000;
    while (minuteRequests.length && minuteRequests[0] <= cutoff) minuteRequests.shift();
  }

  function blockReason() {
    refreshDay();
    if (!enabled) return TwelveDataReason.DISABLED;
    if (!configured) return TwelveDataReason.NOT_CONFIGURED;
    if (minuteRequests.length >= minuteLimit) return TwelveDataReason.MINUTE_LIMIT;
    if (usage.estimated_daily_credits_used >= Math.max(0, dailyLimit - reserve)) return TwelveDataReason.DAILY_BUDGET;
    return null;
  }

  async function getQuote(symbol) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const attemptedAt = iso(clock());
    health.last_attempted_request = attemptedAt;
    if (!normalizedSymbol) return failure(TwelveDataReason.MALFORMED, attemptedAt);
    const cached = cache.get(normalizedSymbol);
    if (cached && clock().getTime() - cached.cached_at_ms < cacheMs) {
      health.cache_hits += 1;
      return { ...cached.result, cache: { hit: true, age_seconds: Math.max(0, (clock().getTime() - cached.cached_at_ms) / 1000) } };
    }
    health.cache_misses += 1;
    if (inflight.has(normalizedSymbol)) return inflight.get(normalizedSymbol);
    const reason = blockReason();
    if (reason) return failure(reason, attemptedAt);
    const promise = requestQuote(normalizedSymbol, attemptedAt).finally(() => inflight.delete(normalizedSymbol));
    inflight.set(normalizedSymbol, promise);
    return promise;
  }

  async function requestQuote(symbol, attemptedAt) {
    refreshDay();
    minuteRequests.push(clock().getTime());
    usage.estimated_daily_credits_used += 1;
    usage.updated_at = iso(clock());
    persistUsage(statePath, usage);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = clock().getTime();
    try {
      const url = `${baseUrl}/quote?symbol=${encodeURIComponent(symbol)}`;
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `apikey ${apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      const body = await readJson(response);
      const providerError = classifyProviderError(response.status, body);
      if (!response.ok || providerError) return failure(providerError || TwelveDataReason.PROVIDER_ERROR, attemptedAt, response.status);
      const quote = normalizeQuote(body, { receivedAt: iso(clock()), maxStalenessSeconds });
      if (!quote.ok) return failure(quote.reason_code, attemptedAt, response.status);
      const result = { ok: true, reason_code: TwelveDataReason.CONFIRMATION_PASSED, quote: quote.record, cache: { hit: false, age_seconds: 0 } };
      cache.set(symbol, { cached_at_ms: clock().getTime(), result });
      const previousStatus = health.status;
      health = { ...health, healthy: !quote.record.stale, status: quote.record.stale ? 'stale' : 'healthy', last_successful_request: iso(clock()), last_error_reason: quote.record.stale ? TwelveDataReason.STALE : null, last_response_age_seconds: quote.record.data_age_seconds, provider_latency_ms: Math.max(0, clock().getTime() - started), authentication_state: 'authenticated' };
      log('info', 'twelve_data_request_success', { symbol, cached: false, latency_ms: health.provider_latency_ms });
      if (previousStatus !== health.status) log('info', 'twelve_data_source_health_transition', { from_status: previousStatus, to_status: health.status });
      return result;
    } catch (error) {
      const reason = error?.name === 'AbortError' ? TwelveDataReason.TIMEOUT : TwelveDataReason.UNAVAILABLE;
      return failure(reason, attemptedAt);
    } finally {
      clearTimeout(timer);
    }
  }

  async function getQuotes(symbols = []) {
    const unique = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))].slice(0, maxSymbolsPerCycle);
    const results = await Promise.all(unique.map(async (symbol) => [symbol, await getQuote(symbol)]));
    return Object.fromEntries(results);
  }

  function failure(reason, attemptedAt, httpStatus = null) {
    const status = statusForReason(reason);
    const previousStatus = health.status;
    health = { ...health, healthy: false, status, last_attempted_request: attemptedAt, last_error_reason: reason, authentication_state: reason === TwelveDataReason.AUTH_FAILED ? 'failed' : health.authentication_state };
    log(reason === TwelveDataReason.DISABLED ? 'debug' : 'warn', eventForReason(reason), { reason_code: reason, http_status: httpStatus });
    if (previousStatus !== status) log('info', 'twelve_data_source_health_transition', { from_status: previousStatus, to_status: status, reason_code: reason });
    return { ok: false, reason_code: reason, quote: null, cache: { hit: false, age_seconds: null } };
  }

  function getHealth() {
    refreshDay();
    return {
      source: 'twelve_data',
      enabled,
      configured,
      healthy: Boolean(health.healthy),
      status: enabled ? (configured ? health.status : 'degraded') : 'disabled',
      last_successful_request: health.last_successful_request,
      last_attempted_request: health.last_attempted_request,
      last_error_reason: health.last_error_reason,
      last_response_age_seconds: health.last_response_age_seconds,
      requests_used_this_minute: minuteRequests.length,
      max_requests_per_minute: minuteLimit,
      estimated_daily_credits_used: usage.estimated_daily_credits_used,
      estimated_daily_credits_remaining: Math.max(0, dailyLimit - usage.estimated_daily_credits_used),
      daily_reserve_credits: reserve,
      normal_request_budget: Math.max(0, dailyLimit - reserve),
      provider_day: usage.provider_day,
      cache_hits: health.cache_hits,
      cache_misses: health.cache_misses,
      provider_latency_ms: health.provider_latency_ms,
      authentication_state: health.authentication_state,
    };
  }

  function log(level, event, fields) {
    logger({ level, event, message: event, provider: 'twelve_data', ...fields });
  }

  return { getQuote, getQuotes, getHealth, blockReason, config: { enabled, configured, maxSymbolsPerCycle, maxStalenessSeconds, maxPriceDifferencePct } };
}

function normalizeQuote(body, options = {}) {
  if (Array.isArray(body?.data)) body = body.data[0];
  if (!body || typeof body !== 'object') return { ok: false, reason_code: TwelveDataReason.MALFORMED };
  const symbol = normalizeSymbol(body.symbol || body.code || body.ticker);
  const price = strictNumber(body.close ?? body.price ?? body.last);
  const timestamp = normalizeTimestamp(body.datetime ?? body.timestamp);
  if (!symbol || price === null) return { ok: false, reason_code: TwelveDataReason.MALFORMED };
  if (!timestamp) return { ok: false, reason_code: TwelveDataReason.MALFORMED };
  const record = normalizeMarketData({
    provider: 'twelvedata', asset_type: 'stock', kind: 'quote', symbol, timestamp,
    received_at: options.receivedAt || nowIso(), price,
    previous_close: strictNumber(body.previous_close), volume: strictNumber(body.volume),
    open: strictNumber(body.open), high: strictNumber(body.high), low: strictNumber(body.low),
    confidence: 82, reliability: 84, exchange: body.exchange || null, raw_payload: body,
  }, { receivedAt: options.receivedAt, maxStalenessSeconds: options.maxStalenessSeconds ?? 90 });
  record.open = strictNumber(body.open);
  record.high = strictNumber(body.high);
  record.low = strictNumber(body.low);
  record.data_age_seconds = record.provider_timestamp_valid ? Math.max(0, (Date.parse(record.received_at) - Date.parse(record.timestamp)) / 1000) : null;
  if (record.stale) return { ok: false, reason_code: TwelveDataReason.STALE, record };
  return { ok: true, reason_code: TwelveDataReason.CONFIRMATION_PASSED, record };
}

function classifyProviderError(status, body = {}) {
  const code = Number(body?.code || status);
  const message = String(body?.message || body?.status || '').toLowerCase();
  if (status === 401 || status === 403 || code === 401 || message.includes('api key') || message.includes('apikey')) return TwelveDataReason.AUTH_FAILED;
  if (status === 429 || code === 429 || message.includes('rate limit')) return TwelveDataReason.RATE_LIMITED;
  if (body?.status === 'error' || body?.code || status >= 400) return TwelveDataReason.PROVIDER_ERROR;
  return null;
}

function compareTwelveDataConfirmation(primary, result, options = {}) {
  if (!result?.ok || !result.quote) return { confirmed: false, reason_code: result?.reason_code || TwelveDataReason.UNAVAILABLE, price_difference_pct: null };
  if (result.quote.stale) return { confirmed: false, reason_code: TwelveDataReason.STALE, price_difference_pct: null };
  const primaryPrice = strictNumber(primary?.price);
  const secondaryPrice = strictNumber(result.quote.price);
  if (primaryPrice === null || primaryPrice <= 0 || secondaryPrice === null) return { confirmed: false, reason_code: TwelveDataReason.MALFORMED, price_difference_pct: null };
  const priceDifferencePct = Math.abs(primaryPrice - secondaryPrice) / primaryPrice * 100;
  const max = Math.max(0, safeNumber(options.maxPriceDifferencePct, 0.5));
  return { confirmed: priceDifferencePct <= max, reason_code: priceDifferencePct <= max ? TwelveDataReason.CONFIRMATION_PASSED : TwelveDataReason.PRICE_MISMATCH, price_difference_pct: Number(priceDifferencePct.toFixed(6)) };
}

function loadUsage(filePath, day) { try { const x = JSON.parse(fs.readFileSync(filePath, 'utf8')); return x?.provider_day === day ? x : { schema_version: 1, provider_day: day, estimated_daily_credits_used: 0, updated_at: null }; } catch { return { schema_version: 1, provider_day: day, estimated_daily_credits_used: 0, updated_at: null }; } }
function persistUsage(filePath, data) { try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); const tmp = `${filePath}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8'); fs.renameSync(tmp, filePath); } catch { /* Usage telemetry must not crash the scanner. */ } }
function providerDay(date) { return date.toISOString().slice(0, 10); }
function iso(date) { return date instanceof Date ? date.toISOString() : new Date(date).toISOString(); }
function initialHealth({ enabled, configured, usage, dailyLimit, reserve }) { return { healthy: false, status: enabled ? (configured ? 'unavailable' : 'degraded') : 'disabled', last_successful_request: null, last_attempted_request: null, last_error_reason: enabled && !configured ? TwelveDataReason.NOT_CONFIGURED : null, last_response_age_seconds: null, cache_hits: 0, cache_misses: 0, provider_latency_ms: null, authentication_state: configured ? 'not_validated' : 'not_configured', usage, dailyLimit, reserve }; }
function statusForReason(reason) { if (reason === TwelveDataReason.STALE) return 'stale'; if ([TwelveDataReason.MINUTE_LIMIT, TwelveDataReason.RATE_LIMITED].includes(reason)) return 'rate_limited'; if (reason === TwelveDataReason.DAILY_BUDGET) return 'quota_exhausted'; if (reason === TwelveDataReason.AUTH_FAILED) return 'authentication_failed'; if (reason === TwelveDataReason.TIMEOUT) return 'timeout'; if (reason === TwelveDataReason.DISABLED) return 'disabled'; return 'error'; }
function eventForReason(reason) { if (reason === TwelveDataReason.TIMEOUT) return 'twelve_data_timeout'; if ([TwelveDataReason.MINUTE_LIMIT, TwelveDataReason.RATE_LIMITED].includes(reason)) return 'twelve_data_rate_limit'; if (reason === TwelveDataReason.DAILY_BUDGET) return 'twelve_data_quota_protection'; if (reason === TwelveDataReason.MALFORMED) return 'twelve_data_response_validation_failed'; return 'twelve_data_request_failed'; }
async function readJson(response) { try { if (typeof response.json === 'function') return await response.json(); if (typeof response.text === 'function') return JSON.parse(await response.text()); return null; } catch { return null; } }
function normalizeSymbol(value) { return String(value || '').trim().toUpperCase(); }
function normalizeTimestamp(value) { if (!value) return null; if (/^\d+$/.test(String(value))) { const n = Number(value); return new Date(n > 1e12 ? n : n * 1000).toISOString(); } const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
function strictNumber(value) { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function boundedInt(value, fallback, min, max) { const n = Number(value); return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : fallback)); }
function parseBoolish(value, fallback) { if (value === undefined || value === null || value === '') return fallback; return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase()); }
function trimTrailingSlash(value) { return String(value || '').replace(/\/+$/, ''); }

module.exports = { createTwelveDataClient, normalizeQuote, classifyProviderError, compareTwelveDataConfirmation, TwelveDataReason, providerDay };
