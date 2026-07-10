const { loadRegularWatchState, resolveRegularWatchStatePath } = require('./regular-watch-feature-state');
const { loadRegularWatchStatus, saveRegularWatchStatus, resolveRegularWatchStatusPath } = require('./regular-watch-status');
const { scoreRegularWatchSymbol } = require('./regular-watch-score');
const { buildScannerConfig } = require('../scanner-config');
const { VOLATILE_STOCK_SYMBOLS, parseSymbolList, resolveRotatingStockSymbols } = require('../volatile-stock-universe');
const { nowIso } = require('../util');
const { buildSourceStatus, fetchJsonWithTimeout, redactSourceMessage } = require('../source-fetch');
const { fetchAlpacaMarketSignals, fetchAlpacaAssetSignals, fetchNasdaqHaltsSignals, fetchSecEdgarSignals } = require('../meme-monitor/phase-a-source-runner');
const { fetchPolygonMarketSignals } = require('../meme-monitor/sources/polygon-market-source');
const { fetchAlphaVantageSignals } = require('../meme-monitor/sources/alpha-vantage-source');
const { loadDynamicHotList, resolveDynamicHotListPath } = require('../meme-monitor/hot-list-store');

function resolveRegularWatchSymbols(env = process.env) {
  const scannerConfig = buildScannerConfig(env);
  const configured = Array.isArray(scannerConfig.symbols) && scannerConfig.symbols.length
    ? scannerConfig.symbols
    : resolveRotatingStockSymbols(env.STOCK_SCANNER_SYMBOLS);
  return normalizeRegularWatchSymbols(configured, []);
}

function normalizeRegularWatchSymbols(value, fallback = []) {
  const parsed = parseSymbolList(value, fallback);
  const cleaned = parsed.filter(isSupportedRegularWatchSymbol);
  return cleaned.length ? [...new Set(cleaned)] : fallback.slice();
}

