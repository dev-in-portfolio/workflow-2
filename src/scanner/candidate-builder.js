const { buildProviderConfirmationFromContext, normalizeMarketData } = require('../market-data');
const { parseBool } = require('../config');
const { nowIso, safeNumber, hashObject, clamp, roundCurrency, roundScore, roundEquityPrice } = require('../util');
const { normalizeCandidateKey, reconcileCandidateLifecycleState } = require('../candidate-lifecycle-state');
const { normalizeExecutionQualityKey } = require('../execution-quality-state');
const { evaluateSetupFatigueCandidate } = require('../setup-fatigue');
const { summarizeSessionGuards } = require('../session-guards');
const { calculateRiskBudgetSize } = require('../risk-budget-sizing');
const { calculateStructureAwareStop } = require('../structure-stops');
const { SetupFatigueReason } = require('../setup-fatigue');
const { buildPositionLookup, buildOpenOrderLookup } = require('./broker-fetcher');
const { calculateSpreadRankPenalty, getRecentTradePenalty, getStopoutClusterBlock } = require('./rank-penalties');

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
    const setupKey = resolveCandidateSetupKey({ symbol, snapshot, options });
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
      partialFillSummary: options.partialFillSummary,
      skipTracker: options.skipTracker,
      twelveDataQuote: options.twelveDataQuotes?.[symbol] || null,
      requireMultiSourceConfirmation: options.requireMultiSourceConfirmation,
      allowContrarianEntries: options.allowContrarianEntries,
      blockBuys: options.blockBuys,
      marketOpen: options.marketOpen,
      requireMarketOpen: options.requireMarketOpen,
      intradayRegime: options.intradayRegime,
      regimeBuysAllowed: options.regimeBuysAllowed,
      sellMaxPriceDiffPct: options.sellMaxPriceDiffPct,
      assetType: 'stock',
      excludedBuySymbols: options.excludedBuySymbols,
      riskBudgetSizingEnabled: options.riskBudgetSizingEnabled,
      maxRiskPerTradeDollars: options.maxRiskPerTradeDollars,
      maxRiskPerTradePctEquity: options.maxRiskPerTradePctEquity,
      maxTradeNotional: options.maxTradeNotional,
      minStopDistanceDollars: options.minStopDistanceDollars,
      maxStopDistanceDollars: options.maxStopDistanceDollars,
      allowRiskBudgetFractionalShares: options.allowRiskBudgetFractionalShares,
      riskBudgetRequireBrokerEquity: options.riskBudgetRequireBrokerEquity,
      recentTradePenalty: getRecentTradePenalty(options.recentTradePenalties || options.antiChurnPenalties || options.antiChurnState?.symbol_cooldowns, symbol),
      setupPenalty: setupKey ? getRecentTradePenalty(options.setupPenalties || options.antiChurnState?.setup_cooldowns, setupKey) : null,
      setupKey,
      antiChurnState: options.antiChurnState || null,
      antiChurnSummary: options.antiChurnSummary || null,
      antiChurnEnabled: options.antiChurnEnabled,
      antiChurnRecentWinnerProtectionEnabled: options.antiChurnRecentWinnerProtectionEnabled,
      antiChurnTinyExitDollars: options.antiChurnTinyExitDollars,
      antiChurnRapidRoundTripSeconds: options.antiChurnRapidRoundTripSeconds,
      setupFatigueState: options.setupFatigueState,
      setupFatigueSummary: options.setupFatigueSummary,
      setupFatigueEnabled: options.setupFatigueEnabled,
      setupFatigueThreshold: options.setupFatigueThreshold,
      sessionGuards: options.sessionGuards,
      executionQualityState: options.executionQualityState,
      executionQualitySummary: options.executionQualitySummary,
      executionQualityFeedbackEnabled: options.executionQualityFeedbackEnabled,
      executionQualityRankPenaltyEnabled: options.executionQualityRankPenaltyEnabled,
      executionQualitySizeMultiplierEnabled: options.executionQualitySizeMultiplierEnabled,
      executionQualityCooldownEnabled: options.executionQualityCooldownEnabled,
      maxExecutionQualityRankPenalty: options.maxExecutionQualityRankPenalty,
      minExecutionQualitySizeMultiplier: options.minExecutionQualitySizeMultiplier,
      highSlippageThresholdPct: options.highSlippageThresholdPct,
      badFillThresholdPct: options.badFillThresholdPct,
      candidateLifecycleEnabled: options.candidateLifecycleEnabled,
      candidateLifecycleState: options.candidateLifecycleState,
      candidateMinScansBeforeEntry: options.candidateMinScansBeforeEntry,
      candidateMinSecondsBeforeEntry: options.candidateMinSecondsBeforeEntry,
      candidateMaxAgeSeconds: options.candidateMaxAgeSeconds,
      candidateConfirmationRequired: options.candidateConfirmationRequired,
      candidateQueueMaxSize: options.candidateQueueMaxSize,
      rankConfidenceDecayEnabled: options.rankConfidenceDecayEnabled,
      rankConfidenceHalfLifeSeconds: options.rankConfidenceHalfLifeSeconds,
      rankConfidenceMaxStaleSeconds: options.rankConfidenceMaxStaleSeconds,
      huntToMonitorLatchEnabled: options.huntToMonitorLatchEnabled,
      monitorModeAllowsNewBuys: options.monitorModeAllowsNewBuys,
      manageOnlyBlocksBuys: options.manageOnlyBlocksBuys,
      scannerMode: options.scannerMode,
      rotationSoftBandPoints: options.rotationSoftBandPoints,
      rotationHardBandPoints: options.rotationHardBandPoints,
      rotationMinHoldScans: options.rotationMinHoldScans,
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
  let candidateLifecycleResult = null;
  let selectedBuyEntries = buyEntries;
  if (options.candidateLifecycleEnabled) {
    candidateLifecycleResult = reconcileCandidateLifecycleState({
      previousState: options.candidateLifecycleState || {},
      candidates: buyEntries,
      now,
      queueEnabled: options.candidateLifecycleEnabled,
      minScansBeforeEntry: options.candidateMinScansBeforeEntry,
      minSecondsBeforeEntry: options.candidateMinSecondsBeforeEntry,
      maxAgeSeconds: options.candidateMaxAgeSeconds,
      confirmationRequired: options.candidateConfirmationRequired,
      queueMaxSize: options.candidateQueueMaxSize,
      rankFloor: options.minAdjustedRankScore,
      decayEnabled: options.rankConfidenceDecayEnabled,
      halfLifeSeconds: options.rankConfidenceHalfLifeSeconds,
      maxStaleSeconds: options.rankConfidenceMaxStaleSeconds,
      huntToMonitorLatchEnabled: options.huntToMonitorLatchEnabled,
      monitorModeAllowsNewBuys: options.monitorModeAllowsNewBuys,
      manageOnlyBlocksBuys: options.manageOnlyBlocksBuys,
      scannerMode: options.scannerMode,
      sessionGuards: options.sessionGuards,
      portfolio: options.portfolio,
      openOrders: options.openOrders,
      softBandPoints: options.rotationSoftBandPoints,
      hardBandPoints: options.rotationHardBandPoints,
      minHoldScans: options.rotationMinHoldScans,
    });
    const selectedKey = candidateLifecycleResult.selection?.selected_key || candidateLifecycleResult.state?.selected_key || null;
    if (selectedKey) {
      selectedBuyEntries = buyEntries.filter((candidate) => resolveCandidateLifecycleKey(candidate) === selectedKey);
    }
    if (!selectedBuyEntries.length) {
      selectedBuyEntries = buyEntries.filter((candidate) => {
        const lifecycleEntry = candidateLifecycleResult.state?.candidates?.[resolveCandidateLifecycleKey(candidate)];
        return lifecycleEntry?.status === 'eligible' || lifecycleEntry?.status === 'entered';
      });
    }
    if (!selectedBuyEntries.length) {
      selectedBuyEntries = [];
    }
    const lifecycleMap = candidateLifecycleResult.state?.candidates || {};
    for (const candidate of buyEntries) {
      const lifecycleEntry = lifecycleMap[resolveCandidateLifecycleKey(candidate)] || null;
      if (!candidate.payload?.market_context?.scanner) continue;
      candidate.candidateLifecycle = lifecycleEntry;
      candidate.payload.market_context.scanner.candidate_lifecycle_status = lifecycleEntry?.status || candidate.payload.market_context.scanner.candidate_lifecycle_status || 'watching';
      candidate.payload.market_context.scanner.candidate_lifecycle_reason_codes = lifecycleEntry?.reason_codes || candidate.payload.market_context.scanner.candidate_lifecycle_reason_codes || [];
      candidate.payload.market_context.scanner.candidate_lifecycle_decayed_rank = roundScore(lifecycleEntry?.decayed_rank ?? candidate.rankScore);
      candidate.payload.market_context.scanner.candidate_lifecycle_selected = Boolean(lifecycleEntry?.status === 'entered');
    }
  }
  const limitedBuys = selectedBuyEntries.slice(0, Math.max(0, options.maxBuyCandidates ?? options.maxCandidatesPerRun ?? 2));
  return {
    candidates: [
      ...sellEntries,
      ...limitedBuys,
    ],
    candidateLifecycleResult,
  };
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
  const pendingPartialBuy = findPendingPartialForSymbol(options.partialFillSummary, symbol, 'buy');
  if (pendingPartialBuy) {
    return skip('PARTIAL_FILL_PENDING', {
      order_id: pendingPartialBuy.order_id,
      side: pendingPartialBuy.side,
      filled_qty: pendingPartialBuy.filled_qty,
      remaining_qty: pendingPartialBuy.remaining_qty,
      last_reconciled_at: pendingPartialBuy.last_reconciled_at,
      recommended_action: pendingPartialBuy.recommended_action,
    });
  }
  const nowMs = new Date(options.receivedAt || nowIso()).getTime();
  const antiChurnState = options.antiChurnState || null;
  const setupFatigue = evaluateSetupFatigueCandidate({
    setupFatigueState: options.setupFatigueState,
    setupKey: options.setupKey,
    now: options.receivedAt || nowIso(),
  });
  if (setupFatigue?.active) {
    return skip(SetupFatigueReason.SETUP_FATIGUE_ACTIVE, {
      setup_key: setupFatigue.setup_key,
      fatigue_score: setupFatigue.fatigue_score,
      paused_until: setupFatigue.paused_until,
      reason_codes: setupFatigue.reason_codes || [],
      explanation: setupFatigue.explanation || null,
    });
  }
  if (options.sessionGuards?.buy_blocked) {
    return skip(options.sessionGuards.reason_codes?.[0] || 'MANAGE_ONLY_MODE_ACTIVE', {
      reason_codes: options.sessionGuards.reason_codes || [],
      explanation: options.sessionGuards.explanation || null,
      expires_at: options.sessionGuards.expires_at || null,
    });
  }
  const symbolCooldown = getRecentTradePenalty(antiChurnState?.symbol_cooldowns || null, symbol);
  const setupCooldown = options.setupKey ? getRecentTradePenalty(antiChurnState?.setup_cooldowns || null, options.setupKey) : null;
  if (antiChurnState?.churn_guard?.active) {
    return skip('CHURN_RATE_GUARD_ACTIVE', {
      churn_score: antiChurnState.churn_guard?.churn_score || null,
      trade_count: antiChurnState.churn_guard?.trade_count || null,
      expires_at: antiChurnState.churn_guard?.expires_at || null,
      reason_codes: antiChurnState.churn_guard?.reason_codes || [],
    });
  }
  if (isActiveCooldownEntry(symbolCooldown, nowMs)) {
    return skip('ANTI_CHURN_COOLDOWN_ACTIVE', {
      symbol,
      penalty: safeNumber(symbolCooldown?.penalty, 0),
      cooldown_until: symbolCooldown?.cooldown_until || null,
      remaining_seconds: safeNumber(symbolCooldown?.remaining_seconds, 0),
      reason_codes: symbolCooldown?.reason_codes || [],
    });
  }
  if (isActiveCooldownEntry(setupCooldown, nowMs)) {
    return skip('SETUP_COOLDOWN_ACTIVE', {
      setup_key: options.setupKey,
      penalty: safeNumber(setupCooldown?.penalty, 0),
      cooldown_until: setupCooldown?.cooldown_until || null,
      remaining_seconds: safeNumber(setupCooldown?.remaining_seconds, 0),
      reason_codes: setupCooldown?.reason_codes || [],
    });
  }
  if (options.blockBuys) return skip('BUY_SIDE_BLOCKED');
  if (options.requireMarketOpen && options.marketOpen === false) return skip('MARKET_CLOSED_FOR_STOCKS');
  if (options.regimeBuysAllowed === false) return skip(options.intradayRegime?.reason_code || 'INTRADAY_REGIME_BUY_BLOCK', { regime: options.intradayRegime?.regime || null });
  if (options.allocation && options.allocation.accepted === false) {
    return skip(options.allocation.reason || 'ALLOCATION_BLOCKED');
  }
  if (options.portfolio?.remaining_position_slots !== null && options.portfolio?.remaining_position_slots <= 0) {
    return skip('MAX_POSITION_SLOTS_FILLED');
  }
  if (Array.isArray(options.excludedBuySymbols) && options.excludedBuySymbols.includes(symbol)) {
    return skip('SYMBOL_EXCLUDED_FROM_BUYS');
  }

  return buildBuyCandidate({ symbol, snapshot, latestQuote, currentPrice, previousClose, spreadPct, options });
}

