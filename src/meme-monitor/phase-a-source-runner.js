const path = require('path');
const { resolveMemeMonitorStatePath, loadMemeMonitorState } = require('../meme-monitor-state');
const { createRedditCollector } = require('./reddit-collector');
const { extractMentionsFromRecord } = require('./symbol-extractor');
const { scoreMarketConfirmation } = require('./market-confirmation-score');
const { nowIso, safeNumber } = require('../util');
const { buildSourceStatus, classifyHttpSourceStatus, fetchJsonWithTimeout, fetchTextWithTimeout, redactSourceMessage } = require('../source-fetch');

function resolvePhaseASourceRuntime(env = process.env, runtimeState = null) {
  const featureState = runtimeState || loadMemeMonitorState({ env, filePath: resolveMemeMonitorStatePath({ env }) });
  const features = featureState.features || {};
  const resolveEnabled = (key) => Boolean(features[key]?.effective || features[key]?.runtime || env[key] === 'true');
  return {
    reddit: resolveEnabled('MEME_SOURCE_REDDIT_ENABLED'),
    alpacaMarket: resolveEnabled('MEME_SOURCE_ALPACA_MARKET_ENABLED'),
    alpacaAssets: resolveEnabled('MEME_SOURCE_ALPACA_ASSETS_ENABLED'),
    nasdaqHalts: resolveEnabled('MEME_SOURCE_NASDAQ_HALTS_ENABLED'),
    secEdgar: resolveEnabled('MEME_SOURCE_SEC_EDGAR_ENABLED'),
  };
}

