const { loadRegularWatchState, resolveRegularWatchStatePath } = require('./regular-watch-feature-state');
const { saveRegularWatchStatus, resolveRegularWatchStatusPath } = require('./regular-watch-status');
const { scoreRegularWatchSymbol } = require('./regular-watch-score');
const { buildScannerConfig } = require('../scanner-config');
const { APPROVED_LIVE_MARKET_SYMBOLS, parseSymbolList } = require('../volatile-stock-universe');
const { nowIso } = require('../util');
const { fetchAlpacaMarketSignals, fetchAlpacaAssetSignals, fetchNasdaqHaltsSignals, fetchSecEdgarSignals } = require('../meme-monitor/phase-a-source-runner');
const { fetchPolygonMarketSignals } = require('../meme-monitor/sources/polygon-market-source');
const { fetchAlphaVantageSignals } = require('../meme-monitor/sources/alpha-vantage-source');

function resolveRegularWatchSymbols(env = process.env) {
  const scannerConfig = buildScannerConfig(env);
  const configured = Array.isArray(scannerConfig.symbols) && scannerConfig.symbols.length
    ? scannerConfig.symbols
    : parseSymbolList(env.STOCK_SCANNER_SYMBOLS, APPROVED_LIVE_MARKET_SYMBOLS);
  const approved = new Set(APPROVED_LIVE_MARKET_SYMBOLS.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean));
  return [...new Set(configured.map((symbol) => String(symbol || '').trim().toUpperCase()).filter((symbol) => symbol && approved.has(symbol)))];
}

function resolveRegularWatchSourceRuntime(env = process.env, runtimeState = null) {
  const featureState = runtimeState || loadRegularWatchState({ env, filePath: resolveRegularWatchStatePath({ env }) });
  const features = featureState.features || {};
  const runtimeEnabled = (key) => Boolean(features[key]?.effective || features[key]?.runtime || String(env?.[key] || '').toLowerCase() === 'true');
  const effectiveOnly = (key) => Boolean(features[key]?.effective);
  return {
    master: runtimeEnabled('REGULAR_WATCH_INTELLIGENCE_ENABLED'),
    marketConfirmation: runtimeEnabled('REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED'),
    assetValidation: runtimeEnabled('REGULAR_WATCH_ASSET_VALIDATION_ENABLED'),
    haltCheck: runtimeEnabled('REGULAR_WATCH_HALT_CHECK_ENABLED'),
    secRiskCheck: runtimeEnabled('REGULAR_WATCH_SEC_RISK_CHECK_ENABLED'),
    newsCatalyst: runtimeEnabled('REGULAR_WATCH_NEWS_CATALYST_ENABLED'),
    priorityScoring: effectiveOnly('REGULAR_WATCH_PRIORITY_SCORING_ENABLED'),
    scannerRanking: effectiveOnly('REGULAR_WATCH_SCANNER_RANKING_ENABLED'),
    positionAwareness: effectiveOnly('REGULAR_WATCH_POSITION_AWARENESS_ENABLED'),
    polygonConfirmation: runtimeEnabled('REGULAR_WATCH_POLYGON_CONFIRMATION_ENABLED'),
    alphaVantageConfirmation: runtimeEnabled('REGULAR_WATCH_ALPHA_VANTAGE_CONFIRMATION_ENABLED'),
    socialContext: runtimeEnabled('REGULAR_WATCH_SOCIAL_CONTEXT_ENABLED'),
    optionsContext: runtimeEnabled('REGULAR_WATCH_OPTIONS_CONTEXT_ENABLED'),
  };
}