function findPendingPartialForSymbol(summary = {}, symbol, side) {
  const list = side === 'sell' ? summary?.partial_sells : summary?.partial_buys;
  return (Array.isArray(list) ? list : []).find((order) => (
    String(order.symbol || '').toUpperCase() === String(symbol || '').toUpperCase()
    && String(order.side || '').toLowerCase() === String(side || '').toLowerCase()
  )) || null;
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

function resolveExecutionQualityEntry(summary, symbol, setupKey = null, side = 'buy', timeRegime = null) {
  if (!summary) return null;
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) return null;
  const normalizedSetup = String(setupKey || '').trim().toLowerCase();
  const normalizedSide = String(side || 'buy').trim().toLowerCase() || 'buy';
  const normalizedRegime = String(timeRegime || '').trim().toLowerCase();
  const candidates = [];
  const bySymbol = Array.isArray(summary.by_symbol) ? summary.by_symbol : [];
  const bySetup = Array.isArray(summary.by_setup) ? summary.by_setup : [];
  const stateEntries = Array.isArray(summary.entries) ? summary.entries : [];

  for (const entry of [...bySymbol, ...bySetup, ...stateEntries]) {
    if (!entry) continue;
    const key = normalizeExecutionQualityKey(entry.symbol || normalizedSymbol, entry.setup_key || normalizedSetup, entry.side || normalizedSide, entry.time_regime || normalizedRegime);
    const targetKey = normalizeExecutionQualityKey(normalizedSymbol, normalizedSetup || entry.setup_key || null, normalizedSide, normalizedRegime || entry.time_regime || null);
    if (key === targetKey) candidates.push(entry);
    if (String(entry.symbol || '').trim().toUpperCase() === normalizedSymbol && (!normalizedSetup || String(entry.setup_key || '').trim().toLowerCase() === normalizedSetup)) {
      candidates.push(entry);
    }
  }

  const best = candidates
    .filter(Boolean)
    .sort((a, b) => safeNumber(b.effective_penalty_points ?? b.penalty_points ?? 0, 0) - safeNumber(a.effective_penalty_points ?? a.penalty_points ?? 0, 0))[0] || null;
  return best;
}

