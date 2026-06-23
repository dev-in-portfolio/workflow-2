const { buildProviderConfirmationFromContext, normalizeMarketData } = require('./market-data');
const { parseBool } = require('./config');
const { nowIso, safeNumber, clamp, hashObject } = require('./util');
const { allocateBuyNotional, buildPortfolioSnapshot } = require('./portfolio-allocation');
const { writeScannerRuntimeState } = require('./scanner-runtime-state');
const { loadRecentSymbolMap, saveRecentSymbolMap } = require('./scanner-recent-symbols');

const DEFAULT_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD', 'DOGE/USD', 'AVAX/USD', 'LINK/USD', 'DOT/USD'];
const DEFAULT_SELL_NET_PROFIT_FLOOR_DOLLARS = 1.0;

function parseSymbolList(value, fallback = DEFAULT_SYMBOLS) {
  if (!value) return fallback.slice();
  const parsed = String(value)
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean)
    .map((symbol) => {
      if (symbol.includes('/')) return symbol;
      if (symbol.endsWith('USDT')) return `${symbol.slice(0, -4)}/USDT`;
      if (symbol.endsWith('USD')) return `${symbol.slice(0, -3)}/USD`;
      return symbol;
    });
  return parsed.length ? [...new Set(parsed)] : fallback.slice();
}

