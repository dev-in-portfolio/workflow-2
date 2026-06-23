const fs = require('fs');
const path = require('path');
const { buildProviderConfirmationFromContext, normalizeMarketData } = require('./market-data');
const { parseBool } = require('./config');
const { nowIso, safeNumber, hashObject, clamp } = require('./util');
const { APPROVED_LIVE_MARKET_SYMBOLS, parseSymbolList } = require('./volatile-stock-universe');
const { allocateBuyNotional, buildPortfolioSnapshot } = require('./portfolio-allocation');
const { writeScannerRuntimeState } = require('./scanner-runtime-state');
const { loadTrailingState, saveTrailingState, updateTrailingSnapshot } = require('./position-trailing-state');
const { isRegularUsMarketHours } = require('./market-hours');

function createStockScanner(options = {}) {
  const env = options.env || process.env;
  const marketFetch = options.marketFetch || options.fetch || globalThis.fetch;
  const localFetch = options.localFetch || globalThis.fetch;
  if (!marketFetch) throw new Error('Stock scanner requires fetch support');
  if (!localFetch) throw new Error('Stock scanner requires local fetch support');

  const apiKeyId = options.apiKeyId || env.ALPACA_API_KEY_ID || '';
  const apiSecretKey = options.apiSecretKey || env.ALPACA_API_SECRET_KEY || '';
  const baseUrl = trimTrailingSlash(options.baseUrl || env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets');
  const twelveDataApiKey = options.twelveDataApiKey || env.TWELVE_DATA_API_KEY || env.TWELVEDATA_API_KEY || '';
  const twelveDataBaseUrl = trimTrailingSlash(options.twelveDataBaseUrl || env.TWELVE_DATA_BASE_URL || 'https://api.twelvedata.com');
  const localBaseUrl = trimTrailingSlash(options.localBaseUrl || options.local_url || '');
  const enabled = options.enabled !== false;
  const symbols = options.symbols
    ? parseSymbolList(options.symbols, APPROVED_LIVE_MARKET_SYMBOLS)
    : parseSymbolList(env.STOCK_SCANNER_SYMBOLS, APPROVED_LIVE_MARKET_SYMBOLS);
  const intervalMs = Math.max(15_000, Number(options.intervalMs ?? Number(env.STOCK_SCANNER_INTERVAL_SECONDS || 60) * 1000) || 60_000);
  const maxCandidatesPerRun = Math.max(1, Number(options.maxCandidatesPerRun ?? env.STOCK_SCANNER_MAX_CANDIDATES ?? 2) || 2);
  const notional = Math.max(1, Number(options.notional ?? env.BUY_NOTIONAL_TARGET ?? 150) || 150);
  const minBuyNotional = Math.max(1, Number(options.minBuyNotional ?? env.MIN_BUY_NOTIONAL ?? 25) || 25);
  const maxOpenPositions = Math.max(1, Number(options.maxOpenPositions ?? env.MAX_OPEN_POSITIONS ?? 2) || 2);
  const stopLossDollars = Math.max(0.01, Number(options.stopLossDollars ?? env.POSITION_STOP_LOSS_DOLLARS ?? 1) || 1);
  const stopLossNotionalPct = Math.max(0, safeNumber(options.stopLossNotionalPct ?? env.POSITION_STOP_LOSS_NOTIONAL_PCT, 0.75));
  const stopLossMaxDollars = Math.max(stopLossDollars, safeNumber(options.stopLossMaxDollars ?? env.POSITION_STOP_LOSS_MAX_DOLLARS, 2.5));
  const trailingProfitStartDollars = Math.max(0.01, Number(options.trailingProfitStartDollars ?? env.TRAILING_PROFIT_START_DOLLARS ?? 0.5) || 0.5);
  const trailingProfitGivebackDollars = Math.max(0.01, Number(options.trailingProfitGivebackDollars ?? env.TRAILING_PROFIT_GIVEBACK_DOLLARS ?? 0.3) || 0.3);
  const requireMultiSourceConfirmation = options.requireMultiSourceConfirmation ?? Boolean(twelveDataApiKey);
  const allowContrarianEntries = options.allowContrarianEntries ?? true;
  const blockBuys = options.blockBuys ?? parseBool(env.BLOCK_BUYS, false);
  const sellMaxPriceDiffPct = safeNumber(options.sellMaxPriceDiffPct ?? env.SELL_MAX_PROVIDER_PRICE_DIFF_PCT, 0.75);
  const recentTradePenaltyMinutes = Math.max(0, safeNumber(options.recentTradePenaltyMinutes ?? env.STOCK_SCANNER_RECENT_TRADE_PENALTY_MINUTES, 15));
  const recentTradeRankPenalty = Math.max(0, safeNumber(options.recentTradeRankPenalty ?? env.STOCK_SCANNER_RECENT_TRADE_RANK_PENALTY, 20));
  const recentLossPenaltyMinutes = Math.max(0, safeNumber(options.recentLossPenaltyMinutes ?? env.STOCK_SCANNER_RECENT_LOSS_PENALTY_MINUTES, 10));
  const recentLossRankPenalty = Math.max(0, safeNumber(options.recentLossRankPenalty ?? env.STOCK_SCANNER_RECENT_LOSS_RANK_PENALTY, 60));
  const keepAlive = options.keepAlive ?? true;
  const runtimeStateEnabled = options.runtimeStateEnabled ?? parseBool(env.SCANNER_RUNTIME_STATE_ENABLED, false);
  const requireMarketOpen = options.requireMarketOpen ?? parseBool(env.STOCK_SCANNER_REQUIRE_MARKET_OPEN, true);

  const state = {
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
      const approvedPositions = filterApprovedPositions(positions, symbols);
      const portfolio = buildPortfolioSnapshot({ positions, openOrders, account, maxOpenPositions });
      const allocation = allocateBuyNotional({ targetNotional: notional, minBuyNotional, portfolio });
      const skipTracker = createSkipTracker();
      const recentTradePenalties = loadRecentTradePenalties({
        env,
        repoRoot: process.cwd(),
        now: receivedAt,
        windowMinutes: recentTradePenaltyMinutes,
        penalty: recentTradeRankPenalty,
        lossWindowMinutes: recentLossPenaltyMinutes,
        lossPenalty: recentLossRankPenalty,
        overrides: options.recentTradePenalties,
      });
      const marketOpen = options.marketOpen ?? isRegularUsMarketHours(new Date());
      if (requireMarketOpen && !marketOpen) {
        skipTracker.record('MARKET_CLOSED_FOR_STOCKS', { symbol: '*', market_open: false });
      }
      if (!allocation.accepted) {
        skipTracker.record(allocation.reason || 'ALLOCATION_BLOCK', {
          symbol: '*',
          notional: allocation.notional,
          requested: allocation.requested,
          remaining_slots: allocation.remaining_slots,
        });
      }
      const previousTrailingState = loadTrailingState({ env, repoRoot: process.cwd() });
      const trailingState = updateTrailingSnapshot({
        positions: approvedPositions,
        startDollars: trailingProfitStartDollars,
        givebackDollars: trailingProfitGivebackDollars,
        previousState: previousTrailingState,
      });
      saveTrailingState(trailingState, { env, repoRoot: process.cwd() });
      const candidates = buildCandidates(bundle, {
        receivedAt,
        maxCandidatesPerRun,
        maxBuyCandidates: Math.min(maxCandidatesPerRun, Math.max(0, portfolio.remaining_position_slots ?? maxOpenPositions)),
        notional: allocation.accepted ? allocation.notional : notional,
        allocation,
        marketOpen,
        requireMarketOpen,
        stopLossDollars,
        stopLossNotionalPct,
        stopLossMaxDollars,
        trailingProfitStartDollars,
        trailingProfitGivebackDollars,
        trailingState,
        requireMultiSourceConfirmation,
        allowContrarianEntries,
        blockBuys,
        sellMaxPriceDiffPct,
        twelveDataQuotes,
        openOrders,
        portfolio,
        skipTracker,
        runId: runOptions.runId || `stock_${hashObject({ receivedAt, symbols, baseUrl }).slice(0, 10)}`,
        positions: approvedPositions,
        approvedSymbols: symbols,
        recentTradePenalties,
      });

      const results = [];
      for (const candidate of candidates) {
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
        if (!isApprovedPostResult({ accepted: response.ok, response: responseBody })) {
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
      state.lastApprovedCount = results.filter(isApprovedPostResult).length;
      state.lastRejectedCount = results.length - state.lastApprovedCount;
      writeRuntimeSnapshot({
        receivedAt,
        durationMs: state.lastScanDurationMs,
        portfolio,
        allocation,
        trailingState,
        skipSummary: skipTracker.summary(),
        recentSkips: skipTracker.recent(),
        candidates,
        results,
        recentTradePenalties,
      });
      return {
        accepted: true,
        candidates: results,
        received_at: receivedAt,
        portfolio,
        allocation,
        skip_summary: skipTracker.summary(),
        recent_skips: skipTracker.recent(),
      };
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
      maxCandidatesPerRun,
      notional,
      minBuyNotional,
      maxOpenPositions,
      stopLossDollars,
      stopLossNotionalPct,
      stopLossMaxDollars,
      trailingProfitStartDollars,
      trailingProfitGivebackDollars,
      twelveDataApiKey,
      twelveDataBaseUrl,
      requireMultiSourceConfirmation,
      requireMarketOpen,
      keepAlive,
      sellMaxPriceDiffPct,
      recentTradePenaltyMinutes,
      recentTradeRankPenalty,
      recentLossPenaltyMinutes,
      recentLossRankPenalty,
    },
  };

  return controller;

  function writeRuntimeSnapshot({ receivedAt, durationMs, portfolio = null, allocation = null, trailingState = null, skipSummary = null, recentSkips = [], candidates = [], results = [], recentTradePenalties = new Map(), error = null }) {
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
      approved_count: results.filter(isApprovedPostResult).length,
      rejected_count: results.filter((result) => !isApprovedPostResult(result)).length,
      post_results: results.map(summarizePostResult),
      recent_trade_rank_penalties: summarizeRecentTradePenalties(recentTradePenalties),
      candidate_rank_details: candidates
        .filter((candidate) => candidate.payload?.side === 'buy')
        .map((candidate) => ({
          symbol: candidate.symbol,
          rank_score: roundScore(candidate.rankScore),
          base_rank_score: roundScore(candidate.baseRankScore ?? candidate.rankScore),
          recent_trade_rank_penalty: roundScore(candidate.recentTradeRankPenalty || 0),
          recent_trade_at: candidate.recentTradePenalty?.last_traded_at || null,
        })),
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
      approved_symbols: symbols,
      exit_rules: {
        stop_loss_dollars: stopLossDollars,
        stop_loss_notional_pct: stopLossNotionalPct,
        stop_loss_max_dollars: stopLossMaxDollars,
        trailing_profit_start_dollars: trailingProfitStartDollars,
        trailing_profit_giveback_dollars: trailingProfitGivebackDollars,
      },
      position_exit_state: candidates
        .filter((candidate) => candidate.exitState)
        .map((candidate) => candidate.exitState),
      trailing_state: trailingState ? {
        updated_at: trailingState.updated_at,
        positions: trailingState.positions,
      } : null,
    }, { env, repoRoot: process.cwd() });
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
  const now = options.receivedAt || nowIso();
  const symbols = Object.keys(bundle.snapshots || {});
  const positionsBySymbol = buildPositionLookup(options.positions || []);
  const openOrdersBySymbol = buildOpenOrderLookup(options.openOrders || []);
  const sellEntries = [];
  const buyEntries = [];
  for (const symbol of symbols) {
    if (Array.isArray(options.approvedSymbols) && !options.approvedSymbols.includes(symbol)) {
      options.skipTracker?.record?.('NOT_IN_APPROVED_ROTATION', { symbol });
      continue;
    }
    const snapshot = bundle.snapshots[symbol] || {};
    const latestQuote = bundle.latestQuotes[symbol] || snapshot.latestQuote || snapshot.latest_quote || {};
      const candidate = buildStockCandidateForSymbol(symbol, snapshot, latestQuote, {
        receivedAt: now,
        notional: options.notional,
        allocation: options.allocation,
        runId: options.runId,
      stopLossDollars: options.stopLossDollars,
      stopLossNotionalPct: options.stopLossNotionalPct,
      stopLossMaxDollars: options.stopLossMaxDollars,
      trailingProfitStartDollars: options.trailingProfitStartDollars,
      trailingProfitGivebackDollars: options.trailingProfitGivebackDollars,
      trailingState: options.trailingState,
      position: positionsBySymbol.get(symbol) || null,
      openOrder: openOrdersBySymbol.get(symbol) || null,
      portfolio: options.portfolio || {},
      skipTracker: options.skipTracker,
      twelveDataQuote: options.twelveDataQuotes?.[symbol] || null,
      requireMultiSourceConfirmation: options.requireMultiSourceConfirmation,
      allowContrarianEntries: options.allowContrarianEntries,
      blockBuys: options.blockBuys,
      marketOpen: options.marketOpen,
      requireMarketOpen: options.requireMarketOpen,
      sellMaxPriceDiffPct: options.sellMaxPriceDiffPct,
      assetType: 'stock',
      recentTradePenalty: getRecentTradePenalty(options.recentTradePenalties, symbol),
      position_avg_entry_price: safeNumber(positionsBySymbol.get(symbol)?.avg_entry_price ?? positionsBySymbol.get(symbol)?.avgEntryPrice ?? null),
      position_qty_available: safeNumber(positionsBySymbol.get(symbol)?.qty ?? positionsBySymbol.get(symbol)?.quantity ?? positionsBySymbol.get(symbol)?.qty_available ?? null),
    });
    if (candidate?.payload?.side === 'sell') {
      sellEntries.push(candidate);
    } else if (candidate?.payload?.side === 'buy') {
      buyEntries.push(candidate);
    }
  }
  buyEntries.sort((a, b) => b.rankScore - a.rankScore);
  return [
    ...sellEntries,
    ...buyEntries.slice(0, Math.max(0, options.maxBuyCandidates ?? options.maxCandidatesPerRun ?? 2)),
  ];
}

function buildStockCandidateForSymbol(symbol, snapshot, latestQuote, options = {}) {
  const skip = (reason, details = {}) => {
    options.skipTracker?.record?.(reason, { symbol, ...details });
    return null;
  };
  const quote = snapshot.latestQuote || latestQuote || {};
  const bid = safeNumber(quote.bp ?? quote.bid_price ?? quote.bid ?? quote.p, null);
  const ask = safeNumber(quote.ap ?? quote.ask_price ?? quote.ask ?? quote.p, null);
  const currentPrice = Number.isFinite(bid) && Number.isFinite(ask)
    ? (bid + ask) / 2
    : safeNumber(quote.p ?? snapshot.latestTrade?.p ?? snapshot.minuteBar?.c ?? null);
  const previousClose = safeNumber(snapshot.prevDailyBar?.c ?? snapshot.dailyBar?.c ?? snapshot.prevDailyBar?.close ?? null);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(previousClose) || previousClose <= 0) {
    return skip('DATA_STALE_OR_UNAVAILABLE');
  }
  const spreadPct = Number.isFinite(bid) && Number.isFinite(ask) && currentPrice > 0
    ? ((ask - bid) / currentPrice) * 100
    : 0;

  const positionQty = safeNumber(options.position?.qty ?? options.position?.quantity ?? options.position?.qty_available ?? 0, 0);
  const hasPosition = Number.isFinite(positionQty) && Math.abs(positionQty) > 0;
  const openBuyOrders = Array.isArray(options.openOrder)
    ? options.openOrder.filter((order) => String(order.side || '').toLowerCase() === 'buy')
    : [];
  const openSellOrders = Array.isArray(options.openOrder)
    ? options.openOrder.filter((order) => String(order.side || '').toLowerCase() === 'sell')
    : [];

  if (hasPosition) {
    if (openSellOrders.length) return skip('OPEN_ORDER_EXISTS', { side: 'sell' });
    return buildExitCandidate({ symbol, snapshot, latestQuote, currentPrice, previousClose, spreadPct, positionQty, options });
  }

  if (openBuyOrders.length) return skip('OPEN_BUY_ORDER_EXISTS');
  if (options.blockBuys) return skip('BUY_SIDE_BLOCKED');
  if (options.requireMarketOpen && options.marketOpen === false) return skip('MARKET_CLOSED_FOR_STOCKS');
  if (options.allocation && options.allocation.accepted === false) {
    return skip(options.allocation.reason || 'ALLOCATION_BLOCKED');
  }
  if (options.portfolio?.remaining_position_slots !== null && options.portfolio?.remaining_position_slots <= 0) {
    return skip('MAX_POSITION_SLOTS_FILLED');
  }

  return buildBuyCandidate({ symbol, snapshot, latestQuote, currentPrice, previousClose, spreadPct, options });
}