function getExecutionQualityCooldown(entry, now = nowIso()) {
  if (!entry) return null;
  const recent = Array.isArray(entry.recent_records) ? entry.recent_records[0] : null;
  const recommendation = recent?.cooldown_recommendation || entry.cooldown_recommendation || null;
  const minutes = Math.max(0, safeNumber(recommendation?.minutes, 0));
  if (minutes <= 0) return { active: false, remaining_seconds: 0, expires_at: null, reason_codes: [] };
  const startedAt = recent?.timestamp || entry.last_bad_execution_at || entry.updated_at || now;
  const startedAtMs = new Date(startedAt).getTime();
  const expiresAtMs = Number.isFinite(startedAtMs) ? startedAtMs + (minutes * 60_000) : null;
  const remainingSeconds = Number.isFinite(expiresAtMs) ? Math.max(0, Math.round((expiresAtMs - new Date(now).getTime()) / 1000)) : 0;
  return {
    active: remainingSeconds > 0,
    reason: recommendation?.reason || entry.last_classification || 'execution_quality',
    reason_codes: ['EXECUTION_QUALITY_COOLDOWN_ACTIVE', `EXECUTION_QUALITY_${String(recommendation?.reason || entry.last_classification || 'EXECUTION_QUALITY').toUpperCase()}`],
    remaining_seconds: remainingSeconds,
    expires_at: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
    cooldown_minutes: minutes,
  };
}

