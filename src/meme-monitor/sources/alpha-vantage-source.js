const path = require('path');
const { nowIso } = require('../../util');
const { buildSourceStatus, fetchJsonWithTimeout, redactSourceMessage } = require('../../source-fetch');
const { URL } = require('url');

async function fetchAlphaVantageSignals({ env = process.env, fetchImpl = globalThis.fetch, symbols = [], timeoutMs = 5000 } = {}) {
  const apiKey = String(env?.ALPHA_VANTAGE_API_KEY || '').trim();
  if (!apiKey) {
    return {
      sourceStatus: buildSourceStatus({ source: 'alphaVantage', enabled: true, available: false, status: 'missing_credentials', lastRunAt: null, lastError: 'ALPHA_VANTAGE_API_KEY missing', blockedReason: 'missing_credentials' }),
      symbols: [],
    };
  }
  if (!symbols.length) {
    return {
      sourceStatus: buildSourceStatus({ source: 'alphaVantage', enabled: true, available: true, status: 'active', newsItemsMatched: 0, lastRunAt: nowIso(), lastError: null }),
      symbols: [],
    };
  }
  try {
    const safeMode = String(env?.MEME_ALPHA_VANTAGE_RATE_LIMIT_SAFE_MODE ?? 'true').toLowerCase() !== 'false';
    const intradayEnabled = String(env?.MEME_ALPHA_VANTAGE_USE_INTRADAY ?? 'true').toLowerCase() !== 'false';
    const newsEnabled = String(env?.MEME_ALPHA_VANTAGE_USE_NEWS_SENTIMENT ?? 'true').toLowerCase() !== 'false';
    const limitedSymbols = safeMode ? symbols.slice(0, 5) : symbols.slice();
    const out = [];
    for (const symbol of limitedSymbols) {
      const items = [];
      if (intradayEnabled) {
        items.push(fetchJsonWithTimeout(fetchImpl, buildUrl('TIME_SERIES_INTRADAY', { symbol, apiKey }), {
          timeoutMs,
          cache: sourceCacheOptions(env, symbol, 'intraday', timeoutMs),
        }));
      }
      if (newsEnabled) {
        items.push(fetchJsonWithTimeout(fetchImpl, buildUrl('NEWS_SENTIMENT', { symbol, apiKey }), {
          timeoutMs,
          cache: sourceCacheOptions(env, symbol, 'news', timeoutMs),
        }));
      }
      const responses = await Promise.all(items);
      const payloads = [];
      for (const response of responses) {
        if (response.status === 429) {
          return {
            sourceStatus: buildSourceStatus({ source: 'alphaVantage', enabled: true, available: false, status: 'rate_limited', newsItemsMatched: out.length, lastRunAt: null, lastError: 'rate_limited', blockedReason: 'rate_limited', cache: response.cache }),
            symbols: out,
          };
        }
        payloads.push(response.body);
      }
      out.push(buildAlphaVantageSignal(symbol, payloads, { intradayEnabled, newsEnabled, safeMode }));
    }
    return {
      sourceStatus: buildSourceStatus({ source: 'alphaVantage', enabled: true, available: true, status: 'active', newsItemsMatched: out.reduce((sum, entry) => sum + Number(entry.rawSummary.newsItemsMatched || 0), 0), lastRunAt: nowIso(), lastError: null, cache: { used: false, hit: false, ageSeconds: null, ttlSeconds: null, stale: false } }),
      symbols: out,
    };
  } catch (error) {
    return {
      sourceStatus: buildSourceStatus({ source: 'alphaVantage', enabled: true, available: false, status: error?.name === 'AbortError' ? 'timeout' : 'error', newsItemsMatched: 0, lastRunAt: null, lastError: redactSourceMessage(error.message), blockedReason: error?.name === 'AbortError' ? 'timeout' : 'source_not_found_or_inaccessible' }),
      symbols: [],
    };
  }
}

