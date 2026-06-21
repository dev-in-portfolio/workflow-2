const { buildCandidateForSymbol } = require('./overnight-scanner');
const { buildProviderConfirmationFromContext, normalizeMarketData } = require('./market-data');
const { parseBool } = require('./config');
const { nowIso, safeNumber, hashObject } = require('./util');
const { VOLATILE_STOCK_SYMBOLS, parseSymbolList, resolveRotatingStockSymbols } = require('./volatile-stock-universe');
const { allocateBuyNotional, buildPortfolioSnapshot } = require('./portfolio-allocation');
const { writeScannerRuntimeState } = require('./scanner-runtime-state');
const { loadRecentSymbolMap, saveRecentSymbolMap } = require('./scanner-recent-symbols');

function createStockScanner(options = {}) {
  const env = options.env || process.env;
  const marketFetch = options.marketFetch || options.fetch || globalThis.fetch;
  const localFetch = options.localFetch || globalThis.fetch;
  if (!marketFetch) throw new Error('Stock scanner requires fetch support');
  if (!localFetch) throw new Error('Stock scanner requires local fetch support');

  const apiKeyId = options.apiKeyId || env.ALPACA_API_KEY_ID || '';
  const apiSecretKey = options.apiSecretKey || env.ALPACA_API_SECRET_KEY || '';
  const baseUrl = trimTrailingSlash(options.baseUrl || env.ALPACA_API_BASE_URL || 'https://data.alpaca.markets');
  const twelveDataApiKey = options.twelveDataApiKey || env.TWELVE_DATA_API_KEY || env.TWELVEDATA_API_KEY || '';
  const twelveDataBaseUrl = trimTrailingSlash(options.twelveDataBaseUrl || env.TWELVE_DATA_BASE_URL || 'https://api.twelvedata.com');
  const localBaseUrl = trimTrailingSlash(options.localBaseUrl || options.local_url || '');
  const enabled = options.enabled !== false;
  const symbols = options.symbols
    ? parseSymbolList(options.symbols, VOLATILE_STOCK_SYMBOLS)
    : resolveRotatingStockSymbols(env.STOCK_SCANNER_SYMBOLS);
  const intervalMs = Math.max(15_000, Number(options.intervalMs ?? Number(env.STOCK_SCANNER_INTERVAL_SECONDS || 60) * 1000) || 60_000);
  const cooldownMs = Math.max(60_000, Number(options.cooldownMs ?? Number(env.STOCK_SCANNER_COOLDOWN_MINUTES || 15) * 60_000) || 900_000);
  const minMovePct = Math.max(0.2, Number(options.minMovePct ?? env.STOCK_SCANNER_MIN_MOVE_PCT ?? 0.35) || 0.35);
  const maxSpreadPct = Math.max(0.02, Number(options.maxSpreadPct ?? env.STOCK_SCANNER_MAX_SPREAD_PCT ?? 0.8) || 0.8);
  const maxCandidatesPerRun = Math.max(1, Number(options.maxCandidatesPerRun ?? env.STOCK_SCANNER_MAX_CANDIDATES ?? 8) || 8);
  const notional = Math.max(1, Number(options.notional ?? env.BUY_NOTIONAL_TARGET ?? 200) || 200);
  const minBuyNotional = Math.max(1, Number(options.minBuyNotional ?? env.MIN_BUY_NOTIONAL ?? 25) || 25);
  const maxOpenPositions = Math.max(1, Number(options.maxOpenPositions ?? env.MAX_OPEN_POSITIONS ?? 12) || 12);
  const sellProfitThresholdPct = Math.max(5.0, Number(options.sellProfitThresholdPct ?? env.STOCK_SCANNER_SELL_PROFIT_THRESHOLD_PCT ?? 5.0) || 5.0);
  const requireMultiSourceConfirmation = options.requireMultiSourceConfirmation ?? Boolean(twelveDataApiKey);
  const allowContrarianEntries = options.allowContrarianEntries ?? true;
  const blockBuys = options.blockBuys ?? parseBool(env.BLOCK_BUYS, false);
  const sellMaxPriceDiffPct = safeNumber(options.sellMaxPriceDiffPct ?? env.SELL_MAX_PROVIDER_PRICE_DIFF_PCT, 0.75);
  const keepAlive = options.keepAlive ?? true;
  const runtimeStateEnabled = options.runtimeStateEnabled ?? parseBool(env.SCANNER_RUNTIME_STATE_ENABLED, false);
  const recentSymbolsEnabled = options.recentSymbolsEnabled ?? parseBool(env.SCANNER_RECENT_SYMBOLS_ENABLED, false);

  const state = {
    lastSentAtBySymbol: recentSymbolsEnabled
      ? loadRecentSymbolMap({ env, repoRoot: process.cwd(), profile: 'live-market', maxAgeMs: cooldownMs })
      : new Map(),
    running: false,
    timer: null,
    lastRunAt: null,
  };

  async function runOnce(runOptions = {}) {
    if (!enabled) return { accepted: false, reason: 'DISABLED', candidates: [] };
    if (!localBaseUrl) return { accepted: false, reason: 'LOCAL_BASE_URL_REQUIRED', candidates: [] };
    if (state.running) return { accepted: false, reason: 'RUN_ALREADY_IN_PROGRESS', candidates: [] };

    state.running = true;
    const receivedAt = nowIso();
    try {
      const bundle = await fetchStockBundle({
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
        requireMultiSourceConfirmation,
        allowContrarianEntries,
        blockBuys,
        sellMaxPriceDiffPct,
        twelveDataQuotes,
        openOrders,
        portfolio,
        skipTracker,
        runId: runOptions.runId || `stock_${hashObject({ receivedAt, symbols, baseUrl }).slice(0, 10)}`,
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
    if (!enabled || state.timer) return controller;
    const tick = () => {
      runOnce({ runId: `stock_${Date.now()}` }).catch((error) => {
        if (typeof options.logger === 'function') {
          options.logger({ level: 'error', event: 'stock_scanner_error', message: error.message });
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
      twelveDataApiKey,
      twelveDataBaseUrl,
      requireMultiSourceConfirmation,
      keepAlive,
      sellMaxPriceDiffPct,
    },
  };

  return controller;

  function writeRuntimeSnapshot({ receivedAt, durationMs, portfolio = null, allocation = null, skipSummary = null, recentSkips = [], candidates = [], results = [], error = null }) {
    if (!runtimeStateEnabled) return;
    writeScannerRuntimeState({
      scanner: 'stock-scanner',
      mode: 'live-market',
      config_version: '2026-06-20.scanner-runtime.1',
      loaded_mode: 'live-market',
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
    saveRecentSymbolMap(state.lastSentAtBySymbol, { env, repoRoot: process.cwd(), profile: 'live-market' });
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

async function fetchStockBundle({ fetchImpl, apiKeyId, apiSecretKey, baseUrl, symbols }) {
  const headers = {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
  const snapshots = {};
  const latestQuotes = {};
  for (const chunk of chunkSymbols(symbols, 25)) {
    const encodedSymbols = encodeURIComponent(chunk.join(','));
    const snapshotsUrl = `${baseUrl}/v2/stocks/snapshots?symbols=${encodedSymbols}&feed=iex`;
    const response = await fetchImpl(snapshotsUrl, { method: 'GET', headers });
    const body = await readJsonResponse(response);
    if (!response.ok) continue;
    const chunkSnapshots = body?.snapshots || body || {};
    Object.assign(snapshots, chunkSnapshots);
    for (const symbol of chunk) {
      latestQuotes[symbol] = chunkSnapshots[symbol]?.latestQuote || chunkSnapshots[symbol]?.latest_quote || latestQuotes[symbol] || {};
    }
  }
  return { snapshots, latestQuotes };
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
  if (!response.ok) return [];
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
  const quotes = {};
  for (const chunk of chunkSymbols(symbols, 20)) {
    const encodedSymbols = encodeURIComponent(chunk.join(','));
    const url = `${baseUrl}/quote?symbol=${encodedSymbols}&apikey=${encodeURIComponent(apiKey)}`;
    const response = await fetchImpl(url, { method: 'GET' });
    const body = await readJsonResponse(response);
    if (!response.ok) continue;
    Object.assign(quotes, normalizeTwelveDataQuotes(body, chunk));
  }
  return quotes;
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
    const symbol = String(entry.symbol || entry.ticker || entry.code || entry.instrument || '').trim().toUpperCase();
    if (!symbol) continue;
    const receivedAt = nowIso();
    const timestamp = entry.datetime || entry.timestamp || entry.time || entry.t || entry.date || receivedAt;
    quotes[symbol] = normalizeMarketData({
      provider: 'twelvedata',
      asset_type: 'stock',
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
    if (!quotes[symbol]) quotes[symbol] = null;
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
    const latestQuote = bundle.latestQuotes[symbol] || snapshot.latestQuote || snapshot.latest_quote || {};
    const candidate = buildCandidateForSymbol(symbol, snapshot, latestQuote, {
      receivedAt: now,
      minMovePct: options.minMovePct,
      maxSpreadPct: options.maxSpreadPct,
      cooldownMs: options.cooldownMs,
      lastSentAt: options.lastSentAtBySymbol?.get(symbol),
      notional: options.notional,
      allocation: options.allocation,
      runId: options.runId,
      sellProfitThresholdPct: options.sellProfitThresholdPct,
      position: positionsBySymbol.get(symbol) || null,
      openOrder: openOrdersBySymbol.get(symbol) || null,
      portfolio: options.portfolio || {},
      skipTracker: options.skipTracker,
      twelveDataQuote: options.twelveDataQuotes?.[symbol] || null,
      requireMultiSourceConfirmation: options.requireMultiSourceConfirmation,
      allowContrarianEntries: options.allowContrarianEntries,
      blockBuys: options.blockBuys,
      sellMaxPriceDiffPct: options.sellMaxPriceDiffPct,
      assetType: 'stock',
      position_avg_entry_price: safeNumber(positionsBySymbol.get(symbol)?.avg_entry_price ?? positionsBySymbol.get(symbol)?.avgEntryPrice ?? null),
      position_qty_available: safeNumber(positionsBySymbol.get(symbol)?.qty_available ?? positionsBySymbol.get(symbol)?.qty ?? null),
    });
    if (candidate) entries.push(candidate);
    if (entries.length >= (options.maxCandidatesPerRun || 8)) break;
  }
  return entries;
}

function buildPositionLookup(positions) {
  const lookup = new Map();
  for (const position of positions) {
    const symbol = String(position.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    lookup.set(symbol, position);
  }
  return lookup;
}

function buildOpenOrderLookup(openOrders = []) {
  const lookup = new Map();
  for (const order of openOrders) {
    const symbol = String(order.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    if (!lookup.has(symbol)) {
      lookup.set(symbol, []);
    }
    lookup.get(symbol).push(order);
  }
  return lookup;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function chunkSymbols(symbols, size) {
  const chunks = [];
  for (let index = 0; index < symbols.length; index += size) {
    chunks.push(symbols.slice(index, index + size));
  }
  return chunks;
}

module.exports = {
  createStockScanner,
};