function resolveCandidateLifecycleKey(candidate = {}) {
  const symbol = String(candidate.symbol || '').trim().toUpperCase();
  const setupKey = String(candidate.setupKey || candidate.setup_key || candidate.payload?.market_context?.setup_key || '').trim().toLowerCase();
  return normalizeCandidateKey(symbol, setupKey || null);
}

function resolveCandidateLifecycleEntry(lifecycleState, symbol, setupKey = null) {
  if (!lifecycleState?.candidates) return null;
  const key = normalizeCandidateKey(symbol, setupKey || null);
  return key ? lifecycleState.candidates[key] || null : null;
}

function isActiveCooldownEntry(entry, nowMs = Date.now()) {
  if (!entry) return false;
  const remainingSeconds = safeNumber(entry.remaining_seconds, 0);
  if (remainingSeconds > 0) return true;
  const cooldownUntil = entry.cooldown_until || entry.expires_at || null;
  if (!cooldownUntil) return false;
  const expiresAtMs = new Date(cooldownUntil).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

function resolveCandidateSetupKey({ symbol, snapshot, options = {} } = {}) {
  const resolver = options.setupKeyResolver;
  if (typeof resolver === 'function') {
    const resolved = resolver({ symbol, snapshot, options });
    if (resolved) return String(resolved).trim().toLowerCase() || null;
  }
  const setupKey = options.setupKey
    || snapshot.setup_key
    || snapshot.setupKey
    || snapshot.market_context?.setup_key
    || snapshot.marketContext?.setup_key
    || snapshot.latestTrade?.setup_key
    || snapshot.latestTrade?.setupKey
    || null;
  const normalized = String(setupKey || '').trim().toLowerCase();
  return normalized || null;
}

function determineScannerMode({
  sessionGuards = null,
  portfolio = null,
  openOrders = null,
  huntToMonitorLatchEnabled = false,
  manageOnlyBlocksBuys = true,
} = {}) {
  if (!huntToMonitorLatchEnabled) return 'hunt';
  if ((sessionGuards?.manage_only || sessionGuards?.buy_blocked) && manageOnlyBlocksBuys) {
    return 'manage_only';
  }
  const hasOpenPositions = Number(safeNumber(portfolio?.open_positions_count, 0)) > 0;
  const hasOpenBuyOrders = Number(safeNumber(portfolio?.open_buy_order_count, 0)) > 0;
  const hasPartialBuys = Number(safeNumber(portfolio?.partial_buy_order_count, 0)) > 0;
  const hasProtectiveOrders = Array.isArray(openOrders) && openOrders.some((order) => String(order?.side || '').toLowerCase() === 'sell');
  if (hasOpenPositions || hasOpenBuyOrders || hasPartialBuys || hasProtectiveOrders) {
    return 'monitor';
  }
  return 'hunt';
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
    setupFatigue: null,
    sessionGuards: options.sessionGuards || null,
    exitState,
  });
}