function createOvernightScanner(options = {}) {
  const env = options.env || process.env;
  const marketFetch = options.marketFetch || options.fetch || globalThis.fetch;
  const localFetch = options.localFetch || globalThis.fetch;
  if (!marketFetch) {
    throw new Error('Overnight scanner requires fetch support');
  }
  if (!localFetch) {
    throw new Error('Overnight scanner requires local fetch support');
  }

  const apiKeyId = options.apiKeyId || env.ALPACA_API_KEY_ID || '';
  const apiSecretKey = options.apiSecretKey || env.ALPACA_API_SECRET_KEY || '';
  const baseUrl = trimTrailingSlash(options.baseUrl || env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets');
  const twelveDataApiKey = options.twelveDataApiKey || env.TWELVE_DATA_API_KEY || env.TWELVEDATA_API_KEY || '';
  const twelveDataBaseUrl = trimTrailingSlash(options.twelveDataBaseUrl || env.TWELVE_DATA_BASE_URL || 'https://api.twelvedata.com');
  const localBaseUrl = trimTrailingSlash(options.localBaseUrl || options.local_url || '');
  const enabled = options.enabled !== false;
  const symbols = parseSymbolList(options.symbols || env.OVERNIGHT_SCANNER_SYMBOLS);
  const intervalMs = Math.max(15_000, Number(options.intervalMs ?? Number(env.OVERNIGHT_SCANNER_INTERVAL_SECONDS || 60) * 1000) || 60_000);
  const cooldownMs = Math.max(60_000, Number(options.cooldownMs ?? Number(env.OVERNIGHT_SCANNER_COOLDOWN_MINUTES || 15) * 60_000) || 900_000);
  const minMovePct = Math.max(0.02, Number(options.minMovePct ?? env.OVERNIGHT_SCANNER_MIN_MOVE_PCT ?? 0.15) || 0.15);
  const maxSpreadPct = Math.max(0.01, Number(options.maxSpreadPct ?? env.OVERNIGHT_SCANNER_MAX_SPREAD_PCT ?? 0.6) || 0.6);
  const maxCandidatesPerRun = Math.max(1, Number(options.maxCandidatesPerRun ?? env.OVERNIGHT_SCANNER_MAX_CANDIDATES ?? 5) || 5);
  const notional = Math.max(1, Number(options.notional ?? env.OVERNIGHT_SCANNER_NOTIONAL ?? 25) || 25);
  const minBuyNotional = Math.max(1, Number(options.minBuyNotional ?? env.MIN_BUY_NOTIONAL ?? 25) || 25);
  const maxOpenPositions = Math.max(1, Number(options.maxOpenPositions ?? env.MAX_OPEN_POSITIONS ?? 12) || 12);
  const sellProfitThresholdPct = Math.max(5.0, Number(options.sellProfitThresholdPct ?? env.OVERNIGHT_SCANNER_SELL_PROFIT_THRESHOLD_PCT ?? 5.0) || 5.0);
  const sellNetProfitFloorDollars = Math.max(
    0,
    Number(
      options.sellNetProfitFloorDollars
        ?? env.SELL_NET_PROFIT_FLOOR_DOLLARS
        ?? env.OVERNIGHT_SCANNER_SELL_NET_PROFIT_FLOOR_DOLLARS
        ?? DEFAULT_SELL_NET_PROFIT_FLOOR_DOLLARS,
    ) || DEFAULT_SELL_NET_PROFIT_FLOOR_DOLLARS,
  );
  const sellLossThresholdPct = Math.max(0.01, Number(options.sellLossThresholdPct ?? env.OVERNIGHT_SCANNER_SELL_LOSS_EXIT_THRESHOLD_PCT ?? 0.75) || 0.75);
  const requireMultiSourceConfirmation = options.requireMultiSourceConfirmation ?? Boolean(twelveDataApiKey);
  const allowContrarianEntries = options.allowContrarianEntries ?? false;
  const blockBuys = options.blockBuys ?? parseBool(env.BLOCK_BUYS, false);
  const sellMaxPriceDiffPct = safeNumber(options.sellMaxPriceDiffPct ?? env.SELL_MAX_PROVIDER_PRICE_DIFF_PCT, 0.75);
  const keepAlive = options.keepAlive ?? true;
  const runtimeStateEnabled = options.runtimeStateEnabled ?? parseBool(env.SCANNER_RUNTIME_STATE_ENABLED, false);
  const recentSymbolsEnabled = options.recentSymbolsEnabled ?? parseBool(env.SCANNER_RECENT_SYMBOLS_ENABLED, false);
  const state = {
    lastSentAtBySymbol: recentSymbolsEnabled
      ? loadRecentSymbolMap({ env, repoRoot: process.cwd(), profile: 'crypto-only', maxAgeMs: cooldownMs })
      : new Map(),
    running: false,
    timer: null,
    lastRunAt: null,
  };

  async function runOnce(runOptions = {}) {
    if (!enabled) {
      return { accepted: false, reason: 'DISABLED', candidates: [] };
    }
    if (!localBaseUrl) {
      return { accepted: false, reason: 'LOCAL_BASE_URL_REQUIRED', candidates: [] };
    }
    if (state.running) {
      return { accepted: false, reason: 'RUN_ALREADY_IN_PROGRESS', candidates: [] };
    }

    state.running = true;
    const receivedAt = nowIso();
    try {
      const bundle = await fetchCryptoBundle({
        fetchImpl: marketFetch,
        apiKeyId,
        apiSecretKey,
        baseUrl,
        symbols,
      });
      const twelveDataQuotes = twelveDataApiKey
        ? await fetchTwelveDataBundle({
          fetchImpl: marketFetch,
          apiKey: twelveDataApiKey,
          baseUrl: twelveDataBaseUrl,
          symbols,
        })
        : {};
      const positions = await fetchPositions({
        fetchImpl: marketFetch,
        apiKeyId,
        apiSecretKey,
        baseUrl: options.accountBaseUrl || options.tradingBaseUrl || options.accountUrl || trimTrailingSlash(env.ALPACA_API_BASE_URL || 'https://paper-api.alpaca.markets'),
      });
      const openOrders = await fetchOpenOrders({
        fetchImpl: marketFetch,
        apiKeyId,
        apiSecretKey,
        baseUrl: options.accountBaseUrl || options.tradingBaseUrl || options.accountUrl || trimTrailingSlash(env.ALPACA_API_BASE_URL || 'https://paper-api.alpaca.markets'),
      });
      const account = await fetchAccount({
        fetchImpl: marketFetch,
        apiKeyId,
        apiSecretKey,
        baseUrl: options.accountBaseUrl || options.tradingBaseUrl || options.accountUrl || trimTrailingSlash(env.ALPACA_API_BASE_URL || 'https://paper-api.alpaca.markets'),
      });
      const portfolio = buildPortfolioSnapshot({ positions, openOrders, account, maxOpenPositions });
      const allocation = allocateBuyNotional({ targetNotional: notional, minBuyNotional, portfolio });
      const skipTracker = createSkipTracker();
      if (!allocation.accepted) {
        skipTracker.record(allocation.reason || 'ALLOCATION_BLOCK', {
          symbol: '*',
          notional: allocation.notional,
          requested: allocation.requested,
          remaining_slots: allocation.remaining_slots,
        });
      }
      const candidates = buildCandidates(bundle, {
        receivedAt,
        minMovePct,
        maxSpreadPct,
        cooldownMs,
        maxCandidatesPerRun,
        notional: allocation.accepted ? allocation.notional : notional,
        allocation,
        sellProfitThresholdPct,
        sellNetProfitFloorDollars,
        sellLossThresholdPct,
        requireMultiSourceConfirmation,
        allowContrarianEntries,
        blockBuys,
        sellMaxPriceDiffPct,
        twelveDataQuotes,
        openOrders,
        portfolio,
        skipTracker,
        runId: runOptions.runId || `overnight_${hashObject({ receivedAt, symbols, baseUrl }).slice(0, 10)}`,
        lastSentAtBySymbol: state.lastSentAtBySymbol,
        positions,
      });

      const results = [];
      for (const candidate of candidates) {
        state.lastSentAtBySymbol.set(candidate.symbol, Date.now());
        persistRecentSymbols();
        const response = await localFetch(`${localBaseUrl}/${candidate.endpoint || 'paper-order'}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(candidate.payload),
        });
        let responseBody = null;
        try {
          responseBody = await response.json();
        } catch {
          responseBody = { accepted: response.ok };
        }
        results.push({
          symbol: candidate.symbol,
          move_pct: candidate.movePct,
          spread_pct: candidate.spreadPct,
          accepted: response.ok,
          status: responseBody?.final_decision || responseBody?.status || null,
          response: responseBody,
        });
        if (!(response.ok && (responseBody?.final_decision === 'APPROVED_FOR_PAPER' || responseBody?.accepted === true))) {
          const reasons = responseBody?.reason_codes || responseBody?.riskDecision?.reason_codes || responseBody?.risk_decision?.reason_codes || [];
          for (const reason of Array.isArray(reasons) ? reasons : [reasons].filter(Boolean)) {
            skipTracker.record(reason || 'RISK_REJECTED', { symbol: candidate.symbol, stage: 'risk' });
          }
        }
      }

      state.lastRunAt = receivedAt;
      state.lastScanDurationMs = Date.now() - new Date(receivedAt).getTime();
      state.lastScanError = null;
      state.lastCandidateCount = candidates.length;
      state.lastPostedCount = results.length;
      state.lastApprovedCount = results.filter((result) => result.status === 'APPROVED_FOR_PAPER' || result.response?.accepted === true).length;
      state.lastRejectedCount = results.length - state.lastApprovedCount;
      writeRuntimeSnapshot({
        mode: 'crypto-only',
        receivedAt,
        durationMs: state.lastScanDurationMs,
        portfolio,
        allocation,
        skipSummary: skipTracker.summary(),
        recentSkips: skipTracker.recent(),
        candidates,
        results,
      });
      return { accepted: true, candidates: results, received_at: receivedAt };
    } catch (error) {
      state.lastRunAt = receivedAt;
      state.lastScanError = error.message;
      state.lastScanDurationMs = Date.now() - new Date(receivedAt).getTime();
      writeRuntimeSnapshot({
        mode: 'crypto-only',
        receivedAt,
        durationMs: state.lastScanDurationMs,
        error: error.message,
      });
      throw error;
    } finally {
      state.running = false;
    }
  }

  function start() {
    if (!enabled || state.timer) {
      return controller;
    }
    const tick = () => {
      runOnce({ runId: `scheduled_${Date.now()}` }).catch((error) => {
        if (typeof options.logger === 'function') {
          options.logger({ level: 'error', event: 'overnight_scanner_error', message: error.message });
        }
      });
    };
    state.timer = setInterval(tick, intervalMs);
    if (!keepAlive) {
      state.timer.unref?.();
    }
    tick();
    return controller;
  }

  function stop() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  const controller = {
    start,
    stop,
    runOnce,
    state,
    config: {
      enabled,
      baseUrl,
      localBaseUrl,
      symbols,
      intervalMs,
      cooldownMs,
      minMovePct,
      maxSpreadPct,
      maxCandidatesPerRun,
      notional,
      minBuyNotional,
      maxOpenPositions,
      sellProfitThresholdPct,
      sellNetProfitFloorDollars,
      sellLossThresholdPct,
      twelveDataApiKey,
      twelveDataBaseUrl,
      requireMultiSourceConfirmation,
      keepAlive,
      sellMaxPriceDiffPct,
    },
  };

  return controller;

  function writeRuntimeSnapshot({ mode, receivedAt, durationMs, portfolio = null, allocation = null, skipSummary = null, recentSkips = [], candidates = [], results = [], error = null }) {
    if (!runtimeStateEnabled) return;
    writeScannerRuntimeState({
      scanner: 'overnight-scanner',
      mode,
      config_version: '2026-06-20.scanner-runtime.1',
      loaded_mode: mode,
      mode_since: state.startedAt || receivedAt,
      last_scan_time: receivedAt,
      last_scan_duration_ms: durationMs,
      last_scan_error: error,
      candidate_count: candidates.length,
      posted_count: results.length,
      approved_count: results.filter((result) => result.status === 'APPROVED_FOR_PAPER' || result.response?.accepted === true).length,
      rejected_count: results.filter((result) => !(result.status === 'APPROVED_FOR_PAPER' || result.response?.accepted === true)).length,
      skip_summary: skipSummary || {
        allocation_block: allocation?.accepted === false ? 1 : 0,
        max_position_or_cash_block: allocation?.accepted === false ? allocation.reason : null,
      },
      recent_skips: recentSkips,
      portfolio: portfolio ? {
        open_positions_count: portfolio.open_positions_count,
        open_buy_order_count: portfolio.open_buy_order_count,
        remaining_position_slots: portfolio.remaining_position_slots,
        cash: portfolio.cash,
        buying_power: portfolio.buying_power,
      } : null,
      allocation,
    }, { env, repoRoot: process.cwd() });
  }

  function persistRecentSymbols() {
    if (!recentSymbolsEnabled) return;
    saveRecentSymbolMap(state.lastSentAtBySymbol, { env, repoRoot: process.cwd(), profile: 'crypto-only' });
  }
}

function createSkipTracker(limit = 12) {
  const counts = {};
  const examples = [];
  return {
    record(reason, details = {}) {
      const key = String(reason || 'UNKNOWN_SKIP');
      counts[key] = (counts[key] || 0) + 1;
      if (examples.length < limit) {
        examples.push({ reason: key, ...details });
      }
    },
    summary() {
      return counts;
    },
    recent() {
      return examples;
    },
  };
}

async function fetchCryptoBundle({ fetchImpl, apiKeyId, apiSecretKey, baseUrl, symbols }) {
  const headers = {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
  const encodedSymbols = encodeURIComponent(symbols.join(','));
  const snapshotsUrl = `${baseUrl}/v1beta3/crypto/us/snapshots?symbols=${encodedSymbols}`;
  const latestQuotesUrl = `${baseUrl}/v1beta3/crypto/us/latest/quotes?symbols=${encodedSymbols}`;
  const [snapshotsResponse, latestQuotesResponse] = await Promise.all([
    fetchImpl(snapshotsUrl, { method: 'GET', headers }),
    fetchImpl(latestQuotesUrl, { method: 'GET', headers }),
  ]);

  const snapshotsBody = await readJsonResponse(snapshotsResponse);
  const latestQuotesBody = await readJsonResponse(latestQuotesResponse);
  return {
    snapshots: snapshotsBody?.snapshots || snapshotsBody || {},
    latestQuotes: latestQuotesBody?.quotes || latestQuotesBody || {},
  };
}

async function fetchPositions({ fetchImpl, apiKeyId, apiSecretKey, baseUrl }) {
  const headers = {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
  const response = await fetchImpl(`${baseUrl}/v2/positions`, { method: 'GET', headers });
  const body = await readJsonResponse(response);
  return Array.isArray(body) ? body : [];
}

async function fetchOpenOrders({ fetchImpl, apiKeyId, apiSecretKey, baseUrl }) {
  const headers = {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
  const response = await fetchImpl(`${baseUrl}/v2/orders?status=open&limit=500`, { method: 'GET', headers });
  const body = await readJsonResponse(response);
  if (!response.ok) {
    return [];
  }
  return Array.isArray(body) ? body : body?.orders || body?.data || [];
}

async function fetchAccount({ fetchImpl, apiKeyId, apiSecretKey, baseUrl }) {
  const headers = {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
  try {
    const response = await fetchImpl(`${baseUrl}/v2/account`, { method: 'GET', headers });
    if (!response.ok) return null;
    return await readJsonResponse(response);
  } catch {
    return null;
  }
}

async function fetchTwelveDataBundle({ fetchImpl, apiKey, baseUrl, symbols }) {
  const encodedSymbols = encodeURIComponent(symbols.join(','));
  const url = `${baseUrl}/quote?symbol=${encodedSymbols}&apikey=${encodeURIComponent(apiKey)}`;
  const response = await fetchImpl(url, { method: 'GET' });
  const body = await readJsonResponse(response);
  if (!response.ok) {
    return {};
  }
  return normalizeTwelveDataQuotes(body, symbols);
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function normalizeTwelveDataQuotes(body, symbols) {
  const quotes = {};
  const entries = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body)
      ? body
      : body && typeof body === 'object' && (body.symbol || body.ticker || body.code || body.instrument)
        ? [body]
      : body && typeof body === 'object'
        ? Object.values(body).filter((value) => value && typeof value === 'object')
        : [];

  for (const entry of entries) {
    const symbol = normalizePositionSymbol(entry.symbol || entry.ticker || entry.code || entry.instrument || '');
    if (!symbol) continue;
    const receivedAt = nowIso();
    const timestamp = entry.datetime || entry.timestamp || entry.time || entry.t || entry.date || receivedAt;
    quotes[symbol] = normalizeMarketData({
      provider: 'twelvedata',
      asset_type: 'crypto',
      kind: 'quote',
      symbol,
      timestamp,
      received_at: receivedAt,
      price: safeNumber(entry.price ?? entry.close ?? entry.last ?? entry.value ?? entry.mid ?? entry.c, null),
      previous_close: safeNumber(entry.previous_close ?? entry.previousClose ?? entry.close ?? null),
      volume: safeNumber(entry.volume ?? entry.v ?? null),
      confidence: 82,
      reliability: 84,
      exchange: entry.exchange || 'twelvedata',
      raw_payload: entry,
    }, { receivedAt, maxStalenessSeconds: 300 });
  }

  for (const symbol of symbols) {
    if (!quotes[symbol]) {
      quotes[symbol] = null;
    }
  }

  return quotes;
}

function buildCandidates(bundle, options = {}) {
  const entries = [];
  const now = options.receivedAt || nowIso();
  const symbols = Object.keys(bundle.snapshots || {});
  const positionsBySymbol = buildPositionLookup(options.positions || []);
  const openOrdersBySymbol = buildOpenOrderLookup(options.openOrders || []);
  for (const symbol of symbols) {
    const snapshot = bundle.snapshots[symbol] || {};
    const latestQuote = bundle.latestQuotes[symbol] || snapshot.latestQuote || {};
    const candidate = buildCandidateForSymbol(symbol, snapshot, latestQuote, {
      receivedAt: now,
      minMovePct: options.minMovePct,
      maxSpreadPct: options.maxSpreadPct,
      cooldownMs: options.cooldownMs,
      lastSentAt: options.lastSentAtBySymbol?.get(symbol),
      notional: options.notional,
      allocation: options.allocation,
      runId: options.runId,
      twelveDataQuote: options.twelveDataQuotes?.[symbol] || null,
      requireMultiSourceConfirmation: options.requireMultiSourceConfirmation,
      allowContrarianEntries: options.allowContrarianEntries,
      blockBuys: options.blockBuys,
      sellProfitThresholdPct: options.sellProfitThresholdPct,
      sellLossThresholdPct: options.sellLossThresholdPct,
      sellMaxPriceDiffPct: options.sellMaxPriceDiffPct,
      sellNetProfitFloorDollars: options.sellNetProfitFloorDollars,
      position: positionsBySymbol.get(symbol) || null,
      openOrder: openOrdersBySymbol.get(symbol) || null,
      portfolio: options.portfolio || {},
      skipTracker: options.skipTracker,
    });
    if (candidate) {
      entries.push(candidate);
    }
  }
  return entries
    .sort((a, b) => b.movePct - a.movePct || b.confidence - a.confidence)
    .slice(0, options.maxCandidatesPerRun || 3);
}

function buildPositionLookup(positions = []) {
  const lookup = new Map();
  for (const position of positions) {
    const symbol = normalizePositionSymbol(position.symbol);
    if (symbol) {
      lookup.set(symbol, position);
    }
  }
  return lookup;
}

function buildOpenOrderLookup(openOrders = []) {
  const lookup = new Map();
  for (const order of openOrders) {
    const symbol = normalizePositionSymbol(order.symbol);
    if (!symbol) continue;
    if (!lookup.has(symbol)) {
      lookup.set(symbol, []);
    }
    lookup.get(symbol).push(order);
  }
  return lookup;
}

function normalizePositionSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes('/')) return raw;
  if (raw.endsWith('USDT')) return `${raw.slice(0, -4)}/USDT`;
  if (raw.endsWith('USD')) return `${raw.slice(0, -3)}/USD`;
  return raw;
}

function buildCandidateForSymbol(symbol, snapshot, latestQuote, options = {}) {
  const skip = (reason, details = {}) => {
    options.skipTracker?.record?.(reason, { symbol, ...details });
    return null;
  };
  const receivedAt = options.receivedAt || nowIso();
  const lastSentAt = Number(options.lastSentAt || 0);
  const assetType = String(options.assetType || 'crypto').trim().toLowerCase() || 'crypto';
  if (lastSentAt && Date.now() - lastSentAt < (options.cooldownMs || 900000)) {
    return skip('COOLDOWN_ACTIVE');
  }
  if (options.blockBuys && !options.position) {
    const quote = snapshot.latestQuote || latestQuote || {};
    const bid = safeNumber(quote.bp ?? quote.bid_price ?? quote.bid ?? quote.p, null);
    const ask = safeNumber(quote.ap ?? quote.ask_price ?? quote.ask ?? quote.p, null);
    const currentPrice = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : safeNumber(quote.p ?? snapshot.latestTrade?.p ?? snapshot.minuteBar?.c ?? null);
    const previousClose = safeNumber(snapshot.prevDailyBar?.c ?? snapshot.dailyBar?.c ?? snapshot.prevDailyBar?.close ?? null);
    if (Number.isFinite(currentPrice) && Number.isFinite(previousClose) && previousClose > 0) {
      const movePct = ((currentPrice - previousClose) / previousClose) * 100;
      if (movePct >= 0) {
        return skip('BUY_SIDE_BLOCKED');
      }
    }
  }
  if (Array.isArray(options.openOrder) && options.openOrder.length > 0) {
    return skip('OPEN_ORDER_EXISTS');
  }
  if (!options.position && options.allocation && options.allocation.accepted === false) {
    return skip(options.allocation.reason || 'ALLOCATION_BLOCKED');
  }

  const quote = snapshot.latestQuote || latestQuote || {};
  const bid = safeNumber(quote.bp ?? quote.bid_price ?? quote.bid ?? quote.p, null);
  const ask = safeNumber(quote.ap ?? quote.ask_price ?? quote.ask ?? quote.p, null);
  const currentPrice = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : safeNumber(quote.p ?? snapshot.latestTrade?.p ?? snapshot.minuteBar?.c ?? null);
  const previousClose = safeNumber(snapshot.prevDailyBar?.c ?? snapshot.dailyBar?.c ?? snapshot.prevDailyBar?.close ?? null);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(previousClose) || previousClose <= 0) {
    return skip('PROVIDER_PRICE_UNAVAILABLE');
  }

  const movePct = ((currentPrice - previousClose) / previousClose) * 100;
  const spreadPct = Number.isFinite(bid) && Number.isFinite(ask) && currentPrice > 0
    ? ((ask - bid) / currentPrice) * 100
    : 0;
  if (spreadPct > (options.maxSpreadPct ?? 0.6)) {
    return skip('SPREAD_TOO_WIDE', { spread_pct: Number(spreadPct.toFixed(4)) });
  }

  const minuteVolume = safeNumber(snapshot.minuteBar?.v ?? 0, 0);
  const dailyVolume = safeNumber(snapshot.prevDailyBar?.v ?? 0, 0);
  const volume = Math.max(
    minuteVolume,
    dailyVolume,
    minuteVolume * currentPrice,
    dailyVolume * currentPrice,
  );
  const highPrice = safeNumber(snapshot.minuteBar?.h ?? snapshot.latestTrade?.p ?? currentPrice, currentPrice);
  const lowPrice = safeNumber(snapshot.minuteBar?.l ?? snapshot.latestTrade?.p ?? currentPrice, currentPrice);
  const positionQty = safeNumber(options.position?.qty ?? options.position?.quantity ?? options.position?.qty_available ?? 0, 0);
  const avgEntryPrice = safeNumber(options.position?.avg_entry_price ?? options.position?.avgEntryPrice ?? null);
  const unrealizedPct = Number.isFinite(avgEntryPrice) && avgEntryPrice > 0
    ? ((currentPrice - avgEntryPrice) / avgEntryPrice) * 100
    : null;
  const hasPosition = Number.isFinite(positionQty) && positionQty > 0;
  const sellProfitThresholdPct = Math.abs(Number(options.sellProfitThresholdPct ?? 5.0) || 5.0);
  const sellLossThresholdPct = Math.abs(Number(options.sellLossThresholdPct ?? 0.75) || 0.75);
  const side = hasPosition && Number.isFinite(unrealizedPct) && (
    unrealizedPct >= sellProfitThresholdPct
    || unrealizedPct <= -sellLossThresholdPct
  )
    ? 'sell'
    : (!hasPosition && movePct >= (options.minMovePct ?? 0.35) ? 'buy'
      : (!hasPosition && options.allowContrarianEntries && movePct <= -(options.minMovePct ?? 0.35) ? 'buy' : null));
  if (!side) {
    return skip(hasPosition ? 'EXIT_TARGET_NOT_MET' : 'INSUFFICIENT_MOVE', { move_pct: Number(movePct.toFixed(4)) });
  }
  const entryThreshold = options.minMovePct ?? 0.35;
  if (side === 'buy' && !options.allowContrarianEntries && movePct < entryThreshold) {
    return skip('INSUFFICIENT_MOVE', { move_pct: Number(movePct.toFixed(4)) });
  }
  if (side === 'buy' && options.allowContrarianEntries && Math.abs(movePct) < entryThreshold) {
    return skip('INSUFFICIENT_MOVE', { move_pct: Number(movePct.toFixed(4)) });
  }
  const rawMarketData = {
    provider: 'alpaca',
    asset_type: assetType,
    kind: 'quote',
    symbol,
    timestamp: quote.t || snapshot.latestTrade?.t || snapshot.minuteBar?.t || receivedAt,
    received_at: receivedAt,
    price: currentPrice,
    previous_close: previousClose,
    volume,
    confidence: clamp(82 + Math.min(10, movePct * 4), 0, 100),
    reliability: clamp(80 + Math.min(15, movePct * 3), 0, 100),
    exchange: 'alpaca',
    provider_asset_id: symbol,
    provider_symbol: symbol,
    raw_payload: {
      snapshot,
      latest_quote: latestQuote,
      quote,
    },
  };
  const secondaryQuote = normalizeMarketData({
    provider: options.twelveDataQuote ? 'twelvedata' : 'alpaca-secondary',
    asset_type: assetType,
    kind: 'quote',
    symbol,
    timestamp: options.twelveDataQuote?.timestamp || options.twelveDataQuote?.t || latestQuote.t || quote.t || receivedAt,
    received_at: receivedAt,
    price: safeNumber(options.twelveDataQuote?.price ?? options.twelveDataQuote?.close ?? options.twelveDataQuote?.last ?? currentPrice, currentPrice),
    previous_close: previousClose,
    volume: safeNumber(options.twelveDataQuote?.volume ?? options.twelveDataQuote?.v ?? dailyVolume, dailyVolume),
    confidence: 80,
    reliability: 78,
    exchange: options.twelveDataQuote ? 'twelvedata' : 'alpaca',
    raw_payload: options.twelveDataQuote || latestQuote,
  }, { receivedAt, maxStalenessSeconds: 300 });
  const normalizedPrimary = normalizeMarketData(rawMarketData, {
    receivedAt,
    maxStalenessSeconds: 300,
  });

  const twelveDataQuote = options.twelveDataQuote
    ? {
      ...secondaryQuote,
      provider_name: 'twelvedata',
      provider: 'twelvedata',
    }
    : null;
  const marketContext = {
    source: 'overnight-scanner',
    scanner: {
      run_id: options.runId || null,
      move_pct: Number(movePct.toFixed(4)),
      spread_pct: Number(spreadPct.toFixed(4)),
      current_price: Number(currentPrice.toFixed(6)),
      previous_close: Number(previousClose.toFixed(6)),
    },
    volume,
    alpaca_quote: normalizedPrimary,
    secondary_quote: secondaryQuote,
    twelve_data_quote: twelveDataQuote,
    alpaca_snapshot: snapshot,
    alpaca_latest_quote: latestQuote,
    spread_slippage_pct: spreadPct,
    volatility_pct: Math.abs(movePct),
    high_price: highPrice,
    low_price: lowPrice,
  };
  const providerConfirmation = buildProviderConfirmationFromContext(marketContext, {
    confirmation_options: {
      maxPriceDiffPct: options.maxPriceDiffPct ?? 0.5,
      maxTimeSkewSeconds: options.maxTimeSkewSeconds ?? 60,
    },
    trade_side: side,
    sellMaxPriceDiffPct: options.sellMaxPriceDiffPct ?? 0.75,
    alpaca_options: {
      maxStalenessSeconds: 300,
    },
    twelve_options: {
      maxStalenessSeconds: 300,
    },
  });
  if (options.requireMultiSourceConfirmation && !providerConfirmation?.confirmed) {
    return skip('MULTI_SOURCE_CONFIRMATION_FAILED');
  }

  const signalId = `overnight_${hashObject({
    symbol,
    timestamp: normalizedPrimary.timestamp,
    price: normalizedPrimary.price,
    movePct: movePct.toFixed(4),
    runId: options.runId || null,
    receivedAt,
  }).slice(0, 16)}`;
  const quantity = side === 'sell'
    ? Number(Math.max(0.000001, positionQty).toFixed(6))
    : null;
  const notionalValue = side === 'buy'
    ? Number(options.notional || 25)
    : null;
  const sellNetProfitFloorDollars = Math.max(
    0,
    Number(
      options.sellNetProfitFloorDollars
        ?? DEFAULT_SELL_NET_PROFIT_FLOOR_DOLLARS,
    ) || DEFAULT_SELL_NET_PROFIT_FLOOR_DOLLARS,
  );
  const estimatedFeesDollars = Math.max(0, Number(options.sellEstimatedFeesDollars ?? 0) || 0);
  const sellOrderNotional = side === 'sell' ? currentPrice * quantity : notionalValue;
  const sellNetProfitRequirementDollars = side === 'sell'
    ? Math.max(sellNetProfitFloorDollars, sellOrderNotional * (sellProfitThresholdPct / 100))
    : null;
  if (side === 'sell') {
    if (!Number.isFinite(sellOrderNotional) || sellOrderNotional <= 0) {
      return skip('POSITION_VALUE_UNAVAILABLE');
    }
    if (sellNetProfitRequirementDollars + estimatedFeesDollars >= sellOrderNotional) {
      return skip('POSITION_TOO_SMALL_FOR_EXIT_FLOOR');
    }
  }
  const profitTargetPct = side === 'sell'
    ? Math.max(5.0, sellProfitThresholdPct, ((sellNetProfitRequirementDollars + estimatedFeesDollars) / sellOrderNotional) * 100)
    : Math.max(5.0, sellProfitThresholdPct);
  const stopDistancePct = 0.7;
  const signal = {
    signal_id: signalId,
    request_id: signalId,
    symbol,
    asset_type: assetType,
    strategy_name: 'overnight-crypto-momentum',
    timeframe: 'overnight',
    direction: side === 'sell' ? 'bearish' : 'bullish',
    action_candidate: side === 'sell' ? 'paper_sell' : 'paper_buy',
    side,
    order_type: 'market',
    time_in_force: 'gtc',
    entry_price: currentPrice,
    price: currentPrice,
    quantity,
    notional: notionalValue,
    requested_notional: side === 'buy' ? options.allocation?.requested ?? notionalValue : null,
    submitted_notional: side === 'buy' ? options.allocation?.notional ?? notionalValue : null,
    min_buy_notional: side === 'buy' ? options.allocation?.floor ?? null : null,
    position_qty_available: Number.isFinite(positionQty) ? positionQty : null,
    position_avg_entry_price: Number.isFinite(avgEntryPrice) ? avgEntryPrice : null,
    stop_loss: side === 'sell'
      ? currentPrice * (1 + stopDistancePct / 100)
      : currentPrice * (1 - stopDistancePct / 100),
    take_profit: side === 'sell'
      ? currentPrice * (1 - profitTargetPct / 100)
      : currentPrice * (1 + profitTargetPct / 100),
    confidence_score: normalizedPrimary.confidence_score,
    freshness_score: 100,
    source_quality_score: clamp(80 + (providerConfirmation?.confirmed ? 10 : -10), 0, 100),
    contradiction_score: providerConfirmation?.confirmed ? 4 : clamp(providerConfirmation?.discrepancy_score || 25, 0, 100),
    risk_score: clamp(18 + Math.min(25, movePct * 6) + (spreadPct * 10) + (providerConfirmation?.confirmed ? 0 : 25), 0, 100),
    provider_confirmation_score: providerConfirmation?.confirmed
      ? clamp(100 - safeNumber(providerConfirmation.discrepancy_score, 0), 0, 100)
      : clamp(35 - safeNumber(providerConfirmation?.discrepancy_score, 0), 0, 100),
    edge_score: 82,
    volume,
    market_context: marketContext,
  };

  return {
    symbol,
    movePct,
    spreadPct,
    confidence: normalizedPrimary.confidence_score,
    endpoint: 'paper-order',
    payload: {
      created_at: receivedAt,
      signal_id: signalId,
      strategy_name: 'overnight-crypto-momentum',
      market_data: rawMarketData,
      market_context: marketContext,
      provider_confirmation: providerConfirmation,
      ...signal,
      portfolio: options.portfolio || {},
    },
  };
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

module.exports = {
  buildCandidateForSymbol,
  buildCandidates,
  createOvernightScanner,
  DEFAULT_SYMBOLS,
  parseSymbolList,
};