function isSupportedRegularWatchSymbol(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return false;
  if (normalized.includes('/') || normalized.includes(' ')) return false;
  if (normalized.length > 15) return false;
  return /^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/.test(normalized);
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
  const maxSymbols = Math.max(1, Number(options.maxSymbolsPerRun || env.REGULAR_WATCH_MAX_SYMBOLS_PER_RUN || 500) || 500);
  const displayedTopLimit = Math.max(1, Number(options.displayedTopLimit || env.REGULAR_WATCH_DISPLAY_LIMIT || 100) || 100);
  const fastLaneEnabled = String(options.fastLaneEnabled ?? env.REGULAR_WATCH_FAST_LANE_ENABLED ?? 'true').toLowerCase() !== 'false';
  const fastLaneLimit = Math.max(0, Number(options.fastLaneLimit || env.REGULAR_WATCH_FAST_LANE_LIMIT || 250) || 250);
  const sourceRuntime = resolveRegularWatchSourceRuntime(env, runtimeState);
  const now = nowIso();
  const previousStatus = loadRegularWatchStatus({ dataDir, repoRoot, filePath: statusPath });
  const universe = await resolveRegularWatchUniverse({
    env,
    fetchImpl,
    repoRoot,
    timeoutMs,
    fallbackSymbols: resolveRegularWatchSymbols(env),
  });
  const fastLane = buildFastLaneSymbols({
    enabled: fastLaneEnabled,
    limit: fastLaneLimit,
    previousStatus,
    dynamicHotList: loadDynamicHotList({
      dataDir,
      filePath: options.dynamicHotListPath || resolveDynamicHotListPath({ dataDir, repoRoot }),
      env,
      now,
    }),
    universeSymbols: universe.symbols,
  });
  const rotation = selectRotatingSymbolBatch({
    symbols: universe.symbols,
    batchSize: Math.max(1, maxSymbols - fastLane.symbols.length),
    previousOffset: previousStatus.universe?.rotation?.next_offset,
  });
  const symbols = uniqueSymbols([...fastLane.symbols, ...rotation.symbols]).slice(0, maxSymbols);
  const scannedToday = updateScannedTodaySymbols({
    previousUniverse: previousStatus.universe,
    symbols,
    now,
  });
  const baseSources = buildBaseSourceEntries({
    sourceRuntime,
    symbols,
    now,
    universe,
  });

  if (!sourceRuntime.master) {
    const idle = buildIdleStatus({
      runtimeState,
      sources: baseSources,
      now,
      reason: 'master_disabled',
      symbols,
      universe: buildUniverseStatus({
        universe,
        rotation,
        fastLane,
        mergedSymbols: symbols,
        displayedTopLimit,
        scannedToday,
        freshDataCount: 0,
      }),
    });
    return saveRegularWatchStatus(idle, { dataDir, filePath: statusPath });
  }

  const timedFetch = createTimedFetch(fetchImpl, timeoutMs);
  const sourceResults = await runEnabledSources({
    env,
    fetchImpl: timedFetch,
    repoRoot,
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
  const runtimeStatus = sourceResults.anyErrors || sourceResults.lastError || stale || blockedSymbols > 0
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
      fullUniverseSymbols: universe.symbols.length,
      currentBatchSize: symbols.length,
      rotationBatchSize: rotation.symbols.length,
      fastLaneCandidateCount: fastLane.symbols.length,
      scannedTodayCount: scannedToday.symbols.length,
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
    universe: buildUniverseStatus({
      universe,
      rotation,
      fastLane,
      mergedSymbols: symbols,
      displayedTopLimit,
      scannedToday,
      freshDataCount: regularWatchList.filter((entry) => !entry.stale && Number.isFinite(Number(entry.currentPrice))).length,
    }),
    generatedAt: now,
    stale,
    status: runtimeStatus,
    lastRunAt: now,
    lastError: sourceResults.lastError || null,
  };

  return saveRegularWatchStatus(status, { dataDir, filePath: statusPath });
}

async function runEnabledSources({ env, fetchImpl, repoRoot, symbols, timeoutMs, sourceRuntime } = {}) {
  const sourceStatusMap = {};
  const sourceSignals = [];
  let anyErrors = false;
  let anyStale = false;
  let lastError = null;

  const addResult = (sourceName, result) => {
    sourceStatusMap[sourceName] = result.sourceStatus;
    const status = String(result.sourceStatus?.status || '').toLowerCase();
    if (result.sourceStatus?.lastError && !lastError && (status === 'warn' || result.sourceStatus?.partialFailure || Array.isArray(result.sourceStatus?.rejectedSymbols))) {
      lastError = result.sourceStatus.lastError;
    }
    if (result.sourceStatus?.status && ['error', 'missing_credentials', 'rate_limited'].includes(status)) {
      anyErrors = true;
      lastError = lastError || result.sourceStatus.lastError || result.sourceStatus.blockedReason || `${sourceName}_failed`;
    }
    for (const signal of result.symbols || []) {
      sourceSignals.push({ ...signal, source: sourceName });
      if (signal?.marketContext?.stale) anyStale = true;
    }
  };

  addResult('alpacaMarket', sourceRuntime.marketConfirmation || sourceRuntime.assetValidation || sourceRuntime.haltCheck || sourceRuntime.secRiskCheck
    ? await fetchAlpacaMarketSignalsBatched({ env, fetchImpl, repoRoot, symbols, timeoutMs })
    : inactiveSource('alpacaMarket'));

  addResult('alpacaAssets', sourceRuntime.assetValidation || sourceRuntime.positionAwareness
    ? await fetchAlpacaAssetSignals({ env, fetchImpl, repoRoot, symbols, timeoutMs })
    : inactiveSource('alpacaAssets'));

  addResult('nasdaqHalts', sourceRuntime.haltCheck
    ? await fetchNasdaqHaltsSignals({ env, fetchImpl, repoRoot, symbols, timeoutMs })
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

function buildBaseSourceEntries({ sourceRuntime, symbols, now, universe = null } = {}) {
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
      fullUniverseSymbols: universe?.symbols?.length ?? symbols.length,
      universeSource: universe?.source || null,
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

function buildIdleStatus({ runtimeState, sources, now, reason, symbols, universe = null } = {}) {
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
      fullUniverseSymbols: universe?.full_eligible_count || universe?.symbols?.length || symbols.length,
      currentBatchSize: symbols.length,
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
    universe,
    generatedAt: now,
    stale: true,
    status: 'off',
    lastRunAt: now,
    lastError: reason || null,
  };
}

async function resolveRegularWatchUniverse({
  env = process.env,
  fetchImpl = globalThis.fetch,
  repoRoot = process.cwd(),
  timeoutMs = 5000,
  fallbackSymbols = [],
} = {}) {
  const configured = normalizeRegularWatchSymbols(env.STOCK_SCANNER_SYMBOLS, []);
  if (configured.length) {
    return {
      source: 'configured_stock_scanner_symbols',
      symbols: configured,
      fallback: false,
      warning: null,
    };
  }
  const source = String(env.REGULAR_WATCH_UNIVERSE_SOURCE || 'alpaca_assets').trim().toLowerCase();
  if (source !== 'alpaca_assets') {
    return {
      source: 'built_in_volatile_stock_symbols',
      symbols: normalizeRegularWatchSymbols(fallbackSymbols, VOLATILE_STOCK_SYMBOLS),
      fallback: true,
      warning: 'REGULAR_WATCH_UNIVERSE_SOURCE is not alpaca_assets.',
    };
  }
  const fetched = await fetchAlpacaRegularStockUniverse({ env, fetchImpl, repoRoot, timeoutMs });
  if (fetched.ok && fetched.symbols.length) {
    return {
      source: 'alpaca_assets',
      symbols: normalizeRegularWatchSymbols(fetched.symbols, []),
      fallback: false,
      warning: null,
    };
  }
  return {
    source: 'built_in_volatile_stock_symbols',
    symbols: normalizeRegularWatchSymbols(fallbackSymbols, VOLATILE_STOCK_SYMBOLS),
    fallback: true,
    warning: fetched.error || 'Alpaca asset universe unavailable; using built-in fallback list.',
  };
}

async function fetchAlpacaRegularStockUniverse({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const apiKeyId = String(env?.ALPACA_API_KEY_ID || '').trim();
  const apiSecretKey = String(env?.ALPACA_API_SECRET_KEY || '').trim();
  const baseUrl = String(env?.ALPACA_API_BASE_URL || '').trim() || 'https://paper-api.alpaca.markets';
  if (!apiKeyId || !apiSecretKey) {
    return { ok: false, symbols: [], error: 'ALPACA credentials missing' };
  }
  try {
    const result = await fetchJsonWithTimeout(fetchImpl, `${trimTrailingSlash(baseUrl)}/v2/assets`, {
      timeoutMs,
      headers: alpacaHeaders(apiKeyId, apiSecretKey),
    });
    if (!result.response.ok) {
      return { ok: false, symbols: [], error: `Alpaca assets HTTP ${result.response.status}` };
    }
    const assets = Array.isArray(result.body) ? result.body : result.body?.assets || result.body?.data || [];
    const symbols = assets
      .filter((asset) => String(asset?.asset_class || asset?.class || '').toLowerCase() === 'us_equity')
      .filter((asset) => String(asset?.status || '').toLowerCase() === 'active')
      .filter((asset) => asset?.tradable === true)
      .map((asset) => String(asset?.symbol || '').trim().toUpperCase())
      .filter((symbol) => symbol && !symbol.includes('/') && !symbol.includes(' '))
      .sort((a, b) => a.localeCompare(b));
    return { ok: true, symbols: [...new Set(symbols)], error: null };
  } catch (error) {
    return { ok: false, symbols: [], error: redactSourceMessage(error.message) };
  }
}

function selectRotatingSymbolBatch({ symbols = [], batchSize = 500, previousOffset = 0 } = {}) {
  const unique = normalizeRegularWatchSymbols(symbols, []);
  const size = Math.max(1, Math.floor(Number(batchSize) || 500));
  if (!unique.length) {
    return { symbols: [], offset: 0, next_offset: 0, batch_size: size, full_eligible_count: 0, wrapped: false };
  }
  if (size >= unique.length) {
    return { symbols: unique, offset: 0, next_offset: 0, batch_size: size, full_eligible_count: unique.length, wrapped: true };
  }
  const offset = Math.max(0, Math.floor(Number(previousOffset) || 0)) % unique.length;
  const selected = [];
  for (let index = 0; index < size; index += 1) {
    selected.push(unique[(offset + index) % unique.length]);
  }
  const nextOffset = (offset + size) % unique.length;
  return {
    symbols: selected,
    offset,
    next_offset: nextOffset,
    batch_size: size,
    full_eligible_count: unique.length,
    wrapped: nextOffset <= offset,
  };
}

function buildFastLaneSymbols({
  enabled = true,
  limit = 250,
  previousStatus = {},
  dynamicHotList = null,
  universeSymbols = [],
} = {}) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (!enabled || max <= 0) {
    return { enabled: false, symbols: [], count: 0, limit: max, sources: {} };
  }
  const universe = new Set(normalizeRegularWatchSymbols(universeSymbols, []));
  const sourceCounts = {};
  const candidates = [];
  const add = (symbol, source, score = 0) => {
    const normalized = String(symbol || '').trim().toUpperCase();
    if (!normalized || (universe.size && !universe.has(normalized))) return;
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    candidates.push({ symbol: normalized, source, score: Number(score) || 0 });
  };
  for (const entry of Array.isArray(previousStatus?.regularWatchMovers) ? previousStatus.regularWatchMovers : []) {
    add(entry?.symbol, 'previous_regular_watch_movers', entry?.score ?? entry?.regularWatchScore);
  }
  for (const entry of Array.isArray(previousStatus?.regularWatchList) ? previousStatus.regularWatchList.slice(0, max) : []) {
    if (String(entry?.status || '').toLowerCase() === 'blocked') continue;
    add(entry?.symbol, 'previous_regular_watch_top', entry?.score ?? entry?.regularWatchScore);
  }
  for (const entry of Array.isArray(dynamicHotList?.dynamicHotList) ? dynamicHotList.dynamicHotList : []) {
    add(entry?.symbol, 'dynamic_hot_list', entry?.marketConfirmationScore ?? entry?.memeHeatScore);
  }
  for (const entry of Array.isArray(dynamicHotList?.hotHotList) ? dynamicHotList.hotHotList : []) {
    add(entry?.symbol, 'hot_hot_list', entry?.marketConfirmationScore ?? entry?.memeHeatScore);
  }
  const symbols = [];
  const seen = new Set();
  for (const entry of candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))) {
    if (seen.has(entry.symbol)) continue;
    seen.add(entry.symbol);
    symbols.push(entry.symbol);
    if (symbols.length >= max) break;
  }
  return {
    enabled: true,
    symbols,
    count: symbols.length,
    limit: max,
    sources: sourceCounts,
  };
}

function updateScannedTodaySymbols({ previousUniverse = {}, symbols = [], now = nowIso() } = {}) {
  const date = String(now || nowIso()).slice(0, 10);
  const previousDate = previousUniverse?.scanned_today_date || null;
  const scanned = new Set(previousDate === date && Array.isArray(previousUniverse?.scanned_today_symbols)
    ? previousUniverse.scanned_today_symbols
    : []);
  for (const symbol of symbols) {
    const normalized = String(symbol || '').trim().toUpperCase();
    if (!isSupportedRegularWatchSymbol(normalized)) continue;
    if (normalized) scanned.add(normalized);
  }
  return {
    date,
    symbols: [...scanned].sort((a, b) => a.localeCompare(b)),
  };
}

function buildUniverseStatus({ universe, rotation, fastLane = null, mergedSymbols = null, displayedTopLimit, scannedToday, freshDataCount = 0 } = {}) {
  return {
    source: universe?.source || null,
    full_eligible_count: universe?.symbols?.length || 0,
    current_batch_size: rotation?.symbols?.length || 0,
    rotation_batch_size: rotation?.symbols?.length || 0,
    fast_lane_enabled: Boolean(fastLane?.enabled),
    fast_lane_candidate_count: fastLane?.count || 0,
    fast_lane_limit: fastLane?.limit || 0,
    fast_lane_sources: fastLane?.sources || {},
    merged_scan_size: Array.isArray(mergedSymbols) ? mergedSymbols.length : (rotation?.symbols?.length || 0),
    displayed_top_limit: displayedTopLimit,
    scanned_today_date: scannedToday?.date || null,
    scanned_today_count: scannedToday?.symbols?.length || 0,
    scanned_today_symbols: scannedToday?.symbols || [],
    fresh_data_count: freshDataCount,
    warning: universe?.warning || null,
    rotation: {
      offset: rotation?.offset || 0,
      next_offset: rotation?.next_offset || 0,
      batch_size: rotation?.batch_size || 0,
      full_eligible_count: rotation?.full_eligible_count || universe?.symbols?.length || 0,
      wrapped: Boolean(rotation?.wrapped),
    },
  };
}

async function fetchAlpacaMarketSignalsBatched({ env, fetchImpl, repoRoot, symbols = [], timeoutMs } = {}) {
  const batchSize = Math.max(1, Number(env.REGULAR_WATCH_MARKET_DATA_BATCH_SIZE || 100) || 100);
  const normalizedSymbols = normalizeRegularWatchSymbols(symbols, []);
  const rejectedSymbols = [...new Set(parseSymbolList(symbols, []).filter((symbol) => !isSupportedRegularWatchSymbol(symbol)))];
  const batches = chunk(normalizedSymbols, batchSize);
  const merged = {
    sourceStatus: null,
    symbols: [],
  };
  const diagnostics = {
    rejectedSymbols: [...rejectedSymbols],
    isolatedRejectedSymbols: [],
    partialFailure: false,
  };
  let hardFailure = null;
  const maxIsolationDepth = Math.max(2, Math.ceil(Math.log2(Math.max(2, batchSize))));

  const processBatch = async (batch, depth = 0) => {
    if (!batch.length || hardFailure) return;
    const result = await fetchAlpacaMarketSignals({ env, fetchImpl, repoRoot, symbols: batch, timeoutMs });
    const status = String(result.sourceStatus?.status || '').toLowerCase();
    const lastError = String(result.sourceStatus?.lastError || '');
    const isBadRequest = status === 'error' && /HTTP 400|HTTP 422/i.test(lastError);
    const isHardFailure = ['rate_limited', 'missing_credentials', 'timeout'].includes(status)
      || (status === 'error' && !isBadRequest);

    if (isBadRequest && batch.length > 1) {
      diagnostics.partialFailure = true;
      if (depth >= maxIsolationDepth) {
        hardFailure = result.sourceStatus;
        return;
      }
      const midpoint = Math.ceil(batch.length / 2);
      await processBatch(batch.slice(0, midpoint), depth + 1);
      await processBatch(batch.slice(midpoint), depth + 1);
      return;
    }

    if (isBadRequest && batch.length === 1) {
      diagnostics.partialFailure = true;
      diagnostics.isolatedRejectedSymbols.push(batch[0]);
      return;
    }

    if (isHardFailure) {
      hardFailure = result.sourceStatus;
      return;
    }

    merged.symbols.push(...(result.symbols || []));
    merged.sourceStatus = mergeSourceStatus(merged.sourceStatus, result.sourceStatus, merged.symbols.length);
  };

  for (const batch of batches) {
    await processBatch(batch, 0);
    if (hardFailure) break;
  }
  merged.sourceStatus = merged.sourceStatus || inactiveSource('alpacaMarket').sourceStatus;

  const failedSymbols = [...new Set([...diagnostics.rejectedSymbols, ...diagnostics.isolatedRejectedSymbols])];
  if (failedSymbols.length || diagnostics.partialFailure || hardFailure) {
    const confirmed = merged.symbols.length;
    const rateLimitCooldownSeconds = Math.max(5, Number(
      hardFailure?.retryAfterSeconds
      ?? env.REGULAR_WATCH_RATE_LIMIT_COOLDOWN_SECONDS
      ?? 120,
    ) || 120);
    const nextRetryAt = hardFailure?.status === 'rate_limited'
      ? (hardFailure.retryAfterAt || new Date(Date.now() + rateLimitCooldownSeconds * 1000).toISOString())
      : null;
    const issueLabel = failedSymbols.length
      ? (failedSymbols.length === 1
        ? `1 unsupported symbol (${failedSymbols[0]})`
        : `${failedSymbols.length} unsupported symbols`)
      : (hardFailure?.status ? `${hardFailure.status} batch failure` : 'Alpaca snapshot batch rejected');
    const errorLabel = hardFailure?.lastError || (failedSymbols.length ? `Ignored ${issueLabel}` : 'Alpaca snapshot batch rejected');
    merged.sourceStatus = buildSourceStatus({
      ...(merged.sourceStatus || {}),
      source: 'alpacaMarket',
      enabled: true,
      available: confirmed > 0 || Boolean(hardFailure?.available),
      status: confirmed > 0 ? 'warn' : (hardFailure?.status || 'error'),
      lastRunAt: confirmed > 0 ? nowIso() : null,
      lastError: confirmed > 0
        ? `Regular Watch ignored ${issueLabel} in Alpaca snapshot requests. ${confirmed} symbols confirmed.`
        : errorLabel,
      blockedReason: failedSymbols.length ? 'partial_request_failure' : (hardFailure?.blockedReason || 'source_not_found_or_inaccessible'),
      symbolsConfirmed: confirmed,
      rejectedSymbols: failedSymbols,
      partialFailure: Boolean(diagnostics.partialFailure || failedSymbols.length),
      httpStatus: hardFailure?.httpStatus ?? null,
      retryAfterSeconds: hardFailure?.status === 'rate_limited' ? rateLimitCooldownSeconds : null,
      nextRetryAt,
    });
  }
  return merged;
}

function mergeSourceStatus(previous, next, symbolsDetected = 0) {
  if (!previous) {
    return { ...(next || {}), symbolsDetected };
  }
  const statusRank = { active: 1, warn: 2, inactive: 3, missing_credentials: 4, timeout: 5, rate_limited: 6, error: 7 };
  const previousRank = statusRank[String(previous.status || '').toLowerCase()] || 0;
  const nextRank = statusRank[String(next?.status || '').toLowerCase()] || 0;
  const winner = nextRank > previousRank ? next : previous;
  return {
    ...previous,
    ...winner,
    symbolsDetected,
    symbolsConfirmed: symbolsDetected,
    lastRunAt: next?.lastRunAt || previous.lastRunAt || null,
    lastScanAt: next?.lastScanAt || previous.lastScanAt || null,
  };
}

function chunk(values = [], size = 100) {
  const out = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function uniqueSymbols(values = []) {
  return [...new Set(normalizeRegularWatchSymbols(values, []))];
}

function alpacaHeaders(apiKeyId, apiSecretKey) {
  return {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
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
  resolveRegularWatchUniverse,
  selectRotatingSymbolBatch,
  runRegularWatchSources,
};