function buildBuyCandidate({ symbol, snapshot, latestQuote, currentPrice, previousClose, spreadPct, options }) {
  const movePct = ((currentPrice - previousClose) / previousClose) * 100;
  const notional = safeNumber(options.notional, 150);
  const minBuyNotional = Math.max(1, safeNumber(options.minBuyNotional ?? options.allocation?.floor ?? 25, 25));
  if (!Number.isFinite(notional) || notional <= 0) {
    options.skipTracker?.record?.('BELOW_MINIMUM_BUY_NOTIONAL', { symbol, notional });
    return null;
  }
  const volumeScore = Math.log10(Math.max(10, safeNumber(snapshot.prevDailyBar?.v ?? snapshot.dailyBar?.v ?? 0, 0)));
  const baseRankScore = Math.abs(movePct) * 10 + volumeScore - (spreadPct * 3);
  const recentPenalty = options.recentTradePenalty || null;
  const setupPenalty = options.setupPenalty || null;
  const setupFatigue = evaluateSetupFatigueCandidate({
    setupFatigueState: options.setupFatigueState,
    setupKey: options.setupKey,
    now: options.receivedAt || nowIso(),
  });
  const stopoutCluster = getStopoutClusterBlock(recentPenalty, {
    blockMinutes: options.stopoutClusterBlockMinutes,
    blockCount: options.stopoutClusterBlockCount,
  });
  if (stopoutCluster.blocked) {
    options.skipTracker?.record?.('RECENT_STOPOUT_CLUSTER', {
      symbol,
      stop_exit_count: stopoutCluster.stop_exit_count,
      required_count: stopoutCluster.required_count,
      remaining_seconds: stopoutCluster.remaining_seconds,
      expires_at: stopoutCluster.expires_at,
    });
    return null;
  }
  const recentTradeRankPenalty = Math.max(0, safeNumber(recentPenalty?.penalty, 0));
  const setupRankPenalty = Math.max(0, safeNumber(setupPenalty?.penalty, 0));
  const executionQualityEntry = resolveExecutionQualityEntry(options.executionQualitySummary, symbol, options.setupKey, 'buy');
  const executionQualityPenalty = options.executionQualityRankPenaltyEnabled
    ? Math.min(
      Math.max(0, safeNumber(options.maxExecutionQualityRankPenalty, 40)),
      Math.max(0, safeNumber(executionQualityEntry?.effective_penalty_points ?? executionQualityEntry?.penalty_points ?? executionQualityEntry?.average_penalty_points ?? 0, 0)),
    )
    : 0;
  const executionQualitySizeMultiplier = options.executionQualitySizeMultiplierEnabled
    ? Math.max(
      Math.max(0.5, safeNumber(options.minExecutionQualitySizeMultiplier, 0.5)),
      Math.min(1, safeNumber(executionQualityEntry?.effective_size_multiplier ?? executionQualityEntry?.size_multiplier ?? 1, 1)),
    )
    : 1;
  const executionQualityCooldown = options.executionQualityCooldownEnabled
    ? getExecutionQualityCooldown(executionQualityEntry, options.receivedAt || nowIso())
    : null;
  if (executionQualityCooldown?.active) {
    options.skipTracker?.record?.('EXECUTION_QUALITY_COOLDOWN_ACTIVE', {
      symbol,
      setup_key: options.setupKey || null,
      execution_quality: executionQualityEntry || null,
      cooldown_until: executionQualityCooldown.expires_at || null,
      remaining_seconds: executionQualityCooldown.remaining_seconds || 0,
      reason_codes: executionQualityCooldown.reason_codes || [],
    });
    return null;
  }
  const spreadRankPenalty = calculateSpreadRankPenalty(spreadPct, {
    thresholdPct: options.spreadRankPenaltyThresholdPct,
    penaltyPerPct: options.spreadRankPenaltyPerPct,
    cap: options.spreadRankPenaltyCap,
  });
  const totalRankPenalty = recentTradeRankPenalty + setupRankPenalty + spreadRankPenalty + executionQualityPenalty;
  const rankScore = baseRankScore - totalRankPenalty;
  const minAdjustedRankScore = safeNumber(options.minAdjustedRankScore, Number.NEGATIVE_INFINITY);
  if (rankScore < minAdjustedRankScore) {
    options.skipTracker?.record?.('ADJUSTED_RANK_BELOW_FLOOR', {
      symbol,
      base_rank_score: roundScore(baseRankScore),
      recent_trade_rank_penalty: roundScore(recentTradeRankPenalty),
      setup_rank_penalty: roundScore(setupRankPenalty),
      execution_quality_rank_penalty: roundScore(executionQualityPenalty),
      spread_rank_penalty: roundScore(spreadRankPenalty),
      total_rank_penalty: roundScore(totalRankPenalty),
      adjusted_rank_score: roundScore(rankScore),
      min_adjusted_rank_score: roundScore(minAdjustedRankScore),
    });
    return null;
  }
  let candidateQuantity = null;
  let candidateNotional = notional;
  let candidateSupportsFractionalShares = true;
  let stopLossOverride = null;
  let takeProfitOverride = null;
  let riskBudgetSizing = null;
  let structureStop = null;
  let sizingMethod = 'fixed_notional';
  if (options.riskBudgetSizingEnabled) {
    structureStop = calculateStructureAwareStop({
      symbol,
      side: 'buy',
      price: currentPrice,
      marketData: {
        ...snapshot,
        spread_pct: spreadPct,
        minute_low: snapshot.minuteBar?.l,
        minute_high: snapshot.minuteBar?.h,
        low_price: snapshot.minuteBar?.l ?? snapshot.dailyBar?.l ?? null,
        high_price: snapshot.minuteBar?.h ?? snapshot.dailyBar?.h ?? null,
      },
      fixedStopDollars: options.stopLossDollars,
      spreadPct,
      minStopDistanceDollars: options.minStopDistanceDollars,
      maxStopDistanceDollars: options.maxStopDistanceDollars > 0 ? options.maxStopDistanceDollars : null,
    });
    if (!structureStop.accepted) {
      options.skipTracker?.record?.(structureStop.reason_codes?.[0] || 'STRUCTURE_STOP_UNAVAILABLE', {
        symbol,
        structure_stop: structureStop,
      });
      return null;
    }
    const accountEquity = safeNumber(options.portfolio?.account_equity ?? options.portfolio?.equity ?? options.portfolio?.portfolio_value ?? options.portfolio?.account?.equity ?? null, null);
    const buyingPower = safeNumber(options.portfolio?.buying_power ?? options.portfolio?.buyingPower ?? options.portfolio?.account?.buying_power ?? null, null);
    const cash = safeNumber(options.portfolio?.cash ?? options.portfolio?.account?.cash ?? null, null);
    const maxNotional = safeNumber(options.maxTradeNotional, 0) > 0 ? options.maxTradeNotional : notional;
    riskBudgetSizing = calculateRiskBudgetSize({
      symbol,
      side: 'buy',
      price: currentPrice,
      stopPrice: structureStop.stop_price,
      stopDistance: structureStop.stop_distance,
      maxRiskDollars: options.maxRiskPerTradeDollars,
      maxRiskPctEquity: options.maxRiskPerTradePctEquity,
      accountEquity,
      buyingPower,
      cash,
      maxNotional,
      minNotional: options.allocation?.floor ?? 0,
      minStopDistanceDollars: options.minStopDistanceDollars,
      maxStopDistanceDollars: options.maxStopDistanceDollars > 0 ? options.maxStopDistanceDollars : null,
      allowFractionalShares: options.allowRiskBudgetFractionalShares,
      requireBrokerEquity: options.riskBudgetRequireBrokerEquity,
    });
    if (!riskBudgetSizing.accepted) {
      for (const reason of riskBudgetSizing.reason_codes || ['RISK_BUDGET_SIZING_REJECTED']) {
        options.skipTracker?.record?.(reason, {
          symbol,
          risk_budget_sizing: riskBudgetSizing,
          structure_stop: structureStop,
        });
      }
      return null;
    }
    candidateQuantity = riskBudgetSizing.quantity;
    candidateNotional = riskBudgetSizing.notional;
    candidateSupportsFractionalShares = riskBudgetSizing.allow_fractional_shares;
    stopLossOverride = structureStop.stop_price;
    takeProfitOverride = roundEquityPrice(currentPrice + Math.max(structureStop.stop_distance * 1.8, currentPrice * 0.02));
    sizingMethod = 'risk_budget';
  }
  if (options.executionQualitySizeMultiplierEnabled && executionQualitySizeMultiplier < 1) {
    candidateNotional = roundCurrency(Math.max(options.allocation?.floor ?? 0, candidateNotional * executionQualitySizeMultiplier));
    if (Number.isFinite(candidateQuantity)) {
      candidateQuantity = Number((candidateQuantity * executionQualitySizeMultiplier).toFixed(6));
    }
    if (candidateNotional < Math.max(options.allocation?.floor ?? 0, minBuyNotional)) {
      options.skipTracker?.record?.('EXECUTION_QUALITY_SIZE_REDUCTION', {
        symbol,
        execution_quality: executionQualityEntry || null,
        execution_quality_size_multiplier: executionQualitySizeMultiplier,
        reduced_notional: candidateNotional,
      });
      return null;
    }
  }
  const candidate = buildSignalCandidate({
    symbol,
    side: 'buy',
    currentPrice,
    previousClose,
    spreadPct,
    snapshot,
    latestQuote,
    options,
    quantity: candidateQuantity,
    notional: candidateNotional,
    supportsFractionalShares: candidateSupportsFractionalShares,
    stopLossOverride,
    takeProfitOverride,
    sizingMethod,
    riskBudgetSizing,
    structureStop,
    rankScore,
    baseRankScore,
    recentTradeRankPenalty,
    setupRankPenalty,
    executionQualityPenalty,
    executionQualityEntry,
    executionQualitySizeMultiplier,
    spreadRankPenalty,
    totalRankPenalty,
    recentTradePenalty: recentPenalty,
    setupPenalty,
    setupFatigue,
    sessionGuards: options.sessionGuards || null,
    setupKey: options.setupKey || null,
  });
  const maxBuyRiskScore = safeNumber(options.maxBuyRiskScore, 70);
  const candidateRiskScore = safeNumber(candidate?.payload?.risk_score, null);
  if (Number.isFinite(candidateRiskScore) && Number.isFinite(maxBuyRiskScore) && candidateRiskScore > maxBuyRiskScore) {
    options.skipTracker?.record?.('BUY_RISK_SCORE_ABOVE_SCANNER_LIMIT', {
      symbol,
      risk_score: roundScore(candidateRiskScore),
      max_buy_risk_score: roundScore(maxBuyRiskScore),
      spread_pct: roundScore(spreadPct),
      move_pct: roundScore(movePct),
      adjusted_rank_score: roundScore(rankScore),
    });
    return null;
  }
  return candidate;
}

