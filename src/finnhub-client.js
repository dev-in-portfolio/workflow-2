const path = require('path');
const { URLSearchParams } = require('url');
const { ProviderRuntime } = require('./provider-runtime');
const { comparePrice, finiteNumber, timestampInfo } = require('./provider-normalization');
const { fetchJsonWithTimeout } = require('./source-fetch');
const { nowIso } = require('./util');

function createFinnhubClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const key = String(env.FINNHUB_API_KEY || '').trim();
  const enabled = String(env.FINNHUB_ENABLED || 'false').toLowerCase() === 'true';
  const runtime = options.runtime || new ProviderRuntime({ provider: 'finnhub', maxRequests: Number(env.FINNHUB_MAX_REQUESTS_PER_MINUTE || 30), statePath: path.resolve(options.dataDir || 'data/runtime', 'finnhub-usage.json'), logger: options.logger });
  const baseUrl = String(env.FINNHUB_BASE_URL || 'https://finnhub.io/api/v1').replace(/\/+$/, '');
  const timeoutMs = Number(env.FINNHUB_TIMEOUT_MS || 5000);
  const cacheSeconds = Number(env.FINNHUB_CACHE_SECONDS || 60);
  const maxStalenessSeconds = Number(env.FINNHUB_MAX_STALENESS_SECONDS || 90);
  const tolerancePct = Number(env.FINNHUB_MAX_PRICE_DIFFERENCE_PCT || 0.5);

  async function get(endpoint, params, cacheKey, ttl = cacheSeconds) {
    if (!enabled) return { ok: false, provider: 'finnhub', reasonCode: 'FINNHUB_DISABLED' };
    if (!key) return { ok: false, provider: 'finnhub', reasonCode: 'FINNHUB_KEY_MISSING' };
    return runtime.run(cacheKey, async () => {
      const query = new URLSearchParams(params);
      const result = await fetchJsonWithTimeout(fetchImpl, `${baseUrl}/${endpoint}?${query}` , { timeoutMs, headers: { 'X-Finnhub-Token': key } });
      if ([401, 403].includes(result.status)) return { ok: false, provider: 'finnhub', reasonCode: result.status === 401 ? 'FINNHUB_AUTH_FAILED' : 'FINNHUB_ENTITLEMENT_MISSING' };
      if (result.status === 429) return { ok: false, provider: 'finnhub', reasonCode: 'FINNHUB_RATE_LIMITED' };
      if (!result.ok || result.body?.error) return { ok: false, provider: 'finnhub', reasonCode: 'FINNHUB_PROVIDER_FAILURE' };
      return { ok: true, body: result.body };
    }, { cacheSeconds: ttl });
  }

  async function quote(symbol, primaryPrice = null) {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    const result = await get('quote', { symbol: normalizedSymbol }, `quote:${normalizedSymbol}`);
    if (!result.ok) return result;
    const price = finiteNumber(result.body?.c);
    const time = timestampInfo(result.body?.t, maxStalenessSeconds);
    if (!(price > 0)) return { ok: false, provider: 'finnhub', reasonCode: 'FINNHUB_MALFORMED_RESPONSE' };
    if (time.freshness !== 'real_time') return { ok: false, provider: 'finnhub', reasonCode: time.freshness === 'stale' ? 'FINNHUB_STALE' : 'FINNHUB_DELAYED_DATA', ...time };
    const comparison = comparePrice(primaryPrice, price, tolerancePct);
    if (primaryPrice !== null && !comparison.pass) return { ok: false, provider: 'finnhub', reasonCode: 'FINNHUB_PRICE_MISMATCH', differencePct: comparison.differencePct, ...time };
    return { ok: true, provider: 'finnhub', symbol: normalizedSymbol, dataType: 'quote', price, open: finiteNumber(result.body?.o), high: finiteNumber(result.body?.h), low: finiteNumber(result.body?.l), previousClose: finiteNumber(result.body?.pc), providerTimestamp: time.providerTimestamp, ageSeconds: time.ageSeconds, freshness: time.freshness, receivedAt: nowIso(), entitlement: 'available', sourceQuality: 'secondary_confirmation', rawDataExcluded: true, differencePct: comparison.differencePct, cached: Boolean(result.cached) };
  }

  async function news(symbol, from, to) {
    const result = await get('company-news', { symbol, from, to }, `news:${symbol}:${from}:${to}`, 300);
    if (!result.ok) return result;
    const seen = new Set();
    const items = (Array.isArray(result.body) ? result.body : []).filter((item) => {
      const id = String(item.id || item.url || `${item.datetime}:${item.headline}`);
      if (seen.has(id)) return false;
      seen.add(id); return true;
    }).map((item) => {
      const publication = timestampInfo(item.datetime, Number.MAX_SAFE_INTEGER);
      return { provider: 'finnhub', id: String(item.id || item.url || ''), headline: item.headline || null, source: item.source || null, url: item.url || null, publicationTimestamp: publication.providerTimestamp, ageSeconds: publication.ageSeconds, relatedSymbols: String(item.related || symbol).split(',').filter(Boolean), category: item.category || null, summary: item.summary || null };
    });
    return { ok: true, provider: 'finnhub', dataType: 'news', items, cached: Boolean(result.cached) };
  }

  async function profile(symbol) {
    const result = await get('stock/profile2', { symbol }, `profile:${symbol}`, 3600);
    if (!result.ok) return result;
    return { ok: true, provider: 'finnhub', symbol, dataType: 'company_profile', profile: { name: result.body?.name || null, exchange: result.body?.exchange || null, industry: result.body?.finnhubIndustry || null, marketCap: finiteNumber(result.body?.marketCapitalization), sharesOutstanding: finiteNumber(result.body?.shareOutstanding) }, receivedAt: nowIso(), freshness: 'historical', cached: Boolean(result.cached), rawDataExcluded: true };
  }

  async function basicFinancials(symbol) {
    const normalized = String(symbol || '').trim().toUpperCase();
    const result = await get('stock/metric', { symbol: normalized, metric: 'all' }, `metrics:${normalized}`, 3600);
    if (!result.ok) return result;
    const metric = result.body?.metric;
    if (!metric || typeof metric !== 'object') return { ok: false, provider: 'finnhub', reasonCode: 'FINNHUB_MALFORMED_RESPONSE' };
    return { ok: true, provider: 'finnhub', symbol: normalized, dataType: 'fundamentals', metrics: metric, receivedAt: nowIso(), freshness: 'historical', liveConfirmationEligible: false, cached: Boolean(result.cached), rawDataExcluded: true };
  }

  async function earningsCalendar({ symbol = '', from, to } = {}) {
    const normalized = String(symbol || '').trim().toUpperCase();
    const result = await get('calendar/earnings', { from, to, ...(normalized ? { symbol: normalized } : {}) }, `earnings:${normalized}:${from}:${to}`, 10800);
    if (!result.ok) return result;
    const items = Array.isArray(result.body?.earningsCalendar) ? result.body.earningsCalendar : [];
    return { ok: true, provider: 'finnhub', symbol: normalized || null, dataType: 'earnings_calendar', items, receivedAt: nowIso(), freshness: 'historical', liveConfirmationEligible: false, cached: Boolean(result.cached), rawDataExcluded: true };
  }

  async function marketStatus(exchange = 'US') {
    const result = await get('stock/market-status', { exchange }, `market-status:${exchange}`, 60);
    if (!result.ok) return result;
    if (typeof result.body?.isOpen !== 'boolean') return { ok: false, provider: 'finnhub', reasonCode: 'FINNHUB_MALFORMED_RESPONSE' };
    return { ok: true, provider: 'finnhub', dataType: 'market_status', exchange, isOpen: result.body.isOpen, session: result.body.session || null, timezone: result.body.timezone || null, receivedAt: nowIso(), liveConfirmationEligible: false, cached: Boolean(result.cached), rawDataExcluded: true };
  }

  async function selfTest(symbol = 'AAPL') {
    const result = await quote(symbol);
    runtime.health.authenticationStatus = result.reasonCode === 'FINNHUB_AUTH_FAILED' ? 'failed' : result.ok ? 'authenticated' : key ? 'unverified' : 'missing';
    runtime.health.capabilities = { authentication: runtime.health.authenticationStatus, quotes: result.ok, realTimeQuotes: Boolean(result.ok && result.freshness === 'real_time'), delayedQuotes: result.freshness === 'stale', historicalBars: 'untested', referenceData: 'untested', companyProfile: 'untested', fundamentals: 'untested', news: 'untested', corporateActions: false, earningsCalendar: 'untested' };
    return { provider: 'finnhub', capabilities: runtime.health.capabilities, reasonCode: result.reasonCode || null };
  }
  return { quote, news, profile, basicFinancials, earningsCalendar, marketStatus, selfTest, health: () => runtime.snapshot({ enabled, configured: Boolean(key), status: !enabled ? 'disabled' : key ? runtime.health.status : 'degraded', credentialPresent: Boolean(key), authenticationStatus: runtime.health.authenticationStatus }) };
}

module.exports = { createFinnhubClient };