async function runRegularWatchSources(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const repoRoot = options.repoRoot || process.cwd();
  const dataDir = options.dataDir || undefined;
  const runtimeState = options.runtimeState || loadRegularWatchState({
    env,
    repoRoot,
    filePath: options.statePath || resolveRegularWatchStatePath({ dataDir, repoRoot }),
  });
  const statusPath = options.statusPath || resolveRegularWatchStatusPath({ dataDir, repoRoot });
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || env.REGULAR_WATCH_SOURCE_TIMEOUT_MS || 5000) || 5000);
  const maxSymbols = Math.max(1, Number(options.maxSymbolsPerRun || env.REGULAR_WATCH_MAX_SYMBOLS_PER_RUN || 100) || 100);
  const sourceRuntime = resolveRegularWatchSourceRuntime(env, runtimeState);
  const now = nowIso();
  const symbols = resolveRegularWatchSymbols(env).slice(0, maxSymbols);
  const baseSources = buildBaseSourceEntries({
    sourceRuntime,
    symbols,
    now,
  });

  if (!sourceRuntime.master) {
    const idle = buildIdleStatus({
      runtimeState,
      sources: baseSources,
      now,
      reason: 'master_disabled',
      symbols,
    });
    return saveRegularWatchStatus(idle, { dataDir, filePath: statusPath });
  }

  const timedFetch = createTimedFetch(fetchImpl, timeoutMs);
  const sourceResults = await runEnabledSources({
    env,
    fetchImpl: timedFetch,
    symbols,
    timeoutMs,
    sourceRuntime,
  });

  const sourceStatusMap = {
    ...baseSources,
    ...sourceResults.sourceStatusMap,
  };
  const sourceSignals = sourceResults.sourceSignals;
  const symbolEntries = buildSymbolEntries({
    symbols,
    sourceSignals,
    sourceStatusMap,
    now,
  });

  const regularWatchList = symbolEntries.slice().sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || a.symbol.localeCompare(b.symbol));
  const moverThreshold = Number.isFinite(Number(env.REGULAR_WATCH_MOVER_SCORE_THRESHOLD))
    ? Number(env.REGULAR_WATCH_MOVER_SCORE_THRESHOLD)
    : 55;
  const regularWatchMovers = regularWatchList.filter((entry) => Number(entry.score || 0) >= moverThreshold || Math.abs(Number(entry.movePct || 0)) >= 2).slice(0, 20);
  const blockedSymbols = regularWatchList.filter((entry) => entry.status === 'blocked').length;
  const stale = regularWatchList.some((entry) => entry.stale) || sourceResults.anyStale;
  const activeSources = Object.values(sourceStatusMap).filter((entry) => ['active', 'warn'].includes(String(entry.status || '').toLowerCase()) && entry.source !== 'approvedUniverse');
  const runtimeStatus = sourceResults.anyErrors || stale || blockedSymbols > 0
    ? 'warn'
    : (activeSources.length ? 'active' : 'inactive');

  const status = {
    version: '2026-06-30.regular-watch-status.2',
    updated_at: now,
    enabled: true,
    sources: Object.values(sourceStatusMap),
    regularWatchIntelligence: {
      enabled: true,
      status: runtimeStatus,
      lastRunAt: now,
      lastError: sourceResults.lastError || null,
      symbolsChecked: regularWatchList.length,
      moversFound: regularWatchMovers.length,
      blockedSymbols,
      features: {
        marketConfirmation: Boolean(sourceRuntime.marketConfirmation),
        assetValidation: Boolean(sourceRuntime.assetValidation),
        haltCheck: Boolean(sourceRuntime.haltCheck),
        secRiskCheck: Boolean(sourceRuntime.secRiskCheck),
        newsCatalyst: Boolean(sourceRuntime.newsCatalyst),
        priorityScoring: Boolean(sourceRuntime.priorityScoring),
        scannerRanking: Boolean(sourceRuntime.scannerRanking),
        positionAwareness: Boolean(sourceRuntime.positionAwareness),
      },
    },
    regularWatchList,
    regularWatchMovers,
    generatedAt: now,
    stale,
    status: runtimeStatus,
    lastRunAt: now,
    lastError: sourceResults.lastError || null,
  };

  return saveRegularWatchStatus(status, { dataDir, filePath: statusPath });
}

