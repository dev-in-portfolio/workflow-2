const path = require('path');
const { ProviderRuntime } = require('./provider-runtime');
const { finiteNumber } = require('./provider-normalization');
const { fetchJsonWithTimeout } = require('./source-fetch');
const { nowIso } = require('./util');

function createFmpClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const key = String(env.FMP_API_KEY || '').trim();
  const enabled = String(env.FMP_ENABLED || 'false').toLowerCase() === 'true';
  const runtime = options.runtime || new ProviderRuntime({ provider: 'fmp', maxRequests: 60, dailyMax: Number(env.FMP_MAX_REQUESTS_PER_DAY || 250), dailyReserve: Number(env.FMP_DAILY_RESERVE_REQUESTS || 25), statePath: path.resolve(options.dataDir || 'data/runtime', 'fmp-usage.json'), logger: options.logger });
  const baseUrl = String(env.FMP_BASE_URL || 'https://financialmodelingprep.com').replace(/\/+$/, '');
  const timeoutMs = Number(env.FMP_TIMEOUT_MS || 5000);
  const cacheSeconds = Number(env.FMP_CACHE_SECONDS || 3600);

  async function request(pathname, cacheKey) {
    if (!enabled) return { ok: false, provider: 'fmp', reasonCode: 'FMP_DISABLED' };
    if (!key) return { ok: false, provider: 'fmp', reasonCode: 'FMP_KEY_MISSING' };
    return runtime.run(cacheKey, async () => {
      const result = await fetchJsonWithTimeout(fetchImpl, `${baseUrl}${pathname}`, { timeoutMs, headers: { apikey: key } });
      if ([401, 403].includes(result.status)) return { ok: false, provider: 'fmp', reasonCode: result.status === 401 ? 'FMP_AUTH_FAILED' : 'FMP_ENTITLEMENT_MISSING' };
      if (result.status === 429) return { ok: false, provider: 'fmp', reasonCode: 'FMP_RATE_LIMITED' };
      if (!result.ok || result.body?.['Error Message'] || result.body?.error) return { ok: false, provider: 'fmp', reasonCode: 'FMP_DATA_UNAVAILABLE' };
      return { ok: true, body: result.body };
    }, { cacheSeconds });
  }

  async function fundamentals(symbol) {
    const normalized = String(symbol || '').trim().toUpperCase();
    const profileResult = await request(`/stable/profile?symbol=${encodeURIComponent(normalized)}`, `profile:${normalized}`);
    if (!profileResult.ok) return profileResult;
    const profile = Array.isArray(profileResult.body) ? profileResult.body[0] : profileResult.body;
    if (!profile || typeof profile !== 'object') return { ok: false, provider: 'fmp', reasonCode: 'FMP_DATA_UNAVAILABLE' };
    const normalizedProfile = {
      name: profile.companyName || profile.companyNameLong || null,
      exchange: profile.exchangeShortName || profile.exchange || null,
      sector: profile.sector || null,
      industry: profile.industry || null,
      marketCap: finiteNumber(profile.mktCap ?? profile.marketCap),
      sharesOutstanding: finiteNumber(profile.sharesOutstanding),
      floatShares: finiteNumber(profile.floatShares),
      beta: finiteNumber(profile.beta),
    };
    const evidence = [];
    if (normalizedProfile.marketCap !== null && normalizedProfile.marketCap < 300000000) evidence.push({ flag: 'micro_cap', value: normalizedProfile.marketCap, field: 'marketCap' });
    if (normalizedProfile.floatShares !== null && normalizedProfile.floatShares < 20000000) evidence.push({ flag: 'low_float', value: normalizedProfile.floatShares, field: 'floatShares' });
    return { ok: true, provider: 'fmp', symbol: normalized, dataType: 'fundamentals', profile: normalizedProfile, derivedFlags: evidence, providerTimestamp: null, receivedAt: nowIso(), freshness: 'historical', entitlement: 'available', sourceQuality: 'fundamentals_reference', rawDataExcluded: true, liveConfirmationEligible: false, cached: Boolean(profileResult.cached), reasonCode: 'FMP_FUNDAMENTALS_AVAILABLE' };
  }

  async function collection(endpoint, symbol, dataType, ttl = cacheSeconds, extra = '') {
    const normalized = String(symbol || '').trim().toUpperCase();
    if (!enabled) return { ok: false, provider: 'fmp', reasonCode: 'FMP_DISABLED' };
    if (!key) return { ok: false, provider: 'fmp', reasonCode: 'FMP_KEY_MISSING' };
    const result = await runtime.run(`${dataType}:${normalized}:${extra}`, async () => {
      const suffix = extra ? `&${extra}` : '';
      const response = await fetchJsonWithTimeout(fetchImpl, `${baseUrl}/stable/${endpoint}?symbol=${encodeURIComponent(normalized)}${suffix}`, { timeoutMs, headers: { apikey: key } });
      if ([401, 403].includes(response.status)) return { ok: false, provider: 'fmp', reasonCode: 'FMP_AUTH_FAILED' };
      if (response.status === 429) return { ok: false, provider: 'fmp', reasonCode: 'FMP_RATE_LIMITED' };
      if (!response.ok || response.body?.['Error Message'] || response.body?.error) return { ok: false, provider: 'fmp', reasonCode: 'FMP_DATA_UNAVAILABLE' };
      if (!Array.isArray(response.body)) return { ok: false, provider: 'fmp', reasonCode: 'FMP_MALFORMED_RESPONSE' };
      return { ok: true, provider: 'fmp', symbol: normalized, dataType, items: response.body, receivedAt: nowIso(), freshness: 'historical', liveConfirmationEligible: false, rawDataExcluded: true };
    }, { cacheSeconds: ttl });
    return result;
  }

  const incomeStatements = (symbol, period = 'quarter') => collection('income-statement', symbol, 'income_statements', cacheSeconds, `period=${encodeURIComponent(period)}&limit=5`);
  const balanceSheets = (symbol, period = 'quarter') => collection('balance-sheet-statement', symbol, 'balance_sheets', cacheSeconds, `period=${encodeURIComponent(period)}&limit=5`);
  const cashFlows = (symbol, period = 'quarter') => collection('cash-flow-statement', symbol, 'cash_flows', cacheSeconds, `period=${encodeURIComponent(period)}&limit=5`);
  const ratios = (symbol) => collection('ratios-ttm', symbol, 'ratios', cacheSeconds);
  const keyMetrics = (symbol) => collection('key-metrics-ttm', symbol, 'key_metrics', cacheSeconds);
  const earnings = (symbol) => collection('earnings', symbol, 'earnings', 10800, 'limit=8');

  async function selfTest(symbol = 'AAPL') {
    const result = await fundamentals(symbol);
    runtime.health.authenticationStatus = result.reasonCode === 'FMP_AUTH_FAILED' ? 'failed' : result.ok ? 'authenticated' : key ? 'unverified' : 'missing';
    runtime.health.capabilities = { authentication: runtime.health.authenticationStatus, quotes: false, realTimeQuotes: false, delayedQuotes: false, historicalBars: 'untested', referenceData: result.ok, companyProfile: result.ok, fundamentals: result.ok, news: 'untested', corporateActions: 'untested', earningsCalendar: 'untested' };
    return { provider: 'fmp', capabilities: runtime.health.capabilities, reasonCode: result.reasonCode || null };
  }
  return { fundamentals, incomeStatements, balanceSheets, cashFlows, ratios, keyMetrics, earnings, selfTest, health: () => runtime.snapshot({ enabled, configured: Boolean(key), status: !enabled ? 'disabled' : key ? runtime.health.status : 'degraded', credentialPresent: Boolean(key), authenticationStatus: runtime.health.authenticationStatus, liveConfirmationEligible: false }) };
}

module.exports = { createFmpClient };