async function runPhaseASources(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const repoRoot = options.repoRoot || process.cwd();
  const runtimeState = options.runtimeState || null;
  const sourceRuntime = resolvePhaseASourceRuntime(env, runtimeState);
  const timeoutMs = Math.max(1000, Number(env.MEME_PHASE_A_SOURCE_TIMEOUT_MS || options.timeoutMs || 5000) || 5000);
  const maxSymbolsPerRun = Math.max(1, Number(env.MEME_PHASE_A_MAX_SYMBOLS_PER_RUN || options.maxSymbolsPerRun || 50) || 50);
  const sources = {};
  const records = [];
  const phaseASymbols = new Map();
  const phaseAMarketContextBySymbol = new Map();
  const precollectedRedditRecords = Array.isArray(options.redditRecords) ? options.redditRecords : Array.isArray(options.records) ? options.records : [];
  const redditRecordSource = options.redditRecordSource || 'reused_records';
  const seedSymbols = new Set(
    [...normalizeSymbols(options.candidateSymbols || []), ...extractSymbolsFromRecords(precollectedRedditRecords, options)],
  );
  for (const symbol of seedSymbols) {
    phaseASymbols.set(symbol, createPhaseASymbolEntry(symbol));
  }

  if (sourceRuntime.reddit) {
    const redditCollector = options.redditCollector || createRedditCollector({ env, fetchImpl });
    const result = precollectedRedditRecords.length
      ? {
          ok: true,
          status: 'ok',
          mode: 'reddit-oauth',
          records: precollectedRedditRecords,
          rejected: Array.isArray(options.redditRejected) ? options.redditRejected : [],
          symbolsDetected: precollectedRedditRecords.length,
          rejectedTokens: Array.isArray(options.redditRejected) ? options.redditRejected.length : 0,
          sources: Array.isArray(options.redditSourceStates) ? options.redditSourceStates : [],
          sourceMode: redditRecordSource,
        }
      : await redditCollector.collectSources({ env, repoRoot: options.repoRoot, dataDir: options.dataDir });
    sources.reddit = normalizeSourceStatus({
      source: 'reddit',
      enabled: true,
      available: Boolean(result.ok),
      status: result.ok ? (precollectedRedditRecords.length ? 'reused_records' : 'active') : result.status === 'missing_credentials' ? 'missing_credentials' : result.status === 'timeout' ? 'timeout' : 'error',
      lastRunAt: nowIso(),
      lastError: result.ok ? null : result.message || result.error || 'reddit_failed',
      symbolsDetected: Number(result.symbolsDetected || 0),
      rejectedTokens: Number(result.rejectedTokens || 0),
      tier: 'tiered',
      blockedReason: result.ok ? null : result.status || 'reddit_failed',
      sourceMode: precollectedRedditRecords.length ? 'reused_records' : 'fresh_collect',
    });
    ingestRedditRecords({
      records: result.records || [],
      phaseASymbols,
      recordsOut: records,
      options,
    });
  } else {
    sources.reddit = normalizeSourceStatus({ source: 'reddit', enabled: false, available: false, status: 'inactive', symbolsDetected: 0, rejectedTokens: 0, lastRunAt: null, lastError: null, blockedReason: 'source_disabled' });
    if (precollectedRedditRecords.length) {
      ingestRedditRecords({
        records: precollectedRedditRecords,
        phaseASymbols,
        recordsOut: records,
        options,
      });
    }
  }

  const symbols = [...phaseASymbols.keys()].slice(0, maxSymbolsPerRun);
  if (sourceRuntime.alpacaMarket) {
    const market = await fetchAlpacaMarketSignals({ env, fetchImpl, repoRoot, symbols, timeoutMs });
    sources.alpacaMarket = market.sourceStatus;
    for (const signal of market.symbols) {
      const entry = phaseASymbols.get(signal.symbol) || createPhaseASymbolEntry(signal.symbol);
      entry.marketConfirmationScore = signal.marketConfirmationScore;
      entry.sourceConfirmations.alpacaMarket = signal.available;
      entry.sourceDetails.alpacaMarket = signal.details || null;
      entry.reasonCodes = new Set([...entry.reasonCodes, ...signal.reasonCodes]);
      entry.riskWarnings = new Set([...entry.riskWarnings, ...signal.riskWarnings]);
      phaseAMarketContextBySymbol.set(signal.symbol, signal.marketContext);
      phaseASymbols.set(signal.symbol, entry);
    }
  } else {
    sources.alpacaMarket = normalizeSourceStatus({ source: 'alpacaMarket', enabled: false, available: false, status: 'inactive', symbolsConfirmed: 0, lastRunAt: null, lastError: null, blockedReason: 'source_disabled' });
  }

  if (sourceRuntime.alpacaAssets) {
    const assets = await fetchAlpacaAssetSignals({ env, fetchImpl, repoRoot, symbols, timeoutMs });
    sources.alpacaAssets = assets.sourceStatus;
    for (const signal of assets.symbols) {
      const entry = phaseASymbols.get(signal.symbol) || createPhaseASymbolEntry(signal.symbol);
      entry.tradableStatus = signal.tradableStatus;
      entry.sourceConfirmations.alpacaAssets = signal.tradableStatus === 'tradable';
      entry.sourceDetails.alpacaAssets = signal.details || null;
      entry.reasonCodes = new Set([...entry.reasonCodes, ...signal.reasonCodes]);
      entry.riskWarnings = new Set([...entry.riskWarnings, ...signal.riskWarnings]);
      phaseAMarketContextBySymbol.set(signal.symbol, mergeMarketContext(phaseAMarketContextBySymbol.get(signal.symbol), signal.marketContext));
      phaseASymbols.set(signal.symbol, entry);
    }
  } else {
    sources.alpacaAssets = normalizeSourceStatus({ source: 'alpacaAssets', enabled: false, available: false, status: 'inactive', symbolsTradable: 0, symbolsBlocked: 0, lastRunAt: null, lastError: null, blockedReason: 'source_disabled' });
  }

  if (sourceRuntime.nasdaqHalts) {
    const halts = await fetchNasdaqHaltsSignals({ env, fetchImpl, repoRoot, symbols, timeoutMs });
    sources.nasdaqHalts = halts.sourceStatus;
    for (const signal of halts.symbols) {
      const entry = phaseASymbols.get(signal.symbol) || createPhaseASymbolEntry(signal.symbol);
      entry.haltStatus = signal.haltStatus;
      entry.sourceConfirmations.nasdaqHalts = signal.haltStatus === 'not_halted';
      entry.sourceDetails.nasdaqHalts = signal.details || null;
      entry.reasonCodes = new Set([...entry.reasonCodes, ...signal.reasonCodes]);
      entry.riskWarnings = new Set([...entry.riskWarnings, ...signal.riskWarnings]);
      phaseAMarketContextBySymbol.set(signal.symbol, mergeMarketContext(phaseAMarketContextBySymbol.get(signal.symbol), signal.marketContext));
      phaseASymbols.set(signal.symbol, entry);
    }
  } else {
    sources.nasdaqHalts = normalizeSourceStatus({ source: 'nasdaqHalts', enabled: false, available: false, status: 'inactive', blockedSymbols: 0, lastRunAt: null, lastError: null, blockedReason: 'source_disabled' });
  }

  if (sourceRuntime.secEdgar) {
    const sec = await fetchSecEdgarSignals({ env, fetchImpl, repoRoot, symbols, timeoutMs });
    sources.secEdgar = sec.sourceStatus;
    for (const signal of sec.symbols) {
      const entry = phaseASymbols.get(signal.symbol) || createPhaseASymbolEntry(signal.symbol);
      entry.catalystScore = signal.catalystScore;
      entry.riskBlockScore = signal.riskBlockScore;
      entry.sourceConfirmations.secEdgar = signal.catalystScore > 0;
      entry.sourceDetails.secEdgar = signal.details || null;
      entry.reasonCodes = new Set([...entry.reasonCodes, ...signal.reasonCodes]);
      entry.riskWarnings = new Set([...entry.riskWarnings, ...signal.riskWarnings]);
      phaseASymbols.set(signal.symbol, entry);
    }
  } else {
    sources.secEdgar = normalizeSourceStatus({ source: 'secEdgar', enabled: false, available: false, status: 'inactive', catalystsDetected: 0, riskWarnings: 0, lastRunAt: null, lastError: null, blockedReason: 'source_disabled' });
  }

  const symbolsOut = [...phaseASymbols.values()].map((entry) => {
    const marketConfirmation = Number.isFinite(entry.marketConfirmationScore)
      ? entry.marketConfirmationScore
      : null;
    const tradableStatus = entry.tradableStatus || 'unknown';
    const haltStatus = entry.haltStatus || 'unknown';
    const catalystScore = entry.catalystScore || 0;
    const riskBlockScore = entry.riskBlockScore || 0;
    const score = scoreMarketConfirmation(entry.symbol, phaseAMarketContextBySymbol.get(entry.symbol) || null, {
      marketConfirmationMinScore: Number(env.MEME_MARKET_CONFIRMATION_MIN_SCORE || 70),
    });
    return {
      symbol: entry.symbol,
      socialHeatScore: Number(entry.socialHeatScore || 0),
      marketConfirmationScore: marketConfirmation,
      catalystScore,
      riskBlockScore,
      haltStatus,
      tradableStatus,
      status: derivePhaseAStatus({ sourceRuntime, marketConfirmation, tradableStatus, haltStatus, catalystScore, riskBlockScore, riskWarnings: [...entry.riskWarnings], score }),
      sourceConfirmations: {
        reddit: Boolean(entry.sourceConfirmations.reddit),
        alpacaMarket: Boolean(entry.sourceConfirmations.alpacaMarket),
        alpacaAssets: Boolean(entry.sourceConfirmations.alpacaAssets),
        nasdaqHalts: Boolean(entry.sourceConfirmations.nasdaqHalts),
        secEdgar: Boolean(entry.sourceConfirmations.secEdgar),
      },
      reasonCodes: [...entry.reasonCodes],
      riskWarnings: [...entry.riskWarnings],
      rawSummary: buildRawSummary(entry),
      sources: buildSourceStatusSummary(entry),
    };
  }).sort((a, b) => Number(b.socialHeatScore || 0) - Number(a.socialHeatScore || 0) || a.symbol.localeCompare(b.symbol));

  return {
    generatedAt: nowIso(),
    phaseA: {
      enabled: true,
      status: 'active',
      sources,
      symbols: symbolsOut,
    },
    symbols: symbolsOut,
    sources: sources,
    symbolsBySymbol: Object.fromEntries(symbolsOut.map((entry) => [entry.symbol, entry])),
    sourceConfirmationsBySymbol: Object.fromEntries(symbolsOut.map((entry) => [entry.symbol, entry.sourceConfirmations])),
    marketContextBySymbol: Object.fromEntries(phaseAMarketContextBySymbol.entries()),
  };
}