function isApprovedPostResult(result = {}) {
  const response = result.response || result;
  const decision = response?.final_decision
    || response?.decision
    || response?.riskDecision?.decision
    || response?.risk_decision?.decision
    || result.status;
  return Boolean(result.accepted !== false)
    && (decision === 'APPROVED_FOR_PAPER' || response?.accepted === true);
}

function summarizePostResult(result = {}) {
  const response = result.response || {};
  return {
    symbol: result.symbol || response.signal?.symbol || null,
    accepted: result.accepted,
    status: result.status,
    response_accepted: response.accepted,
    stage: response.stage || response.last_result?.stage || null,
    error: response.error || response.last_result?.error || null,
    message: response.message || response.last_result?.message || null,
    reason_codes: response.reason_codes || response.last_result?.reason_codes || response.riskDecision?.reason_codes || response.risk_decision?.reason_codes || [],
    risk_decision: response.riskDecision?.decision || response.risk_decision?.decision || null,
  };
}

function loadRecentTradePenalties({ env = process.env, repoRoot = process.cwd(), now = nowIso(), windowMinutes = 5, penalty = 8, lossWindowMinutes = 10, lossPenalty = 60, overrides = null } = {}) {
  if ((!windowMinutes || !penalty) && (!lossWindowMinutes || !lossPenalty)) return new Map();
  if (overrides) return normalizeRecentTradePenaltyMap(overrides, { now, windowMinutes, penalty, lossWindowMinutes, lossPenalty });
  const historyPath = resolvePerformanceHistoryPath(env, repoRoot);
  const lines = readTailLines(historyPath, 512 * 1024);
  return normalizeRecentTradePenaltyMap(lines.map(parseJsonLine).filter(Boolean), { now, windowMinutes, penalty, lossWindowMinutes, lossPenalty });
}

