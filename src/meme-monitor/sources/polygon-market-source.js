const path = require('path');
const { scoreMarketConfirmation } = require('../market-confirmation-score');
const { nowIso } = require('../../util');
const { buildSourceStatus, fetchJsonWithTimeout, redactSourceMessage } = require('../../source-fetch');
const { createMassiveClient } = require('../../massive-client');

async function fetchPolygonMarketSignals({ env = process.env, fetchImpl = globalThis.fetch, symbols = [], timeoutMs = 5000 } = {}) {
  if (String(env.MASSIVE_ENABLED || 'false').toLowerCase() === 'true') {
    const client = createMassiveClient({ env: { ...env, MASSIVE_TIMEOUT_MS: env.MASSIVE_TIMEOUT_MS || timeoutMs }, fetchImpl });
    const out = [];
    const limit = Math.max(0, Number(env.MASSIVE_MAX_SYMBOLS_PER_CYCLE || 2));
    for (const symbol of [...new Set(symbols.map((value) => String(value).toUpperCase()))].slice(0, limit)) {
      const quote = await client.quote(symbol);
      out.push({
        symbol,
        sourceSignalType: 'market_confirmation',
        score: quote.ok ? 80 : null,
        confidence: quote.ok ? 0.8 : 0,
        reasonCodes: [quote.reasonCode || 'MASSIVE_REALTIME_CONFIRMED'],
        riskWarnings: quote.ok ? [] : [quote.reasonCode || 'MASSIVE_DATA_UNAVAILABLE'],
        rawSummary: { snapshotStatus: quote.freshness || 'unavailable', spreadStatus: quote.bid && quote.ask ? 'available' : 'unknown', volumeMultiple: null },
        available: quote.ok,
        status: quote.ok ? 'active' : 'unavailable',
        marketContext: quote.ok ? { currentPrice: quote.price, previousClose: quote.previousClose, openPrice: quote.open, volume: quote.volume, bid: quote.bid, ask: quote.ask, stale: false } : null,
      });
    }
    const health = client.health();
    return { sourceStatus: buildSourceStatus({ source: 'massive', providerLabel: 'Massive (formerly Polygon.io)', enabled: true, available: out.some((entry) => entry.available), status: out.some((entry) => entry.available) ? 'active' : 'unavailable', symbolsConfirmed: out.filter((entry) => entry.available).length, lastRunAt: nowIso(), lastError: health.lastReasonCode, ...health }), symbols: out };
  }
  const apiKey = String(env?.MASSIVE_API_KEY || env?.POLYGON_API_KEY || '').trim();
  if (!apiKey) {
    return {
      sourceStatus: buildSourceStatus({ source: 'massive', providerLabel: 'Massive (formerly Polygon.io)', enabled: true, available: false, status: 'missing_credentials', lastRunAt: null, lastError: 'MASSIVE_API_KEY missing', blockedReason: 'missing_credentials' }),
      symbols: [],
    };
  }
  if (!symbols.length) {
    return {
      sourceStatus: buildSourceStatus({ source: 'massive', providerLabel: 'Massive (formerly Polygon.io)', enabled: true, available: true, status: 'active', symbolsConfirmed: 0, lastRunAt: nowIso(), lastError: null }),
      symbols: [],
    };
  }
  try {
    const out = [];
    for (const symbol of symbols) {
      const result = await fetchJsonWithTimeout(fetchImpl, `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}?apiKey=${encodeURIComponent(apiKey)}`, {
        timeoutMs,
        cache: sourceCacheOptions(env, symbol, 'snapshot', timeoutMs),
      });
      const snapshotResponse = result.response;
      if (snapshotResponse.status === 429) {
        return {
          sourceStatus: buildSourceStatus({ source: 'polygon', enabled: true, available: false, status: 'rate_limited', symbolsConfirmed: out.length, lastRunAt: null, lastError: 'rate_limited', blockedReason: 'rate_limited', cache: result.cache }),
          symbols: out,
        };
      }
      const body = result.body;
      if (!snapshotResponse.ok) {
        out.push(buildPolygonSignal(symbol, null, { unavailable: true, error: `HTTP ${snapshotResponse.status}` }));
        continue;
      }
      const snapshot = body?.ticker || body?.results || body?.snapshot || body || {};
      const marketContext = buildMarketContext(snapshot, env);
      const score = scoreMarketConfirmation(symbol, marketContext, {
        marketConfirmationMinScore: Number(env.MEME_MARKET_CONFIRMATION_MIN_SCORE || 70),
      });
      out.push({
        symbol,
        sourceSignalType: 'market_confirmation',
        score: score.marketConfirmationScore,
        confidence: Number.isFinite(Number(score.marketConfirmationScore)) ? score.marketConfirmationScore / 100 : 0,
        reasonCodes: ['polygon_source_active', ...score.reasonCodes],
        riskWarnings: score.riskWarnings.slice(),
        rawSummary: {
          volumeMultiple: marketContext.volume && marketContext.averageVolume ? Number((marketContext.volume / marketContext.averageVolume).toFixed(2)) : null,
          spreadStatus: marketContext.spreadPct !== null && marketContext.spreadPct <= 1 ? 'acceptable' : 'wide',
          snapshotStatus: marketContext.stale ? 'stale' : 'confirmed',
        },
        available: true,
        status: 'active',
        marketContext,
      });
    }
    return {
      sourceStatus: buildSourceStatus({ source: 'polygon', enabled: true, available: true, status: 'active', symbolsConfirmed: out.length, lastRunAt: nowIso(), lastError: null, cache: { used: false, hit: false, ageSeconds: null, ttlSeconds: null, stale: false } }),
      symbols: out,
    };
  } catch (error) {
    return {
      sourceStatus: buildSourceStatus({ source: 'polygon', enabled: true, available: false, status: error?.name === 'AbortError' ? 'timeout' : 'error', symbolsConfirmed: 0, lastRunAt: null, lastError: redactSourceMessage(error.message), blockedReason: error?.name === 'AbortError' ? 'timeout' : 'source_not_found_or_inaccessible' }),
      symbols: [],
    };
  }
}

