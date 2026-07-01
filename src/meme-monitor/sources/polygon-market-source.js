const { scoreMarketConfirmation } = require('../market-confirmation-score');
const { nowIso } = require('../../util');

async function fetchPolygonMarketSignals({ env = process.env, fetchImpl = globalThis.fetch, symbols = [], timeoutMs = 5000 } = {}) {
  const apiKey = String(env?.POLYGON_API_KEY || '').trim();
  if (!apiKey) {
    return {
      sourceStatus: normalizeSourceStatus({ source: 'polygon', enabled: true, available: false, status: 'missing_credentials', lastRunAt: null, lastError: 'POLYGON_API_KEY missing', blockedReason: 'missing_credentials' }),
      symbols: [],
    };
  }
  if (!symbols.length) {
    return {
      sourceStatus: normalizeSourceStatus({ source: 'polygon', enabled: true, available: true, status: 'active', symbolsConfirmed: 0, lastRunAt: nowIso(), lastError: null }),
      symbols: [],
    };
  }
  try {
    const out = [];
    for (const symbol of symbols) {
      const snapshotResponse = await fetchWithTimeout(fetchImpl, `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}?apiKey=${encodeURIComponent(apiKey)}`, timeoutMs);
      if (snapshotResponse.status === 429) {
        return {
          sourceStatus: normalizeSourceStatus({ source: 'polygon', enabled: true, available: false, status: 'rate_limited', symbolsConfirmed: out.length, lastRunAt: null, lastError: 'rate_limited', blockedReason: 'rate_limited' }),
          symbols: out,
        };
      }
      const body = await readJson(snapshotResponse);
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
      sourceStatus: normalizeSourceStatus({ source: 'polygon', enabled: true, available: true, status: 'active', symbolsConfirmed: out.length, lastRunAt: nowIso(), lastError: null }),
      symbols: out,
    };
  } catch (error) {
    return {
      sourceStatus: normalizeSourceStatus({ source: 'polygon', enabled: true, available: false, status: 'error', symbolsConfirmed: 0, lastRunAt: null, lastError: error.message, blockedReason: 'source_not_found_or_inaccessible' }),
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

function normalizeSourceStatus(entry = {}) {
  return {
    source: entry.source || 'polygon',
    enabled: Boolean(entry.enabled),
    available: Boolean(entry.available),
    status: String(entry.status || 'off').toLowerCase(),
    lastRunAt: entry.lastRunAt || null,
    lastScanAt: entry.lastScanAt || entry.lastRunAt || null,
    lastError: entry.lastError || null,
    symbolsConfirmed: Number.isFinite(Number(entry.symbolsConfirmed)) ? Number(entry.symbolsConfirmed) : 0,
    blockedReason: entry.blockedReason || null,
  };
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 5000));
  try {
    return await fetchImpl(url, { signal: controller.signal, headers: { 'user-agent': 'workflow-2-meme-monitor' } });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

module.exports = {
  fetchPolygonMarketSignals,
};