async function fetchAlpacaMarketSignals({ env, fetchImpl, symbols = [], timeoutMs = 5000, repoRoot = process.cwd() } = {}) {
  const apiKeyId = String(env?.ALPACA_API_KEY_ID || '').trim();
  const apiSecretKey = String(env?.ALPACA_API_SECRET_KEY || '').trim();
  const baseUrl = String(env?.ALPACA_DATA_BASE_URL || '').trim() || 'https://data.alpaca.markets';
  if (!apiKeyId || !apiSecretKey) {
    return {
      sourceStatus: buildSourceStatus({ source: 'alpacaMarket', enabled: true, available: false, status: 'missing_credentials', symbolsConfirmed: 0, lastRunAt: null, lastError: 'ALPACA credentials missing', blockedReason: 'missing_credentials' }),
      symbols: [],
    };
  }
  if (!symbols.length) {
    return {
      sourceStatus: buildSourceStatus({ source: 'alpacaMarket', enabled: true, available: true, status: 'active', symbolsConfirmed: 0, lastRunAt: nowIso(), lastError: null }),
      symbols: [],
    };
  }
  try {
    const encodedSymbols = encodeURIComponent(symbols.join(','));
    const url = `${trimTrailingSlash(baseUrl)}/v2/stocks/snapshots?symbols=${encodedSymbols}&feed=iex`;
    const snapshotCacheSeconds = Math.max(0, Number(
      env?.REGULAR_WATCH_ALPACA_SNAPSHOT_CACHE_SECONDS
      ?? env?.MEME_PHASE_A_SOURCE_CACHE_SECONDS
      ?? 15,
    ) || 0);
    const result = await fetchJsonWithTimeout(fetchImpl, url, {
      timeoutMs,
      headers: alpacaHeaders(apiKeyId, apiSecretKey),
      cache: sourceCacheOptions({ env, repoRoot, cacheKey: symbols.join(',') }, 'alpacaMarket', 'snapshots', snapshotCacheSeconds),
    });
    const { response, body } = result;
    if (!response.ok) {
      const retryAfterSeconds = resolveRetryAfterSeconds(response);
      return {
        sourceStatus: buildSourceStatus({
          source: 'alpacaMarket',
          enabled: true,
          available: false,
          status: response.status === 429 ? 'rate_limited' : 'error',
          symbolsConfirmed: 0,
          lastRunAt: null,
          lastError: `HTTP ${response.status}`,
          blockedReason: classifyHttpSourceStatus(response.status, body).blockedReason,
          httpStatus: response.status,
          retryAfterSeconds,
          retryAfterAt: retryAfterSeconds !== null ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString() : null,
          cache: result.cache,
        }),
        symbols: [],
      };
    }
    const snapshots = body?.snapshots || body || {};
    const nowMs = Date.now();
    const out = [];
    for (const symbol of symbols) {
      const snapshot = snapshots[symbol] || {};
      const latestTrade = snapshot.latestTrade || snapshot.latest_trade || null;
      const latestQuote = snapshot.latestQuote || snapshot.latest_quote || null;
      const currentPrice = safeNumber(latestTrade?.p ?? latestTrade?.price ?? latestQuote?.ap ?? latestQuote?.bp ?? snapshot.dailyBar?.c ?? snapshot.daily_bar?.c, null);
      const previousClose = safeNumber(snapshot.previousDailyBar?.c ?? snapshot.prevDailyBar?.c ?? snapshot.previous_daily_bar?.c ?? snapshot.prev_daily_bar?.c ?? snapshot.dailyBar?.o ?? snapshot.daily_bar?.o, null);
      const volume = safeNumber(snapshot.dailyBar?.v ?? snapshot.daily_bar?.v ?? latestTrade?.s, null);
      const averageVolume = safeNumber(snapshot.previousDailyBar?.v ?? snapshot.prevDailyBar?.v ?? snapshot.previous_daily_bar?.v ?? snapshot.prev_daily_bar?.v ?? null, null);
      const bid = safeNumber(latestQuote?.bp ?? latestQuote?.bid_price, null);
      const ask = safeNumber(latestQuote?.ap ?? latestQuote?.ask_price, null);
      const latestTimestamp = latestTrade?.t || latestQuote?.t || snapshot.updated_at || snapshot.updatedAt || null;
      const ageSeconds = Number.isFinite(new Date(latestTimestamp).getTime())
        ? Math.max(0, (nowMs - new Date(latestTimestamp).getTime()) / 1000)
        : null;
      const marketContext = {
        currentPrice,
        previousClose,
        openPrice: safeNumber(snapshot.dailyBar?.o ?? snapshot.daily_bar?.o, null),
        volume,
        averageVolume,
        bid,
        ask,
        stale: Number.isFinite(ageSeconds) ? ageSeconds > 90 : false,
        ageSeconds,
        asset_type: snapshot.asset?.asset_class || 'us_equity',
      };
      const score = scoreMarketConfirmation(symbol, marketContext, { marketConfirmationMinScore: Number(env.MEME_MARKET_CONFIRMATION_MIN_SCORE || 70) });
      out.push({
        symbol,
        available: true,
        marketConfirmationScore: score.marketConfirmationScore,
        reasonCodes: score.reasonCodes,
        riskWarnings: score.riskWarnings,
        details: {
          currentPrice,
          previousClose,
          volume,
          averageVolume,
          bid,
          ask,
          stale: false,
        },
        marketContext,
      });
    }
    return {
      sourceStatus: buildSourceStatus({ source: 'alpacaMarket', enabled: true, available: true, status: 'active', symbolsConfirmed: out.length, lastRunAt: nowIso(), lastError: null, cache: result.cache }),
      symbols: out,
    };
  } catch (error) {
    return {
      sourceStatus: buildSourceStatus({ source: 'alpacaMarket', enabled: true, available: false, status: isTimeoutError(error) ? 'timeout' : 'error', symbolsConfirmed: 0, lastRunAt: null, lastError: redactSourceMessage(error.message), blockedReason: isTimeoutError(error) ? 'timeout' : 'source_not_found_or_inaccessible' }),
      symbols: [],
    };
  }
}

