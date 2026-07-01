const { loadMemeMonitorState, resolveMemeMonitorStatePath } = require('../meme-monitor-state');
const { nowIso } = require('../util');
const { fetchStocktwitsSignals } = require('./sources/stocktwits-source');
const { fetchPolygonMarketSignals } = require('./sources/polygon-market-source');
const { fetchAlphaVantageSignals } = require('./sources/alpha-vantage-source');
const { buildCrossSourceConfirmation } = require('./cross-source-confirmation');

function resolvePhaseBSourceRuntime(env = process.env, runtimeState = null) {
  const featureState = runtimeState || loadMemeMonitorState({ env, filePath: resolveMemeMonitorStatePath({ env }) });
  const features = featureState.features || {};
  const resolveEnabled = (key) => Boolean(features[key]?.effective || features[key]?.runtime || env[key] === 'true');
  return {
    stocktwits: resolveEnabled('MEME_SOURCE_STOCKTWITS_ENABLED'),
    polygon: resolveEnabled('MEME_SOURCE_POLYGON_ENABLED'),
    alphaVantage: resolveEnabled('MEME_SOURCE_ALPHA_VANTAGE_ENABLED'),
  };
}

async function runPhaseBSources(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const runtimeState = options.runtimeState || null;
  const sourceRuntime = resolvePhaseBSourceRuntime(env, runtimeState);
  const timeoutMs = Math.max(1000, Number(env.MEME_PHASE_B_SOURCE_TIMEOUT_MS || options.timeoutMs || 5000) || 5000);
  const phaseAEntries = options.phaseASymbolsBySymbol || options.phaseAEntries || {};
  const candidateSymbols = normalizeSymbols(options.candidateSymbols || Object.keys(phaseAEntries));
  const symbols = candidateSymbols.length ? candidateSymbols : Object.keys(phaseAEntries);
  const sources = {};

  const stocktwits = sourceRuntime.stocktwits
    ? await fetchStocktwitsSignals({ env, fetchImpl, symbols, timeoutMs })
    : inactiveSource('stocktwits');
  sources.stocktwits = stocktwits.sourceStatus;

  const polygon = sourceRuntime.polygon
    ? await fetchPolygonMarketSignals({ env, fetchImpl, symbols, timeoutMs })
    : inactiveSource('polygon');
  sources.polygon = polygon.sourceStatus;

  const alphaVantage = sourceRuntime.alphaVantage
    ? await fetchAlphaVantageSignals({ env, fetchImpl, symbols, timeoutMs })
    : inactiveSource('alphaVantage');
  sources.alphaVantage = alphaVantage.sourceStatus;

  const stocktwitsBySymbol = indexBySymbol(stocktwits.symbols || []);
  const polygonBySymbol = indexBySymbol(polygon.symbols || []);
  const alphaBySymbol = indexBySymbol(alphaVantage.symbols || []);

  const symbolsOut = symbols.map((symbol) => {
    const phaseAEntry = phaseAEntries[symbol] || null;
    const result = buildCrossSourceConfirmation({
      symbol,
      phaseAEntry,
      stocktwits: stocktwitsBySymbol[symbol] || null,
      polygon: polygonBySymbol[symbol] || null,
      alphaVantage: alphaBySymbol[symbol] || null,
      policy: {
        hotHotMinScore: Number(env.MEME_HOT_HOT_MIN_SCORE || 90),
        marketConfirmationMinScore: Number(env.MEME_MARKET_CONFIRMATION_MIN_SCORE || 70),
      },
    });
    return {
      symbol,
      ...result,
      sourceConfirmations: {
        reddit: Boolean(phaseAEntry?.sourceConfirmations?.reddit),
        stocktwits: Boolean(stocktwitsBySymbol[symbol]),
        alpacaMarket: Boolean(phaseAEntry?.sourceConfirmations?.alpacaMarket),
        polygon: Boolean(polygonBySymbol[symbol]),
        alphaVantage: Boolean(alphaBySymbol[symbol]),
        alpacaAssets: Boolean(phaseAEntry?.sourceConfirmations?.alpacaAssets),
        nasdaqHalts: Boolean(phaseAEntry?.sourceConfirmations?.nasdaqHalts),
        secEdgar: Boolean(phaseAEntry?.sourceConfirmations?.secEdgar),
      },
      phaseA: phaseAEntry || null,
      sourceBreakdown: {
        reddit: phaseAEntry?.memeHeatScore ?? null,
        stocktwits: result.socialConfirmation.stocktwits,
        alpaca: phaseAEntry?.marketConfirmationScore ?? null,
        polygon: result.marketConfirmation.polygon,
        alphaVantage: result.marketConfirmation.alphaVantage,
      },
    };
  }).sort((a, b) => Number(b.finalMemeScore || 0) - Number(a.finalMemeScore || 0) || a.symbol.localeCompare(b.symbol));

  const anyEnabled = Object.values(sourceRuntime).some(Boolean);
  const anyActive = [stocktwits, polygon, alphaVantage].some((entry) => entry.sourceStatus?.status === 'active');
  const anyMissing = [stocktwits, polygon, alphaVantage].some((entry) => ['missing_credentials', 'rate_limited', 'error'].includes(String(entry.sourceStatus?.status || '').toLowerCase()));

  return {
    generatedAt: nowIso(),
    phaseB: {
      enabled: anyEnabled,
      status: !anyEnabled ? 'off' : anyMissing ? 'warn' : anyActive ? 'active' : 'inactive',
      lastRunAt: nowIso(),
      lastError: null,
      sources,
      symbols: symbolsOut,
    },
    sources,
    symbols: symbolsOut,
    symbolsBySymbol: Object.fromEntries(symbolsOut.map((entry) => [entry.symbol, entry])),
    sourceConfirmationsBySymbol: Object.fromEntries(symbolsOut.map((entry) => [entry.symbol, entry.sourceConfirmations])),
  };
}

function inactiveSource(source) {
  return {
    sourceStatus: {
      source,
      enabled: false,
      available: false,
      status: 'inactive',
      lastRunAt: null,
      lastScanAt: null,
      lastError: null,
      blockedReason: 'source_disabled',
    },
    symbols: [],
  };
}

function indexBySymbol(items = []) {
  const out = {};
  for (const item of items) {
    if (!item?.symbol) continue;
    out[String(item.symbol).toUpperCase()] = item;
  }
  return out;
}

function normalizeSymbols(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((entry) => String(entry || '').trim().toUpperCase()).filter(Boolean))];
}

module.exports = {
  resolvePhaseBSourceRuntime,
  runPhaseBSources,
};