function buildSignalCandidate({ symbol, side, currentPrice, previousClose, spreadPct, snapshot, latestQuote, options, quantity, notional, supportsFractionalShares = true, stopLossOverride = null, takeProfitOverride = null, sizingMethod = 'fixed_notional', riskBudgetSizing = null, structureStop = null, rankScore = 0, baseRankScore = rankScore, recentTradeRankPenalty = 0, setupRankPenalty = 0, executionQualityPenalty = 0, executionQualityEntry = null, executionQualitySizeMultiplier = 1, spreadRankPenalty = 0, totalRankPenalty = recentTradeRankPenalty + setupRankPenalty + spreadRankPenalty, recentTradePenalty = null, setupPenalty = null, setupFatigue = null, sessionGuards = null, exitState = null, setupKey = null }) {
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
  const candidateLifecycleEntry = side === 'buy'
    ? resolveCandidateLifecycleEntry(options.candidateLifecycleState, symbol, setupKey)
    : null;
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
      setup_key: setupKey || null,
      move_pct: Number(movePct.toFixed(4)),
      spread_pct: Number(spreadPct.toFixed(4)),
      current_price: Number(currentPrice.toFixed(6)),
      previous_close: Number(previousClose.toFixed(6)),
      rank_score: side === 'buy' ? roundScore(rankScore) : null,
      base_rank_score: side === 'buy' ? roundScore(baseRankScore) : null,
      recent_trade_rank_penalty: side === 'buy' ? roundScore(recentTradeRankPenalty) : 0,
      setup_rank_penalty: side === 'buy' ? roundScore(setupRankPenalty) : 0,
      execution_quality_rank_penalty: side === 'buy' ? roundScore(safeNumber(executionQualityPenalty, 0)) : 0,
      spread_rank_penalty: side === 'buy' ? roundScore(spreadRankPenalty) : 0,
      total_rank_penalty: side === 'buy' ? roundScore(totalRankPenalty) : 0,
      adjusted_rank_score: side === 'buy' ? roundScore(rankScore) : null,
      min_adjusted_rank_score: side === 'buy' ? roundScore(safeNumber(options.minAdjustedRankScore, Number.NEGATIVE_INFINITY)) : null,
      recent_trade_at: side === 'buy' ? recentTradePenalty?.last_traded_at || null : null,
      recent_trade_penalty_reason: side === 'buy' ? recentTradePenalty?.reason || null : null,
      execution_quality_penalty_reason: side === 'buy' ? executionQualityEntry?.last_classification || executionQualityEntry?.classification || null : null,
      execution_quality_size_multiplier: side === 'buy' ? roundScore(safeNumber(executionQualitySizeMultiplier, 1)) : null,
      execution_quality_penalty_points: side === 'buy' ? roundScore(safeNumber(executionQualityEntry?.effective_penalty_points ?? executionQualityEntry?.penalty_points ?? 0, 0)) : null,
      setup_trade_at: side === 'buy' ? setupPenalty?.last_traded_at || null : null,
      setup_trade_penalty_reason: side === 'buy' ? setupPenalty?.reason || null : null,
      anti_churn_recent_winner_protected: side === 'buy' ? Boolean(recentTradePenalty?.recent_winner_protected || setupPenalty?.recent_winner_protected) : false,
      setup_fatigue_score: side === 'buy' ? roundScore(setupFatigue?.fatigue_score || 0) : null,
      setup_fatigue_active: side === 'buy' ? Boolean(setupFatigue?.active) : false,
      setup_fatigue_paused_until: side === 'buy' ? setupFatigue?.paused_until || null : null,
      setup_fatigue_reason_codes: side === 'buy' ? setupFatigue?.reason_codes || [] : [],
      session_guard_blocked: side === 'buy' ? Boolean(sessionGuards?.buy_blocked) : false,
      candidate_lifecycle_status: side === 'buy' ? candidateLifecycleEntry?.status || (options.candidateLifecycleEnabled ? 'watching' : null) : null,
      candidate_lifecycle_reason_codes: side === 'buy' ? candidateLifecycleEntry?.reason_codes || [] : [],
      candidate_lifecycle_decayed_rank: side === 'buy' ? roundScore(candidateLifecycleEntry?.decayed_rank ?? rankScore) : null,
      candidate_lifecycle_selected: side === 'buy' ? Boolean(candidateLifecycleEntry?.status === 'entered') : false,
      sizing_method: side === 'buy' ? sizingMethod : null,
      risk_budget_sizing: side === 'buy' ? riskBudgetSizing : null,
      structure_stop: side === 'buy' ? structureStop : null,
      execution_quality: side === 'buy' ? executionQualityEntry || null : null,
      execution_quality_state: side === 'buy' ? options.executionQualitySummary || null : null,
      setup_fatigue: side === 'buy' ? setupFatigue : null,
      session_guards: side === 'buy' ? summarizeSessionGuards(sessionGuards) : null,
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
  const riskPerShare = side === 'buy' && estimatedQty > 0
    ? (Number.isFinite(safeNumber(stopLossOverride, null)) ? Math.abs(currentPrice - stopLossOverride) : (options.stopLossDollars ?? 1) / estimatedQty)
    : currentPrice * 0.01;
  const rewardPerShare = Math.max(riskPerShare * 1.8, currentPrice * 0.02);
  const stopLoss = Number.isFinite(safeNumber(stopLossOverride, null))
    ? stopLossOverride
    : roundEquityPrice(side === 'sell' ? currentPrice * 1.01 : Math.max(0.01, currentPrice - riskPerShare));
  const takeProfit = Number.isFinite(safeNumber(takeProfitOverride, null))
    ? takeProfitOverride
    : roundEquityPrice(side === 'sell' ? Math.max(0.01, currentPrice * 0.99) : currentPrice + rewardPerShare);
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
    supports_fractional_shares: side === 'buy' ? Boolean(supportsFractionalShares) : null,
    requested_notional: side === 'buy' ? options.allocation?.requested ?? notional : null,
    submitted_notional: side === 'buy' ? notional : null,
    min_buy_notional: side === 'buy' ? options.allocation?.floor ?? null : null,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    sizing_method: side === 'buy' ? sizingMethod : null,
    risk_budget_sizing: side === 'buy' ? riskBudgetSizing : null,
    structure_stop: side === 'buy' ? structureStop : null,
    risk_budget: side === 'buy' ? riskBudgetSizing : null,
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
    setup_fatigue: side === 'buy' ? setupFatigue : null,
    session_guards: side === 'buy' ? summarizeSessionGuards(sessionGuards) : null,
    candidate_lifecycle: side === 'buy' ? candidateLifecycleEntry || null : null,
  };
  return {
    symbol,
    setupKey: setupKey || null,
    movePct,
    spreadPct,
    rankScore,
    baseRankScore,
    recentTradeRankPenalty,
    setupRankPenalty,
    executionQualityPenalty,
    spreadRankPenalty,
    totalRankPenalty,
    recentTradePenalty,
    setupPenalty,
    setupFatigue,
    sessionGuards: options.sessionGuards || null,
    endpoint: 'paper-order',
    payload,
    exitState,
  };
}

module.exports = {
  createSkipTracker,
  buildCandidates,
  buildStockCandidateForSymbol,
  findPendingPartialForSymbol,
  isApprovedPostResult,
  summarizePostResult,
  resolveExecutionQualityEntry,
  getExecutionQualityCooldown,
  resolveCandidateLifecycleKey,
  resolveCandidateLifecycleEntry,
  isActiveCooldownEntry,
  resolveCandidateSetupKey,
  determineScannerMode,
  calculateEffectiveStopLossDollars,
  buildExitCandidate,
  buildBuyCandidate,
  buildSignalCandidate,
};