async function runEnabledSources({ env, fetchImpl, symbols, timeoutMs, sourceRuntime } = {}) {
  const sourceStatusMap = {};
  const sourceSignals = [];
  let anyErrors = false;
  let anyStale = false;
  let lastError = null;

  const addResult = (sourceName, result) => {
    sourceStatusMap[sourceName] = result.sourceStatus;
    if (result.sourceStatus?.status && ['error', 'missing_credentials', 'rate_limited'].includes(String(result.sourceStatus.status).toLowerCase())) {
      anyErrors = true;
      lastError = lastError || result.sourceStatus.lastError || result.sourceStatus.blockedReason || `${sourceName}_failed`;
    }
    for (const signal of result.symbols || []) {
      sourceSignals.push({ ...signal, source: sourceName });
      if (signal?.marketContext?.stale) anyStale = true;
    }
  };

  addResult('alpacaMarket', sourceRuntime.marketConfirmation || sourceRuntime.assetValidation || sourceRuntime.haltCheck || sourceRuntime.secRiskCheck
    ? await fetchAlpacaMarketSignals({ env, fetchImpl, symbols, timeoutMs })
    : inactiveSource('alpacaMarket'));

  addResult('alpacaAssets', sourceRuntime.assetValidation || sourceRuntime.positionAwareness
    ? await fetchAlpacaAssetSignals({ env, fetchImpl, symbols, timeoutMs })
    : inactiveSource('alpacaAssets'));

  addResult('nasdaqHalts', sourceRuntime.haltCheck
    ? await fetchNasdaqHaltsSignals({ env, fetchImpl, symbols, timeoutMs })
    : inactiveSource('nasdaqHalts'));

  addResult('secEdgar', sourceRuntime.secRiskCheck || sourceRuntime.newsCatalyst
    ? await fetchSecEdgarSignals({ env, fetchImpl, symbols, timeoutMs })
    : inactiveSource('secEdgar'));

  addResult('polygon', sourceRuntime.polygonConfirmation
    ? await fetchPolygonMarketSignals({ env, fetchImpl, symbols, timeoutMs })
    : inactiveSource('polygon'));

  addResult('alphaVantage', sourceRuntime.alphaVantageConfirmation
    ? await fetchAlphaVantageSignals({ env, fetchImpl, symbols, timeoutMs })
    : inactiveSource('alphaVantage'));

  sourceStatusMap.socialContext = buildContextSourceStatus('socialContext', sourceRuntime.socialContext);
  sourceStatusMap.optionsContext = buildContextSourceStatus('optionsContext', sourceRuntime.optionsContext);

  return {
    sourceStatusMap,
    sourceSignals,
    anyErrors,
    anyStale,
    lastError,
  };
}

function buildBaseSourceEntries({ sourceRuntime, symbols, now } = {}) {
  const universeStatus = symbols.length
    ? 'active'
    : 'inactive';
  return {
    approvedUniverse: {
      source: 'approvedUniverse',
      tier: 'universe',
      status: universeStatus,
      lastScanAt: now,
      lastError: null,
      blockedReason: null,
      symbolsDetected: symbols.length,
    },
    alpacaMarket: buildDisabledSource('alpacaMarket', 'market', sourceRuntime.marketConfirmation, now),
    alpacaAssets: buildDisabledSource('alpacaAssets', 'risk', sourceRuntime.assetValidation, now),
    nasdaqHalts: buildDisabledSource('nasdaqHalts', 'risk', sourceRuntime.haltCheck, now),
    secEdgar: buildDisabledSource('secEdgar', 'risk', sourceRuntime.secRiskCheck, now),
    polygon: buildDisabledSource('polygon', 'market', sourceRuntime.polygonConfirmation, now),
    alphaVantage: buildDisabledSource('alphaVantage', 'market', sourceRuntime.alphaVantageConfirmation, now),
    socialContext: buildContextSourceStatus('socialContext', sourceRuntime.socialContext, now),
    optionsContext: buildContextSourceStatus('optionsContext', sourceRuntime.optionsContext, now),
  };
}