function buildAlphaVantageSignal(symbol, payloads = [], options = {}) {
  let latestClose = null;
  let previousClose = null;
  let newsItemsMatched = 0;
  let bullishNews = 0;
  let bearishNews = 0;
  for (const payload of payloads) {
    const series = payload?.['Time Series (5min)'] || payload?.['Time Series (15min)'] || payload?.['Time Series (1min)'] || null;
    if (series && !latestClose) {
      const entries = Object.values(series);
      latestClose = Number(entries[0]?.['4. close'] || entries[0]?.close || null);
      previousClose = Number(entries[1]?.['4. close'] || entries[1]?.close || null);
    }
    const feed = Array.isArray(payload?.feed) ? payload.feed : Array.isArray(payload?.items) ? payload.items : [];
    newsItemsMatched += feed.filter((item) => matchesSymbol(item, symbol)).length;
    bullishNews += feed.filter((item) => matchesSymbol(item, symbol) && sentimentIsBullish(item)).length;
    bearishNews += feed.filter((item) => matchesSymbol(item, symbol) && sentimentIsBearish(item)).length;
  }
  const intradayScore = Number.isFinite(latestClose) && Number.isFinite(previousClose) && previousClose > 0
    ? clampScore(40 + Math.abs(((latestClose - previousClose) / previousClose) * 100) * 6)
    : null;
  const newsScore = newsItemsMatched ? clampScore(35 + newsItemsMatched * 6 + bullishNews * 8 - bearishNews * 5) : null;
  const combinedScore = clampScore(
    ((Number.isFinite(intradayScore) ? intradayScore : 0) * 0.6)
    + ((Number.isFinite(newsScore) ? newsScore : 0) * 0.4),
  );
  const reasonCodes = ['alpha_vantage_source_active'];
  if (intradayScore !== null) reasonCodes.push('alpha_vantage_intraday_confirmed');
  if (newsItemsMatched > 0) reasonCodes.push('alpha_vantage_news_sentiment_confirmed');
  if (combinedScore >= 70) reasonCodes.push('alpha_vantage_top_gainer_confirmed');
  if (safeModeNotice(options)) reasonCodes.push('alpha_vantage_data_delayed');
  return {
    symbol,
    sourceSignalType: 'market_confirmation',
    score: combinedScore,
    confidence: combinedScore / 100,
    reasonCodes,
    riskWarnings: [],
    rawSummary: {
      latestClose,
      previousClose,
      newsItemsMatched,
      bullishNews,
      bearishNews,
      safeMode: safeModeNotice(options),
    },
    available: true,
    status: 'active',
  };
}

function safeModeNotice(options = {}) {
  return Boolean(options.safeMode);
}

function buildUrl(functionName, { symbol, apiKey } = {}) {
  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function', functionName);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('keywords', symbol);
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

function matchesSymbol(item = {}, symbol = '') {
  const text = `${item?.title || ''} ${item?.summary || ''} ${item?.ticker || ''}`.toUpperCase();
  return text.includes(String(symbol || '').toUpperCase());
}

function sentimentIsBullish(item = {}) {
  const value = String(item?.overall_sentiment_score_label || item?.sentiment || item?.sentiment_label || '').toLowerCase();
  return ['bullish', 'somewhat_bullish', 'positive'].includes(value);
}

function sentimentIsBearish(item = {}) {
  const value = String(item?.overall_sentiment_score_label || item?.sentiment || item?.sentiment_label || '').toLowerCase();
  return ['bearish', 'somewhat_bearish', 'negative'].includes(value);
}

function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

module.exports = {
  fetchAlphaVantageSignals,
};

function sourceCacheOptions(env, symbol, category, ttlSeconds) {
  return {
    cacheDir: path.resolve(process.cwd(), 'data', 'runtime', 'source-cache'),
    source: 'alphaVantage',
    category,
    key: `alphaVantage:${String(symbol || '').toUpperCase()}:${category}`,
    ttlSeconds: Math.max(0, Number(env?.MEME_PHASE_B_SOURCE_CACHE_SECONDS || ttlSeconds || 0) || 0),
  };
}