function buildMarketContext(snapshot = {}, env = process.env) {
  const latestTrade = snapshot.lastTrade || snapshot.latestTrade || snapshot.ticker?.lastTrade || null;
  const latestQuote = snapshot.lastQuote || snapshot.latestQuote || snapshot.ticker?.lastQuote || null;
  const day = snapshot.day || snapshot.ticker?.day || {};
  const prevDay = snapshot.prevDay || snapshot.previousDay || snapshot.ticker?.prevDay || snapshot.ticker?.previousDay || {};
  const currentPrice = Number(latestTrade?.p ?? latestTrade?.price ?? snapshot.lastTrade?.p ?? day.c ?? snapshot.ticker?.day?.c ?? null);
  const previousClose = Number(prevDay?.c ?? snapshot.prevDay?.c ?? snapshot.previousClose ?? day.o ?? null);
  const bid = Number(latestQuote?.p ?? latestQuote?.bid ?? latestQuote?.bp ?? null);
  const ask = Number(latestQuote?.P ?? latestQuote?.ask ?? latestQuote?.ap ?? null);
  const spreadPct = Number.isFinite(bid) && Number.isFinite(ask) && ask > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null;
  const volume = Number(day.v ?? snapshot.ticker?.day?.v ?? snapshot.volume ?? null);
  const averageVolume = Number(prevDay.v ?? snapshot.ticker?.prevDay?.v ?? null);
  return {
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    openPrice: Number.isFinite(Number(day.o)) ? Number(day.o) : null,
    volume: Number.isFinite(volume) ? volume : null,
    averageVolume: Number.isFinite(averageVolume) ? averageVolume : null,
    bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null,
    spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
    stale: Boolean(snapshot.updated || snapshot.ticker?.updated ? false : false),
    tradable: snapshot.ticker?.market || snapshot.market || null ? true : null,
  };
}

function buildPolygonSignal(symbol, snapshot, options = {}) {
  return {
    symbol,
    sourceSignalType: 'market_confirmation',
    score: null,
    confidence: 0,
    reasonCodes: ['polygon_unavailable'],
    riskWarnings: [],
    rawSummary: {
      snapshotStatus: options.unavailable ? 'unavailable' : 'unknown',
      spreadStatus: 'unknown',
      volumeMultiple: null,
    },
    available: !options.unavailable,
    status: options.unavailable ? 'unavailable' : 'active',
    marketContext: null,
  };
}

module.exports = {
  fetchPolygonMarketSignals,
};

function sourceCacheOptions(env, symbol, category, ttlSeconds) {
  return {
    cacheDir: path.resolve(process.cwd(), 'data', 'runtime', 'source-cache'),
    source: 'polygon',
    category,
    key: `polygon:${category}:${String(symbol || '').toUpperCase()}`,
    ttlSeconds: Math.max(0, Number(env?.MEME_PHASE_B_SOURCE_CACHE_SECONDS || ttlSeconds || 0) || 0),
  };
}