function buildDisabledSource(source, tier, enabled, now) {
  return {
    source,
    tier,
    status: enabled ? 'inactive' : 'off',
    lastScanAt: enabled ? now : null,
    lastError: null,
    blockedReason: enabled ? 'source_not_run_yet' : 'source_disabled',
    symbolsDetected: 0,
  };
}

function buildContextSourceStatus(source, enabled, now = null) {
  return {
    source,
    tier: 'context',
    status: enabled ? 'inactive' : 'off',
    lastScanAt: enabled ? now : null,
    lastError: enabled ? 'not_implemented' : null,
    blockedReason: enabled ? 'not_implemented' : 'source_disabled',
    symbolsDetected: 0,
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

function buildIdleStatus({ runtimeState, sources, now, reason, symbols } = {}) {
  return {
    version: '2026-06-30.regular-watch-status.2',
    updated_at: now,
    enabled: false,
    sources: Object.values(sources),
    regularWatchIntelligence: {
      enabled: false,
      status: 'off',
      lastRunAt: now,
      lastError: reason || null,
      symbolsChecked: symbols.length,
      moversFound: 0,
      blockedSymbols: 0,
      features: {
        marketConfirmation: Boolean(runtimeState?.features?.REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED?.effective),
        assetValidation: Boolean(runtimeState?.features?.REGULAR_WATCH_ASSET_VALIDATION_ENABLED?.effective),
        haltCheck: Boolean(runtimeState?.features?.REGULAR_WATCH_HALT_CHECK_ENABLED?.effective),
        secRiskCheck: Boolean(runtimeState?.features?.REGULAR_WATCH_SEC_RISK_CHECK_ENABLED?.effective),
        newsCatalyst: Boolean(runtimeState?.features?.REGULAR_WATCH_NEWS_CATALYST_ENABLED?.effective),
        priorityScoring: Boolean(runtimeState?.features?.REGULAR_WATCH_PRIORITY_SCORING_ENABLED?.effective),
        scannerRanking: Boolean(runtimeState?.features?.REGULAR_WATCH_SCANNER_RANKING_ENABLED?.effective),
        positionAwareness: Boolean(runtimeState?.features?.REGULAR_WATCH_POSITION_AWARENESS_ENABLED?.effective),
      },
    },
    regularWatchList: [],
    regularWatchMovers: [],
    generatedAt: now,
    stale: true,
    status: 'off',
    lastRunAt: now,
    lastError: reason || null,
  };
}

function buildSymbolEntries({ symbols, sourceSignals, sourceStatusMap, now } = {}) {
  const lookup = new Map();
  for (const symbol of symbols) {
    lookup.set(symbol, createSymbolEntry(symbol));
  }

  for (const signal of sourceSignals || []) {
    const symbol = String(signal?.symbol || '').trim().toUpperCase();
    if (!symbol || !lookup.has(symbol)) continue;
    const entry = lookup.get(symbol);
    applySignal(entry, signal);
  }

  return [...lookup.values()].map((entry) => {
    const result = scoreRegularWatchSymbol(entry.symbol, entry, {
      sourceContributors: entry.sourceContributors,
    });
    const sourceList = entry.sourceContributors.slice();
    const status = result.status;
    const reasonCodes = [...new Set([...(entry.reasonCodes || []), ...result.reasonCodes])];
    const riskWarnings = [...new Set([...(entry.riskWarnings || []), ...result.riskWarnings])];
    return {
      symbol: entry.symbol,
      status: entry.blockedReason ? 'blocked' : status,
      blockedReason: entry.blockedReason || result.blockedReason || null,
      score: result.score,
      regularWatchScore: result.score,
      marketConfirmationScore: result.marketConfirmationScore,
      currentPrice: result.currentPrice,
      previousClose: result.previousClose,
      movePct: result.movePct,
      volatilityPct: result.volatilityPct,
      ageSeconds: result.ageSeconds,
      volume: result.volume,
      averageVolume: result.averageVolume,
      volumeMultiple: Number.isFinite(result.volume) && Number.isFinite(result.averageVolume) && result.averageVolume > 0
        ? Number((result.volume / result.averageVolume).toFixed(2))
        : entry.volumeMultiple ?? null,
      spreadPct: result.spreadPct,
      bid: result.bid,
      ask: result.ask,
      tradableStatus: entry.tradableStatus,
      haltStatus: entry.haltStatus,
      stale: Boolean(entry.stale || result.riskWarnings.includes('stale_market_data')),
      sourceContributors: sourceList,
      sources: sourceList,
      reasonCodes,
      riskWarnings,
      sourceStatus: buildSymbolSourceStatus(sourceStatusMap, entry),
      lastScanAt: now,
      dashboardReady: true,
      statusLabel: status,
    };
  });
}

function createSymbolEntry(symbol) {
  return {
    symbol,
    sourceContributors: [],
    reasonCodes: [],
    riskWarnings: [],
    tradableStatus: 'unknown',
    haltStatus: 'unknown',
    stale: false,
    blockedReason: null,
    currentPrice: null,
    previousClose: null,
    movePct: null,
    spreadPct: null,
    ageSeconds: null,
    bid: null,
    ask: null,
    volume: null,
    averageVolume: null,
  };
}

function applySignal(entry, signal) {
  const source = String(signal?.source || '').trim();
  if (!source) return;
  const contributor = {
    source,
    tier: signal?.tier || inferSourceTier(source),
    status: signal?.status || 'active',
  };
  if (!entry.sourceContributors.some((item) => item.source === contributor.source)) {
    entry.sourceContributors.push(contributor);
  }
  const reasonCodes = Array.isArray(signal?.reasonCodes) ? signal.reasonCodes : [];
  const riskWarnings = Array.isArray(signal?.riskWarnings) ? signal.riskWarnings : [];
  entry.reasonCodes.push(...reasonCodes);
  entry.riskWarnings.push(...riskWarnings);
  entry.currentPrice = pickNumber(signal.currentPrice ?? signal.details?.currentPrice ?? signal.marketContext?.currentPrice, entry.currentPrice);
  entry.previousClose = pickNumber(signal.previousClose ?? signal.details?.previousClose ?? signal.marketContext?.previousClose, entry.previousClose);
  entry.movePct = pickNumber(signal.movePct ?? signal.marketContext?.movePct, entry.movePct);
  entry.spreadPct = pickNumber(signal.spreadPct ?? signal.details?.spreadPct ?? signal.marketContext?.spreadPct, entry.spreadPct);
  entry.volume = pickNumber(signal.volume ?? signal.details?.volume ?? signal.marketContext?.volume, entry.volume);
  entry.averageVolume = pickNumber(signal.averageVolume ?? signal.details?.averageVolume ?? signal.marketContext?.averageVolume, entry.averageVolume);
  entry.ageSeconds = pickNumber(signal.ageSeconds ?? signal.marketContext?.ageSeconds, entry.ageSeconds);
  entry.bid = pickNumber(signal.bid ?? signal.details?.bid ?? signal.marketContext?.bid, entry.bid);
  entry.ask = pickNumber(signal.ask ?? signal.details?.ask ?? signal.marketContext?.ask, entry.ask);
  entry.tradableStatus = mergeTradableStatus(entry.tradableStatus, signal.tradableStatus, signal.details);
  entry.haltStatus = mergeHaltStatus(entry.haltStatus, signal.haltStatus);
  entry.stale = Boolean(entry.stale || signal?.marketContext?.stale);
  if (signal?.blockedReason && !entry.blockedReason) {
    entry.blockedReason = signal.blockedReason;
  }
  if (signal?.marketContext?.halted) {
    entry.blockedReason = entry.blockedReason || 'halted';
  }
  if (signal?.marketContext?.excluded) {
    entry.blockedReason = entry.blockedReason || 'excluded';
  }
  if (signal?.marketConfirmationScore !== undefined && signal?.marketConfirmationScore !== null) {
    entry.marketConfirmationScore = Math.max(Number(entry.marketConfirmationScore || 0), Number(signal.marketConfirmationScore || 0));
  }
  if (signal?.catalystScore !== undefined && signal?.catalystScore !== null) {
    entry.secCatalystScore = Math.max(Number(entry.secCatalystScore || 0), Number(signal.catalystScore || 0));
  }
  if (signal?.riskBlockScore !== undefined && signal?.riskBlockScore !== null) {
    entry.secRiskBlockScore = Math.max(Number(entry.secRiskBlockScore || 0), Number(signal.riskBlockScore || 0));
  }
  if (signal?.score !== undefined && signal?.score !== null) {
    entry.secondaryScore = Math.max(Number(entry.secondaryScore || 0), Number(signal.score || 0));
  }
}

function buildSymbolSourceStatus(sourceStatusMap = {}, entry = {}) {
  const status = [];
  for (const contributor of entry.sourceContributors || []) {
    const sourceEntry = sourceStatusMap[contributor.source] || null;
    status.push({
      source: contributor.source,
      tier: contributor.tier || inferSourceTier(contributor.source),
      status: sourceEntry?.status || contributor.status || 'active',
      lastScanAt: sourceEntry?.lastScanAt || sourceEntry?.lastRunAt || null,
      lastError: sourceEntry?.lastError || null,
      symbolsDetected: sourceEntry?.symbolsDetected ?? null,
      blockedReason: sourceEntry?.blockedReason || null,
    });
  }
  return status;
}

function inferSourceTier(source) {
  const key = String(source || '').toLowerCase();
  if (key.includes('asset') || key.includes('halt') || key.includes('risk')) return 'risk';
  if (key.includes('news') || key.includes('social') || key.includes('options')) return 'context';
  if (key.includes('ranking') || key.includes('scoring')) return 'scoring';
  if (key.includes('polygon') || key.includes('market') || key.includes('alpha')) return 'market';
  if (key.includes('universe')) return 'universe';
  return 'context';
}

function mergeTradableStatus(current, next, details = null) {
  const values = [current, next, details?.tradable ? 'tradable' : null].filter(Boolean).map((value) => String(value).toLowerCase());
  if (values.includes('blocked')) return 'blocked';
  if (values.includes('not_tradable')) return 'blocked';
  if (values.includes('tradable')) return 'tradable';
  if (values.includes('not_found')) return 'not_found';
  return values[0] || 'unknown';
}

function mergeHaltStatus(current, next) {
  const values = [current, next].filter(Boolean).map((value) => String(value).toLowerCase());
  if (values.includes('halted')) return 'halted';
  if (values.includes('not_halted')) return 'not_halted';
  return values[0] || 'unknown';
}

function pickNumber(next, current) {
  const numeric = Number(next);
  return Number.isFinite(numeric) ? numeric : current ?? null;
}

function createTimedFetch(fetchImpl, timeoutMs) {
  return async (url, options = {}) => {
    const controller = new AbortController();
    const existingSignal = options.signal;
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 5000));
    const signal = existingSignal || controller.signal;
    try {
      return await fetchImpl(url, {
        ...options,
        signal,
        headers: {
          'user-agent': 'workflow-2-regular-watch',
          ...(options.headers || {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = {
  buildBaseSourceEntries,
  buildContextSourceStatus,
  buildIdleStatus,
  buildSymbolEntries,
  createTimedFetch,
  resolveRegularWatchSourceRuntime,
  resolveRegularWatchSymbols,
  runRegularWatchSources,
};
