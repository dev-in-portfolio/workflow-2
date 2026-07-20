const path = require('path');
const { ProviderRuntime } = require('./provider-runtime');
const { comparePrice, finiteNumber, timestampInfo } = require('./provider-normalization');
const { fetchJsonWithTimeout } = require('./source-fetch');
const { nowIso } = require('./util');

function createMassiveClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const key = String(env.MASSIVE_API_KEY || env.POLYGON_API_KEY || '').trim();
  const enabled = String(env.MASSIVE_ENABLED ?? env.MEME_SOURCE_POLYGON_ENABLED ?? 'false').toLowerCase() === 'true';
  const runtime = options.runtime || new ProviderRuntime({ provider: 'massive', maxRequests: Number(env.MASSIVE_MAX_REQUESTS_PER_MINUTE || 5), statePath: path.resolve(options.dataDir || 'data/runtime', 'massive-usage.json'), logger: options.logger });
  const baseUrl = String(env.MASSIVE_BASE_URL || 'https://api.massive.com').replace(/\/+$/, '');
  const timeoutMs = Number(env.MASSIVE_TIMEOUT_MS || 5000);
  const cacheSeconds = Number(env.MASSIVE_CACHE_SECONDS || 60);
  const maxStalenessSeconds = Number(env.MASSIVE_MAX_STALENESS_SECONDS || 90);
  const tolerancePct = Number(env.MASSIVE_MAX_PRICE_DIFFERENCE_PCT || 0.5);

  async function quote(symbol, primaryPrice = null) {
    if (!enabled) return { ok: false, provider: 'massive', reasonCode: 'MASSIVE_DISABLED' };
    if (!key) return { ok: false, provider: 'massive', reasonCode: 'MASSIVE_KEY_MISSING' };
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    return runtime.run(`quote:${normalizedSymbol}`, async () => {
      const url = `${baseUrl}/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(normalizedSymbol)}`;
      const result = await fetchJsonWithTimeout(fetchImpl, url, { timeoutMs, headers: { authorization: `Bearer ${key}` } });
      if ([401, 403].includes(result.status)) return { ok: false, provider: 'massive', reasonCode: result.status === 401 ? 'MASSIVE_AUTH_FAILED' : 'MASSIVE_ENTITLEMENT_MISSING' };
      if (result.status === 429) return { ok: false, provider: 'massive', reasonCode: 'MASSIVE_RATE_LIMITED' };
      if (!result.ok || result.body?.status === 'ERROR' || result.body?.error) return { ok: false, provider: 'massive', reasonCode: 'MASSIVE_PROVIDER_FAILURE' };
      const snapshot = result.body?.ticker || result.body?.results || {};
      const trade = snapshot.lastTrade || snapshot.latestTrade || {};
      const quoteData = snapshot.lastQuote || snapshot.latestQuote || {};
      const day = snapshot.day || {};
      const previous = snapshot.prevDay || snapshot.previousDay || {};
      const price = finiteNumber(trade.p ?? trade.price ?? day.c);
      const time = timestampInfo(trade.t ?? trade.timestamp ?? snapshot.updated, maxStalenessSeconds);
      if (!(price > 0)) return { ok: false, provider: 'massive', reasonCode: 'MASSIVE_MALFORMED_RESPONSE' };
      if (time.freshness !== 'real_time') return { ok: false, provider: 'massive', reasonCode: time.freshness === 'stale' ? 'MASSIVE_STALE' : 'MASSIVE_DELAYED_DATA', ...time };
      const comparison = comparePrice(primaryPrice, price, tolerancePct);
      if (primaryPrice !== null && !comparison.pass) return { ok: false, provider: 'massive', reasonCode: 'MASSIVE_PRICE_MISMATCH', differencePct: comparison.differencePct, ...time };
      return { ok: true, provider: 'massive', symbol: normalizedSymbol, dataType: 'quote', price, bid: finiteNumber(quoteData.p ?? quoteData.bp), ask: finiteNumber(quoteData.P ?? quoteData.ap), open: finiteNumber(day.o), high: finiteNumber(day.h), low: finiteNumber(day.l), previousClose: finiteNumber(previous.c), volume: finiteNumber(day.v), receivedAt: nowIso(), entitlement: 'available', sourceQuality: 'secondary_confirmation', rawDataExcluded: true, differencePct: comparison.differencePct, ...time };
    }, { cacheSeconds });
  }

  async function selfTest(symbol = 'AAPL') {
    const result = await quote(symbol);
    runtime.health.authenticationStatus = result.reasonCode === 'MASSIVE_AUTH_FAILED' ? 'failed' : result.ok ? 'authenticated' : key ? 'unverified' : 'missing';
    runtime.health.capabilities = { authentication: runtime.health.authenticationStatus, quotes: result.ok, realTimeQuotes: Boolean(result.ok && result.freshness === 'real_time'), delayedQuotes: result.freshness === 'stale', historicalBars: 'untested', referenceData: 'untested', companyProfile: 'untested', fundamentals: false, news: 'untested', corporateActions: 'untested', earningsCalendar: false };
    return { provider: 'massive', capabilities: runtime.health.capabilities, reasonCode: result.reasonCode || null };
  }

  async function reference(symbol) {
    const normalized = String(symbol || '').trim().toUpperCase();
    return requestJson(`/v3/reference/tickers/${encodeURIComponent(normalized)}`, `reference:${normalized}`, 'reference_data', 86400);
  }

  async function aggregates(symbol, { from, to, multiplier = 1, timespan = 'minute' } = {}) {
    const normalized = String(symbol || '').trim().toUpperCase();
    return requestJson(`/v2/aggs/ticker/${encodeURIComponent(normalized)}/range/${Math.max(1, Number(multiplier) || 1)}/${encodeURIComponent(timespan)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}?adjusted=true&sort=desc&limit=500`, `aggregates:${normalized}:${multiplier}:${timespan}:${from}:${to}`, 'historical_bars', cacheSeconds);
  }

  async function dividends(symbol) {
    const normalized = String(symbol || '').trim().toUpperCase();
    return requestJson(`/v3/reference/dividends?ticker=${encodeURIComponent(normalized)}&limit=20`, `dividends:${normalized}`, 'corporate_actions', 21600);
  }

  async function news(symbol) {
    const normalized = String(symbol || '').trim().toUpperCase();
    return requestJson(`/v2/reference/news?ticker=${encodeURIComponent(normalized)}&limit=20`, `news:${normalized}`, 'news', 300);
  }

  async function requestJson(pathname, cacheKey, dataType, ttl) {
    if (!enabled) return { ok: false, provider: 'massive', reasonCode: 'MASSIVE_DISABLED' };
    if (!key) return { ok: false, provider: 'massive', reasonCode: 'MASSIVE_KEY_MISSING' };
    return runtime.run(cacheKey, async () => {
      const result = await fetchJsonWithTimeout(fetchImpl, `${baseUrl}${pathname}`, { timeoutMs, headers: { authorization: `Bearer ${key}` } });
      if (result.status === 401) return { ok: false, provider: 'massive', reasonCode: 'MASSIVE_AUTH_FAILED' };
      if (result.status === 403) return { ok: false, provider: 'massive', reasonCode: 'MASSIVE_ENTITLEMENT_MISSING' };
      if (result.status === 429) return { ok: false, provider: 'massive', reasonCode: 'MASSIVE_RATE_LIMITED' };
      if (!result.ok || result.body?.status === 'ERROR' || result.body?.error) return { ok: false, provider: 'massive', reasonCode: 'MASSIVE_PROVIDER_FAILURE' };
      return { ok: true, provider: 'massive', dataType, items: result.body?.results ?? result.body, receivedAt: nowIso(), freshness: dataType === 'historical_bars' ? 'historical' : 'reference', liveConfirmationEligible: false, rawDataExcluded: true };
    }, { cacheSeconds: ttl });
  }
  return { quote, reference, aggregates, dividends, news, selfTest, health: () => runtime.snapshot({ enabled, configured: Boolean(key), status: !enabled ? 'disabled' : key ? runtime.health.status : 'degraded', credentialPresent: Boolean(key), authenticationStatus: runtime.health.authenticationStatus, providerLabel: 'Massive (formerly Polygon.io)', legacyPolygonAliasUsed: Boolean(!env.MASSIVE_API_KEY && env.POLYGON_API_KEY) }) };
}

module.exports = { createMassiveClient };