function resolveRetryAfterSeconds(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const retryAt = new Date(raw).getTime();
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

async function fetchAlpacaAssetSignals({ env, fetchImpl, symbols = [], timeoutMs = 5000, repoRoot = process.cwd() } = {}) {
  const apiKeyId = String(env?.ALPACA_API_KEY_ID || '').trim();
  const apiSecretKey = String(env?.ALPACA_API_SECRET_KEY || '').trim();
  const baseUrl = String(env?.ALPACA_API_BASE_URL || '').trim() || 'https://paper-api.alpaca.markets';
  if (!apiKeyId || !apiSecretKey) {
    return {
      sourceStatus: buildSourceStatus({ source: 'alpacaAssets', enabled: true, available: false, status: 'missing_credentials', symbolsTradable: 0, symbolsBlocked: 0, lastRunAt: null, lastError: 'ALPACA credentials missing', blockedReason: 'missing_credentials' }),
      symbols: [],
    };
  }
  if (!symbols.length) {
    return {
      sourceStatus: buildSourceStatus({ source: 'alpacaAssets', enabled: true, available: true, status: 'active', symbolsTradable: 0, symbolsBlocked: 0, lastRunAt: nowIso(), lastError: null }),
      symbols: [],
    };
  }
  try {
    const result = await fetchJsonWithTimeout(fetchImpl, `${trimTrailingSlash(baseUrl)}/v2/assets`, {
      timeoutMs,
      headers: alpacaHeaders(apiKeyId, apiSecretKey),
      cache: sourceCacheOptions({ env, repoRoot, cacheKey: 'assets' }, 'alpacaAssets', 'assets', timeoutMs),
    });
    const { response, body } = result;
    if (!response.ok) {
      return {
        sourceStatus: buildSourceStatus({ source: 'alpacaAssets', enabled: true, available: false, status: response.status === 429 ? 'rate_limited' : 'error', symbolsTradable: 0, symbolsBlocked: 0, lastRunAt: null, lastError: `HTTP ${response.status}`, blockedReason: classifyHttpSourceStatus(response.status, body).blockedReason, cache: result.cache }),
        symbols: [],
      };
    }
    const assets = Array.isArray(body) ? body : body?.assets || body?.data || [];
    const lookup = new Map(assets.map((asset) => [String(asset.symbol || '').toUpperCase(), asset]));
    const out = [];
    for (const symbol of symbols) {
      const asset = lookup.get(symbol.toUpperCase()) || null;
      const tradable = Boolean(asset?.tradable);
      const active = String(asset?.status || '').toLowerCase() === 'active';
      const notFound = !asset;
      const tradableStatus = notFound ? 'not_found' : (tradable && active ? 'tradable' : 'blocked');
      out.push({
        symbol,
        tradableStatus,
        reasonCodes: notFound
          ? ['alpaca_asset_not_found']
          : tradable && active
            ? ['alpaca_asset_tradable_confirmed']
            : ['alpaca_asset_not_tradable'],
        riskWarnings: notFound || !active ? ['alpaca_asset_status_unavailable'] : [],
        details: asset ? { asset_type: asset.asset_class, status: asset.status, exchange: asset.exchange, tradable: asset.tradable } : null,
        marketContext: { tradable, asset_type: asset?.asset_class || 'us_equity', excluded: !tradable || !active },
      });
    }
    return {
      sourceStatus: buildSourceStatus({ source: 'alpacaAssets', enabled: true, available: true, status: 'active', symbolsTradable: out.filter((entry) => entry.tradableStatus === 'tradable').length, symbolsBlocked: out.filter((entry) => entry.tradableStatus !== 'tradable').length, lastRunAt: nowIso(), lastError: null, cache: result.cache }),
      symbols: out,
    };
  } catch (error) {
    return {
      sourceStatus: buildSourceStatus({ source: 'alpacaAssets', enabled: true, available: false, status: isTimeoutError(error) ? 'timeout' : 'error', symbolsTradable: 0, symbolsBlocked: 0, lastRunAt: null, lastError: redactSourceMessage(error.message), blockedReason: isTimeoutError(error) ? 'timeout' : 'source_not_found_or_inaccessible' }),
      symbols: [],
    };
  }
}

async function fetchNasdaqHaltsSignals({ env, fetchImpl, symbols = [], timeoutMs = 5000, repoRoot = process.cwd() } = {}) {
  const feedUrl = String(env?.NASDAQ_HALTS_RSS_URL || 'https://www.nasdaqtrader.com/Trader.aspx?id=TradeHaltRSS');
  if (!symbols.length) {
    return {
      sourceStatus: buildSourceStatus({ source: 'nasdaqHalts', enabled: true, available: true, status: 'active', blockedSymbols: 0, lastRunAt: nowIso(), lastError: null }),
      symbols: [],
    };
  }
  try {
    const result = await fetchTextWithTimeout(fetchImpl, feedUrl, {
      timeoutMs,
      headers: { 'user-agent': env?.REDDIT_USER_AGENT || 'workflow-2-meme-monitor' },
      cache: sourceCacheOptions({ env, repoRoot, cacheKey: feedUrl }, 'nasdaqHalts', 'rss', timeoutMs),
    });
    const { response, text } = result;
    if (!response.ok) {
      return {
        sourceStatus: buildSourceStatus({ source: 'nasdaqHalts', enabled: true, available: false, status: response.status === 429 ? 'rate_limited' : 'error', blockedSymbols: 0, lastRunAt: null, lastError: `HTTP ${response.status}`, blockedReason: classifyHttpSourceStatus(response.status, text).blockedReason, cache: result.cache }),
        symbols: [],
      };
    }
    const haltedSymbols = new Set([...text.matchAll(/<symbol>([^<]+)<\/symbol>/gi)].map((match) => String(match[1] || '').toUpperCase()));
    const out = symbols.map((symbol) => ({
      symbol,
      haltStatus: haltedSymbols.has(symbol.toUpperCase()) ? 'halted' : 'not_halted',
      reasonCodes: haltedSymbols.has(symbol.toUpperCase()) ? ['nasdaq_halt_detected'] : ['nasdaq_not_halted'],
      riskWarnings: haltedSymbols.has(symbol.toUpperCase()) ? ['possible_halt_risk'] : [],
      details: { source: feedUrl, halted: haltedSymbols.has(symbol.toUpperCase()) },
      marketContext: { halted: haltedSymbols.has(symbol.toUpperCase()), halt_status: haltedSymbols.has(symbol.toUpperCase()) ? 'halted' : 'open' },
    }));
    return {
      sourceStatus: buildSourceStatus({ source: 'nasdaqHalts', enabled: true, available: true, status: 'active', blockedSymbols: out.filter((entry) => entry.haltStatus === 'halted').length, lastRunAt: nowIso(), lastError: null, cache: result.cache }),
      symbols: out,
    };
  } catch (error) {
    return {
      sourceStatus: buildSourceStatus({ source: 'nasdaqHalts', enabled: true, available: false, status: isTimeoutError(error) ? 'timeout' : 'error', blockedSymbols: 0, lastRunAt: null, lastError: redactSourceMessage(error.message), blockedReason: isTimeoutError(error) ? 'timeout' : 'source_not_found_or_inaccessible' }),
      symbols: [],
    };
  }
}

async function fetchSecEdgarSignals({ env, fetchImpl, symbols = [], timeoutMs = 5000, repoRoot = process.cwd() } = {}) {
  const lookbackDays = Math.max(1, Number(env?.MEME_SEC_EDGAR_LOOKBACK_DAYS || 5) || 5);
  if (!symbols.length) {
    return {
      sourceStatus: buildSourceStatus({ source: 'secEdgar', enabled: true, available: true, status: 'active', catalystsDetected: 0, riskWarnings: 0, lastRunAt: nowIso(), lastError: null }),
      symbols: [],
    };
  }
  try {
    const tickerMap = await fetchSecTickerMap(fetchImpl, timeoutMs, repoRoot);
    const out = [];
    for (const symbol of symbols) {
      const entry = tickerMap.get(symbol.toUpperCase());
      if (!entry) {
        out.push({
          symbol,
          catalystScore: 0,
          riskBlockScore: 0,
          reasonCodes: ['sec_cik_missing', 'sec_no_recent_catalyst'],
          riskWarnings: ['sec_cik_missing'],
          details: { cik: null, recentFilings: [] },
          marketContext: { stale: false },
        });
        continue;
      }
      const cik = String(entry.cik).padStart(10, '0');
      const filings = await fetchSecFilings(fetchImpl, cik, timeoutMs, repoRoot);
      const recent = filterRecentFilings(filings, lookbackDays);
      const riskWarnings = [];
      const reasonCodes = ['sec_edgar_source_active'];
      let catalystScore = 0;
      let riskBlockScore = 0;
      for (const filing of recent) {
        const form = String(filing.form || '').toUpperCase();
        if (form === '8-K') {
          reasonCodes.push('sec_recent_8k_detected');
          catalystScore = Math.max(catalystScore, 25);
        } else {
          reasonCodes.push('sec_recent_filing_detected');
        }
        if (['S-1', 'S-3', '424B', '424B5'].some((prefix) => form.startsWith(prefix))) {
          reasonCodes.push('sec_offering_risk_detected');
          riskWarnings.push('sec_offering_risk_detected');
          riskBlockScore = Math.max(riskBlockScore, 30);
        }
        if (form.includes('RW') || form.includes('RS')) {
          reasonCodes.push('sec_reverse_split_risk_detected');
          riskWarnings.push('sec_reverse_split_risk_detected');
          riskBlockScore = Math.max(riskBlockScore, 50);
        }
        if (form === 'S-1' || form === 'S-3' || form.startsWith('424')) {
          reasonCodes.push('sec_registration_risk_detected');
        }
      }
      if (!recent.length) {
        reasonCodes.push('sec_no_recent_catalyst');
      }
      out.push({
        symbol,
        catalystScore,
        riskBlockScore,
        reasonCodes,
        riskWarnings,
        details: { cik, recentFilings: recent.slice(0, 5) },
        marketContext: { stale: false },
      });
    }
    return {
      sourceStatus: buildSourceStatus({ source: 'secEdgar', enabled: true, available: true, status: 'active', catalystsDetected: out.filter((entry) => entry.catalystScore > 0).length, riskWarnings: out.reduce((sum, entry) => sum + entry.riskWarnings.length, 0), lastRunAt: nowIso(), lastError: null }),
      symbols: out,
    };
  } catch (error) {
    return {
      sourceStatus: buildSourceStatus({ source: 'secEdgar', enabled: true, available: false, status: isTimeoutError(error) ? 'timeout' : 'error', catalystsDetected: 0, riskWarnings: 0, lastRunAt: null, lastError: redactSourceMessage(error.message), blockedReason: isTimeoutError(error) ? 'timeout' : 'source_not_found_or_inaccessible' }),
      symbols: [],
    };
  }
}

async function fetchSecTickerMap(fetchImpl, timeoutMs = 5000, repoRoot = process.cwd()) {
  const result = await fetchJsonWithTimeout(fetchImpl, 'https://www.sec.gov/files/company_tickers.json', {
    timeoutMs,
    headers: { 'user-agent': 'workflow-2-meme-monitor' },
    cache: sourceCacheOptions({ repoRoot, cacheKey: 'ticker-map' }, 'secEdgar', 'ticker-map', timeoutMs),
  });
  if (!result.response.ok) return new Map();
  const body = result.body;
  const items = Array.isArray(body) ? body : Object.values(body || {});
  const map = new Map();
  for (const item of items) {
    const ticker = String(item.ticker || item.tic || '').toUpperCase();
    if (!ticker) continue;
    map.set(ticker, { cik: item.cik_str || item.cik || item.cik_str || null });
  }
  return map;
}

async function fetchSecFilings(fetchImpl, cik, timeoutMs = 5000, repoRoot = process.cwd()) {
  const result = await fetchJsonWithTimeout(fetchImpl, `https://data.sec.gov/submissions/CIK${cik}.json`, {
    timeoutMs,
    headers: { 'user-agent': 'workflow-2-meme-monitor' },
    cache: sourceCacheOptions({ repoRoot, cacheKey: cik }, 'secEdgar', 'filings', timeoutMs),
  });
  if (!result.response.ok) return [];
  const body = result.body;
  const recent = body?.filings?.recent || {};
  const count = Array.isArray(recent.form) ? recent.form.length : 0;
  const filings = [];
  for (let index = 0; index < count; index += 1) {
    filings.push({
      form: recent.form[index],
      filingDate: recent.filingDate?.[index] || recent.filing_date?.[index] || null,
      reportDate: recent.reportDate?.[index] || recent.report_date?.[index] || null,
      accessionNumber: recent.accessionNumber?.[index] || null,
    });
  }
  return filings;
}

function filterRecentFilings(filings = [], lookbackDays = 5) {
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  return filings.filter((filing) => {
    const ts = new Date(filing.filingDate || filing.reportDate || 0).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

function createPhaseASymbolEntry(symbol) {
  return {
    symbol,
    socialHeatScore: 0,
    marketConfirmationScore: null,
    catalystScore: 0,
    riskBlockScore: 0,
    tradableStatus: 'unknown',
    haltStatus: 'unknown',
    sourceConfirmations: {
      reddit: false,
      alpacaMarket: false,
      alpacaAssets: false,
      nasdaqHalts: false,
      secEdgar: false,
    },
    sourceDetails: {
      reddit: [],
      alpacaMarket: null,
      alpacaAssets: null,
      nasdaqHalts: null,
      secEdgar: null,
    },
    reasonCodes: new Set(),
    riskWarnings: new Set(),
  };
}

function derivePhaseAStatus({ sourceRuntime, marketConfirmation, tradableStatus, haltStatus, catalystScore, riskBlockScore, riskWarnings = [] } = {}) {
  if (!sourceRuntime.reddit && !sourceRuntime.alpacaMarket && !sourceRuntime.alpacaAssets && !sourceRuntime.nasdaqHalts && !sourceRuntime.secEdgar) {
    return 'off';
  }
  if (haltStatus === 'halted') return 'blocked';
  if (riskBlockScore >= 50) return 'blocked';
  if (tradableStatus === 'blocked' || tradableStatus === 'not_found') return 'blocked';
  if (marketConfirmation === null) return riskWarnings.length ? 'warn' : 'unavailable';
  if (marketConfirmation >= 70 || catalystScore > 0) return 'active';
  return 'warn';
}

function buildRawSummary(entry) {
  return {
    socialHeatScore: Number(entry.socialHeatScore || 0),
    marketConfirmationScore: entry.marketConfirmationScore,
    catalystScore: entry.catalystScore,
    riskBlockScore: entry.riskBlockScore,
    sourceDetails: entry.sourceDetails,
  };
}

function buildSourceStatusSummary(entry) {
  return [
    `Reddit:${entry.sourceConfirmations.reddit ? 'confirmed' : 'unavailable'}`,
    `Alpaca Market:${entry.sourceConfirmations.alpacaMarket ? 'confirmed' : 'failed'}`,
    `Alpaca Assets:${entry.sourceConfirmations.alpacaAssets ? 'tradable' : 'blocked'}`,
    `Nasdaq Halts:${entry.sourceConfirmations.nasdaqHalts ? 'not halted' : 'unavailable'}`,
    `SEC EDGAR:${entry.sourceConfirmations.secEdgar ? 'catalyst' : 'none'}`,
  ];
}

function mergeMarketContext(base = null, next = null) {
  if (!base) return next || null;
  if (!next) return base;
  return { ...base, ...next };
}

function normalizeSymbols(symbols = []) {
  return [...new Set((Array.isArray(symbols) ? symbols : [])
    .map((symbol) => String(symbol || '').trim().toUpperCase())
    .filter(Boolean))];
}

function extractSymbolsFromRecords(records = [], options = {}) {
  const symbols = [];
  for (const record of Array.isArray(records) ? records : []) {
    const extracted = extractMentionsFromRecord(record, {
      sourceMeta: record.sourceMeta || null,
      tradableSymbols: options.tradableSymbols,
      isTradableSymbol: options.isTradableSymbol,
      requireTradableMatch: options.requireTradableMatch,
    });
    for (const mention of extracted.mentions || []) {
      const symbol = String(mention.symbol || '').toUpperCase();
      if (symbol) symbols.push(symbol);
    }
  }
  return symbols;
}

function ingestRedditRecords({ records = [], phaseASymbols, recordsOut = [], options = {} } = {}) {
  for (const record of Array.isArray(records) ? records : []) {
    recordsOut.push(record);
    const extracted = extractMentionsFromRecord(record, {
      sourceMeta: record.sourceMeta || null,
      tradableSymbols: options.tradableSymbols,
      isTradableSymbol: options.isTradableSymbol,
      requireTradableMatch: options.requireTradableMatch,
    });
    for (const mention of extracted.mentions || []) {
      const symbol = String(mention.symbol || '').toUpperCase();
      if (!symbol) continue;
      const entry = phaseASymbols.get(symbol) || createPhaseASymbolEntry(symbol);
      entry.sourceConfirmations.reddit = true;
      entry.socialHeatScore += Math.max(1, Number(mention.sourceWeight) || 1);
      entry.socialMentions += 1;
      entry.sourceDetails.reddit.push({
        source: mention.source || 'reddit',
        tier: mention.sourceTier || null,
        status: mention.sourceStatus || null,
      });
      if (mention.sourceTier) {
        entry.reasonCodes.add(`reddit_${mention.sourceTier}_signal`);
      }
      phaseASymbols.set(symbol, entry);
    }
  }
}

function normalizeSourceStatus(entry = {}) {
  return {
    source: entry.source || null,
    enabled: Boolean(entry.enabled),
    available: Boolean(entry.available),
    status: entry.status || 'off',
    lastRunAt: entry.lastRunAt || null,
    lastScanAt: entry.lastScanAt || entry.lastRunAt || null,
    lastError: entry.lastError || null,
    symbolsDetected: Number.isFinite(Number(entry.symbolsDetected)) ? Number(entry.symbolsDetected) : null,
    rejectedTokens: Number.isFinite(Number(entry.rejectedTokens)) ? Number(entry.rejectedTokens) : null,
    symbolsConfirmed: Number.isFinite(Number(entry.symbolsConfirmed)) ? Number(entry.symbolsConfirmed) : null,
    symbolsTradable: Number.isFinite(Number(entry.symbolsTradable)) ? Number(entry.symbolsTradable) : null,
    symbolsBlocked: Number.isFinite(Number(entry.symbolsBlocked)) ? Number(entry.symbolsBlocked) : null,
    blockedSymbols: Number.isFinite(Number(entry.blockedSymbols)) ? Number(entry.blockedSymbols) : null,
    catalystsDetected: Number.isFinite(Number(entry.catalystsDetected)) ? Number(entry.catalystsDetected) : null,
    riskWarnings: Number.isFinite(Number(entry.riskWarnings)) ? Number(entry.riskWarnings) : null,
    tier: entry.tier || null,
    blockedReason: entry.blockedReason || null,
    sourceMode: entry.sourceMode || null,
  };
}

function isTimeoutError(error) {
  const code = String(error?.code || '').toUpperCase();
  return error?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT' || code === 'UND_ERR_ABORTED' || String(error?.message || '').toLowerCase().includes('timed out');
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

function sourceCacheOptions(context = {}, source, category, ttlSeconds) {
  const env = context.env || process.env;
  const repoRoot = context.repoRoot || process.cwd();
  const cacheEnabled = String(env?.MEME_PHASE_A_SOURCE_CACHE_SECONDS || ttlSeconds || 0);
  return {
    cacheDir: path.resolve(repoRoot, 'data', 'runtime', 'source-cache'),
    source,
    category,
    key: `${category}:${context.cacheKey || 'default'}:${cacheEnabled}`,
    ttlSeconds: Math.max(0, Number(env?.MEME_PHASE_A_SOURCE_CACHE_SECONDS || ttlSeconds || 0) || 0),
  };
}

module.exports = {
  derivePhaseAStatus,
  fetchAlpacaAssetSignals,
  fetchAlpacaMarketSignals,
  fetchNasdaqHaltsSignals,
  fetchSecEdgarSignals,
  resolvePhaseASourceRuntime,
  runPhaseASources,
};