function resolvePerformanceHistoryPath(env = process.env, repoRoot = process.cwd()) {
  const configured = String(env.PERFORMANCE_HISTORY_PATH || '').trim();
  return path.resolve(repoRoot, configured || path.join('data', 'performance-history.jsonl'));
}

function readTailLines(filePath, maxBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeRecentTradePenaltyMap(source, { now = nowIso(), windowMinutes = 15, penalty = 20, lossWindowMinutes = 10, lossPenalty = 60 } = {}) {
  const map = new Map();
  const nowMs = new Date(now).getTime();
  const windowMs = Math.max(0, safeNumber(windowMinutes, 15)) * 60_000;
  const lossWindowMs = Math.max(0, safeNumber(lossWindowMinutes, 10)) * 60_000;
  if (!Number.isFinite(nowMs)) return map;
  const records = source instanceof Map
    ? [...source.values()]
    : Array.isArray(source)
      ? source
      : Object.values(source || {});
  for (const item of records) {
    const record = item?.record || item;
    const trade = extractFilledTrade(record);
    if (!trade.symbol || !trade.traded_at) continue;
    const tradedAtMs = new Date(trade.traded_at).getTime();
    if (!Number.isFinite(tradedAtMs)) continue;
    const ageMs = nowMs - tradedAtMs;
    if (ageMs < 0) continue;
    const isLossExit = trade.side === 'sell' && trade.loss_exit;
    if (trade.side !== 'sell') continue;
    const components = [];
    if (windowMs > 0 && penalty > 0 && ageMs <= windowMs) {
      components.push(buildPenaltyComponent({
        trade,
        tradedAtMs,
        nowMs,
        windowMs,
        penalty,
        reason: 'recent_sell',
      }));
    }
    if (isLossExit && lossWindowMs > 0 && lossPenalty > 0 && ageMs <= lossWindowMs) {
      components.push(buildPenaltyComponent({
        trade,
        tradedAtMs,
        nowMs,
        windowMs: lossWindowMs,
        penalty: lossPenalty,
        reason: 'recent_loss_exit',
      }));
    }
    if (!components.length) continue;
    const existing = map.get(trade.symbol) || {
      symbol: trade.symbol,
      last_traded_at: trade.traded_at,
      components: [],
    };
    existing.components.push(...components);
    existing.components.sort((a, b) => new Date(b.traded_at).getTime() - new Date(a.traded_at).getTime());
    existing.penalty = existing.components.reduce((sum, component) => sum + safeNumber(component.penalty, 0), 0);
    existing.last_traded_at = existing.components[0]?.traded_at || trade.traded_at;
    existing.age_seconds = existing.components.length
      ? Math.min(...existing.components.map((component) => safeNumber(component.age_seconds, 0)))
      : Math.round(ageMs / 1000);
    existing.window_seconds = existing.components.length
      ? Math.max(...existing.components.map((component) => safeNumber(component.window_seconds, 0)))
      : 0;
    existing.remaining_seconds = existing.components.length
      ? Math.max(...existing.components.map((component) => safeNumber(component.remaining_seconds, 0)))
      : 0;
    existing.reason = existing.components.some((component) => component.reason === 'recent_loss_exit')
      ? 'compound_recent_sell_and_loss'
      : 'compound_recent_sell';
    existing.loss_exit = existing.components.some((component) => component.loss_exit);
    existing.exit_reason = existing.components.find((component) => component.exit_reason)?.exit_reason || null;
    map.set(trade.symbol, existing);
  }
  return map;
}

function buildPenaltyComponent({ trade, tradedAtMs, nowMs, windowMs, penalty, reason }) {
  const expiresAtMs = tradedAtMs + windowMs;
  return {
    reason,
    traded_at: trade.traded_at,
    expires_at: new Date(expiresAtMs).toISOString(),
    age_seconds: Math.max(0, Math.round((nowMs - tradedAtMs) / 1000)),
    remaining_seconds: Math.max(0, Math.round((expiresAtMs - nowMs) / 1000)),
    window_seconds: Math.round(windowMs / 1000),
    penalty,
    side: trade.side,
    loss_exit: Boolean(trade.loss_exit),
    exit_reason: trade.exit_reason || null,
  };
}

function extractFilledTrade(record = {}) {
  const paperResult = record.paper_result || record.paperResult || {};
  const status = String(paperResult.status || record.status || '').trim().toLowerCase();
  const hasOrder = Boolean(paperResult.order_id || paperResult.filled_at || paperResult.filledAt || record.paper_result);
  if (status && !['filled', 'accepted', 'new'].includes(status)) return {};
  if (!hasOrder && record.entry_type !== 'paper_outcome') return {};
  const symbol = String(record.symbol || paperResult.symbol || record.original_signal?.symbol || paperResult.original_signal?.symbol || '').trim().toUpperCase();
  const tradedAt = paperResult.filled_at
    || paperResult.filledAt
    || record.recorded_at
    || record.created_at
    || record.timestamp
    || null;
  const side = String(record.side || record.paper_order_request?.side || record.original_signal?.side || paperResult.side || '').trim().toLowerCase();
  const exitState = record.original_signal?.market_context?.exit_state
    || record.market_context?.exit_state
    || record.exit_state
    || {};
  const exitReason = String(exitState.exit_reason || record.exit_reason || '').trim();
  const pnlValues = [
    record.net_pnl,
    record.adjusted_pnl,
    record.pnl,
    record.gross_pnl,
    exitState.net_pnl,
    exitState.gross_pnl,
    exitState.unrealized_pl,
  ].map((value) => safeNumber(value, null)).filter(Number.isFinite);
  const lossExit = side === 'sell' && (
    pnlValues.some((value) => value < 0)
    || /STOP_LOSS|LOSS/i.test(exitReason)
  );
  return {
    symbol,
    traded_at: tradedAt,
    side,
    loss_exit: lossExit,
    exit_reason: exitReason || null,
  };
}

function getRecentTradePenalty(penalties, symbol) {
  if (!penalties) return null;
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return null;
  if (penalties instanceof Map) return penalties.get(normalized) || null;
  return penalties[normalized] || null;
}

function summarizeRecentTradePenalties(penalties) {
  if (!penalties) return [];
  const values = penalties instanceof Map ? [...penalties.values()] : Object.values(penalties);
  return values.map((entry) => ({
    symbol: entry.symbol,
    last_traded_at: entry.last_traded_at,
    age_seconds: entry.age_seconds,
    window_seconds: entry.window_seconds,
    remaining_seconds: entry.remaining_seconds,
    penalty: entry.penalty,
    reason: entry.reason || 'compound_recent_sell',
    loss_exit: Boolean(entry.loss_exit),
    exit_reason: entry.exit_reason || null,
    components: Array.isArray(entry.components) ? entry.components : [],
  }));
}

function calculateEffectiveStopLossDollars({
  baseStopLossDollars = 1,
  stopLossNotionalPct = 0,
  stopLossMaxDollars = baseStopLossDollars,
  positionMarketValue = null,
} = {}) {
  const base = Math.abs(safeNumber(baseStopLossDollars, 1));
  const maxStop = Math.max(base, Math.abs(safeNumber(stopLossMaxDollars, base)));
  const notionalPct = Math.max(0, safeNumber(stopLossNotionalPct, 0));
  const marketValue = Math.abs(safeNumber(positionMarketValue, NaN));
  const notionalStop = Number.isFinite(marketValue) && marketValue > 0 && notionalPct > 0
    ? marketValue * (notionalPct / 100)
    : base;
  return roundCurrency(Math.min(maxStop, Math.max(base, notionalStop)));
}

function buildExitCandidate({ symbol, snapshot, latestQuote, currentPrice, previousClose, spreadPct, positionQty, options }) {
  const unrealized = safeNumber(options.position?.unrealized_pl ?? options.position?.unrealizedPnl ?? options.position?.unrealized_intraday_pl, null);
  const trailingRecord = options.trailingState?.positions?.[symbol] || {};
  const stopLossDollars = options.stopLossDollars ?? 1;
  const stopLossNotionalPct = Math.max(0, safeNumber(options.stopLossNotionalPct, 0));
  const stopLossMaxDollars = Math.max(Math.abs(stopLossDollars), safeNumber(options.stopLossMaxDollars, Math.abs(stopLossDollars)));
  const trailingStart = options.trailingProfitStartDollars ?? 0.5;
  const trailingGiveback = options.trailingProfitGivebackDollars ?? 0.3;
  const peak = safeNumber(trailingRecord.peak_unrealized_pl, null);
  const trailingActive = Number.isFinite(peak) && peak >= trailingStart;
  const trailingSellAt = trailingActive ? peak - trailingGiveback : null;
  const entryPrice = safeNumber(options.position?.avg_entry_price ?? options.position?.avgEntryPrice ?? options.position_avg_entry_price, null);
  const entrySlippage = Math.max(0, safeNumber(options.position?.entry_slippage ?? options.position?.entrySlippage, 0));
  const exitSlippage = Math.max(0, safeNumber(options.exitSlippage ?? options.position?.exit_slippage ?? options.position?.exitSlippage, 0));
  const fees = Math.max(0, safeNumber(options.fees ?? options.position?.fees ?? options.position?.estimated_fees, 0));
  const grossPnl = Number.isFinite(entryPrice)
    ? (currentPrice - entryPrice) * Math.abs(positionQty)
    : unrealized;
  const executionDrag = entrySlippage + exitSlippage + fees;
  const netPnl = Number.isFinite(grossPnl) ? grossPnl - executionDrag : null;
  const positionMarketValue = safeNumber(
    options.position?.market_value ?? options.position?.marketValue,
    Number.isFinite(currentPrice) ? Math.abs(positionQty) * currentPrice : null,
  );
  const effectiveStopLossDollars = calculateEffectiveStopLossDollars({
    baseStopLossDollars: stopLossDollars,
    stopLossNotionalPct,
    stopLossMaxDollars,
    positionMarketValue,
  });
  let exitReason = null;
  if (Number.isFinite(unrealized) && unrealized <= -effectiveStopLossDollars) {
    exitReason = 'STOP_LOSS_DOLLARS';
  } else if (trailingActive && Number.isFinite(unrealized) && unrealized <= trailingSellAt) {
    exitReason = 'TRAILING_PROFIT_GIVEBACK';
  }
  const exitState = {
    symbol,
    unrealized_pl: Number.isFinite(unrealized) ? roundCurrency(unrealized) : null,
    stop_loss_dollars: roundCurrency(effectiveStopLossDollars),
    base_stop_loss_dollars: roundCurrency(Math.abs(stopLossDollars)),
    stop_loss_notional_pct: roundCurrency(stopLossNotionalPct),
    stop_loss_max_dollars: roundCurrency(stopLossMaxDollars),
    position_market_value: Number.isFinite(positionMarketValue) ? roundCurrency(positionMarketValue) : null,
    distance_to_stop_dollars: Number.isFinite(unrealized) ? roundCurrency(unrealized + effectiveStopLossDollars) : null,
    trailing_active: trailingActive,
    trailing_peak_unrealized_pl: Number.isFinite(peak) ? roundCurrency(peak) : null,
    trailing_sell_if_unrealized_pl_at_or_below: Number.isFinite(trailingSellAt) ? roundCurrency(trailingSellAt) : null,
    sell_price: Number.isFinite(currentPrice) ? roundCurrency(currentPrice) : null,
    entry_price: Number.isFinite(entryPrice) ? roundCurrency(entryPrice) : null,
    quantity: Number(Math.abs(positionQty).toFixed(6)),
    gross_pnl: Number.isFinite(grossPnl) ? roundCurrency(grossPnl) : null,
    entry_slippage: roundCurrency(entrySlippage),
    exit_slippage: roundCurrency(exitSlippage),
    fees: roundCurrency(fees),
    execution_drag: roundCurrency(executionDrag),
    net_pnl: Number.isFinite(netPnl) ? roundCurrency(netPnl) : null,
    real_gain: Number.isFinite(netPnl) ? netPnl >= 0 : null,
    exit_reason: exitReason,
  };
  if (!exitReason) {
    options.skipTracker?.record?.('EXIT_TARGET_NOT_MET', { symbol, unrealized_pl: exitState.unrealized_pl });
    return null;
  }
  return buildSignalCandidate({
    symbol,
    side: 'sell',
    currentPrice,
    previousClose,
    spreadPct,
    snapshot,
    latestQuote,
    options,
    quantity: Number(Math.abs(positionQty).toFixed(6)),
    notional: null,
    exitState,
  });
}

function buildBuyCandidate({ symbol, snapshot, latestQuote, currentPrice, previousClose, spreadPct, options }) {
  const movePct = ((currentPrice - previousClose) / previousClose) * 100;
  const notional = safeNumber(options.notional, 150);
  if (!Number.isFinite(notional) || notional <= 0) {
    options.skipTracker?.record?.('BELOW_MINIMUM_BUY_NOTIONAL', { symbol, notional });
    return null;
  }
  const volumeScore = Math.log10(Math.max(10, safeNumber(snapshot.prevDailyBar?.v ?? snapshot.dailyBar?.v ?? 0, 0)));
  const baseRankScore = Math.abs(movePct) * 10 + volumeScore - (spreadPct * 3);
  const recentPenalty = options.recentTradePenalty || null;
  const recentTradeRankPenalty = Math.max(0, safeNumber(recentPenalty?.penalty, 0));
  const rankScore = baseRankScore - recentTradeRankPenalty;
  return buildSignalCandidate({
    symbol,
    side: 'buy',
    currentPrice,
    previousClose,
    spreadPct,
    snapshot,
    latestQuote,
    options,
    quantity: null,
    notional,
    rankScore,
    baseRankScore,
    recentTradeRankPenalty,
    recentTradePenalty: recentPenalty,
  });
}

function buildSignalCandidate({ symbol, side, currentPrice, previousClose, spreadPct, snapshot, latestQuote, options, quantity, notional, rankScore = 0, baseRankScore = rankScore, recentTradeRankPenalty = 0, recentTradePenalty = null, exitState = null }) {
  const receivedAt = options.receivedAt || nowIso();
  const movePct = ((currentPrice - previousClose) / previousClose) * 100;
  const minuteVolume = safeNumber(snapshot.minuteBar?.v ?? 0, 0);
  const dailyVolume = safeNumber(snapshot.prevDailyBar?.v ?? snapshot.dailyBar?.v ?? 0, 0);
  const volume = Math.max(minuteVolume, dailyVolume, minuteVolume * currentPrice, dailyVolume * currentPrice);
  const quote = snapshot.latestQuote || latestQuote || {};
  const rawMarketData = {
    provider: 'alpaca',
    asset_type: 'stock',
    kind: 'quote',
    symbol,
    timestamp: quote.t || snapshot.latestTrade?.t || snapshot.minuteBar?.t || receivedAt,
    received_at: receivedAt,
    price: currentPrice,
    previous_close: previousClose,
    volume,
    confidence: clamp(82 + Math.min(10, Math.abs(movePct) * 4), 0, 100),
    reliability: clamp(80 + Math.min(15, Math.abs(movePct) * 3), 0, 100),
    exchange: 'alpaca',
    provider_asset_id: symbol,
    provider_symbol: symbol,
    raw_payload: { snapshot, latest_quote: latestQuote, quote },
  };
  const normalizedPrimary = normalizeMarketData(rawMarketData, { receivedAt, maxStalenessSeconds: 300 });
  const secondaryQuote = normalizeMarketData({
    provider: options.twelveDataQuote ? 'twelvedata' : 'alpaca-secondary',
    asset_type: 'stock',
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
  const marketContext = {
    source: 'stock-scanner',
    scanner: {
      run_id: options.runId || null,
      move_pct: Number(movePct.toFixed(4)),
      spread_pct: Number(spreadPct.toFixed(4)),
      current_price: Number(currentPrice.toFixed(6)),
      previous_close: Number(previousClose.toFixed(6)),
      rank_score: side === 'buy' ? roundScore(rankScore) : null,
      base_rank_score: side === 'buy' ? roundScore(baseRankScore) : null,
      recent_trade_rank_penalty: side === 'buy' ? roundScore(recentTradeRankPenalty) : 0,
      recent_trade_at: side === 'buy' ? recentTradePenalty?.last_traded_at || null : null,
      recent_trade_penalty_reason: side === 'buy' ? recentTradePenalty?.reason || null : null,
    },
    volume,
    alpaca_quote: normalizedPrimary,
    secondary_quote: secondaryQuote,
    twelve_data_quote: options.twelveDataQuote || null,
    alpaca_snapshot: snapshot,
    alpaca_latest_quote: latestQuote,
    spread_slippage_pct: spreadPct,
    volatility_pct: Math.abs(movePct),
    high_price: safeNumber(snapshot.minuteBar?.h ?? snapshot.latestTrade?.p ?? currentPrice, currentPrice),
    low_price: safeNumber(snapshot.minuteBar?.l ?? snapshot.latestTrade?.p ?? currentPrice, currentPrice),
    exit_state: exitState,
    market_closed: options.requireMarketOpen && options.marketOpen === false,
  };
  const providerConfirmation = buildProviderConfirmationFromContext(marketContext, {
    confirmation_options: {
      maxPriceDiffPct: options.maxPriceDiffPct ?? 0.5,
      maxTimeSkewSeconds: options.maxTimeSkewSeconds ?? 60,
    },
    trade_side: side,
    sellMaxPriceDiffPct: options.sellMaxPriceDiffPct ?? 0.75,
  });
  if (options.requireMultiSourceConfirmation && !providerConfirmation?.confirmed) {
    options.skipTracker?.record?.('MULTI_SOURCE_CONFIRMATION_FAILED', { symbol });
    return null;
  }
  const signalId = `stock_${hashObject({ symbol, side, receivedAt, price: currentPrice, runId: options.runId || null }).slice(0, 16)}`;
  const estimatedQty = side === 'buy' && notional ? notional / currentPrice : Math.max(0.000001, quantity || 0);
  const riskPerShare = side === 'buy' && estimatedQty > 0 ? (options.stopLossDollars ?? 1) / estimatedQty : currentPrice * 0.01;
  const rewardPerShare = Math.max(riskPerShare * 1.8, currentPrice * 0.02);
  const payload = {
    signal_id: signalId,
    request_id: signalId,
    symbol,
    asset_type: 'stock',
    strategy_name: 'live-market-stock-rotation',
    strategy_requires_open_market: true,
    timeframe: 'intraday',
    direction: side === 'sell' ? 'bearish' : 'bullish',
    action_candidate: side === 'sell' ? 'paper_sell' : 'paper_buy',
    side,
    order_type: 'market',
    time_in_force: 'day',
    entry_price: currentPrice,
    price: currentPrice,
    quantity,
    notional,
    supports_fractional_shares: side === 'buy' ? true : null,
    requested_notional: side === 'buy' ? options.allocation?.requested ?? notional : null,
    submitted_notional: side === 'buy' ? options.allocation?.notional ?? notional : null,
    min_buy_notional: side === 'buy' ? options.allocation?.floor ?? null : null,
    stop_loss: roundEquityPrice(side === 'sell' ? currentPrice * 1.01 : Math.max(0.01, currentPrice - riskPerShare)),
    take_profit: roundEquityPrice(side === 'sell' ? Math.max(0.01, currentPrice * 0.99) : currentPrice + rewardPerShare),
    confidence_score: normalizedPrimary.confidence_score,
    freshness_score: 100,
    source_quality_score: clamp(80 + (providerConfirmation?.confirmed ? 10 : -10), 0, 100),
    contradiction_score: providerConfirmation?.confirmed ? 4 : clamp(providerConfirmation?.discrepancy_score || 25, 0, 100),
    risk_score: clamp(18 + Math.min(25, Math.abs(movePct) * 6) + (spreadPct * 10) + (providerConfirmation?.confirmed ? 0 : 25), 0, 100),
    provider_confirmation_score: providerConfirmation?.confirmed
      ? clamp(100 - safeNumber(providerConfirmation.discrepancy_score, 0), 0, 100)
      : clamp(35 - safeNumber(providerConfirmation?.discrepancy_score, 0), 0, 100),
    edge_score: clamp(78 + Math.min(12, Math.abs(movePct) * 2), 0, 100),
    volume,
    market_context: marketContext,
  };
  return {
    symbol,
    movePct,
    spreadPct,
    rankScore,
    baseRankScore,
    recentTradeRankPenalty,
    recentTradePenalty,
    endpoint: 'paper-order',
    payload,
    exitState,
  };
}

function filterApprovedPositions(positions = [], approvedSymbols = APPROVED_LIVE_MARKET_SYMBOLS) {
  const approved = new Set(approvedSymbols.map((symbol) => String(symbol).toUpperCase()));
  return (Array.isArray(positions) ? positions : []).filter((position) => approved.has(String(position.symbol || '').toUpperCase()));
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

function roundCurrency(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function roundScore(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function roundEquityPrice(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  const decimals = Math.abs(numericValue) >= 1 ? 2 : 4;
  return Number(numericValue.toFixed(decimals));
}

module.exports = {
  APPROVED_LIVE_MARKET_SYMBOLS,
  buildStockCandidateForSymbol,
  calculateEffectiveStopLossDollars,
  createStockScanner,
  normalizeRecentTradePenaltyMap,
};
