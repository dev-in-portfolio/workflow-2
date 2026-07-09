const fs = require('fs');
const path = require('path');
const { buildProviderConfirmationFromContext, normalizeMarketData } = require('./market-data');
const { parseBool } = require('./config');
const { nowIso, safeNumber, hashObject, clamp, resolveRepoRoot } = require('./util');
const { APPROVED_LIVE_MARKET_SYMBOLS, parseSymbolList } = require('./volatile-stock-universe');
const { loadRegularWatchState, resolveRegularWatchStatePath } = require('./regular-watch/regular-watch-feature-state');
const { loadRegularWatchStatus, resolveRegularWatchStatusPath } = require('./regular-watch/regular-watch-status');
const { allocateBuyNotional, buildPortfolioSnapshot } = require('./portfolio-allocation');
const { writeScannerRuntimeState } = require('./scanner-runtime-state');
const { buildSelectionV2Score } = require('./scanner-selection-v2');
const { recordScannerDecisionCycle, recordScannerSelectionShadow } = require('./scanner-outcome-shadow');
const { loadTrailingState, saveTrailingState, updateTrailingSnapshot } = require('./position-trailing-state');
const { isRegularUsMarketHours, resolveIntradayStockRegime } = require('./market-hours');
const { assertSignalCandidate } = require('./module-contracts');
const { LIVE_STOCK_POLICY_DEFAULTS } = require('./live-stock-policy');
const {
  loadPartialFillState,
  reconcilePartialFills,
  savePartialFillState,
  summarizePartialFillState,
} = require('./partial-fill-state');
const {
  evaluateHotSlotRotationPlan,
  resolveHotSlotRotationConfig,
  summarizeHotSlotRotationRuntime,
} = require('./hot-slot-rotation');
const {
  loadExecutionQualityState,
  summarizeExecutionQualityState,
  normalizeExecutionQualityKey,
} = require('./execution-quality-state');
const {
  CandidateLifecycleReason,
  loadCandidateLifecycleState,
  reconcileCandidateLifecycleState,
  saveCandidateLifecycleState,
  summarizeCandidateLifecycleState,
  normalizeCandidateKey,
} = require('./candidate-lifecycle-state');
const {
  SetupFatigueReason,
  loadSetupFatigueState,
  reconcileSetupFatigueState,
  saveSetupFatigueState,
  normalizeSetupFatigueState,
  summarizeSetupFatigueState,
  evaluateSetupFatigueCandidate,
} = require('./setup-fatigue');
const { evaluateSessionGuards, summarizeSessionGuards } = require('./session-guards');
const { loadMemeMonitorState, resolveMemeMonitorStatePath } = require('./meme-monitor-state');
const { loadDynamicHotList, resolveDynamicHotListPath } = require('./meme-monitor/hot-list-store');
const {
  loadAntiChurnState,
  reconcileAntiChurnState,
  saveAntiChurnState,
  normalizeAntiChurnState,
  summarizeAntiChurnState,
} = require('./anti-churn-engine');
const { createLogger } = require('./logger');
const { calculateRiskBudgetSize } = require('./risk-budget-sizing');
const { calculateBuyingPowerSize } = require('./buying-power-sizing');
const { calculateStructureAwareStop } = require('./structure-stops');

const SCANNER_SYMBOL_SOURCE_ALIASES = {
  approved: 'approved',
  legacy: 'approved',
  approved_only: 'approved',
  dynamic: 'dynamic',
  dynamic_hot: 'dynamic',
  dynamic_hotlist: 'dynamic',
  dynamic_watch: 'dynamic',
  hybrid: 'hybrid',
  approved_dynamic: 'hybrid',
  dynamic_hybrid: 'hybrid',
};

const SCANNER_SOURCE_LABELS = {
  approved: 'Approved List',
  regular_watch_list: 'Regular Watch List',
  regular_watch_movers_list: 'Regular Watch Movers List',
  dynamic_hot_list: 'Dynamic Hot List',
  hot_hot_list: 'Hot Hot List',
};

function normalizeScannerSymbolSource(value = 'dynamic') {
  const normalized = String(value || '').trim().toLowerCase();
  return SCANNER_SYMBOL_SOURCE_ALIASES[normalized] || 'dynamic';
}

function uniqueNormalizedSymbols(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => normalizeWatchSymbol(value)).filter(Boolean))];
}

function uniqueSourceLabels(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => SCANNER_SOURCE_LABELS[String(value || '').trim().toLowerCase()] || String(value || '').trim()).filter(Boolean))];
}

function mapSourceLabel(key) {
  return SCANNER_SOURCE_LABELS[String(key || '').trim().toLowerCase()] || String(key || '').trim();
}

function shouldUseStricterLiveEntryDefaults(env = process.env, options = {}) {
  const tradingMode = String(options.tradingMode || env.TRADING_MODE || '').trim().toLowerCase();
  const scannerMode = String(options.scannerMode || env.SCANNER_MODE || env.SCANNER_PROFILE || '').trim().toLowerCase();
  const liveTradingEnabled = parseBool(env.LIVE_TRADING_ENABLED, false);
  return tradingMode === 'live'
    || liveTradingEnabled === true
    || scannerMode === 'live-market'
    || scannerMode === 'live';
}

function createStockScanner(options = {}) {
  const env = options.env || process.env;
  const scannerConfig = options.scannerConfig || {};
  const marketFetch = options.marketFetch || options.fetch || globalThis.fetch;
  const localFetch = options.localFetch || globalThis.fetch;
  if (!marketFetch) throw new Error('Stock scanner requires fetch support');
  if (!localFetch) throw new Error('Stock scanner requires local fetch support');
  options.logger = options.logger || createLogger();
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const dataDir = options.dataDir || path.resolve(repoRoot, 'data');
  const memeMonitorStatePath = resolveMemeMonitorStatePath({ dataDir, filePath: options.memeMonitorStatePath, repoRoot });
  const dynamicHotListPath = resolveDynamicHotListPath({ dataDir, filePath: options.dynamicHotListPath, repoRoot });
  const stricterLiveEntryDefaults = shouldUseStricterLiveEntryDefaults(env, options);

  const apiKeyId = options.apiKeyId || env.ALPACA_API_KEY_ID || '';
  const apiSecretKey = options.apiSecretKey || env.ALPACA_API_SECRET_KEY || '';
  const baseUrl = trimTrailingSlash(options.baseUrl || env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets');
  const twelveDataApiKey = options.twelveDataApiKey || env.TWELVE_DATA_API_KEY || env.TWELVEDATA_API_KEY || '';
  const twelveDataBaseUrl = trimTrailingSlash(options.twelveDataBaseUrl || env.TWELVE_DATA_BASE_URL || 'https://api.twelvedata.com');
  const localBaseUrl = trimTrailingSlash(options.localBaseUrl || options.local_url || '');
  const enabled = options.enabled !== false;
  const approvedSymbols = options.symbols
    ? parseSymbolList(options.symbols, [])
    : parseSymbolList(env.STOCK_SCANNER_SYMBOLS, []);
  const scannerSymbolSource = normalizeScannerSymbolSource(options.scannerSymbolSource
    ?? scannerConfig.scannerSymbolSource
    ?? (Object.prototype.hasOwnProperty.call(env, 'SCANNER_SYMBOL_SOURCE') ? env.SCANNER_SYMBOL_SOURCE : 'approved'));
  const excludedBuySymbols = parseSymbolList(options.excludedBuySymbols ?? env.STOCK_SCANNER_EXCLUDED_BUY_SYMBOLS, []);
  const intervalMs = Math.max(5_000, Number(options.intervalMs ?? Number(env.STOCK_SCANNER_INTERVAL_SECONDS || 10) * 1000) || 10_000);
  const maxCandidatesPerRun = Math.max(1, Number(options.maxCandidatesPerRun ?? env.STOCK_SCANNER_MAX_CANDIDATES ?? 2) || 2);
  const notional = Math.max(1, Number(options.notional ?? env.BUY_NOTIONAL_TARGET ?? 150) || 150);
  const minBuyNotional = Math.max(1, Number(options.minBuyNotional ?? env.MIN_BUY_NOTIONAL ?? 25) || 25);
  const maxOpenPositions = Math.max(1, Number(options.maxOpenPositions ?? env.MAX_OPEN_POSITIONS ?? 2) || 2);
  const maxStalenessSeconds = Math.max(1, safeNumber(options.maxStalenessSeconds ?? env.MAX_STALENESS_SECONDS ?? 60, 60));
  const stopLossDollars = Math.max(0.01, Number(options.stopLossDollars ?? env.POSITION_STOP_LOSS_DOLLARS ?? 1) || 1);
  const stopLossNotionalPct = Math.max(0, safeNumber(options.stopLossNotionalPct ?? env.POSITION_STOP_LOSS_NOTIONAL_PCT, 0.75));
  const stopLossMaxDollars = Math.max(stopLossDollars, safeNumber(options.stopLossMaxDollars ?? env.POSITION_STOP_LOSS_MAX_DOLLARS, 2.5));
  const trailingProfitStartDollars = Math.max(0.01, Number(options.trailingProfitStartDollars ?? env.TRAILING_PROFIT_START_DOLLARS ?? LIVE_STOCK_POLICY_DEFAULTS.trailingProfitStartDollars) || LIVE_STOCK_POLICY_DEFAULTS.trailingProfitStartDollars);
  const trailingProfitGivebackDollars = Math.max(0.01, Number(options.trailingProfitGivebackDollars ?? env.TRAILING_PROFIT_GIVEBACK_DOLLARS ?? LIVE_STOCK_POLICY_DEFAULTS.trailingProfitGivebackDollars) || LIVE_STOCK_POLICY_DEFAULTS.trailingProfitGivebackDollars);
  const stalePositionExitEnabled = options.stalePositionExitEnabled ?? parseBool(env.STOCK_SCANNER_STALE_POSITION_EXIT_ENABLED, LIVE_STOCK_POLICY_DEFAULTS.stalePositionExitEnabled);
  const stalePositionMaxHoldMinutes = Math.max(1, safeNumber(options.stalePositionMaxHoldMinutes ?? env.STOCK_SCANNER_STALE_POSITION_MAX_HOLD_MINUTES, LIVE_STOCK_POLICY_DEFAULTS.stalePositionMaxHoldMinutes));
  const stalePositionMinPeakProfitDollars = Math.max(0, safeNumber(options.stalePositionMinPeakProfitDollars ?? env.STOCK_SCANNER_STALE_POSITION_MIN_PEAK_PROFIT_DOLLARS, LIVE_STOCK_POLICY_DEFAULTS.stalePositionMinPeakProfitDollars));
  const stalePositionMaxExitPnlDollars = safeNumber(options.stalePositionMaxExitPnlDollars ?? env.STOCK_SCANNER_STALE_POSITION_MAX_EXIT_PNL_DOLLARS, LIVE_STOCK_POLICY_DEFAULTS.stalePositionMaxExitPnlDollars);
  const stalledWinnerExitEnabled = options.stalledWinnerExitEnabled ?? parseBool(env.STOCK_SCANNER_STALLED_WINNER_EXIT_ENABLED, LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerExitEnabled);
  const stalledWinnerMaxHoldMinutes = Math.max(1, safeNumber(options.stalledWinnerMaxHoldMinutes ?? env.STOCK_SCANNER_STALLED_WINNER_MAX_HOLD_MINUTES, LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMaxHoldMinutes));
  const stalledWinnerMaxMinutesSincePeak = Math.max(1, safeNumber(options.stalledWinnerMaxMinutesSincePeak ?? env.STOCK_SCANNER_STALLED_WINNER_MAX_MINUTES_SINCE_PEAK, LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMaxMinutesSincePeak));
  const stalledWinnerMinProfitDollars = Math.max(0, safeNumber(options.stalledWinnerMinProfitDollars ?? env.STOCK_SCANNER_STALLED_WINNER_MIN_PROFIT_DOLLARS, LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMinProfitDollars));
  const sellNetProfitFloorDollars = Math.max(0, safeNumber(options.sellNetProfitFloorDollars ?? env.SELL_NET_PROFIT_FLOOR_DOLLARS, LIVE_STOCK_POLICY_DEFAULTS.sellNetProfitFloorDollars));
  const requireMultiSourceConfirmation = options.requireMultiSourceConfirmation ?? Boolean(twelveDataApiKey);
  const singleSourceMomentumEnabled = options.singleSourceMomentumEnabled ?? parseBool(env.STOCK_SCANNER_SINGLE_SOURCE_MOMENTUM_ENABLED, false);
  const singleSourceMomentumMinRankScore = Math.max(0, safeNumber(options.singleSourceMomentumMinRankScore ?? env.STOCK_SCANNER_SINGLE_SOURCE_MOMENTUM_MIN_RANK_SCORE, 500));
  const minMovePct = Math.max(0, safeNumber(options.minMovePct ?? scannerConfig.minMovePct ?? env.STOCK_SCANNER_MIN_MOVE_PCT, stricterLiveEntryDefaults ? LIVE_STOCK_POLICY_DEFAULTS.minMovePct : 0));
  const requireRecentMomentum = options.requireRecentMomentum ?? scannerConfig.requireRecentMomentum ?? parseBool(env.STOCK_SCANNER_REQUIRE_RECENT_MOMENTUM, stricterLiveEntryDefaults);
  const minRecentMovePct = Math.max(0, safeNumber(options.minRecentMovePct ?? scannerConfig.minRecentMovePct ?? env.STOCK_SCANNER_MIN_RECENT_MOVE_PCT, stricterLiveEntryDefaults ? LIVE_STOCK_POLICY_DEFAULTS.minRecentMovePct : 0.03));
  const minRecentRangePct = Math.max(0, safeNumber(options.minRecentRangePct ?? scannerConfig.minRecentRangePct ?? env.STOCK_SCANNER_MIN_RECENT_RANGE_PCT, stricterLiveEntryDefaults ? LIVE_STOCK_POLICY_DEFAULTS.minRecentRangePct : 0.05));
  const minRecentCloseLocationPct = Math.max(0, Math.min(100, safeNumber(options.minRecentCloseLocationPct ?? scannerConfig.minRecentCloseLocationPct ?? env.STOCK_SCANNER_MIN_RECENT_CLOSE_LOCATION_PCT, stricterLiveEntryDefaults ? LIVE_STOCK_POLICY_DEFAULTS.minRecentCloseLocationPct : 60)));
  const allowContrarianEntries = options.allowContrarianEntries ?? true;
  const blockBuys = options.blockBuys ?? parseBool(env.BLOCK_BUYS, false);
  const sellMaxPriceDiffPct = safeNumber(options.sellMaxPriceDiffPct ?? env.SELL_MAX_PROVIDER_PRICE_DIFF_PCT, 0.75);
  const recentTradePenaltyMinutes = Math.max(0, safeNumber(options.recentTradePenaltyMinutes ?? env.STOCK_SCANNER_RECENT_TRADE_PENALTY_MINUTES, 15));
  const recentTradeRankPenalty = Math.max(0, safeNumber(options.recentTradeRankPenalty ?? env.STOCK_SCANNER_RECENT_TRADE_RANK_PENALTY, 20));
  const recentLossPenaltyMinutes = Math.max(0, safeNumber(options.recentLossPenaltyMinutes ?? env.STOCK_SCANNER_RECENT_LOSS_PENALTY_MINUTES, 10));
  const recentLossRankPenalty = Math.max(0, safeNumber(options.recentLossRankPenalty ?? env.STOCK_SCANNER_RECENT_LOSS_RANK_PENALTY, 60));
  const recentStaleExitPenaltyMinutes = Math.max(0, safeNumber(options.recentStaleExitPenaltyMinutes ?? env.STOCK_SCANNER_RECENT_STALE_EXIT_PENALTY_MINUTES, 20));
  const recentStaleExitRankPenalty = Math.max(0, safeNumber(options.recentStaleExitRankPenalty ?? env.STOCK_SCANNER_RECENT_STALE_EXIT_RANK_PENALTY, 40));
  const recentStopExitPenaltyMinutes = Math.max(0, safeNumber(options.recentStopExitPenaltyMinutes ?? env.STOCK_SCANNER_RECENT_STOP_EXIT_PENALTY_MINUTES, 30));
  const recentStopExitRankPenalty = Math.max(0, safeNumber(options.recentStopExitRankPenalty ?? env.STOCK_SCANNER_RECENT_STOP_EXIT_RANK_PENALTY, 80));
  const antiChurnEnabled = options.antiChurnEnabled ?? parseBool(env.ANTI_CHURN_ENABLED, true);
  const antiChurnRetentionHours = Math.max(1, safeNumber(options.antiChurnRetentionHours ?? env.ANTI_CHURN_RETENTION_HOURS, 24));
  const antiChurnCleanWinCooldownSeconds = Math.max(0, safeNumber(options.antiChurnCleanWinCooldownSeconds ?? env.ANTI_CHURN_CLEAN_WIN_COOLDOWN_SECONDS, 0));
  const antiChurnTrailingWinCooldownSeconds = Math.max(0, safeNumber(options.antiChurnTrailingWinCooldownSeconds ?? env.ANTI_CHURN_TRAILING_WIN_COOLDOWN_SECONDS, 5 * 60));
  const antiChurnSmallWinCooldownSeconds = Math.max(0, safeNumber(options.antiChurnSmallWinCooldownSeconds ?? env.ANTI_CHURN_SMALL_WIN_COOLDOWN_SECONDS, 5 * 60));
  const antiChurnGoodLossCooldownSeconds = Math.max(0, safeNumber(options.antiChurnGoodLossCooldownSeconds ?? env.ANTI_CHURN_GOOD_LOSS_COOLDOWN_SECONDS, 15 * 60));
  const antiChurnBadLossCooldownSeconds = Math.max(0, safeNumber(options.antiChurnBadLossCooldownSeconds ?? env.ANTI_CHURN_BAD_LOSS_COOLDOWN_SECONDS, 30 * 60));
  const antiChurnHardStopoutCooldownSeconds = Math.max(0, safeNumber(options.antiChurnHardStopoutCooldownSeconds ?? env.ANTI_CHURN_HARD_STOPOUT_COOLDOWN_SECONDS, 45 * 60));
  const antiChurnRepeatedStopoutMultiplier = Math.max(1, safeNumber(options.antiChurnRepeatedStopoutMultiplier ?? env.ANTI_CHURN_REPEATED_STOPOUT_MULTIPLIER, 2));
  const antiChurnMaxCooldownSeconds = Math.max(0, safeNumber(options.antiChurnMaxCooldownSeconds ?? env.ANTI_CHURN_MAX_COOLDOWN_SECONDS, 90 * 60));
  const antiChurnRecentWinnerProtectionEnabled = options.antiChurnRecentWinnerProtectionEnabled ?? parseBool(env.RECENT_WINNER_PROTECTION_ENABLED, true);
  const antiChurnRecentWinnerWindowSeconds = Math.max(1, safeNumber(options.antiChurnRecentWinnerWindowSeconds ?? env.ANTI_CHURN_RECENT_WINNER_WINDOW_SECONDS, 30 * 60));
  const antiChurnTinyExitDollars = Math.max(0, safeNumber(options.antiChurnTinyExitDollars ?? env.ANTI_CHURN_TINY_EXIT_DOLLARS, 0.5));
  const antiChurnRapidRoundTripSeconds = Math.max(1, safeNumber(options.antiChurnRapidRoundTripSeconds ?? env.ANTI_CHURN_RAPID_ROUND_TRIP_SECONDS, 10 * 60));
  const antiChurnWindowSeconds = Math.max(1, safeNumber(options.antiChurnWindowSeconds ?? env.ANTI_CHURN_WINDOW_SECONDS, 60 * 60));
  const antiChurnGuardScoreThreshold = Math.max(1, safeNumber(options.antiChurnGuardScoreThreshold ?? env.ANTI_CHURN_GUARD_SCORE_THRESHOLD, 60));
  const antiChurnGuardTradeCount = Math.max(0, safeNumber(options.antiChurnGuardTradeCount ?? env.ANTI_CHURN_GUARD_TRADE_COUNT, 4));
  const antiChurnGuardStopoutCount = Math.max(0, safeNumber(options.antiChurnGuardStopoutCount ?? env.ANTI_CHURN_GUARD_STOPOUT_COUNT, 2));
  const antiChurnGuardTinyExitCount = Math.max(0, safeNumber(options.antiChurnGuardTinyExitCount ?? env.ANTI_CHURN_GUARD_TINY_EXIT_COUNT, 2));
  const antiChurnGuardRoundTripCount = Math.max(0, safeNumber(options.antiChurnGuardRoundTripCount ?? env.ANTI_CHURN_GUARD_ROUND_TRIP_COUNT, 2));
  const antiChurnGuardSymbolLoopCount = Math.max(0, safeNumber(options.antiChurnGuardSymbolLoopCount ?? env.ANTI_CHURN_GUARD_SYMBOL_LOOP_COUNT, 3));
  const antiChurnGuardSetupLoopCount = Math.max(0, safeNumber(options.antiChurnGuardSetupLoopCount ?? env.ANTI_CHURN_GUARD_SETUP_LOOP_COUNT, 3));
  const setupFatigueEnabled = options.setupFatigueEnabled ?? parseBool(env.SETUP_FATIGUE_ENABLED, true);
  const setupFatigueThreshold = Math.max(0, safeNumber(options.setupFatigueThreshold ?? env.SETUP_FATIGUE_THRESHOLD, 60));
  const setupFatigueDecayPerHour = Math.max(0, safeNumber(options.setupFatigueDecayPerHour ?? env.SETUP_FATIGUE_DECAY_PER_HOUR, 8));
  const setupFatigueStopoutPoints = Math.max(0, safeNumber(options.setupFatigueStopoutPoints ?? env.SETUP_FATIGUE_STOPOUT_POINTS, 28));
  const setupFatigueBadLossPoints = Math.max(0, safeNumber(options.setupFatigueBadLossPoints ?? env.SETUP_FATIGUE_BAD_LOSS_POINTS, 16));
  const setupFatigueGoodLossPoints = Math.max(0, safeNumber(options.setupFatigueGoodLossPoints ?? env.SETUP_FATIGUE_GOOD_LOSS_POINTS, 6));
  const setupFatigueCleanWinRecoveryPoints = Math.max(0, safeNumber(options.setupFatigueCleanWinRecoveryPoints ?? env.SETUP_FATIGUE_CLEAN_WIN_RECOVERY_POINTS, 10));
  const setupFatiguePauseSeconds = Math.max(0, safeNumber(options.setupFatiguePauseSeconds ?? env.SETUP_FATIGUE_PAUSE_SECONDS, 15 * 60));
  const setupFatigueMaxPauseSeconds = Math.max(0, safeNumber(options.setupFatigueMaxPauseSeconds ?? env.SETUP_FATIGUE_MAX_PAUSE_SECONDS, 90 * 60));
  const sessionGuardsEnabled = options.sessionGuardsEnabled ?? parseBool(env.SESSION_GUARDS_ENABLED, false);
  const stopoutClusterBlockMinutes = Math.max(0, safeNumber(options.stopoutClusterBlockMinutes ?? env.STOCK_SCANNER_STOPOUT_CLUSTER_BLOCK_MINUTES, 30));
  const stopoutClusterBlockCount = Math.max(0, Math.floor(safeNumber(options.stopoutClusterBlockCount ?? env.STOCK_SCANNER_STOPOUT_CLUSTER_BLOCK_COUNT, 2)));
  const maxBuyRiskScore = Math.max(0, safeNumber(options.maxBuyRiskScore ?? env.STOCK_SCANNER_MAX_BUY_RISK_SCORE, 70));
  const spreadRankPenaltyThresholdPct = Math.max(0, safeNumber(options.spreadRankPenaltyThresholdPct ?? env.STOCK_SCANNER_SPREAD_RANK_PENALTY_THRESHOLD_PCT, 0.75));
  const spreadRankPenaltyPerPct = Math.max(0, safeNumber(options.spreadRankPenaltyPerPct ?? env.STOCK_SCANNER_SPREAD_RANK_PENALTY_PER_PCT, 25));
  const spreadRankPenaltyCap = Math.max(0, safeNumber(options.spreadRankPenaltyCap ?? env.STOCK_SCANNER_SPREAD_RANK_PENALTY_CAP, 80));
  const minAdjustedRankScore = safeNumber(options.minAdjustedRankScore ?? env.STOCK_SCANNER_MIN_ADJUSTED_RANK_SCORE, Number.NEGATIVE_INFINITY);
  const keepAlive = options.keepAlive ?? true;
  const runtimeStateEnabled = options.runtimeStateEnabled ?? parseBool(env.SCANNER_RUNTIME_STATE_ENABLED, false);
  const requireMarketOpen = options.requireMarketOpen ?? parseBool(env.STOCK_SCANNER_REQUIRE_MARKET_OPEN, true);
  const openingNoiseMinutes = Math.max(0, safeNumber(options.openingNoiseMinutes ?? env.STOCK_SCANNER_OPENING_NOISE_MINUTES, 5));
  const nearCloseManageOnlyMinutes = Math.max(0, safeNumber(options.nearCloseManageOnlyMinutes ?? env.STOCK_SCANNER_NEAR_CLOSE_MANAGE_ONLY_MINUTES, 15));
  const volatilityStopEnabled = options.volatilityStopEnabled ?? parseBool(env.STOCK_SCANNER_VOLATILITY_STOP_ENABLED, false);
  const marketQualityRankingEnabled = options.marketQualityRankingEnabled ?? parseBool(env.STOCK_SCANNER_MARKET_QUALITY_RANKING_ENABLED, false);
  const scannerSelectionV2ShadowEnabled = options.scannerSelectionV2ShadowEnabled ?? parseBool(env.SCANNER_SELECTION_V2_SHADOW, true);
  const scannerSelectionV2AuthorityEnabled = options.scannerSelectionV2AuthorityEnabled ?? parseBool(env.SCANNER_SELECTION_V2_AUTHORITY_ENABLED, false);
  const scannerSelectionV2OutcomeTrackingEnabled = options.scannerSelectionV2OutcomeTrackingEnabled ?? parseBool(env.SCANNER_SELECTION_V2_OUTCOME_TRACKING_ENABLED, scannerSelectionV2ShadowEnabled);
  const scannerSelectionV2Config = {
    selectionV2MaxSpreadPct: safeNumber(options.selectionV2MaxSpreadPct ?? env.SCANNER_SELECTION_V2_MAX_SPREAD_PCT, stricterLiveEntryDefaults ? 2.0 : 2.5),
    selectionV2HardBlockSpreadPct: safeNumber(options.selectionV2HardBlockSpreadPct ?? env.SCANNER_SELECTION_V2_HARD_BLOCK_SPREAD_PCT, 5),
    selectionV2MinRelativeVolume: safeNumber(options.selectionV2MinRelativeVolume ?? env.SCANNER_SELECTION_V2_MIN_RELATIVE_VOLUME, stricterLiveEntryDefaults ? 0.75 : 0.25),
    selectionV2MinFreshnessScore: safeNumber(options.selectionV2MinFreshnessScore ?? env.SCANNER_SELECTION_V2_MIN_FRESHNESS_SCORE, stricterLiveEntryDefaults ? 60 : 35),
    selectionV2MaxVwapExtensionPct: safeNumber(options.selectionV2MaxVwapExtensionPct ?? env.SCANNER_SELECTION_V2_MAX_VWAP_EXTENSION_PCT, 7),
    selectionV2SpreadPenaltyThresholdPct: safeNumber(options.selectionV2SpreadPenaltyThresholdPct ?? env.SCANNER_SELECTION_V2_SPREAD_PENALTY_THRESHOLD_PCT, 0.75),
    selectionV2RegularWatchMaxBonus: safeNumber(options.selectionV2RegularWatchMaxBonus ?? env.SCANNER_SELECTION_V2_REGULAR_WATCH_MAX_BONUS, 12),
    selectionV2RegularWatchMaxAgeSeconds: safeNumber(options.selectionV2RegularWatchMaxAgeSeconds ?? env.SCANNER_SELECTION_V2_REGULAR_WATCH_MAX_AGE_SECONDS, 180),
    selectionV2PriorityOverrideMaxBonus: safeNumber(options.selectionV2PriorityOverrideMaxBonus ?? env.SCANNER_SELECTION_V2_PRIORITY_OVERRIDE_MAX_BONUS, 15),
  };
  const executionQualityFeedbackEnabled = options.executionQualityFeedbackEnabled ?? parseBool(env.EXECUTION_QUALITY_FEEDBACK_ENABLED, false);
  const executionQualityRankPenaltyEnabled = options.executionQualityRankPenaltyEnabled ?? parseBool(env.EXECUTION_QUALITY_RANK_PENALTY_ENABLED, false);
  const executionQualitySizeMultiplierEnabled = options.executionQualitySizeMultiplierEnabled ?? parseBool(env.EXECUTION_QUALITY_SIZE_MULTIPLIER_ENABLED, false);
  const executionQualityCooldownEnabled = options.executionQualityCooldownEnabled ?? parseBool(env.EXECUTION_QUALITY_COOLDOWN_ENABLED, false);
  const maxExecutionQualityRankPenalty = Math.max(0, safeNumber(options.maxExecutionQualityRankPenalty ?? env.MAX_EXECUTION_QUALITY_RANK_PENALTY, 40));
  const minExecutionQualitySizeMultiplier = Math.max(0.5, Math.min(1, safeNumber(options.minExecutionQualitySizeMultiplier ?? env.MIN_EXECUTION_QUALITY_SIZE_MULTIPLIER, 0.5)));
  const highSlippageThresholdPct = Math.max(0, safeNumber(options.highSlippageThresholdPct ?? env.HIGH_SLIPPAGE_THRESHOLD_PCT, 0.5));
  const badFillThresholdPct = Math.max(0, safeNumber(options.badFillThresholdPct ?? env.BAD_FILL_THRESHOLD_PCT, 2));
  const executionQualityDecayPerHour = Math.max(0, safeNumber(options.executionQualityDecayPerHour ?? env.EXECUTION_QUALITY_DECAY_PER_HOUR, 0));
  const riskBudgetSizingEnabled = options.riskBudgetSizingEnabled ?? parseBool(env.RISK_BUDGET_SIZING_ENABLED, false);
  const positionSizingMode = String(options.positionSizingMode ?? env.POSITION_SIZING_MODE ?? (riskBudgetSizingEnabled ? 'risk_budget' : 'fixed_notional')).trim().toLowerCase();
  const maxBuyingPowerDeploymentPct = Math.max(0, Math.min(100, safeNumber(options.maxBuyingPowerDeploymentPct ?? env.MAX_BUYING_POWER_DEPLOYMENT_PCT, 100)));
  const buyingPowerMarketOrderBufferPct = Math.max(0, Math.min(50, safeNumber(options.buyingPowerMarketOrderBufferPct ?? env.BUYING_POWER_MARKET_ORDER_BUFFER_PCT, 0)));
  const buyingPowerCashReserve = Math.max(0, safeNumber(options.buyingPowerCashReserve ?? env.BUYING_POWER_CASH_RESERVE ?? env.CASH_RESERVE_DOLLARS, 0));
  const allowBuyingPowerFractionalShares = options.allowBuyingPowerFractionalShares ?? parseBool(env.ALLOW_BUYING_POWER_FRACTIONAL_SHARES, false);
  const maxRiskPerTradeDollars = Math.max(0, safeNumber(options.maxRiskPerTradeDollars ?? env.MAX_RISK_PER_TRADE_DOLLARS, 0));
  const maxRiskPerTradePctEquity = Math.max(0, safeNumber(options.maxRiskPerTradePctEquity ?? env.MAX_RISK_PER_TRADE_PCT_EQUITY, 0));
  const maxTradeNotional = Math.max(0, safeNumber(options.maxTradeNotional ?? env.MAX_TRADE_NOTIONAL, 0));
  const minStopDistanceDollars = Math.max(0.01, safeNumber(options.minStopDistanceDollars ?? env.MIN_STOP_DISTANCE_DOLLARS, 0.01));
  const maxStopDistanceDollars = Math.max(0, safeNumber(options.maxStopDistanceDollars ?? env.MAX_STOP_DISTANCE_DOLLARS, 0));
  const allowRiskBudgetFractionalShares = options.allowRiskBudgetFractionalShares ?? parseBool(env.ALLOW_RISK_BUDGET_FRACTIONAL_SHARES, false);
  const riskBudgetRequireBrokerEquity = options.riskBudgetRequireBrokerEquity ?? parseBool(env.RISK_BUDGET_REQUIRE_BROKER_EQUITY, true);
  const candidateLifecycleEnabled = options.candidateLifecycleEnabled ?? parseBool(env.CANDIDATE_QUEUE_ENABLED, false);
  const candidateMinScansBeforeEntry = Math.max(1, Math.floor(safeNumber(options.candidateMinScansBeforeEntry ?? env.CANDIDATE_MIN_SCANS_BEFORE_ENTRY, 2)));
  const candidateMinSecondsBeforeEntry = Math.max(0, Math.floor(safeNumber(options.candidateMinSecondsBeforeEntry ?? env.CANDIDATE_MIN_SECONDS_BEFORE_ENTRY, 30)));
  const candidateMaxAgeSeconds = Math.max(1, Math.floor(safeNumber(options.candidateMaxAgeSeconds ?? env.CANDIDATE_MAX_AGE_SECONDS, 10 * 60)));
  const candidateConfirmationRequired = options.candidateConfirmationRequired ?? parseBool(env.CANDIDATE_CONFIRMATION_REQUIRED, true);
  const candidateQueueMaxSize = Math.max(1, Math.floor(safeNumber(options.candidateQueueMaxSize ?? env.CANDIDATE_QUEUE_MAX_SIZE, 12)));
  const rankConfidenceDecayEnabled = options.rankConfidenceDecayEnabled ?? parseBool(env.RANK_CONFIDENCE_DECAY_ENABLED, false);
  const rankConfidenceHalfLifeSeconds = Math.max(1, Math.floor(safeNumber(options.rankConfidenceHalfLifeSeconds ?? env.RANK_CONFIDENCE_HALF_LIFE_SECONDS, 15 * 60)));
  const rankConfidenceMaxStaleSeconds = Math.max(1, Math.floor(safeNumber(options.rankConfidenceMaxStaleSeconds ?? env.RANK_CONFIDENCE_MAX_STALE_SECONDS, 30 * 60)));
  const huntToMonitorLatchEnabled = options.huntToMonitorLatchEnabled ?? parseBool(env.HUNT_TO_MONITOR_LATCH_ENABLED, false);
  const monitorModeAllowsNewBuys = options.monitorModeAllowsNewBuys ?? parseBool(env.MONITOR_MODE_ALLOWS_NEW_BUYS, false);
  const manageOnlyBlocksBuys = options.manageOnlyBlocksBuys ?? parseBool(env.MANAGE_ONLY_BLOCKS_BUYS, true);
  const microRotationGuardEnabled = options.microRotationGuardEnabled ?? parseBool(env.MICRO_ROTATION_GUARD_ENABLED, false);
  const rotationSoftBandPoints = Math.max(0, safeNumber(options.rotationSoftBandPoints ?? env.ROTATION_SOFT_BAND_POINTS, 4));
  const rotationHardBandPoints = Math.max(0, safeNumber(options.rotationHardBandPoints ?? env.ROTATION_HARD_BAND_POINTS, 12));
  const rotationMinHoldScans = Math.max(0, Math.floor(safeNumber(options.rotationMinHoldScans ?? env.ROTATION_MIN_HOLD_SCANS, 1)));
  const hotSlotRotationConfig = resolveHotSlotRotationConfig(env);
  const hotSlotRotationFeatureEnabled = Boolean(hotSlotRotationConfig.enabled);
  const hotSlotRotationEnabled = hotSlotRotationFeatureEnabled;

  const state = {
    running: false,
    timer: null,
    lastRunAt: null,
    hotSlotRotation: null,
  };
  let latestSourceUniverse = null;
  let latestActiveSymbols = approvedSymbols.slice();
  let latestApprovedReferenceSymbols = approvedSymbols.slice();
  let latestSourceCounts = null;
  let latestSourceListsBySymbol = new Map();

  async function runOnce(runOptions = {}) {
    if (!enabled) return { accepted: false, reason: 'DISABLED', candidates: [] };
    if (!localBaseUrl) return { accepted: false, reason: 'LOCAL_BASE_URL_REQUIRED', candidates: [] };
    if (state.running) return { accepted: false, reason: 'RUN_ALREADY_IN_PROGRESS', candidates: [] };

      state.running = true;
    const receivedAt = nowIso();
    const regularWatchFeatureState = options.regularWatchState || loadRegularWatchState({
      env,
      repoRoot,
      filePath: resolveRegularWatchStatePath({ dataDir, repoRoot }),
    });
    const regularWatchStatus = options.regularWatchStatus || loadRegularWatchStatus({
      dataDir,
      filePath: resolveRegularWatchStatusPath({ dataDir, repoRoot }),
    });
    const sourceUniverse = resolveScannerSymbolUniverse({
      env,
      repoRoot,
      dataDir,
      regularWatchStatus,
      dynamicHotListPath,
      approvedSymbols,
      scannerSymbolSource,
      currentDate: receivedAt,
    });
    const memeWatchConfig = resolveScannerWatchConfig({
      env,
      repoRoot,
      dataDir,
      memeMonitorStatePath,
      dynamicHotListPath,
      regularWatchStatus,
      approvedSymbols: sourceUniverse.approvedSymbols,
      attentionSymbols: sourceUniverse.activeSymbols,
      scannerSymbolSource,
      currentDate: receivedAt,
    });
    latestSourceUniverse = sourceUniverse;
    latestActiveSymbols = sourceUniverse.activeSymbols.slice();
    latestApprovedReferenceSymbols = sourceUniverse.approvedSymbols.slice();
    latestSourceCounts = sourceUniverse.sourceCounts;
    latestSourceListsBySymbol = sourceUniverse.sourceListsBySymbol;
    const regularWatchRankingEnabled = Boolean(
      options.regularWatchRankingEnabled
      ?? regularWatchFeatureState?.features?.REGULAR_WATCH_SCANNER_RANKING_ENABLED?.effective,
    );
    const regularWatchPositionAwarenessEnabled = Boolean(
      options.regularWatchPositionAwarenessEnabled
      ?? regularWatchFeatureState?.features?.REGULAR_WATCH_POSITION_AWARENESS_ENABLED?.effective,
    );
    const hotSlotRotationFeatureState = memeWatchConfig.state?.features?.MEME_HOT_SLOT_ROTATION_ENABLED || null;
    const hotSlotRotationEnabled = Boolean(hotSlotRotationConfig.enabled && hotSlotRotationFeatureState?.effective);
    let previousCandidateLifecycleState = null;
    let scannerMode = 'hunt';
    let candidateLifecycleResult = null;
    let executionQualityState = null;
    let executionQualitySummary = null;
    try {
      const activeSymbols = memeWatchConfig.attentionSymbols;
      const approvedReferenceSymbols = memeWatchConfig.approvedSymbols;
      const bundle = await fetchStockBundle({
        fetchImpl: marketFetch,
        apiKeyId,
        apiSecretKey,
        baseUrl,
        symbols: activeSymbols,
      });
      const twelveDataSymbols = activeSymbols;
      const twelveDataQuotes = twelveDataApiKey
        ? await fetchTwelveDataBundle({
          fetchImpl: marketFetch,
          apiKey: twelveDataApiKey,
          baseUrl: twelveDataBaseUrl,
          symbols: twelveDataSymbols,
        })
        : {};
      const accountBaseUrl = options.accountBaseUrl || options.tradingBaseUrl || options.accountUrl || trimTrailingSlash(env.ALPACA_API_BASE_URL || 'https://paper-api.alpaca.markets');
      const positionsState = await fetchPositions({
        fetchImpl: marketFetch,
        apiKeyId,
        apiSecretKey,
        baseUrl: accountBaseUrl,
      });
      const openOrdersState = await fetchOpenOrders({
        fetchImpl: marketFetch,
        apiKeyId,
        apiSecretKey,
        baseUrl: accountBaseUrl,
      });
      const accountState = await fetchAccount({
        fetchImpl: marketFetch,
        apiKeyId,
        apiSecretKey,
        baseUrl: accountBaseUrl,
      });
      let positions = positionsState.data;
      const openOrders = openOrdersState.data;
      const account = accountState.data;
      const brokerState = buildScannerBrokerState({ accountState, positionsState, openOrdersState });
      const positionEntryTimes = await fetchRecentFilledBuyOrderTimes({
        fetchImpl: marketFetch,
        apiKeyId,
        apiSecretKey,
        baseUrl: accountBaseUrl,
        symbols: positions.map((position) => position.symbol),
      });
      positions = enrichPositionsWithEntryTimes(positions, positionEntryTimes);
      const approvedPositions = filterApprovedPositions(positions, approvedReferenceSymbols);
      const managedPositions = positions;
      const heldPositionSymbols = managedPositions
        .map((position) => String(position.symbol || '').trim().toUpperCase())
        .filter(Boolean);
      const managedAttentionSymbols = [...new Set([
        ...memeWatchConfig.attentionSymbols,
        ...heldPositionSymbols,
      ])];
      const heldSymbolsMissingFromBundle = managedPositions
        .map((position) => String(position.symbol || '').trim().toUpperCase())
        .filter((symbol) => symbol && !bundle.snapshots?.[symbol]);
      if (heldSymbolsMissingFromBundle.length) {
        const heldBundle = await fetchStockBundle({
          fetchImpl: marketFetch,
          apiKeyId,
          apiSecretKey,
          baseUrl,
          symbols: heldSymbolsMissingFromBundle,
        });
        Object.assign(bundle.snapshots, heldBundle.snapshots || {});
        Object.assign(bundle.latestQuotes, heldBundle.latestQuotes || {});
      }
      for (const position of managedPositions) {
        const symbol = String(position.symbol || '').trim().toUpperCase();
        if (!symbol || bundle.snapshots?.[symbol]) continue;
        const brokerPrice = safeNumber(position.current_price ?? position.currentPrice ?? position.market_price ?? position.avg_entry_price, null);
        if (!Number.isFinite(brokerPrice) || brokerPrice <= 0) continue;
        const timestamp = receivedAt;
        bundle.snapshots[symbol] = {
          latestTrade: { p: brokerPrice, t: timestamp },
          latestQuote: { bp: brokerPrice, ap: brokerPrice, t: timestamp },
          minuteBar: { o: brokerPrice, h: brokerPrice, l: brokerPrice, c: brokerPrice, v: 0, t: timestamp },
          dailyBar: { c: brokerPrice, v: 0, t: timestamp },
          broker_position_fallback: true,
        };
        bundle.latestQuotes[symbol] = bundle.snapshots[symbol].latestQuote;
      }
      const loadedPartialFillState = options.partialFillState || loadPartialFillState({ env, repoRoot: resolveRepoRoot() });
      const partialFillState = options.partialFillState
        ? loadedPartialFillState
        : await reconcilePartialFills({
          previousState: loadedPartialFillState,
          openOrders,
          positions,
          now: receivedAt,
          options: { authoritativeOpenOrders: true },
        });
      if (!options.partialFillState) {
        savePartialFillState(partialFillState, { env, repoRoot: resolveRepoRoot() });
      }
      const partialFillSummary = summarizePartialFillState(partialFillState);
      executionQualityState = options.executionQualityState || loadExecutionQualityState({ env, repoRoot: resolveRepoRoot() });
      executionQualitySummary = summarizeExecutionQualityState(executionQualityState, {
        now: receivedAt,
        decayPerHour: executionQualityDecayPerHour,
        minSizeMultiplier: minExecutionQualitySizeMultiplier,
      });
      const previousAntiChurnState = options.antiChurnState || loadAntiChurnState({ env, repoRoot: resolveRepoRoot() });
      let antiChurnState = normalizeAntiChurnState(previousAntiChurnState);
      if (!options.antiChurnState) {
        try {
          antiChurnState = await reconcileAntiChurnState({
            previousState: previousAntiChurnState,
            performanceHistoryPath: resolvePerformanceHistoryPath(env, resolveRepoRoot()),
            now: receivedAt,
            env,
            repoRoot: resolveRepoRoot(),
            antiChurnEnabled,
            retentionHours: antiChurnRetentionHours,
            cleanWinCooldownSeconds: antiChurnCleanWinCooldownSeconds,
            trailingWinCooldownSeconds: antiChurnTrailingWinCooldownSeconds,
            smallWinCooldownSeconds: antiChurnSmallWinCooldownSeconds,
            goodLossCooldownSeconds: antiChurnGoodLossCooldownSeconds,
            badLossCooldownSeconds: antiChurnBadLossCooldownSeconds,
            hardStopoutCooldownSeconds: antiChurnHardStopoutCooldownSeconds,
            repeatedStopoutMultiplier: antiChurnRepeatedStopoutMultiplier,
            maxCooldownSeconds: antiChurnMaxCooldownSeconds,
            recentWinnerProtectionEnabled: antiChurnRecentWinnerProtectionEnabled,
            recentWinnerWindowSeconds: antiChurnRecentWinnerWindowSeconds,
            tinyExitDollars: antiChurnTinyExitDollars,
            rapidRoundTripSeconds: antiChurnRapidRoundTripSeconds,
            churnWindowSeconds: antiChurnWindowSeconds,
            churnGuardScoreThreshold: antiChurnGuardScoreThreshold,
            churnGuardTradeCount: antiChurnGuardTradeCount,
            churnGuardStopoutCount: antiChurnGuardStopoutCount,
            churnGuardTinyExitCount: antiChurnGuardTinyExitCount,
            churnGuardRoundTripCount: antiChurnGuardRoundTripCount,
            churnGuardSymbolLoopCount: antiChurnGuardSymbolLoopCount,
            churnGuardSetupLoopCount: antiChurnGuardSetupLoopCount,
          });
        } catch (error) {
          antiChurnState = normalizeAntiChurnState(previousAntiChurnState);
          options.logger({ level: 'warn', event: 'anti_churn_state_reconcile_failed', message: error.message });
        }
      }
      if (!options.antiChurnState) {
        saveAntiChurnState(antiChurnState, { env, repoRoot: resolveRepoRoot() });
      }
      const antiChurnSummary = summarizeAntiChurnState(antiChurnState);
      const performanceHistoryPath = resolvePerformanceHistoryPath(env, resolveRepoRoot());
      const previousSetupFatigueState = options.setupFatigueState || loadSetupFatigueState({ env, repoRoot: resolveRepoRoot() });
      let setupFatigueState = normalizeSetupFatigueState(previousSetupFatigueState);
      if (!options.setupFatigueState) {
        try {
          setupFatigueState = await reconcileSetupFatigueState({
            previousState: previousSetupFatigueState,
            performanceHistoryPath,
            now: receivedAt,
            env,
            repoRoot: resolveRepoRoot(),
            setupFatigueEnabled,
            threshold: setupFatigueThreshold,
            decayPerHour: setupFatigueDecayPerHour,
            stopoutPoints: setupFatigueStopoutPoints,
            badLossPoints: setupFatigueBadLossPoints,
            goodLossPoints: setupFatigueGoodLossPoints,
            cleanWinRecoveryPoints: setupFatigueCleanWinRecoveryPoints,
            pauseSeconds: setupFatiguePauseSeconds,
            maxPauseSeconds: setupFatigueMaxPauseSeconds,
          });
        } catch (error) {
          setupFatigueState = normalizeSetupFatigueState(previousSetupFatigueState);
          options.logger({ level: 'warn', event: 'setup_fatigue_state_reconcile_failed', message: error.message });
        }
      }
      if (!options.setupFatigueState) {
        saveSetupFatigueState(setupFatigueState, { env, repoRoot: resolveRepoRoot() });
      }
      const setupFatigueSummary = summarizeSetupFatigueState(setupFatigueState);
      const computedIntradayRegime = options.intradayRegime || resolveIntradayStockRegime(new Date(), {
        openingNoiseMinutes,
        nearCloseMinutes: nearCloseManageOnlyMinutes,
      });
      const sessionGuards = options.sessionGuards
        || (sessionGuardsEnabled
          ? await evaluateSessionGuards({
            now: receivedAt,
            env,
            repoRoot: resolveRepoRoot(),
            performanceHistoryPath,
            setupFatigueState,
            setupFatigueSummary,
            intradayRegime: computedIntradayRegime,
            openingNoiseMinutes,
            nearCloseManageOnlyMinutes,
          })
          : {
            status: 'CLEAR',
            active_guards: [],
            buy_blocked: false,
            sells_allowed: true,
            manage_only: false,
            reason_codes: [],
            expires_at: null,
            explanation: 'Session guards disabled.',
            intraday_regime: computedIntradayRegime,
            metrics: {},
            setup_fatigue_summary: setupFatigueSummary,
          });
      const antiChurnActive = Boolean(
        antiChurnSummary.active_churn_guard
        || antiChurnSummary.symbol_cooldown_count
        || antiChurnSummary.setup_cooldown_count
        || antiChurnSummary.recent_exit_count,
      );
      const portfolio = buildPortfolioSnapshot({ positions, openOrders, account, maxOpenPositions, partialFillSummary });
      const allocation = brokerState.strict_buy_blocked
        ? {
          accepted: false,
          reason: brokerState.reason_codes[0] || 'BROKER_STATE_REQUIRED_FOR_BUY',
          requested: notional,
          notional: 0,
          floor: minBuyNotional,
          remaining_slots: portfolio.remaining_position_slots,
          broker_state_required: true,
        }
        : allocateBuyNotional({ targetNotional: notional, minBuyNotional, portfolio, requireBrokerCash: true });
      const skipTracker = createSkipTracker();
      const legacyRecentTradePenalties = loadRecentTradePenalties({
        env,
        repoRoot: resolveRepoRoot(),
        now: receivedAt,
        windowMinutes: recentTradePenaltyMinutes,
        penalty: recentTradeRankPenalty,
        lossWindowMinutes: recentLossPenaltyMinutes,
        lossPenalty: recentLossRankPenalty,
        staleWindowMinutes: recentStaleExitPenaltyMinutes,
        stalePenalty: recentStaleExitRankPenalty,
        stopWindowMinutes: recentStopExitPenaltyMinutes,
        stopPenalty: recentStopExitRankPenalty,
        overrides: options.recentTradePenalties,
      });
      const recentTradePenalties = antiChurnActive ? antiChurnState.symbol_cooldowns : legacyRecentTradePenalties;
      const intradayRegime = sessionGuards.intraday_regime || computedIntradayRegime || options.intradayRegime || resolveIntradayStockRegime(new Date(), {
        openingNoiseMinutes,
        nearCloseMinutes: nearCloseManageOnlyMinutes,
      });
      const hasMarketOpenOverride = Object.prototype.hasOwnProperty.call(options, 'marketOpen');
      const marketOpen = options.marketOpen ?? intradayRegime.market_open ?? isRegularUsMarketHours(new Date());
      const regimeBuysAllowed = options.regimeBuysAllowed ?? (hasMarketOpenOverride ? Boolean(marketOpen) : intradayRegime.buys_allowed !== false);
      if (requireMarketOpen && !marketOpen) {
        skipTracker.record('MARKET_CLOSED_FOR_STOCKS', { symbol: '*', market_open: false });
      }
      if (!regimeBuysAllowed) {
        skipTracker.record(intradayRegime.reason_code || 'INTRADAY_REGIME_BUY_BLOCK', { symbol: '*', regime: intradayRegime.regime });
      }
      if (!allocation.accepted) {
        skipTracker.record(allocation.reason || 'ALLOCATION_BLOCK', {
          symbol: '*',
          notional: allocation.notional,
          requested: allocation.requested,
          remaining_slots: allocation.remaining_slots,
        });
        for (const reason of Array.isArray(allocation.reason_codes) ? allocation.reason_codes : []) {
          skipTracker.record(reason, { symbol: '*', allocation: true });
        }
      }
      if (brokerState.strict_buy_blocked) {
        for (const reason of brokerState.reason_codes) {
          skipTracker.record(reason, { symbol: '*', broker_state_required: true });
        }
      }
      if (sessionGuards.buy_blocked) {
        for (const reason of sessionGuards.reason_codes || []) {
          skipTracker.record(reason, { symbol: '*', session_guard: true });
        }
      }
      const previousTrailingState = loadTrailingState({ env, repoRoot: resolveRepoRoot() });
      const trailingState = updateTrailingSnapshot({
        positions: managedPositions,
        startDollars: trailingProfitStartDollars,
        givebackDollars: trailingProfitGivebackDollars,
        previousState: previousTrailingState,
      });
      saveTrailingState(trailingState, { env, repoRoot: resolveRepoRoot() });
      previousCandidateLifecycleState = options.candidateLifecycleState || loadCandidateLifecycleState({ env, repoRoot: resolveRepoRoot() });
      scannerMode = determineScannerMode({
        sessionGuards,
        portfolio,
        openOrders,
        huntToMonitorLatchEnabled,
        manageOnlyBlocksBuys,
      });
      const { candidates, allBuyCandidates, candidateLifecycleResult: computedCandidateLifecycleResult } = buildCandidates(bundle, {
        receivedAt,
        maxCandidatesPerRun,
        maxBuyCandidates: hotSlotRotationEnabled && Number(safeNumber(portfolio.remaining_position_slots, 0)) <= 0
          ? maxCandidatesPerRun
          : Math.min(maxCandidatesPerRun, Math.max(0, portfolio.remaining_position_slots ?? maxOpenPositions)),
        notional: allocation.accepted ? allocation.notional : notional,
        minBuyNotional,
        allocation,
        marketOpen,
        intradayRegime,
        regimeBuysAllowed,
        requireMarketOpen,
        stopLossDollars,
        stopLossNotionalPct,
        stopLossMaxDollars,
        trailingProfitStartDollars,
        trailingProfitGivebackDollars,
        stalePositionExitEnabled,
        stalePositionMaxHoldMinutes,
        stalePositionMinPeakProfitDollars,
        stalePositionMaxExitPnlDollars,
        maxStalenessSeconds,
        stalledWinnerExitEnabled,
        stalledWinnerMaxHoldMinutes,
        stalledWinnerMaxMinutesSincePeak,
        stalledWinnerMinProfitDollars,
        sellNetProfitFloorDollars,
        trailingState,
        requireMultiSourceConfirmation,
        singleSourceMomentumEnabled,
        singleSourceMomentumMinRankScore,
        minMovePct,
        requireRecentMomentum,
        minRecentMovePct,
        minRecentRangePct,
        minRecentCloseLocationPct,
        allowContrarianEntries,
        blockBuys,
        sellMaxPriceDiffPct,
        twelveDataQuotes,
        openOrders,
        portfolio,
        skipTracker,
        runId: runOptions.runId || `stock_${hashObject({ receivedAt, symbols: activeSymbols, baseUrl }).slice(0, 10)}`,
        positions: managedPositions,
        attentionSymbols: managedAttentionSymbols,
        approvedSymbols: approvedReferenceSymbols,
        dynamicWatchlistSymbols: memeWatchConfig.dynamicWatchlistSymbols,
        priorityOverrideSymbols: memeWatchConfig.priorityOverrideSymbols,
        priorityOverrideBonus: memeWatchConfig.priorityOverrideBonus,
        regularWatchStatus,
        regularWatchRankingEnabled,
        regularWatchPositionAwarenessEnabled,
        excludedBuySymbols,
        recentTradePenalties,
        antiChurnState,
        antiChurnSummary,
        antiChurnEnabled,
        antiChurnRecentWinnerProtectionEnabled,
        antiChurnTinyExitDollars,
        antiChurnRapidRoundTripSeconds,
        setupFatigueState,
        setupFatigueSummary,
        setupFatigueEnabled,
        setupFatigueThreshold,
        sessionGuards,
        minAdjustedRankScore,
        brokerState,
        partialFillSummary,
        executionQualityState,
        executionQualitySummary,
        executionQualityFeedbackEnabled,
        executionQualityRankPenaltyEnabled,
        executionQualitySizeMultiplierEnabled,
        executionQualityCooldownEnabled,
        maxExecutionQualityRankPenalty,
        minExecutionQualitySizeMultiplier,
        highSlippageThresholdPct,
        badFillThresholdPct,
        executionQualityDecayPerHour,
        allowRotationBuyEvaluation: hotSlotRotationEnabled && Number(safeNumber(portfolio.remaining_position_slots, 0)) <= 0,
        stopoutClusterBlockMinutes,
        stopoutClusterBlockCount,
        maxBuyRiskScore,
        spreadRankPenaltyThresholdPct,
        spreadRankPenaltyPerPct,
        spreadRankPenaltyCap,
        scannerSelectionV2ShadowEnabled,
        scannerSelectionV2AuthorityEnabled,
        scannerSelectionV2Config,
        scannerMode,
        optionalHooks: {
          volatility_stop_enabled: Boolean(volatilityStopEnabled),
          market_quality_ranking_enabled: Boolean(marketQualityRankingEnabled),
          scanner_selection_v2_shadow_enabled: Boolean(scannerSelectionV2ShadowEnabled),
          scanner_selection_v2_authority_enabled: Boolean(scannerSelectionV2AuthorityEnabled),
          risk_budget_sizing_enabled: Boolean(riskBudgetSizingEnabled),
        },
        riskBudgetSizingEnabled,
        positionSizingMode,
        maxBuyingPowerDeploymentPct,
        buyingPowerMarketOrderBufferPct,
        buyingPowerCashReserve,
        allowBuyingPowerFractionalShares,
        maxRiskPerTradeDollars,
        maxRiskPerTradePctEquity,
        maxTradeNotional,
        minStopDistanceDollars,
        maxStopDistanceDollars,
        allowRiskBudgetFractionalShares,
        riskBudgetRequireBrokerEquity,
        maxStalenessSeconds,
        scannerSymbolSource: memeWatchConfig.scannerSymbolSource || scannerSymbolSource,
        sourceListsBySymbol: memeWatchConfig.sourceListsBySymbol || latestSourceListsBySymbol,
        candidateLifecycleEnabled,
        candidateLifecycleState: previousCandidateLifecycleState,
        candidateLifecycleConfig: {
          minScansBeforeEntry: candidateMinScansBeforeEntry,
          minSecondsBeforeEntry: candidateMinSecondsBeforeEntry,
          maxAgeSeconds: candidateMaxAgeSeconds,
          confirmationRequired: candidateConfirmationRequired,
          queueMaxSize: candidateQueueMaxSize,
          rankFloor: minAdjustedRankScore,
          decayEnabled: rankConfidenceDecayEnabled,
          halfLifeSeconds: rankConfidenceHalfLifeSeconds,
          maxStaleSeconds: rankConfidenceMaxStaleSeconds,
          huntToMonitorLatchEnabled,
          monitorModeAllowsNewBuys,
          manageOnlyBlocksBuys,
          softBandPoints: rotationSoftBandPoints,
          hardBandPoints: rotationHardBandPoints,
          minHoldScans: rotationMinHoldScans,
        },
      });
      candidateLifecycleResult = computedCandidateLifecycleResult;
      if (!options.candidateLifecycleState && candidateLifecycleResult?.state) {
        saveCandidateLifecycleState(candidateLifecycleResult.state, { env, repoRoot: resolveRepoRoot() });
      }

      const { candidates: previewCandidates = [], allBuyCandidates: allPreviewBuyCandidates = [] } = !marketOpen
        ? buildCandidates(bundle, {
          receivedAt,
          maxCandidatesPerRun,
          maxBuyCandidates: hotSlotRotationEnabled && Number(safeNumber(portfolio.remaining_position_slots, 0)) <= 0
            ? maxCandidatesPerRun
            : Math.min(maxCandidatesPerRun, Math.max(0, portfolio.remaining_position_slots ?? maxOpenPositions)),
          notional: allocation.accepted ? allocation.notional : notional,
          minBuyNotional,
          allocation,
          marketOpen,
          intradayRegime,
          regimeBuysAllowed,
          requireMarketOpen,
          stopLossDollars,
          stopLossNotionalPct,
          stopLossMaxDollars,
          trailingProfitStartDollars,
          trailingProfitGivebackDollars,
          stalePositionExitEnabled,
          stalePositionMaxHoldMinutes,
          stalePositionMinPeakProfitDollars,
          stalePositionMaxExitPnlDollars,
          maxStalenessSeconds,
          stalledWinnerExitEnabled,
          stalledWinnerMaxHoldMinutes,
          stalledWinnerMaxMinutesSincePeak,
          stalledWinnerMinProfitDollars,
          sellNetProfitFloorDollars,
          trailingState,
          requireMultiSourceConfirmation,
          singleSourceMomentumEnabled,
          singleSourceMomentumMinRankScore,
          minMovePct,
          requireRecentMomentum,
          minRecentMovePct,
          minRecentRangePct,
          minRecentCloseLocationPct,
          allowContrarianEntries,
          blockBuys,
          sellMaxPriceDiffPct,
          twelveDataQuotes,
          openOrders,
          portfolio,
          skipTracker: createSkipTracker(),
          runId: runOptions.runId || `stock_${hashObject({ receivedAt, symbols: activeSymbols, baseUrl }).slice(0, 10)}_preview`,
          positions: managedPositions,
          attentionSymbols: managedAttentionSymbols,
          approvedSymbols: approvedReferenceSymbols,
          dynamicWatchlistSymbols: memeWatchConfig.dynamicWatchlistSymbols,
          priorityOverrideSymbols: memeWatchConfig.priorityOverrideSymbols,
          priorityOverrideBonus: memeWatchConfig.priorityOverrideBonus,
          regularWatchStatus,
          regularWatchRankingEnabled,
          regularWatchPositionAwarenessEnabled,
          excludedBuySymbols,
          recentTradePenalties,
          antiChurnState,
          antiChurnSummary,
          antiChurnEnabled,
          antiChurnRecentWinnerProtectionEnabled,
          antiChurnTinyExitDollars,
          antiChurnRapidRoundTripSeconds,
          setupFatigueState,
          setupFatigueSummary,
          setupFatigueEnabled,
          setupFatigueThreshold,
          sessionGuards,
          minAdjustedRankScore,
          brokerState,
          partialFillSummary,
          executionQualityState,
          executionQualitySummary,
          executionQualityFeedbackEnabled,
          executionQualityRankPenaltyEnabled,
          executionQualitySizeMultiplierEnabled,
          executionQualityCooldownEnabled,
          maxExecutionQualityRankPenalty,
          minExecutionQualitySizeMultiplier,
          highSlippageThresholdPct,
          badFillThresholdPct,
          executionQualityDecayPerHour,
          allowRotationBuyEvaluation: false,
          stopoutClusterBlockMinutes,
          stopoutClusterBlockCount,
          maxBuyRiskScore,
          spreadRankPenaltyThresholdPct,
          spreadRankPenaltyPerPct,
          spreadRankPenaltyCap,
          scannerSelectionV2ShadowEnabled,
          scannerSelectionV2AuthorityEnabled,
          scannerSelectionV2Config,
          scannerMode,
          optionalHooks: {
            volatility_stop_enabled: Boolean(volatilityStopEnabled),
            market_quality_ranking_enabled: Boolean(marketQualityRankingEnabled),
            scanner_selection_v2_shadow_enabled: Boolean(scannerSelectionV2ShadowEnabled),
            scanner_selection_v2_authority_enabled: Boolean(scannerSelectionV2AuthorityEnabled),
            risk_budget_sizing_enabled: Boolean(riskBudgetSizingEnabled),
          },
          riskBudgetSizingEnabled,
          positionSizingMode,
          maxBuyingPowerDeploymentPct,
          buyingPowerMarketOrderBufferPct,
          buyingPowerCashReserve,
          allowBuyingPowerFractionalShares,
          maxRiskPerTradeDollars,
          maxRiskPerTradePctEquity,
          maxTradeNotional,
          minStopDistanceDollars,
          maxStopDistanceDollars,
          allowRiskBudgetFractionalShares,
          riskBudgetRequireBrokerEquity,
          scannerSymbolSource: memeWatchConfig.scannerSymbolSource || scannerSymbolSource,
          sourceListsBySymbol: memeWatchConfig.sourceListsBySymbol || latestSourceListsBySymbol,
          candidateLifecycleEnabled: false,
          candidateLifecycleState: previousCandidateLifecycleState,
          candidateLifecycleConfig: {
            minScansBeforeEntry: candidateMinScansBeforeEntry,
            minSecondsBeforeEntry: candidateMinSecondsBeforeEntry,
            maxAgeSeconds: candidateMaxAgeSeconds,
            confirmationRequired: candidateConfirmationRequired,
            queueMaxSize: candidateQueueMaxSize,
            rankFloor: minAdjustedRankScore,
            decayEnabled: rankConfidenceDecayEnabled,
            halfLifeSeconds: rankConfidenceHalfLifeSeconds,
            maxStaleSeconds: rankConfidenceMaxStaleSeconds,
            huntToMonitorLatchEnabled,
            monitorModeAllowsNewBuys,
            manageOnlyBlocksBuys,
            softBandPoints: rotationSoftBandPoints,
            hardBandPoints: rotationHardBandPoints,
            minHoldScans: rotationMinHoldScans,
          },
          previewMode: true,
        })
        : [];

      const buyCandidates = candidates.filter((candidate) => candidate?.payload?.side === 'buy');
      const sellCandidates = candidates.filter((candidate) => candidate?.payload?.side === 'sell');
      const rotationPlan = hotSlotRotationEnabled
        ? evaluateHotSlotRotationPlan({
          featureState: hotSlotRotationFeatureState,
          config: hotSlotRotationConfig,
          buyCandidates,
          hotHotEntries: memeWatchConfig.hotList?.hotHotList || [],
          portfolio,
          positions: managedPositions,
          openOrders,
          partialFillSummary,
          trailingState,
          snapshots: bundle.snapshots,
          runtimeCandidates: candidateLifecycleResult?.state?.candidates ? Object.values(candidateLifecycleResult.state.candidates).map((entry) => ({
            symbol: entry?.symbol,
            adjusted_rank_score: entry?.decayed_rank ?? entry?.latest_rank ?? entry?.latest_decayed_rank ?? null,
            rank_score: entry?.latest_rank ?? entry?.decayed_rank ?? null,
          })) : [],
          currentDate: receivedAt,
          brokerState,
        })
        : summarizeHotSlotRotationRuntime({ enabled: false, status: 'off', lastDecision: 'rotation_blocked_feature_disabled', reasonCodes: ['rotation_blocked_feature_disabled'] }, hotSlotRotationFeatureState);
      state.hotSlotRotation = summarizeHotSlotRotationRuntime(rotationPlan, hotSlotRotationFeatureState);

      const results = [];
      const postCandidate = async (candidate) => {
        if (!candidate) return null;
        assertSignalCandidate(candidate.payload);
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
        const result = {
          symbol: candidate.symbol,
          move_pct: candidate.movePct,
          spread_pct: candidate.spreadPct,
          accepted: response.ok,
          status: responseBody?.final_decision || responseBody?.status || null,
          response: responseBody,
        };
        results.push(result);
        if (!isApprovedPostResult({ accepted: response.ok, response: responseBody })) {
          const reasons = responseBody?.reason_codes || responseBody?.riskDecision?.reason_codes || responseBody?.risk_decision?.reason_codes || [];
          for (const reason of Array.isArray(reasons) ? reasons : [reasons].filter(Boolean)) {
            skipTracker.record(reason || 'RISK_REJECTED', { symbol: candidate.symbol, stage: 'risk' });
          }
        }
        return result;
      };

      for (const candidate of sellCandidates) {
        await postCandidate(candidate);
      }

      let rotationResult = null;
      let rotationCandidateSymbol = normalizeWatchSymbol(rotationPlan?.candidate);
      const suppressBuyPosting = Boolean(hotSlotRotationEnabled && rotationPlan?.accountFull);
      const shouldAttemptRotation = hotSlotRotationEnabled
        && rotationPlan?.rotationEligible
        && rotationPlan?.selectedCandidate
        && rotationPlan?.selectedEviction;

      if (shouldAttemptRotation) {
        const eviction = rotationPlan.selectedEviction;
        const evictionSymbol = normalizeWatchSymbol(eviction.symbol);
        const evictionSnapshot = bundle.snapshots[evictionSymbol] || {};
        const evictionQuote = bundle.latestQuotes[evictionSymbol] || evictionSnapshot.latestQuote || evictionSnapshot.latest_quote || {};
        const evictionCurrentPrice = safeNumber(
          evictionSnapshot.latestQuote?.p
            ?? evictionSnapshot.latestTrade?.p
            ?? evictionSnapshot.minuteBar?.c
            ?? evictionSnapshot.dailyBar?.c
            ?? eviction.current_price
            ?? null,
          null,
        );
        const evictionPreviousClose = safeNumber(evictionSnapshot.prevDailyBar?.c ?? evictionSnapshot.dailyBar?.c ?? eviction.previous_close ?? null, null);
        const evictionSpreadPct = Number.isFinite(evictionCurrentPrice)
          ? safeNumber(
            Number.isFinite(evictionSnapshot.latestQuote?.bp) && Number.isFinite(evictionSnapshot.latestQuote?.ap)
              ? ((evictionSnapshot.latestQuote.ap - evictionSnapshot.latestQuote.bp) / evictionCurrentPrice) * 100
              : evictionSnapshot.spread_pct,
            0,
          )
          : 0;
        const rotationExitState = {
          symbol: evictionSymbol,
          exit_reason: 'HOT_SLOT_ROTATION',
          rotation_reason: rotationPlan.evictionReason || 'small_profit_weak_momentum',
          rotation_requested: true,
          rotation_candidate: rotationPlan.candidate || null,
          rotation_candidate_heat_score: rotationPlan.candidateHeatScore ?? null,
          rotation_candidate_market_score: rotationPlan.candidateMarketScore ?? null,
          rotation_expected_exit_pnl: rotationPlan.expectedExitPnl ?? null,
          rotation_eviction_candidate: evictionSymbol,
          rotation_reason_codes: ['hot_slot_rotation_requested', 'rotation_eviction_candidate_selected'],
          unrealized_pl: Number.isFinite(eviction.netPnl) ? roundCurrency(eviction.netPnl) : null,
        };
        const rotationExitCandidate = buildSignalCandidate({
          symbol: evictionSymbol,
          side: 'sell',
          currentPrice: evictionCurrentPrice,
          previousClose: evictionPreviousClose,
          spreadPct: evictionSpreadPct,
          snapshot: evictionSnapshot,
          latestQuote: evictionQuote,
          options: {
            receivedAt,
            sellMaxPriceDiffPct,
            requireMultiSourceConfirmation,
            marketOpen,
            requireMarketOpen,
            runId: runOptions.runId || `stock_${hashObject({ receivedAt, symbols: activeSymbols, baseUrl }).slice(0, 10)}`,
            position: eviction,
            trailingState,
            openOrder: openOrders,
            partialFillSummary,
            sessionGuards,
          },
          quantity: Math.abs(safeNumber(eviction.qty ?? eviction.quantity ?? eviction.qty_available, 0)),
          notional: null,
          exitState: rotationExitState,
        });
        if (rotationExitCandidate) {
          rotationExitCandidate.payload.market_context.rotation_state = {
            requested: true,
            decision: 'rotation_exit_submitted',
            reason_codes: ['hot_slot_rotation_requested', 'rotation_eviction_candidate_selected'],
            candidate: rotationPlan.candidate,
            eviction_candidate: evictionSymbol,
            eviction_reason: rotationPlan.evictionReason,
            expected_exit_pnl: rotationPlan.expectedExitPnl,
          };
          state.hotSlotRotation = summarizeHotSlotRotationRuntime({
            ...rotationPlan,
            lastDecision: 'rotation_exit_submitted',
            decision: 'rotation_exit_submitted',
            reasonCodes: ['hot_slot_rotation_requested', 'rotation_eviction_candidate_selected', 'rotation_exit_submitted'],
            candidate: rotationPlan.candidate,
            candidateHeatScore: rotationPlan.candidateHeatScore,
            candidateMarketScore: rotationPlan.candidateMarketScore,
            evictionCandidate: evictionSymbol,
            evictionReason: rotationPlan.evictionReason,
            expectedExitPnl: rotationPlan.expectedExitPnl,
            accountFull: true,
            rotationEligible: true,
            requested: true,
            enabled: true,
            status: 'active',
            lastDecisionAt: receivedAt,
          }, hotSlotRotationFeatureState);
          options.logger({ level: 'info', event: 'hot_slot_rotation_requested', message: `Hot slot rotation requested for ${rotationPlan.candidate} by evicting ${evictionSymbol}` });
          rotationResult = await postCandidate(rotationExitCandidate);
          if (!rotationResult || !rotationResult.accepted) {
            state.hotSlotRotation = summarizeHotSlotRotationRuntime({
              ...state.hotSlotRotation,
              lastDecision: 'rotation_exit_rejected',
              decision: 'rotation_exit_rejected',
              reasonCodes: ['hot_slot_rotation_requested', 'rotation_exit_rejected'],
              status: 'error',
              blockReason: 'rotation_exit_rejected',
              lastDecisionAt: receivedAt,
            }, hotSlotRotationFeatureState);
          } else {
            state.hotSlotRotation = summarizeHotSlotRotationRuntime({
              ...state.hotSlotRotation,
              lastDecision: 'rotation_exit_confirmed',
              decision: 'rotation_exit_confirmed',
              reasonCodes: ['hot_slot_rotation_requested', 'rotation_eviction_candidate_selected', 'rotation_exit_confirmed'],
              status: 'active',
              blockReason: null,
              lastDecisionAt: receivedAt,
            }, hotSlotRotationFeatureState);
            options.logger({ level: 'info', event: 'rotation_exit_confirmed', message: `Rotation exit confirmed for ${evictionSymbol}` });
            const rotationDeadline = Date.now() + (hotSlotRotationConfig.exitTimeoutSeconds * 1000);
            state.hotSlotRotation = summarizeHotSlotRotationRuntime({
              ...state.hotSlotRotation,
              lastDecision: 'rotation_reconcile_after_exit_started',
              decision: 'rotation_reconcile_after_exit_started',
              reasonCodes: ['rotation_reconcile_after_exit_started'],
              lastDecisionAt: nowIso(),
            }, hotSlotRotationFeatureState);
            options.logger({ level: 'info', event: 'rotation_reconcile_after_exit_started', message: `Rechecking broker state after exiting ${evictionSymbol}` });

            let reconciledState = null;
            while (Date.now() <= rotationDeadline) {
              const [freshPositionsState, freshOpenOrdersState, freshAccountState] = await Promise.all([
                fetchPositions({ fetchImpl: marketFetch, apiKeyId, apiSecretKey, baseUrl: accountBaseUrl }),
                fetchOpenOrders({ fetchImpl: marketFetch, apiKeyId, apiSecretKey, baseUrl: accountBaseUrl }),
                fetchAccount({ fetchImpl: marketFetch, apiKeyId, apiSecretKey, baseUrl: accountBaseUrl }),
              ]);
              if (!freshPositionsState.available || !freshOpenOrdersState.available || !freshAccountState.available) {
                reconciledState = {
                  available: false,
                  reason: 'rotation_blocked_broker_reconciliation_failed',
                  positions: freshPositionsState,
                  openOrders: freshOpenOrdersState,
                  account: freshAccountState,
                };
                break;
              }
              const freshPositions = freshPositionsState.data || [];
              const freshOpenOrders = freshOpenOrdersState.data || [];
              const freshAccount = freshAccountState.data || {};
              const freshPortfolio = buildPortfolioSnapshot({
                positions: freshPositions,
                openOrders: freshOpenOrders,
                account: freshAccount,
                maxOpenPositions,
                partialFillSummary,
              });
              const remainingPosition = freshPositions.find((position) => normalizeWatchSymbol(position.symbol) === evictionSymbol);
              const remainingQty = safeNumber(remainingPosition?.qty ?? remainingPosition?.quantity ?? remainingPosition?.qty_available, 0);
              const stillHasConflict = freshOpenOrders.some((order) => normalizeWatchSymbol(order.symbol) === evictionSymbol && String(order.side || '').toLowerCase() === 'sell');
              if ((!remainingPosition || remainingQty <= 0) && freshPortfolio.remaining_position_slots > 0 && !stillHasConflict) {
                reconciledState = {
                  available: true,
                  portfolio: freshPortfolio,
                  positions: freshPositions,
                  openOrders: freshOpenOrders,
                  account: freshAccount,
                };
                break;
              }
              // Recheck quickly so a freed slot can be reused without waiting a full second.
              await sleep(250);
            }

            if (!reconciledState?.available) {
              state.hotSlotRotation = summarizeHotSlotRotationRuntime({
                ...state.hotSlotRotation,
                lastDecision: 'rotation_reconcile_after_exit_failed',
                decision: 'rotation_reconcile_after_exit_failed',
                reasonCodes: ['rotation_reconcile_after_exit_started', 'rotation_reconcile_after_exit_failed'],
                status: 'error',
                blockReason: 'rotation_reconcile_after_exit_failed',
                lastDecisionAt: nowIso(),
              }, hotSlotRotationFeatureState);
              options.logger({ level: 'error', event: 'rotation_reconcile_after_exit_failed', message: `Rotation reconciliation failed for ${evictionSymbol}` });
            } else {
              const freshPortfolio = reconciledState.portfolio;
              const rotationCandidateFreshEnough = Number.isFinite(hotSlotRotationConfig.entryRecheckMaxAgeSeconds)
                ? (Date.now() - new Date(receivedAt).getTime()) <= (hotSlotRotationConfig.entryRecheckMaxAgeSeconds * 1000)
                : true;
              state.hotSlotRotation = summarizeHotSlotRotationRuntime({
                ...state.hotSlotRotation,
                lastDecision: 'rotation_buy_recheck_started',
                decision: 'rotation_buy_recheck_started',
                reasonCodes: ['rotation_buy_recheck_started'],
                status: 'active',
                lastDecisionAt: nowIso(),
              }, hotSlotRotationFeatureState);
              options.logger({ level: 'info', event: 'rotation_buy_recheck_started', message: `Revalidating ${rotationPlan.candidate} after exiting ${evictionSymbol}` });
              const normalizedRotationSymbol = normalizeWatchSymbol(rotationPlan.candidate);
              const freshRotationCandidates = buyCandidates.filter((candidate) => {
                const candidateSymbol = normalizeWatchSymbol(candidate?.symbol);
                if (!candidateSymbol || candidateSymbol === evictionSymbol) return false;
                return Number.isFinite(safeNumber(candidate.payload?.market_context?.scanner?.current_price, null))
                  && Number.isFinite(safeNumber(candidate.payload?.market_context?.scanner?.spread_pct, null));
              });
              const preferredCandidate = freshRotationCandidates.find((candidate) => normalizeWatchSymbol(candidate.symbol) === normalizedRotationSymbol) || null;
              const promotedCandidate = (rotationCandidateFreshEnough && preferredCandidate)
                ? preferredCandidate
                : (freshRotationCandidates.find((candidate) => normalizeWatchSymbol(candidate.symbol) !== normalizedRotationSymbol) || preferredCandidate);
              const promotedSymbol = promotedCandidate ? normalizeWatchSymbol(promotedCandidate.symbol) : null;
              if (!promotedCandidate) {
                state.hotSlotRotation = summarizeHotSlotRotationRuntime({
                  ...state.hotSlotRotation,
                  lastDecision: 'rotation_candidate_no_longer_valid',
                  decision: 'rotation_candidate_no_longer_valid',
                  reasonCodes: ['rotation_buy_recheck_started', 'rotation_candidate_no_longer_valid'],
                  status: 'active',
                  blockReason: 'rotation_candidate_no_longer_valid',
                  lastDecisionAt: nowIso(),
                }, hotSlotRotationFeatureState);
                options.logger({ level: 'warn', event: 'rotation_candidate_no_longer_valid', message: `Rotation candidate ${rotationPlan.candidate} is no longer valid after exit` });
              } else {
                state.hotSlotRotation = summarizeHotSlotRotationRuntime({
                  ...state.hotSlotRotation,
                  lastDecision: promotedSymbol === normalizedRotationSymbol ? 'rotation_candidate_still_valid' : 'rotation_candidate_replaced_with_fresh_candidate',
                  decision: promotedSymbol === normalizedRotationSymbol ? 'rotation_candidate_still_valid' : 'rotation_candidate_replaced_with_fresh_candidate',
                  reasonCodes: promotedSymbol === normalizedRotationSymbol
                    ? ['rotation_buy_recheck_started', 'rotation_candidate_still_valid']
                    : ['rotation_buy_recheck_started', 'rotation_candidate_still_valid', 'rotation_candidate_replaced_with_fresh_candidate'],
                  status: 'active',
                  blockReason: null,
                  lastDecisionAt: nowIso(),
                }, hotSlotRotationFeatureState);
                options.logger({
                  level: 'info',
                  event: promotedSymbol === normalizedRotationSymbol ? 'rotation_candidate_still_valid' : 'rotation_candidate_replaced_with_fresh_candidate',
                  message: promotedSymbol === normalizedRotationSymbol
                    ? `Rotation candidate ${rotationPlan.candidate} remains valid`
                    : `Rotation candidate ${rotationPlan.candidate} aged out, promoting fresh candidate ${promotedSymbol}`,
                });
                state.hotSlotRotation = summarizeHotSlotRotationRuntime({
                  ...state.hotSlotRotation,
                  candidate: promotedSymbol || state.hotSlotRotation.candidate,
                  candidateHeatScore: promotedSymbol === normalizedRotationSymbol
                    ? state.hotSlotRotation.candidateHeatScore
                    : safeNumber(promotedCandidate?.payload?.market_context?.scanner?.selection_v2_score ?? promotedCandidate?.rankScore ?? null, null),
                  candidateMarketScore: promotedSymbol === normalizedRotationSymbol
                    ? state.hotSlotRotation.candidateMarketScore
                    : safeNumber(promotedCandidate?.payload?.market_context?.scanner?.selection_v2?.market_score ?? promotedCandidate?.marketScore ?? null, null),
                  selectedCandidate: promotedCandidate || state.hotSlotRotation.selectedCandidate,
                  lastDecision: 'rotation_candidate_promoted_to_risk_gate',
                  decision: 'rotation_candidate_promoted_to_risk_gate',
                  reasonCodes: ['rotation_buy_recheck_started', 'rotation_candidate_still_valid', 'rotation_candidate_promoted_to_risk_gate'],
                  status: 'active',
                  lastDecisionAt: nowIso(),
                }, hotSlotRotationFeatureState);
                rotationCandidateSymbol = promotedSymbol || rotationCandidateSymbol;
                options.logger({ level: 'info', event: 'rotation_candidate_promoted_to_risk_gate', message: `Posting rotation candidate ${promotedSymbol || rotationPlan.candidate} through the normal risk gate` });
                const promotedResult = await postCandidate(promotedCandidate);
                if (promotedResult && promotedResult.accepted) {
                  state.hotSlotRotation = summarizeHotSlotRotationRuntime({
                    ...state.hotSlotRotation,
                    lastDecision: 'rotation_complete',
                    decision: 'rotation_complete',
                    reasonCodes: ['rotation_complete'],
                    status: 'active',
                    rotationEligible: true,
                    lastDecisionAt: nowIso(),
                  }, hotSlotRotationFeatureState);
                  options.logger({ level: 'info', event: 'rotation_complete', message: `Hot slot rotation completed for ${promotedSymbol || rotationPlan.candidate}` });
                } else {
                  state.hotSlotRotation = summarizeHotSlotRotationRuntime({
                    ...state.hotSlotRotation,
                    lastDecision: 'rotation_aborted',
                    decision: 'rotation_aborted',
                    reasonCodes: ['rotation_candidate_promoted_to_risk_gate', 'rotation_aborted'],
                    status: 'error',
                    blockReason: 'rotation_aborted',
                    lastDecisionAt: nowIso(),
                  }, hotSlotRotationFeatureState);
                  options.logger({ level: 'warn', event: 'rotation_aborted', message: `Hot slot rotation aborted for ${promotedSymbol || rotationPlan.candidate}` });
                }
              }
            }
          }
        }
      }

      const buyCandidatesToPost = suppressBuyPosting
        ? []
        : shouldAttemptRotation && rotationCandidateSymbol
        ? buyCandidates.filter((candidate) => normalizeWatchSymbol(candidate?.symbol) !== rotationCandidateSymbol)
        : buyCandidates;

      for (const candidate of buyCandidatesToPost) {
        await postCandidate(candidate);
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
        runId: runOptions.runId || `stock_${hashObject({ receivedAt, symbols: activeSymbols, baseUrl }).slice(0, 10)}`,
        durationMs: state.lastScanDurationMs,
        portfolio,
        allocation,
        antiChurnState,
        antiChurnSummary,
        setupFatigueState,
        setupFatigueSummary,
        executionQualityState,
        executionQualitySummary,
        sessionGuards,
        trailingState,
        partialFillSummary,
        skipSummary: skipTracker.summary(),
        recentSkips: skipTracker.recent(),
        decisionTraces: skipTracker.traces(),
        candidates,
        previewCandidates,
        allBuyCandidates,
        allPreviewBuyCandidates,
        marketClosedExecutionBlock: !marketOpen,
        results,
        recentTradePenalties,
        brokerState,
        candidateLifecycleState: candidateLifecycleResult?.state || previousCandidateLifecycleState,
        candidateLifecycleSummary: candidateLifecycleResult?.summary || summarizeCandidateLifecycleState(previousCandidateLifecycleState || {}),
        hotSlotRotation: state.hotSlotRotation || null,
      });
      return {
        accepted: true,
        candidates: results,
        received_at: receivedAt,
        portfolio,
        allocation,
        broker_state: brokerState,
        partial_fill_state: partialFillSummary,
        execution_quality_state: executionQualityState,
        execution_quality_summary: executionQualitySummary,
        anti_churn_state: antiChurnState,
        anti_churn_summary: antiChurnSummary,
        hot_slot_rotation: state.hotSlotRotation || null,
        candidate_lifecycle_state: candidateLifecycleResult?.state || previousCandidateLifecycleState,
        candidate_lifecycle_summary: candidateLifecycleResult?.summary || summarizeCandidateLifecycleState(previousCandidateLifecycleState || {}),
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
        executionQualityState: executionQualityState || null,
        executionQualitySummary: executionQualitySummary || summarizeExecutionQualityState(executionQualityState || {}, {
          now: receivedAt,
          decayPerHour: executionQualityDecayPerHour,
          minSizeMultiplier: minExecutionQualitySizeMultiplier,
        }),
        candidateLifecycleState: previousCandidateLifecycleState || null,
        candidateLifecycleSummary: summarizeCandidateLifecycleState(previousCandidateLifecycleState || {}),
        hotSlotRotation: state.hotSlotRotation || null,
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
        options.logger({ level: 'error', event: 'stock_scanner_error', message: error.message });
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
      symbols: approvedSymbols,
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
      sellNetProfitFloorDollars,
      twelveDataApiKey,
      twelveDataBaseUrl,
      requireMultiSourceConfirmation,
      singleSourceMomentumEnabled,
      singleSourceMomentumMinRankScore,
      minMovePct,
      requireRecentMomentum,
      minRecentMovePct,
      minRecentRangePct,
      minRecentCloseLocationPct,
      requireMarketOpen,
      keepAlive,
      sellMaxPriceDiffPct,
      recentTradePenaltyMinutes,
      recentTradeRankPenalty,
      recentLossPenaltyMinutes,
      recentLossRankPenalty,
      recentStaleExitPenaltyMinutes,
      recentStaleExitRankPenalty,
      recentStopExitPenaltyMinutes,
      recentStopExitRankPenalty,
      stopoutClusterBlockMinutes,
      stopoutClusterBlockCount,
      maxBuyRiskScore,
      spreadRankPenaltyThresholdPct,
      spreadRankPenaltyPerPct,
      spreadRankPenaltyCap,
      minAdjustedRankScore,
      openingNoiseMinutes,
      nearCloseManageOnlyMinutes,
      volatilityStopEnabled,
      marketQualityRankingEnabled,
      executionQualityFeedbackEnabled,
      executionQualityRankPenaltyEnabled,
      executionQualitySizeMultiplierEnabled,
      executionQualityCooldownEnabled,
      maxExecutionQualityRankPenalty,
      minExecutionQualitySizeMultiplier,
      highSlippageThresholdPct,
      badFillThresholdPct,
      executionQualityDecayPerHour,
      riskBudgetSizingEnabled,
      maxRiskPerTradeDollars,
      maxRiskPerTradePctEquity,
      maxTradeNotional,
      minStopDistanceDollars,
      maxStopDistanceDollars,
      allowRiskBudgetFractionalShares,
      riskBudgetRequireBrokerEquity,
      antiChurnEnabled,
      antiChurnRetentionHours,
      antiChurnCleanWinCooldownSeconds,
      antiChurnTrailingWinCooldownSeconds,
      antiChurnSmallWinCooldownSeconds,
      antiChurnGoodLossCooldownSeconds,
      antiChurnBadLossCooldownSeconds,
      antiChurnHardStopoutCooldownSeconds,
      antiChurnRepeatedStopoutMultiplier,
      antiChurnMaxCooldownSeconds,
      antiChurnRecentWinnerProtectionEnabled,
      antiChurnRecentWinnerWindowSeconds,
      antiChurnTinyExitDollars,
      antiChurnRapidRoundTripSeconds,
      antiChurnWindowSeconds,
      antiChurnGuardScoreThreshold,
      antiChurnGuardTradeCount,
      antiChurnGuardStopoutCount,
      antiChurnGuardTinyExitCount,
      antiChurnGuardRoundTripCount,
      antiChurnGuardSymbolLoopCount,
      antiChurnGuardSetupLoopCount,
      excludedBuySymbols,
      hotSlotRotationEnabled,
      hotSlotRotationConfig,
    },
  };

  return controller;

  function writeRuntimeSnapshot({ receivedAt, runId = null, durationMs, portfolio = null, allocation = null, brokerState = null, intradayRegime = null, optionalHooks = null, trailingState = null, partialFillSummary = null, executionQualityState = null, executionQualitySummary = null, antiChurnState = null, antiChurnSummary = null, setupFatigueState = null, setupFatigueSummary = null, sessionGuards = null, candidateLifecycleState = null, candidateLifecycleSummary = null, hotSlotRotation = null, skipSummary = null, recentSkips = [], decisionTraces = [], candidates = [], previewCandidates = [], allBuyCandidates = [], allPreviewBuyCandidates = [], marketClosedExecutionBlock = false, results = [], recentTradePenalties = new Map(), error = null }) {
    if (!runtimeStateEnabled) return;
    let scannerSelectionShadowOutcome = null;
    if (scannerSelectionV2ShadowEnabled && scannerSelectionV2OutcomeTrackingEnabled) {
      scannerSelectionShadowOutcome = recordScannerSelectionShadow({
        candidates: allBuyCandidates.length ? allBuyCandidates : (allPreviewBuyCandidates.length ? allPreviewBuyCandidates : (candidates.length ? candidates : previewCandidates)),
        receivedAt,
        env,
        repoRoot,
      });
    }
    const decisionRecord = recordScannerDecisionCycle({
      receivedAt,
      runId,
      mode: 'live-market',
      marketRegime: intradayRegime,
      symbolUniverse: latestSourceUniverse?.regularWatch?.universe || null,
      approvedSymbols: latestApprovedReferenceSymbols,
      candidates: allBuyCandidates.length ? allBuyCandidates : candidates,
      selectedCandidates: candidates,
      previewCandidates: allPreviewBuyCandidates.length ? allPreviewBuyCandidates : previewCandidates,
      skipSummary,
      recentSkips,
      decisionTraces,
      candidateLifecycle: {
        state: candidateLifecycleState,
        summary: candidateLifecycleSummary,
      },
      results,
      brokerState,
      env,
      repoRoot,
    });
    const previewDetails = summarizePreviewCandidates(previewCandidates);
    const waitingForBuy = summarizeWaitingForBuy({
      candidates,
      previewCandidates,
      results,
      brokerState,
      skipSummary,
      recentSkips,
      marketClosedExecutionBlock,
    });
    writeScannerRuntimeState({
      scanner: 'stock-scanner',
      mode: 'live-market',
      config_version: '2026-06-20.scanner-runtime.1',
      loaded_mode: 'live-market',
      scanner_symbol_source: scannerSymbolSource,
      active_symbols: Array.isArray(latestActiveSymbols) ? latestActiveSymbols.slice() : [],
      active_source_count: Array.isArray(latestActiveSymbols) ? latestActiveSymbols.length : 0,
      approved_symbols: Array.isArray(latestApprovedReferenceSymbols) ? latestApprovedReferenceSymbols.slice() : [],
      approved_source_count: Array.isArray(latestApprovedReferenceSymbols) ? latestApprovedReferenceSymbols.length : 0,
      source_counts: latestSourceCounts || null,
      symbol_universe: latestSourceUniverse?.regularWatch?.universe || null,
      source_lists_by_symbol: latestSourceListsBySymbol ? Object.fromEntries([...latestSourceListsBySymbol.entries()].map(([symbol, value]) => [symbol, value])) : {},
      dynamic_source_empty: Boolean(latestSourceUniverse?.dynamicSourceEmpty),
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
      anti_churn_state: antiChurnState || null,
      anti_churn_summary: antiChurnSummary || summarizeAntiChurnState(antiChurnState || {}),
      setup_fatigue_state: setupFatigueState || null,
      setup_fatigue_summary: setupFatigueSummary || summarizeSetupFatigueState(setupFatigueState || {}),
      session_guards: sessionGuards || null,
      candidate_lifecycle_state: candidateLifecycleState || null,
      candidate_lifecycle_summary: candidateLifecycleSummary || summarizeCandidateLifecycleState(candidateLifecycleState || {}),
      hot_slot_rotation: hotSlotRotation || null,
      candidate_rank_details: candidates
        .filter((candidate) => candidate.payload?.side === 'buy')
        .map((candidate) => ({
          symbol: candidate.symbol,
          setup_key: candidate.setupKey || null,
          selection_status: candidate.payload?.market_context?.scanner?.candidate_lifecycle_selected ? 'selected' : 'ranked',
          selection_v2: candidate.payload?.market_context?.scanner?.selection_v2 || null,
          selection_v2_score: candidate.payload?.market_context?.scanner?.selection_v2?.final_opportunity_score ?? null,
          setup_classification: candidate.payload?.market_context?.scanner?.selection_v2?.setup_classification || null,
          raw_market_score: candidate.payload?.market_context?.scanner?.selection_v2?.market_score ?? null,
          trend_quality_score: candidate.payload?.market_context?.scanner?.selection_v2?.components?.trend_quality_score ?? null,
          momentum_score: candidate.payload?.market_context?.scanner?.selection_v2?.components?.momentum_score ?? null,
          relative_volume_score: candidate.payload?.market_context?.scanner?.selection_v2?.components?.relative_volume_score ?? null,
          structure_score: candidate.payload?.market_context?.scanner?.selection_v2?.components?.structure_score ?? null,
          reward_risk_score: candidate.payload?.market_context?.scanner?.selection_v2?.components?.reward_risk_score ?? null,
          overextension_penalty: candidate.payload?.market_context?.scanner?.selection_v2?.penalties?.overextension_penalty ?? null,
          social_watch_bonus: candidate.payload?.market_context?.scanner?.selection_v2?.bonuses ?? null,
          current_price: candidate.payload?.market_context?.scanner?.current_price ?? null,
          previous_close: candidate.payload?.market_context?.scanner?.previous_close ?? null,
          move_pct: candidate.payload?.market_context?.scanner?.move_pct ?? null,
          spread_pct: candidate.payload?.market_context?.scanner?.spread_pct ?? null,
          volume: candidate.payload?.volume ?? candidate.volume ?? null,
          average_volume: candidate.payload?.market_context?.scanner?.average_volume ?? null,
          volume_multiple: candidate.payload?.market_context?.scanner?.volume_multiple ?? null,
          dynamic_watchlist_member: Boolean(candidate.payload?.market_context?.scanner?.dynamic_watchlist_member),
          priority_override_eligible: Boolean(candidate.payload?.market_context?.scanner?.priority_override_eligible),
          priority_override_applied: Boolean(candidate.payload?.market_context?.scanner?.priority_override_applied),
          priority_override_bonus: roundScore(candidate.priorityOverrideBonus || 0),
          priority_override_block_reason: candidate.payload?.market_context?.scanner?.priority_override_block_reason || null,
          secondary_confirmation_available: Boolean(candidate.secondaryConfirmationAvailable),
          secondary_confirmation_source: candidate.secondaryConfirmationSource || null,
          regular_watch_comparison: candidate.payload?.market_context?.scanner?.regular_watch_comparison || null,
          position_awareness_tags: Array.isArray(candidate.payload?.market_context?.scanner?.position_awareness_tags)
            ? candidate.payload.market_context.scanner.position_awareness_tags.slice()
            : [],
          rank_score: roundScore(candidate.rankScore),
          base_rank_score: roundScore(candidate.baseRankScore ?? candidate.rankScore),
          recent_trade_rank_penalty: roundScore(candidate.recentTradeRankPenalty || 0),
          setup_rank_penalty: roundScore(candidate.setupRankPenalty || 0),
          execution_quality_rank_penalty: roundScore(candidate.executionQualityRankPenalty || 0),
          spread_rank_penalty: roundScore(candidate.spreadRankPenalty || 0),
          total_rank_penalty: roundScore(candidate.totalRankPenalty ?? candidate.recentTradeRankPenalty ?? 0),
          adjusted_rank_score: roundScore(candidate.rankScore),
          min_adjusted_rank_score: roundScore(minAdjustedRankScore),
          recent_trade_at: candidate.recentTradePenalty?.last_traded_at || null,
          sizing_method: candidate.payload?.sizing_method || 'fixed_notional',
          risk_budget_sizing: candidate.payload?.risk_budget_sizing || null,
          structure_stop: candidate.payload?.structure_stop || null,
          execution_quality: candidate.payload?.execution_quality || null,
          execution_quality_state: candidate.payload?.execution_quality_state || null,
          sizing_explanation: candidate.payload?.market_context?.scanner?.sizing_explanation || null,
          execution_status: candidate.payload?.market_context?.scanner?.execution_status || null,
          waiting_reason: candidate.payload?.market_context?.scanner?.waiting_reason || null,
          block_stage: candidate.payload?.market_context?.scanner?.execution_status || null,
          block_reason: candidate.payload?.market_context?.scanner?.waiting_reason
            || candidate.payload?.market_context?.scanner?.selection_v2?.reason_codes?.[0]
            || null,
          submission_result: null,
          candidate_lifecycle_status: candidate.payload?.market_context?.scanner?.candidate_lifecycle_status || null,
          candidate_lifecycle_reason_codes: candidate.payload?.market_context?.scanner?.candidate_lifecycle_reason_codes || [],
          candidate_lifecycle_decayed_rank: candidate.payload?.market_context?.scanner?.candidate_lifecycle_decayed_rank || null,
          source_mode: candidate.payload?.market_context?.scanner?.source_mode || null,
          source_list: candidate.payload?.market_context?.scanner?.source_list || null,
          source_lists: Array.isArray(candidate.payload?.market_context?.scanner?.source_lists)
            ? candidate.payload.market_context.scanner.source_lists.slice()
            : [],
          anti_churn_recent_winner_protected: Boolean(candidate.payload?.market_context?.scanner?.anti_churn_recent_winner_protected),
          anti_churn_reason: candidate.recentTradePenalty?.reason || null,
          setup_trade_penalty_reason: candidate.setupPenalty?.reason || null,
          setup_fatigue_score: candidate.setupFatigue?.fatigue_score ?? null,
          setup_fatigue_active: Boolean(candidate.setupFatigue?.active),
          setup_fatigue_paused_until: candidate.setupFatigue?.paused_until || null,
          setup_fatigue_reason_codes: candidate.setupFatigue?.reason_codes || [],
          session_guard_blocked: Boolean(sessionGuards?.buy_blocked),
        })),
      preview_candidate_count: previewDetails.length,
      preview_candidates: previewDetails,
      top_preview_candidates: previewDetails.slice(0, 5),
      preview_reason_codes: [...new Set(previewDetails.flatMap((candidate) => Array.isArray(candidate.reason_codes) ? candidate.reason_codes : []))],
      market_closed_execution_block: Boolean(marketClosedExecutionBlock),
      skip_summary: skipSummary || {
        allocation_block: allocation?.accepted === false ? 1 : 0,
        max_position_or_cash_block: allocation?.accepted === false ? allocation.reason : null,
      },
      recent_skips: recentSkips,
      portfolio: portfolio ? {
        open_positions_count: portfolio.open_positions_count,
        open_buy_order_count: portfolio.open_buy_order_count,
        partial_buy_order_count: portfolio.partial_buy_order_count,
        partial_reserved_buy_notional: portfolio.partial_reserved_buy_notional,
        remaining_position_slots: portfolio.remaining_position_slots,
        cash: portfolio.cash,
        buying_power: portfolio.buying_power,
      } : null,
      allocation,
      partial_fill_state: partialFillSummary,
      execution_quality_state: executionQualityState || null,
      execution_quality_summary: executionQualitySummary || null,
      broker_state: brokerState,
      broker_truth: {
        source_of_truth: brokerState?.source_of_truth || 'alpaca',
        freshness: brokerState?.freshness || 'unknown',
        checked_at: brokerState?.checked_at || receivedAt,
      },
      waiting_for_buy: waitingForBuy,
      intraday_regime: intradayRegime,
      optional_hooks: optionalHooks || {
        volatility_stop_enabled: Boolean(volatilityStopEnabled),
        market_quality_ranking_enabled: Boolean(marketQualityRankingEnabled),
        scanner_selection_v2_shadow_enabled: Boolean(scannerSelectionV2ShadowEnabled),
        scanner_selection_v2_authority_enabled: Boolean(scannerSelectionV2AuthorityEnabled),
        scanner_selection_v2_outcome_tracking_enabled: Boolean(scannerSelectionV2OutcomeTrackingEnabled),
        execution_quality_feedback_enabled: Boolean(executionQualityFeedbackEnabled),
        execution_quality_rank_penalty_enabled: Boolean(executionQualityRankPenaltyEnabled),
        execution_quality_size_multiplier_enabled: Boolean(executionQualitySizeMultiplierEnabled),
        execution_quality_cooldown_enabled: Boolean(executionQualityCooldownEnabled),
        risk_budget_sizing_enabled: Boolean(riskBudgetSizingEnabled),
        position_sizing_mode: positionSizingMode,
      },
      scanner_selection_v2: {
        shadow_enabled: Boolean(scannerSelectionV2ShadowEnabled),
        authority_enabled: Boolean(scannerSelectionV2AuthorityEnabled),
        outcome_tracking_enabled: Boolean(scannerSelectionV2OutcomeTrackingEnabled),
        outcome_record: scannerSelectionShadowOutcome,
        decision_record: decisionRecord,
        config: scannerSelectionV2Config,
      },
      position_sizing: {
        mode: positionSizingMode,
        max_buying_power_deployment_pct: maxBuyingPowerDeploymentPct,
        buying_power_market_order_buffer_pct: buyingPowerMarketOrderBufferPct,
        buying_power_cash_reserve: buyingPowerCashReserve,
        allow_buying_power_fractional_shares: Boolean(allowBuyingPowerFractionalShares),
        latest_candidates: candidates
          .filter((candidate) => candidate.payload?.side === 'buy')
          .map((candidate) => ({
            symbol: candidate.symbol,
            sizing_method: candidate.payload?.sizing_method || 'fixed_notional',
            sizing_explanation: candidate.payload?.sizing_explanation || null,
            buying_power_sizing: candidate.payload?.buying_power_sizing || null,
            risk_budget_sizing: candidate.payload?.risk_budget_sizing || null,
          })),
      },
      risk_budget_sizing: {
        enabled: Boolean(riskBudgetSizingEnabled),
        max_risk_per_trade_dollars: maxRiskPerTradeDollars,
        max_risk_per_trade_pct_equity: maxRiskPerTradePctEquity,
        max_trade_notional: maxTradeNotional,
        min_stop_distance_dollars: minStopDistanceDollars,
        max_stop_distance_dollars: maxStopDistanceDollars,
        allow_fractional_shares: Boolean(allowRiskBudgetFractionalShares),
        require_broker_equity: Boolean(riskBudgetRequireBrokerEquity),
        execution_quality_feedback_enabled: Boolean(executionQualityFeedbackEnabled),
        execution_quality_rank_penalty_enabled: Boolean(executionQualityRankPenaltyEnabled),
        execution_quality_size_multiplier_enabled: Boolean(executionQualitySizeMultiplierEnabled),
        execution_quality_cooldown_enabled: Boolean(executionQualityCooldownEnabled),
        execution_quality_decay_per_hour: executionQualityDecayPerHour,
        latest_candidates: candidates
          .filter((candidate) => candidate.payload?.side === 'buy')
          .map((candidate) => ({
            symbol: candidate.symbol,
            sizing_method: candidate.payload?.sizing_method || 'fixed_notional',
            current_price: candidate.payload?.market_context?.scanner?.current_price ?? null,
            previous_close: candidate.payload?.market_context?.scanner?.previous_close ?? null,
            move_pct: candidate.payload?.market_context?.scanner?.move_pct ?? null,
            spread_pct: candidate.payload?.market_context?.scanner?.spread_pct ?? null,
            volume: candidate.payload?.volume ?? candidate.volume ?? null,
            average_volume: candidate.payload?.market_context?.scanner?.average_volume ?? null,
            volume_multiple: candidate.payload?.market_context?.scanner?.volume_multiple ?? null,
            dynamic_watchlist_member: Boolean(candidate.payload?.market_context?.scanner?.dynamic_watchlist_member),
            priority_override_eligible: Boolean(candidate.payload?.market_context?.scanner?.priority_override_eligible),
            priority_override_applied: Boolean(candidate.payload?.market_context?.scanner?.priority_override_applied),
            priority_override_bonus: roundScore(candidate.priorityOverrideBonus || 0),
            priority_override_block_reason: candidate.payload?.market_context?.scanner?.priority_override_block_reason || null,
            regular_watch_comparison: candidate.payload?.market_context?.scanner?.regular_watch_comparison || null,
            position_awareness_tags: Array.isArray(candidate.payload?.market_context?.scanner?.position_awareness_tags)
              ? candidate.payload.market_context.scanner.position_awareness_tags.slice()
              : [],
            sizing_explanation: candidate.payload?.sizing_explanation || null,
            buying_power_sizing: candidate.payload?.buying_power_sizing || null,
            risk_budget_sizing: candidate.payload?.risk_budget_sizing || null,
            structure_stop: candidate.payload?.structure_stop || null,
            execution_quality: candidate.payload?.execution_quality || null,
            execution_quality_size_multiplier: candidate.payload?.market_context?.scanner?.execution_quality_size_multiplier || null,
          })),
      },
      rank_floor: {
        min_adjusted_rank_score: roundScore(minAdjustedRankScore),
        skip_reason: 'ADJUSTED_RANK_BELOW_FLOOR',
      },
      excluded_buy_symbols: excludedBuySymbols,
      exit_rules: {
        stop_loss_dollars: stopLossDollars,
        stop_loss_notional_pct: stopLossNotionalPct,
        stop_loss_max_dollars: stopLossMaxDollars,
        trailing_profit_start_dollars: trailingProfitStartDollars,
        trailing_profit_giveback_dollars: trailingProfitGivebackDollars,
        sell_net_profit_floor_dollars: sellNetProfitFloorDollars,
      },
      anti_churn_overview: antiChurnState ? {
        active_churn_guard: Boolean(antiChurnState.churn_guard?.active),
        symbol_cooldown_count: Object.keys(antiChurnState.symbol_cooldowns || {}).length,
        setup_cooldown_count: Object.keys(antiChurnState.setup_cooldowns || {}).length,
        recent_exit_count: Array.isArray(antiChurnState.recent_classifications) ? antiChurnState.recent_classifications.length : 0,
      } : null,
      setup_fatigue_overview: setupFatigueSummary ? {
        setup_count: setupFatigueSummary.setup_count,
        active_setup_count: setupFatigueSummary.active_setup_count,
        paused_setup_count: setupFatigueSummary.paused_setup_count,
        active_setups: setupFatigueSummary.active_setups,
        paused_setups: setupFatigueSummary.paused_setups,
      } : null,
      candidate_lifecycle: candidateLifecycleSummary || summarizeCandidateLifecycleState(candidateLifecycleState || {}),
      execution_quality: executionQualitySummary,
      position_exit_state: candidates
        .filter((candidate) => candidate.exitState)
        .map((candidate) => candidate.exitState),
      trailing_state: trailingState ? {
        updated_at: trailingState.updated_at,
        positions: trailingState.positions,
      } : null,
      session_guard_overview: summarizeSessionGuards(sessionGuards),
    }, { env, repoRoot });
  }

}

function createSkipTracker(limit = 12) {
  const counts = {};
  const examples = [];
  const traces = new Map();
  return {
    record(reason, details = {}) {
      const key = String(reason || 'UNKNOWN_SKIP');
      counts[key] = (counts[key] || 0) + 1;
      const traceSymbol = String(details.symbol || '').trim().toUpperCase();
      if (traceSymbol && traceSymbol !== '*') {
        const existing = traces.get(traceSymbol) || {
          symbol: traceSymbol,
          fetched: true,
          snapshot_valid: true,
          candidate_built: false,
          ranked: false,
          lifecycle_eligible: false,
          selected: false,
          submitted: false,
          risk_approved: false,
          order_accepted: false,
          terminal_stage: 'CANDIDATE_CONSTRUCTION',
          reason_codes: [],
        };
        existing.reason_codes = [...new Set([...(existing.reason_codes || []), key])];
        existing.terminal_stage = resolveTraceStageForSkip(key);
        traces.set(traceSymbol, existing);
      }
      if (key === 'EXIT_TARGET_NOT_MET') {
        examples.unshift({ reason: key, ...details });
        if (examples.length > limit) examples.length = limit;
      } else if (examples.length < limit) {
        examples.push({ reason: key, ...details });
      }
    },
    summary() {
      return counts;
    },
    recent() {
      return examples;
    },
    traces() {
      return [...traces.values()];
    },
  };
}

function resolveTraceStageForSkip(reason) {
  const key = String(reason || '');
  if (key.includes('MARKET') || key.includes('DATA')) return 'MARKET_DATA';
  if (key.includes('RANK') || key.includes('SCORE') || key.includes('MOMENTUM')) return 'QUALIFICATION';
  if (key.includes('LIFECYCLE') || key.includes('QUEUE') || key.includes('CONFIRMATION')) return 'LIFECYCLE';
  if (key.includes('POSITION') || key.includes('ALLOCATION') || key.includes('BUYING_POWER')) return 'ALLOCATION';
  if (key.includes('RISK') || key.includes('STOP')) return 'RISK_GATE';
  if (key.includes('ORDER')) return 'ORDER_SUBMISSION';
  return 'CANDIDATE_CONSTRUCTION';
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
  try {
    const response = await fetchImpl(`${baseUrl}/v2/positions`, { method: 'GET', headers });
    const body = await readJsonResponse(response);
    if (!response.ok) return { available: false, data: [], reason_code: 'BROKER_POSITIONS_UNAVAILABLE', status: response.status };
    return { available: true, data: Array.isArray(body) ? body : body?.positions || body?.data || [], reason_code: null, status: response.status };
  } catch (error) {
    return { available: false, data: [], reason_code: 'BROKER_POSITIONS_UNAVAILABLE', error: error.message };
  }
}

async function fetchOpenOrders({ fetchImpl, apiKeyId, apiSecretKey, baseUrl }) {
  const headers = {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
  try {
    const response = await fetchImpl(`${baseUrl}/v2/orders?status=open&limit=500`, { method: 'GET', headers });
    const body = await readJsonResponse(response);
    if (!response.ok) return { available: false, data: [], reason_code: 'BROKER_OPEN_ORDERS_UNAVAILABLE', status: response.status };
    return { available: true, data: Array.isArray(body) ? body : body?.orders || body?.data || [], reason_code: null, status: response.status };
  } catch (error) {
    return { available: false, data: [], reason_code: 'BROKER_OPEN_ORDERS_UNAVAILABLE', error: error.message };
  }
}

async function fetchRecentFilledBuyOrderTimes({ fetchImpl, apiKeyId, apiSecretKey, baseUrl, symbols = [] }) {
  const uniqueSymbols = [...new Set((Array.isArray(symbols) ? symbols : [])
    .map((symbol) => String(symbol || '').trim().toUpperCase())
    .filter(Boolean))];
  if (!uniqueSymbols.length) return {};
  const headers = {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
  const result = {};
  await Promise.all(uniqueSymbols.map(async (symbol) => {
    try {
      const url = `${baseUrl}/v2/orders?status=all&symbols=${encodeURIComponent(symbol)}&limit=20&direction=desc`;
      const response = await fetchImpl(url, { method: 'GET', headers });
      const body = await readJsonResponse(response);
      if (!response.ok) return;
      const orders = Array.isArray(body) ? body : body?.orders || body?.data || [];
      const latestFilledBuy = orders.find((order) => (
        String(order?.symbol || '').trim().toUpperCase() === symbol
        && String(order?.side || '').trim().toLowerCase() === 'buy'
        && String(order?.status || '').trim().toLowerCase() === 'filled'
        && (order?.filled_at || order?.submitted_at)
      ));
      if (latestFilledBuy) {
        result[symbol] = latestFilledBuy.filled_at || latestFilledBuy.submitted_at;
      }
    } catch {
      // Broker position truth still wins; missing order history only affects stale-hold timing.
    }
  }));
  return result;
}

function enrichPositionsWithEntryTimes(positions = [], entryTimes = {}) {
  return (Array.isArray(positions) ? positions : []).map((position) => {
    const symbol = String(position?.symbol || '').trim().toUpperCase();
    const openedAt = entryTimes[symbol] || position.opened_at || position.filled_at || null;
    return openedAt ? { ...position, opened_at: openedAt } : position;
  });
}

async function fetchAccount({ fetchImpl, apiKeyId, apiSecretKey, baseUrl }) {
  const headers = {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
  try {
    const response = await fetchImpl(`${baseUrl}/v2/account`, { method: 'GET', headers });
    const body = await readJsonResponse(response);
    if (!response.ok) return { available: false, data: null, reason_code: 'BROKER_ACCOUNT_UNAVAILABLE', status: response.status };
    return { available: true, data: body, reason_code: null, status: response.status };
  } catch (error) {
    return { available: false, data: null, reason_code: 'BROKER_ACCOUNT_UNAVAILABLE', error: error.message };
  }
}

function buildScannerBrokerState({ accountState, positionsState, openOrdersState }) {
  const states = { account: accountState, positions: positionsState, open_orders: openOrdersState };
  const reasonCodes = Object.values(states)
    .filter((state) => !state?.available)
    .map((state) => state.reason_code)
    .filter(Boolean);
  const buyingPower = safeNumber(accountState?.data?.buying_power ?? accountState?.data?.cash, null);
  if (accountState?.available && !Number.isFinite(buyingPower)) {
    reasonCodes.push('BUYING_POWER_UNAVAILABLE');
  }
  const strictBuyBlocked = reasonCodes.length > 0;
  if (strictBuyBlocked && !reasonCodes.includes('BROKER_STATE_REQUIRED_FOR_BUY')) {
    reasonCodes.push('BROKER_STATE_REQUIRED_FOR_BUY');
  }
  return {
    available: !strictBuyBlocked,
    strict_buy_blocked: strictBuyBlocked,
    reason_codes: [...new Set(reasonCodes)],
    account_available: Boolean(accountState?.available),
    positions_available: Boolean(positionsState?.available),
    open_orders_available: Boolean(openOrdersState?.available),
    buying_power_available: Number.isFinite(buyingPower),
    account_status: accountState?.status || null,
    positions_status: positionsState?.status || null,
    open_orders_status: openOrdersState?.status || null,
    errors: Object.entries(states).reduce((acc, [key, state]) => {
      if (state?.error) acc[key] = state.error;
      return acc;
    }, {}),
  };
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
  const attentionSymbols = Array.isArray(options.attentionSymbols) && options.attentionSymbols.length
    ? options.attentionSymbols.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean)
    : Array.isArray(options.approvedSymbols)
      ? options.approvedSymbols.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean)
      : [];
  const attentionSet = new Set(attentionSymbols);
  const dynamicWatchlistSymbols = options.dynamicWatchlistSymbols instanceof Set
    ? options.dynamicWatchlistSymbols
    : new Set(Array.isArray(options.dynamicWatchlistSymbols) ? options.dynamicWatchlistSymbols : []);
  const priorityOverrideSymbols = options.priorityOverrideSymbols instanceof Set
    ? options.priorityOverrideSymbols
    : new Set(Array.isArray(options.priorityOverrideSymbols) ? options.priorityOverrideSymbols : []);
  const priorityOverrideBonus = Math.max(0, safeNumber(options.priorityOverrideBonus, 1000));
  const regularWatchRankingEnabled = Boolean(options.regularWatchRankingEnabled);
  const regularWatchPositionAwarenessEnabled = Boolean(options.regularWatchPositionAwarenessEnabled);
  const regularWatchStatus = options.regularWatchStatus || null;
  const regularWatchEntryBySymbol = new Map();
  const regularWatchList = Array.isArray(regularWatchStatus?.regularWatchList) ? regularWatchStatus.regularWatchList : [];
  for (const entry of regularWatchList) {
    const entrySymbol = String(entry?.symbol || '').trim().toUpperCase();
    if (!entrySymbol || regularWatchEntryBySymbol.has(entrySymbol)) continue;
    regularWatchEntryBySymbol.set(entrySymbol, entry);
  }
  for (const symbol of symbols) {
    if (attentionSet.size && !attentionSet.has(symbol)) {
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
      stalePositionExitEnabled: options.stalePositionExitEnabled,
      stalePositionMaxHoldMinutes: options.stalePositionMaxHoldMinutes,
      stalePositionMinPeakProfitDollars: options.stalePositionMinPeakProfitDollars,
      stalePositionMaxExitPnlDollars: options.stalePositionMaxExitPnlDollars,
      maxStalenessSeconds: options.maxStalenessSeconds,
      stalledWinnerExitEnabled: options.stalledWinnerExitEnabled,
      stalledWinnerMaxHoldMinutes: options.stalledWinnerMaxHoldMinutes,
      stalledWinnerMaxMinutesSincePeak: options.stalledWinnerMaxMinutesSincePeak,
      stalledWinnerMinProfitDollars: options.stalledWinnerMinProfitDollars,
      sellNetProfitFloorDollars: options.sellNetProfitFloorDollars,
      trailingState: options.trailingState,
      previewMode: options.previewMode,
      previewReasonCodes: options.previewReasonCodes || [],
      position: positionsBySymbol.get(symbol) || null,
      openOrder: openOrdersBySymbol.get(symbol) || null,
      portfolio: options.portfolio || {},
      partialFillSummary: options.partialFillSummary,
      skipTracker: options.skipTracker,
      twelveDataQuote: options.twelveDataQuotes?.[symbol] || null,
      requireMultiSourceConfirmation: options.requireMultiSourceConfirmation,
      singleSourceMomentumEnabled: options.singleSourceMomentumEnabled,
      singleSourceMomentumMinRankScore: options.singleSourceMomentumMinRankScore,
      minMovePct: options.minMovePct,
      requireRecentMomentum: options.requireRecentMomentum,
      minRecentMovePct: options.minRecentMovePct,
      minRecentRangePct: options.minRecentRangePct,
      minRecentCloseLocationPct: options.minRecentCloseLocationPct,
      allowContrarianEntries: options.allowContrarianEntries,
      blockBuys: options.blockBuys,
      maxBuyRiskScore: options.maxBuyRiskScore,
      marketOpen: options.marketOpen,
      requireMarketOpen: options.requireMarketOpen,
      intradayRegime: options.intradayRegime,
      regimeBuysAllowed: options.regimeBuysAllowed,
      sellMaxPriceDiffPct: options.sellMaxPriceDiffPct,
      assetType: 'stock',
      excludedBuySymbols: options.excludedBuySymbols,
      riskBudgetSizingEnabled: options.riskBudgetSizingEnabled,
      positionSizingMode: options.positionSizingMode,
      maxBuyingPowerDeploymentPct: options.maxBuyingPowerDeploymentPct,
      buyingPowerMarketOrderBufferPct: options.buyingPowerMarketOrderBufferPct,
      buyingPowerCashReserve: options.buyingPowerCashReserve,
      allowBuyingPowerFractionalShares: options.allowBuyingPowerFractionalShares,
      maxRiskPerTradeDollars: options.maxRiskPerTradeDollars,
      maxRiskPerTradePctEquity: options.maxRiskPerTradePctEquity,
      maxTradeNotional: options.maxTradeNotional,
      minStopDistanceDollars: options.minStopDistanceDollars,
      maxStopDistanceDollars: options.maxStopDistanceDollars,
      allowRiskBudgetFractionalShares: options.allowRiskBudgetFractionalShares,
      riskBudgetRequireBrokerEquity: options.riskBudgetRequireBrokerEquity,
      sourceMode: options.scannerSymbolSource || null,
      sourceLists: options.sourceListsBySymbol?.get(symbol)?.source_lists || [],
      sourceList: options.sourceListsBySymbol?.get(symbol)?.source_lists?.[0] || null,
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
      allowRotationBuyEvaluation: options.allowRotationBuyEvaluation,
      rotationSoftBandPoints: options.rotationSoftBandPoints,
      rotationHardBandPoints: options.rotationHardBandPoints,
      rotationMinHoldScans: options.rotationMinHoldScans,
      position_avg_entry_price: safeNumber(positionsBySymbol.get(symbol)?.avg_entry_price ?? positionsBySymbol.get(symbol)?.avgEntryPrice ?? null),
      position_qty_available: safeNumber(positionsBySymbol.get(symbol)?.qty ?? positionsBySymbol.get(symbol)?.quantity ?? positionsBySymbol.get(symbol)?.qty_available ?? null),
    });
    if (candidate?.payload?.market_context?.scanner) {
      const scannerContext = candidate.payload.market_context.scanner;
      const isDynamicWatchSymbol = dynamicWatchlistSymbols.has(symbol);
      const isPriorityOverrideSymbol = priorityOverrideSymbols.has(symbol);
      const isPriorityOverrideApplied = isPriorityOverrideSymbol && candidate.payload.side === 'buy';
      const secondaryConfirmationAvailable = Boolean(candidate.payload?.twelve_data_quote);
      const secondaryConfirmationSource = secondaryConfirmationAvailable ? 'twelvedata' : 'alpaca-secondary';
      candidate.positionAwarenessTags = buildPositionAwarenessTags({
        symbol,
        candidate,
        position: positionsBySymbol.get(symbol) || null,
        openOrders: openOrdersBySymbol.get(symbol) || null,
        partialFillSummary: options.partialFillSummary || null,
        enabled: regularWatchPositionAwarenessEnabled,
      });
      const regularWatchEntry = regularWatchEntryBySymbol.get(symbol) || null;
      const regularWatchComparison = buildRegularWatchComparison({
        symbol,
        candidate,
        regularWatchEntry,
        regularWatchRankingEnabled,
      });
      const selectionV2 = options.scannerSelectionV2ShadowEnabled
        ? buildSelectionV2Score({
          symbol,
          snapshot,
          latestQuote,
          currentPrice: scannerContext.current_price,
          previousClose: scannerContext.previous_close,
          spreadPct: scannerContext.spread_pct,
          receivedAt: now,
          structureStop: scannerContext.structure_stop || null,
          regularWatchEntry,
          priorityOverride: {
            eligible: isPriorityOverrideSymbol,
            legacy_applied: isPriorityOverrideApplied,
          },
          options: options.scannerSelectionV2Config || {},
        })
        : null;
      scannerContext.dynamic_watchlist_member = isDynamicWatchSymbol;
      scannerContext.priority_override_eligible = isPriorityOverrideSymbol;
      scannerContext.priority_override_applied = isPriorityOverrideApplied;
      scannerContext.priority_override_bonus = isPriorityOverrideApplied ? priorityOverrideBonus : 0;
      scannerContext.priority_override_block_reason = null;
      scannerContext.secondary_confirmation_available = secondaryConfirmationAvailable;
      scannerContext.secondary_confirmation_source = secondaryConfirmationSource;
      scannerContext.regular_watch_comparison = regularWatchComparison;
      scannerContext.selection_v2 = selectionV2;
      scannerContext.selection_v2_shadow_only = Boolean(selectionV2);
      scannerContext.selection_v2_authoritative = false;
      candidate.dynamicWatchlistMember = isDynamicWatchSymbol;
      candidate.priorityOverrideEligible = isPriorityOverrideSymbol;
      candidate.priorityOverrideApplied = isPriorityOverrideApplied;
      candidate.priorityOverrideBonus = isPriorityOverrideApplied ? priorityOverrideBonus : 0;
      candidate.secondaryConfirmationAvailable = secondaryConfirmationAvailable;
      candidate.secondaryConfirmationSource = secondaryConfirmationSource;
      candidate.priorityOverrideSortScore = candidate.rankScore;
      candidate.regularWatchComparison = regularWatchComparison;
      candidate.selectionV2 = selectionV2;
      candidate.selectionV2SortScore = selectionV2?.qualified ? selectionV2.final_opportunity_score : Number.NEGATIVE_INFINITY;
      candidate.regularWatchSortScore = Number.isFinite(Number(regularWatchComparison?.sortScore))
        ? Number(regularWatchComparison.sortScore)
        : candidate.priorityOverrideSortScore;
      scannerContext.position_awareness_tags = candidate.positionAwarenessTags.slice();
      if (isPriorityOverrideApplied) {
        candidate.priorityOverrideBonus = priorityOverrideBonus;
        candidate.priorityOverrideSortScore = candidate.rankScore + priorityOverrideBonus;
        candidate.regularWatchSortScore = Math.max(candidate.regularWatchSortScore, candidate.priorityOverrideSortScore);
      }
    }
    if (candidate?.payload?.side === 'sell') {
      sellEntries.push(candidate);
    } else if (candidate?.payload?.side === 'buy') {
      buyEntries.push(candidate);
    }
  }
  buyEntries.sort((a, b) => {
    const aScore = Number.isFinite(Number(a.regularWatchSortScore))
      ? Number(a.regularWatchSortScore)
      : (Number.isFinite(Number(a.priorityOverrideSortScore)) ? Number(a.priorityOverrideSortScore) : Number(a.rankScore || 0));
    const bScore = Number.isFinite(Number(b.regularWatchSortScore))
      ? Number(b.regularWatchSortScore)
      : (Number.isFinite(Number(b.priorityOverrideSortScore)) ? Number(b.priorityOverrideSortScore) : Number(b.rankScore || 0));
    if (bScore !== aScore) return bScore - aScore;
    const rankDelta = Number(b.rankScore || 0) - Number(a.rankScore || 0);
    if (Math.abs(rankDelta) > 1e-9) return rankDelta;
    return String(a.symbol).localeCompare(String(b.symbol));
  });
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
      candidate.payload.market_context.scanner.candidate_lifecycle_selected = Boolean(lifecycleEntry?.status === 'selected' || lifecycleEntry?.status === 'entered');
    }
  }
  const limitedBuys = selectedBuyEntries.slice(0, Math.max(0, options.maxBuyCandidates ?? options.maxCandidatesPerRun ?? 2));
  return {
    candidates: [
      ...sellEntries,
      ...limitedBuys,
    ],
    allBuyCandidates: buyEntries,
    selectedBuyCandidates: selectedBuyEntries,
    candidateLifecycleResult,
  };
}

function summarizeDominantSkip(skipSummary = {}, recentSkips = []) {
  const entries = Object.entries(skipSummary || {}).filter(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0);
  entries.sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])));
  const top = entries[0] || null;
  const recent = Array.isArray(recentSkips) ? recentSkips.find((entry) => entry?.reason) : null;
  return {
    reason_code: top?.[0] || recent?.reason || null,
    count: top ? Number(top[1]) : 0,
    details: recent || null,
  };
}

function summarizeWaitingForBuy({ candidates = [], previewCandidates = [], results = [], brokerState = null, skipSummary = {}, recentSkips = [], marketClosedExecutionBlock = false } = {}) {
  const liveBuyCandidate = (Array.isArray(candidates) ? candidates : []).find((candidate) => candidate?.payload?.side === 'buy');
  const previewBuyCandidate = (Array.isArray(previewCandidates) ? previewCandidates : []).find((candidate) => candidate?.payload?.side === 'buy');
  const rejectedResult = (Array.isArray(results) ? results : []).find((result) => result?.accepted === false);
  const dominantSkip = summarizeDominantSkip(skipSummary, recentSkips);

  if (marketClosedExecutionBlock) {
    return {
      reason_code: 'SCANNER_PREVIEW_ONLY_MARKET_CLOSED',
      message: 'Scanner is showing preview candidates while live entry is blocked outside regular market hours.',
      candidate_symbol: previewBuyCandidate?.symbol || null,
      candidate_rank_score: previewBuyCandidate?.rankScore ?? null,
      source: 'scanner-preview',
    };
  }
  if (brokerState?.strict_buy_blocked) {
    return {
      reason_code: brokerState.reason_codes?.[0] || 'BROKER_STATE_REQUIRED_FOR_BUY',
      message: 'Live buy is blocked until fresh Alpaca account, positions, and open-order truth is available.',
      broker_reason_codes: brokerState.reason_codes || [],
      source: 'alpaca',
    };
  }
  if (rejectedResult) {
    const summary = summarizePostResult(rejectedResult);
    return {
      reason_code: summary.reason_codes?.[0] || summary.error || 'ORDER_SUBMISSION_REJECTED',
      message: summary.message || 'Top live candidate reached submission but was blocked by the risk or execution path.',
      candidate_symbol: summary.symbol || liveBuyCandidate?.symbol || null,
      broker_reason_codes: summary.reason_codes || [],
      source: 'risk-or-execution',
    };
  }
  if (Number(skipSummary?.MAX_POSITION_SLOTS_FILLED || 0) > 0) {
    return {
      reason_code: 'MAX_POSITION_SLOTS_FILLED',
      message: 'A candidate is ranked, but the one-position slot is occupied until Alpaca shows the current position closed.',
      candidate_symbol: liveBuyCandidate?.symbol || null,
      candidate_rank_score: liveBuyCandidate?.rankScore ?? null,
      source: 'broker-position-slot',
    };
  }
  if (liveBuyCandidate) {
    return {
      reason_code: 'LIVE_BUY_CANDIDATE_READY',
      message: 'A live buy candidate is ranked and eligible for the next submission path.',
      candidate_symbol: liveBuyCandidate.symbol,
      candidate_rank_score: liveBuyCandidate.rankScore ?? null,
      source: 'scanner-live',
    };
  }
  return {
    reason_code: dominantSkip.reason_code || 'NO_ELIGIBLE_BUY_CANDIDATE',
    message: dominantSkip.reason_code
      ? `No live buy was eligible because ${dominantSkip.reason_code} was the dominant gate.`
      : 'No live buy candidate is currently eligible.',
    candidate_symbol: dominantSkip.details?.symbol && dominantSkip.details.symbol !== '*' ? dominantSkip.details.symbol : null,
    source: dominantSkip.reason_code ? 'skip-summary' : 'scanner-live',
  };
}

function buildRegularWatchComparison({ symbol, candidate, regularWatchEntry = null, regularWatchRankingEnabled = false } = {}) {
  const scannerScore = safeNumber(candidate?.rankScore ?? candidate?.priorityOverrideSortScore, null);
  const regularWatchScore = safeNumber(regularWatchEntry?.score, null);
  const baseSortScore = safeNumber(candidate?.priorityOverrideSortScore ?? candidate?.rankScore, null);
  const scoreDelta = Number.isFinite(scannerScore) && Number.isFinite(regularWatchScore)
    ? Number((regularWatchScore - scannerScore).toFixed(2))
    : null;
  const rankingEligible = Boolean(
    regularWatchRankingEnabled
    && regularWatchEntry
    && regularWatchEntry.status !== 'blocked'
    && regularWatchEntry.scannerWatched !== false,
  );
  const rankingBonus = rankingEligible && Number.isFinite(regularWatchScore)
    ? Math.max(0, Math.round(regularWatchScore - (baseSortScore || 0)))
    : 0;
  const boundedSupplementalBonus = rankingEligible && Number.isFinite(regularWatchScore)
    ? Math.min(12, Math.max(0, ((regularWatchScore - 50) / 50) * 12))
    : 0;
  const sortScore = rankingEligible && Number.isFinite(regularWatchScore)
    ? regularWatchScore
    : baseSortScore;
  return {
    symbol,
    enabled: Boolean(regularWatchRankingEnabled),
    approved: true,
    rankingEligible,
    rankingApplied: rankingEligible && rankingBonus > 0,
    rankingBonus,
    boundedSupplementalBonus: roundScore(boundedSupplementalBonus),
    supplementalSortScore: Number.isFinite(baseSortScore) ? roundScore(baseSortScore + boundedSupplementalBonus) : null,
    preferredModel: 'scanner_market_score_plus_bounded_regular_watch_bonus',
    legacyModel: 'regular_watch_score_replaces_sort_score_when_enabled',
    scannerScore: Number.isFinite(scannerScore) ? scannerScore : null,
    regularWatchScore: Number.isFinite(regularWatchScore) ? regularWatchScore : null,
    scoreDelta,
    blockedReason: regularWatchEntry?.blockedReason || null,
    sources: Array.isArray(regularWatchEntry?.sourceStatus) ? regularWatchEntry.sourceStatus.slice() : [],
    sourceContributors: Array.isArray(regularWatchEntry?.sourceContributors) ? regularWatchEntry.sourceContributors.slice() : [],
    positionTags: Array.isArray(candidate?.positionAwarenessTags) ? candidate.positionAwarenessTags.slice() : [],
    baseSortScore: Number.isFinite(baseSortScore) ? baseSortScore : null,
    sortScore: Number.isFinite(sortScore) ? sortScore : null,
  };
}

function buildPositionAwarenessTags({ symbol, candidate = null, position = null, openOrders = null, partialFillSummary = null, enabled = false } = {}) {
  if (!enabled) return [];
  const tags = new Set();
  const qty = safeNumber(position?.qty ?? position?.quantity ?? position?.qty_available ?? candidate?.position_qty_available ?? 0, 0);
  const hasPosition = Number.isFinite(qty) && Math.abs(qty) > 0;
  if (!hasPosition) return [];
  const avgEntry = safeNumber(position?.avg_entry_price ?? position?.avgEntryPrice ?? candidate?.position_avg_entry_price ?? null, null);
  const currentPrice = safeNumber(candidate?.payload?.market_context?.scanner?.current_price ?? candidate?.currentPrice ?? null, null);
  const unrealizedPl = safeNumber(position?.unrealized_pl ?? position?.unrealizedPnl ?? position?.unrealized_intraday_pl ?? null, null);
  const pnlPct = Number.isFinite(avgEntry) && avgEntry > 0 && Number.isFinite(currentPrice)
    ? ((currentPrice - avgEntry) / avgEntry) * 100
    : null;
  const recentOrders = Array.isArray(openOrders) ? openOrders : [];
  const hasOpenSellOrder = recentOrders.some((order) => String(order?.symbol || '').trim().toUpperCase() === String(symbol || '').trim().toUpperCase() && String(order?.side || '').toLowerCase() === 'sell');
  const hasPartialFill = Boolean(findPendingPartialForSymbol(partialFillSummary || {}, symbol, 'sell') || findPendingPartialForSymbol(partialFillSummary || {}, symbol, 'buy'));
  const staleMarket = Boolean(candidate?.stale);
  if (Number.isFinite(pnlPct) && pnlPct >= 12) tags.add('strong_runner');
  if (Number.isFinite(pnlPct) && Math.abs(pnlPct) <= 1.5) tags.add('weak_flat');
  if ((Number.isFinite(unrealizedPl) && Math.abs(unrealizedPl) <= 0.25) || (Number.isFinite(pnlPct) && Math.abs(pnlPct) <= 0.5 && staleMarket)) tags.add('break_even_stale');
  if (hasOpenSellOrder || hasPartialFill) tags.add('do_not_evict');
  if (candidate?.rotationEligible || candidate?.payload?.market_context?.scanner?.candidate_lifecycle_selected) tags.add('rotation_candidate');
  if (candidate?.payload?.market_context?.scanner?.priority_override_applied) tags.add('priority_override_active');
  if (tags.size === 0 && Number.isFinite(pnlPct) && pnlPct > 0) tags.add('profitable_hold');
  return [...tags];
}

function buildStockCandidateForSymbol(symbol, snapshot, latestQuote, options = {}) {
  const skip = (reason, details = {}) => {
    options.skipTracker?.record?.(reason, { symbol, ...details });
    return null;
  };
  const previewMode = Boolean(options.previewMode);
  const previewReasonCodes = [];
  const maxStalenessSeconds = Math.max(1, safeNumber(options.maxStalenessSeconds ?? 20000000, 20000000));
  const receivedAt = options.receivedAt || nowIso();
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
  const newestMarketTimestampMs = getNewestMarketTimestampMs(snapshot, quote);
  const marketAgeSeconds = Number.isFinite(newestMarketTimestampMs)
    ? Math.max(0, (new Date(receivedAt).getTime() - newestMarketTimestampMs) / 1000)
    : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(marketAgeSeconds) || marketAgeSeconds > maxStalenessSeconds) {
    return skip('DATA_STALE_OR_UNAVAILABLE', {
      market_age_seconds: Number.isFinite(marketAgeSeconds) ? roundScore(marketAgeSeconds) : null,
      max_staleness_seconds: maxStalenessSeconds,
    });
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
    if (previewMode) {
      previewReasonCodes.push(...(options.sessionGuards.reason_codes || [options.sessionGuards.reason_code || 'MANAGE_ONLY_MODE_ACTIVE']).filter(Boolean));
    } else {
      return skip(options.sessionGuards.reason_codes?.[0] || 'MANAGE_ONLY_MODE_ACTIVE', {
        reason_codes: options.sessionGuards.reason_codes || [],
        explanation: options.sessionGuards.explanation || null,
        expires_at: options.sessionGuards.expires_at || null,
      });
    }
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
  if (options.blockBuys) {
    if (previewMode) previewReasonCodes.push('BUY_SIDE_BLOCKED');
    else return skip('BUY_SIDE_BLOCKED');
  }
  if (options.requireMarketOpen && options.marketOpen === false) {
    if (previewMode) previewReasonCodes.push('MARKET_CLOSED_FOR_STOCKS');
    else return skip('MARKET_CLOSED_FOR_STOCKS');
  }
  if (options.regimeBuysAllowed === false) {
    if (previewMode) previewReasonCodes.push(options.intradayRegime?.reason_code || 'INTRADAY_REGIME_BUY_BLOCK');
    else return skip(options.intradayRegime?.reason_code || 'INTRADAY_REGIME_BUY_BLOCK', { regime: options.intradayRegime?.regime || null });
  }
  if (options.allocation && options.allocation.accepted === false && !(options.allowRotationBuyEvaluation && options.allocation.reason === 'MAX_POSITION_SLOTS_FILLED')) {
    if (previewMode) previewReasonCodes.push(options.allocation.reason || 'ALLOCATION_BLOCKED');
    else return skip(options.allocation.reason || 'ALLOCATION_BLOCKED');
  }
  if (!options.allowRotationBuyEvaluation && options.portfolio?.remaining_position_slots !== null && options.portfolio?.remaining_position_slots <= 0) {
    if (previewMode) previewReasonCodes.push('MAX_POSITION_SLOTS_FILLED');
    else return skip('MAX_POSITION_SLOTS_FILLED');
  }
  if (Array.isArray(options.excludedBuySymbols) && options.excludedBuySymbols.includes(symbol)) {
    if (previewMode) previewReasonCodes.push('SYMBOL_EXCLUDED_FROM_BUYS');
    else return skip('SYMBOL_EXCLUDED_FROM_BUYS');
  }

  const candidate = buildBuyCandidate({ symbol, snapshot, latestQuote, currentPrice, previousClose, spreadPct, options: { ...options, previewMode, previewReasonCodes } });
  if (candidate && previewMode) {
    candidate.previewOnly = true;
    candidate.executionBlocked = true;
    candidate.marketClosedExecutionBlock = Boolean(options.marketOpen === false);
    candidate.previewReasonCodes = [...new Set(previewReasonCodes.length ? previewReasonCodes : ['MARKET_CLOSED_FOR_STOCKS'])];
    candidate.sourceContributors = [
      'alpaca',
      candidate.secondaryConfirmationSource,
    ].filter(Boolean);
    candidate.payload.preview_only = true;
    candidate.payload.execution_blocked = true;
    candidate.payload.market_context.scanner.preview_only = true;
    candidate.payload.market_context.scanner.execution_blocked = true;
    candidate.payload.market_context.scanner.market_closed_execution_block = Boolean(options.marketOpen === false);
    candidate.payload.market_context.scanner.preview_reason_codes = candidate.previewReasonCodes.slice();
  }
  return candidate;
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

function loadRecentTradePenalties({ env = process.env, repoRoot = resolveRepoRoot(), now = nowIso(), windowMinutes = 5, penalty = 8, lossWindowMinutes = 10, lossPenalty = 60, staleWindowMinutes = 20, stalePenalty = 40, stopWindowMinutes = 30, stopPenalty = 80, overrides = null } = {}) {
  if ((!windowMinutes || !penalty) && (!lossWindowMinutes || !lossPenalty) && (!staleWindowMinutes || !stalePenalty) && (!stopWindowMinutes || !stopPenalty)) return new Map();
  if (overrides) return normalizeRecentTradePenaltyMap(overrides, { now, windowMinutes, penalty, lossWindowMinutes, lossPenalty, staleWindowMinutes, stalePenalty, stopWindowMinutes, stopPenalty });
  const historyPath = resolvePerformanceHistoryPath(env, repoRoot);
  const lines = readTailLines(historyPath, 512 * 1024);
  return normalizeRecentTradePenaltyMap(lines.map(parseJsonLine).filter(Boolean), { now, windowMinutes, penalty, lossWindowMinutes, lossPenalty, staleWindowMinutes, stalePenalty, stopWindowMinutes, stopPenalty });
}

function resolvePerformanceHistoryPath(env = process.env, repoRoot = resolveRepoRoot()) {
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

function normalizeRecentTradePenaltyMap(source, { now = nowIso(), windowMinutes = 15, penalty = 20, lossWindowMinutes = 10, lossPenalty = 60, staleWindowMinutes = 20, stalePenalty = 40, stopWindowMinutes = 30, stopPenalty = 80 } = {}) {
  const map = new Map();
  const nowMs = new Date(now).getTime();
  const windowMs = Math.max(0, safeNumber(windowMinutes, 15)) * 60_000;
  const lossWindowMs = Math.max(0, safeNumber(lossWindowMinutes, 10)) * 60_000;
  const staleWindowMs = Math.max(0, safeNumber(staleWindowMinutes, 20)) * 60_000;
  const stopWindowMs = Math.max(0, safeNumber(stopWindowMinutes, 30)) * 60_000;
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
    const isStaleExit = trade.side === 'sell' && trade.stale_exit;
    const isStopExit = trade.side === 'sell' && trade.stop_exit;
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
    if (isStaleExit && staleWindowMs > 0 && stalePenalty > 0 && ageMs <= staleWindowMs) {
      components.push(buildPenaltyComponent({
        trade,
        tradedAtMs,
        nowMs,
        windowMs: staleWindowMs,
        penalty: stalePenalty,
        reason: 'recent_stale_exit',
      }));
    }
    if (isStopExit && stopWindowMs > 0 && stopPenalty > 0 && ageMs <= stopWindowMs) {
      components.push(buildPenaltyComponent({
        trade,
        tradedAtMs,
        nowMs,
        windowMs: stopWindowMs,
        penalty: stopPenalty,
        reason: 'recent_stop_exit',
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
    existing.reason = summarizePenaltyReason(existing.components);
    existing.loss_exit = existing.components.some((component) => component.loss_exit);
    existing.stop_exit = existing.components.some((component) => component.stop_exit);
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
    stop_exit: Boolean(trade.stop_exit),
    exit_reason: trade.exit_reason || null,
  };
}

function summarizePenaltyReason(components = []) {
  const reasons = new Set(components.map((component) => component.reason).filter(Boolean));
  if (reasons.has('recent_stop_exit') && reasons.has('recent_loss_exit')) return 'compound_recent_sell_loss_and_stop';
  if (reasons.has('recent_stale_exit') && reasons.has('recent_loss_exit')) return 'compound_recent_sell_loss_and_stale';
  if (reasons.has('recent_stale_exit')) return 'compound_recent_sell_and_stale';
  if (reasons.has('recent_stop_exit')) return 'compound_recent_sell_and_stop';
  if (reasons.has('recent_loss_exit')) return 'compound_recent_sell_and_loss';
  return 'compound_recent_sell';
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
  const stopExit = side === 'sell' && /STOP/i.test(exitReason);
  const staleExit = side === 'sell' && /STALE_POSITION_TIMEOUT/i.test(exitReason);
  return {
    symbol,
    traded_at: tradedAt,
    side,
    loss_exit: lossExit,
    stale_exit: staleExit,
    stop_exit: stopExit,
    exit_reason: exitReason || null,
  };
}

function summarizePreviewCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate && candidate.payload?.side === 'buy')
    .slice()
    .sort((a, b) => {
      const aScore = Number(a.rankScore || 0);
      const bScore = Number(b.rankScore || 0);
      if (bScore !== aScore) return bScore - aScore;
      return String(a.symbol || '').localeCompare(String(b.symbol || ''));
    })
    .map((candidate) => {
      const reasonCodes = Array.isArray(candidate.previewReasonCodes) && candidate.previewReasonCodes.length
        ? candidate.previewReasonCodes
        : Array.isArray(candidate.payload?.market_context?.scanner?.preview_reason_codes)
          ? candidate.payload.market_context.scanner.preview_reason_codes
          : [];
      const sourceContributors = [
        'alpaca',
        candidate.secondaryConfirmationSource,
      ].filter(Boolean);
      return {
        symbol: candidate.symbol,
        source: 'scanner',
        source_mode: candidate.payload?.market_context?.scanner?.source_mode || candidate.sourceMode || null,
        source_list: candidate.payload?.market_context?.scanner?.source_list || candidate.sourceList || null,
        source_lists: Array.isArray(candidate.payload?.market_context?.scanner?.source_lists)
          ? candidate.payload.market_context.scanner.source_lists.slice()
          : uniqueSourceLabels(candidate.sourceLists || []),
        source_contributors: sourceContributors,
        status: 'preview_only',
        execution_blocked: true,
        executionBlocked: true,
        market_closed_execution_block: Boolean(candidate.marketClosedExecutionBlock ?? candidate.payload?.market_context?.scanner?.market_closed_execution_block),
        rank_score: roundScore(candidate.rankScore),
        base_rank_score: roundScore(candidate.baseRankScore ?? candidate.rankScore),
        adjusted_rank_score: roundScore(candidate.rankScore),
        recent_trade_rank_penalty: roundScore(candidate.recentTradeRankPenalty || 0),
        setup_rank_penalty: roundScore(candidate.setupRankPenalty || 0),
        execution_quality_rank_penalty: roundScore(candidate.executionQualityRankPenalty || 0),
        spread_rank_penalty: roundScore(candidate.spreadRankPenalty || 0),
        total_rank_penalty: roundScore(candidate.totalRankPenalty ?? candidate.recentTradeRankPenalty ?? 0),
        reason_codes: reasonCodes,
        preview_reason_codes: reasonCodes,
        secondary_confirmation_source: candidate.secondaryConfirmationSource || null,
        sizing_method: candidate.payload?.sizing_method || 'fixed_notional',
        risk_budget_sizing: candidate.payload?.risk_budget_sizing || null,
        structure_stop: candidate.payload?.structure_stop || null,
        current_price: candidate.payload?.market_context?.scanner?.current_price ?? null,
        previous_close: candidate.payload?.market_context?.scanner?.previous_close ?? null,
        move_pct: candidate.payload?.market_context?.scanner?.move_pct ?? null,
        spread_pct: candidate.payload?.market_context?.scanner?.spread_pct ?? null,
        volume: candidate.payload?.volume ?? candidate.volume ?? null,
        volume_multiple: candidate.payload?.market_context?.scanner?.volume_multiple ?? null,
        dynamic_watchlist_member: Boolean(candidate.payload?.market_context?.scanner?.dynamic_watchlist_member),
        priority_override_eligible: Boolean(candidate.payload?.market_context?.scanner?.priority_override_eligible),
        priority_override_applied: Boolean(candidate.payload?.market_context?.scanner?.priority_override_applied),
        priority_override_block_reason: candidate.payload?.market_context?.scanner?.priority_override_block_reason || null,
        secondary_confirmation_available: Boolean(candidate.secondaryConfirmationAvailable),
      };
    });
}

function normalizeWatchSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function getRecentTradePenalty(penalties, symbol) {
  if (!penalties) return null;
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return null;
  if (penalties instanceof Map) return penalties.get(normalized) || null;
  return penalties[normalized] || null;
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
    stop_exit: Boolean(entry.stop_exit),
    exit_reason: entry.exit_reason || null,
    components: Array.isArray(entry.components) ? entry.components : [],
  }));
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

function resolveScannerSymbolUniverse({
  env = process.env,
  repoRoot = resolveRepoRoot(),
  dataDir = path.resolve(repoRoot, 'data'),
  regularWatchStatusPath = null,
  dynamicHotListPath = null,
  approvedSymbols = [],
  scannerSymbolSource = 'dynamic',
  currentDate = nowIso(),
  regularWatchStatus = null,
  dynamicHotList = null,
} = {}) {
  const mode = normalizeScannerSymbolSource(scannerSymbolSource);
  const approved = uniqueNormalizedSymbols(approvedSymbols);
  const regularWatch = regularWatchStatus || loadRegularWatchStatus({
    env,
    repoRoot,
    filePath: regularWatchStatusPath || resolveRegularWatchStatusPath({ dataDir, repoRoot }),
  });
  const hotList = dynamicHotList || loadDynamicHotList({
    dataDir,
    filePath: dynamicHotListPath || resolveDynamicHotListPath({ dataDir, repoRoot }),
    env,
    now: currentDate,
  });
  const regularWatchListSymbols = uniqueNormalizedSymbols((Array.isArray(regularWatch?.regularWatchList) ? regularWatch.regularWatchList : []).map((entry) => entry?.symbol));
  const regularWatchMoverSymbols = uniqueNormalizedSymbols((Array.isArray(regularWatch?.regularWatchMovers) ? regularWatch.regularWatchMovers : []).map((entry) => entry?.symbol));
  const dynamicHotSymbols = uniqueNormalizedSymbols((Array.isArray(hotList?.dynamicHotList) ? hotList.dynamicHotList : []).map((entry) => entry?.symbol));
  const hotHotSymbols = uniqueNormalizedSymbols((Array.isArray(hotList?.hotHotList) ? hotList.hotHotList : []).map((entry) => entry?.symbol));
  const dynamicSourceSymbols = uniqueNormalizedSymbols([
    ...regularWatchListSymbols,
    ...regularWatchMoverSymbols,
    ...dynamicHotSymbols,
    ...hotHotSymbols,
  ]);
  const activeSymbols = mode === 'approved'
    ? approved
    : mode === 'hybrid'
      ? uniqueNormalizedSymbols([...approved, ...dynamicSourceSymbols])
      : dynamicSourceSymbols;
  const dynamicSourceEmpty = mode === 'dynamic' && activeSymbols.length === 0;
  const sourceListsBySymbol = new Map();
  const addSource = (symbol, sourceKey) => {
    const normalized = normalizeWatchSymbol(symbol);
    if (!normalized) return;
    const current = sourceListsBySymbol.get(normalized) || { source_lists: [], source_mode: mode };
    const label = mapSourceLabel(sourceKey);
    if (label && !current.source_lists.includes(label)) current.source_lists.push(label);
    sourceListsBySymbol.set(normalized, current);
  };

  if (mode !== 'dynamic') {
    for (const symbol of approved) addSource(symbol, 'approved');
  }
  for (const symbol of regularWatchListSymbols) addSource(symbol, 'regular_watch_list');
  for (const symbol of regularWatchMoverSymbols) addSource(symbol, 'regular_watch_movers_list');
  for (const symbol of dynamicHotSymbols) addSource(symbol, 'dynamic_hot_list');
  for (const symbol of hotHotSymbols) addSource(symbol, 'hot_hot_list');

  return {
    scannerSymbolSource: mode,
    approvedSymbols: approved,
    activeSymbols,
    dynamicSourceEmpty,
    regularWatchListSymbols,
    regularWatchMoverSymbols,
    dynamicHotSymbols,
    hotHotSymbols,
    dynamicSourceSymbols,
    sourceCounts: {
      approved_source_count: approved.length,
      regular_watch_source_count: regularWatchListSymbols.length,
      regular_watch_movers_source_count: regularWatchMoverSymbols.length,
      regular_watch_full_universe_count: Number(regularWatch?.universe?.full_eligible_count || regularWatch?.universe?.fullEligibleCount || regularWatchListSymbols.length),
      regular_watch_current_batch_count: Number(regularWatch?.universe?.current_batch_size || regularWatchListSymbols.length),
      regular_watch_rotation_batch_count: Number(regularWatch?.universe?.rotation_batch_size || regularWatch?.universe?.rotationBatchSize || regularWatch?.universe?.current_batch_size || regularWatchListSymbols.length),
      regular_watch_fast_lane_count: Number(regularWatch?.universe?.fast_lane_candidate_count || regularWatch?.universe?.fastLaneCandidateCount || 0),
      regular_watch_fast_lane_limit: Number(regularWatch?.universe?.fast_lane_limit || regularWatch?.universe?.fastLaneLimit || 0),
      regular_watch_merged_scan_size: Number(regularWatch?.universe?.merged_scan_size || regularWatch?.universe?.mergedScanSize || regularWatchListSymbols.length),
      regular_watch_scanned_today_count: Number(regularWatch?.universe?.scanned_today_count || 0),
      regular_watch_fresh_data_count: Number(regularWatch?.universe?.fresh_data_count || 0),
      regular_watch_displayed_top_limit: Number(regularWatch?.universe?.displayed_top_limit || 100),
      dynamic_hot_source_count: dynamicHotSymbols.length,
      hot_hot_source_count: hotHotSymbols.length,
      dynamic_source_count: dynamicSourceSymbols.length,
      active_source_count: activeSymbols.length,
    },
    sourceListsBySymbol,
    regularWatch,
    hotList,
  };
}

function resolveScannerWatchConfig({
  env = process.env,
  repoRoot = resolveRepoRoot(),
  dataDir = path.resolve(repoRoot, 'data'),
  memeMonitorStatePath = null,
  dynamicHotListPath = null,
  regularWatchStatusPath = null,
  regularWatchStatus = null,
  approvedSymbols = [],
  attentionSymbols = null,
  scannerSymbolSource = null,
  currentDate = nowIso(),
} = {}) {
  const state = loadMemeMonitorState({
    env,
    repoRoot,
    filePath: memeMonitorStatePath || resolveMemeMonitorStatePath({ dataDir, repoRoot }),
  });
  const dynamicFeature = state?.features?.MEME_DYNAMIC_WATCHLIST_ENABLED;
  const priorityFeature = state?.features?.MEME_PRIORITY_OVERRIDE_ENABLED;
  const dynamicEnabled = Boolean(dynamicFeature?.effective);
  const priorityEnabled = Boolean(priorityFeature?.effective);
  const hotListEnabled = Boolean(state?.features?.MEME_HOT_LIST_ENABLED?.effective);
  const resolvedScannerSymbolSource = scannerSymbolSource
    ?? (dynamicEnabled ? 'dynamic' : 'approved');
  const sourceUniverse = resolveScannerSymbolUniverse({
    env,
    repoRoot,
    dataDir,
    regularWatchStatusPath,
    dynamicHotListPath,
    approvedSymbols,
    scannerSymbolSource: resolvedScannerSymbolSource,
    currentDate,
    regularWatchStatus,
  });
  const approved = sourceUniverse.approvedSymbols;
  const attention = Array.isArray(attentionSymbols) && attentionSymbols.length
    ? uniqueNormalizedSymbols(attentionSymbols)
    : sourceUniverse.activeSymbols;
  const dynamicWatchlistSymbols = new Set();
  const priorityOverrideSymbols = new Set();
  const hotListActive = Boolean(sourceUniverse.hotList?.enabled) && !sourceUniverse.hotList?.stale;

  if (dynamicEnabled && hotListEnabled && hotListActive) {
    const dynamicEntries = Array.isArray(sourceUniverse.hotList?.dynamicHotList) ? sourceUniverse.hotList.dynamicHotList : [];
    const hotHotEntries = Array.isArray(sourceUniverse.hotList?.hotHotList) ? sourceUniverse.hotList.hotHotList : [];
    for (const entry of [...dynamicEntries, ...hotHotEntries]) {
      const symbol = normalizeWatchSymbol(entry?.symbol);
      if (!symbol) continue;
      if (entry?.status === 'ignore' || entry?.expired) continue;
      dynamicWatchlistSymbols.add(symbol);
      if (priorityEnabled && entry?.status === 'hot_hot') {
        priorityOverrideSymbols.add(symbol);
      }
    }
  }

  return {
    scannerSymbolSource: sourceUniverse.scannerSymbolSource,
    approvedSymbols: approved,
    attentionSymbols: attention,
    dynamicWatchlistSymbols,
    priorityOverrideSymbols,
    priorityOverrideBonus: 1000,
    state,
    hotList: sourceUniverse.hotList,
    dynamicEnabled,
    priorityEnabled,
    hotListActive,
    dynamicSourceEmpty: sourceUniverse.dynamicSourceEmpty,
    sourceCounts: sourceUniverse.sourceCounts,
    sourceListsBySymbol: sourceUniverse.sourceListsBySymbol,
  };
}

function rankScannerBuyCandidates(candidates = [], options = {}) {
  const priorityOverrideSymbols = options.priorityOverrideSymbols instanceof Set
    ? options.priorityOverrideSymbols
    : new Set(Array.isArray(options.priorityOverrideSymbols) ? options.priorityOverrideSymbols : []);
  const priorityOverrideBonus = Math.max(0, safeNumber(options.priorityOverrideBonus, 1000));
  return [...candidates].sort((a, b) => {
    const aSymbol = normalizeWatchSymbol(a?.symbol);
    const bSymbol = normalizeWatchSymbol(b?.symbol);
    const aScore = Number(a?.priorityOverrideSortScore)
      || (priorityOverrideSymbols.has(aSymbol) ? Number(a?.rankScore || 0) + priorityOverrideBonus : Number(a?.rankScore || 0));
    const bScore = Number(b?.priorityOverrideSortScore)
      || (priorityOverrideSymbols.has(bSymbol) ? Number(b?.rankScore || 0) + priorityOverrideBonus : Number(b?.rankScore || 0));
    if (bScore !== aScore) return bScore - aScore;
    const rankDelta = Number(b?.rankScore || 0) - Number(a?.rankScore || 0);
    if (Math.abs(rankDelta) > 1e-9) return rankDelta;
    return String(aSymbol).localeCompare(String(bSymbol));
  });
}

function calculateEffectiveStopLossDollars({
  baseStopLossDollars = 1,
  stopLossNotionalPct = 0,
  stopLossMaxDollars = baseStopLossDollars,
  positionMarketValue = null,
  positionQuantity = null,
} = {}) {
  const base = Math.abs(safeNumber(baseStopLossDollars, 1));
  const quantity = Math.abs(safeNumber(positionQuantity, NaN));
  const quantityMultiplier = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  const basePositionStop = roundCurrency(base * quantityMultiplier);
  const maxStop = Math.max(basePositionStop, Math.abs(safeNumber(stopLossMaxDollars, base)) * quantityMultiplier);
  const notionalPct = Math.max(0, safeNumber(stopLossNotionalPct, 0));
  const marketValue = Math.abs(safeNumber(positionMarketValue, NaN));
  const notionalStop = Number.isFinite(marketValue) && marketValue > 0 && notionalPct > 0
    ? marketValue * (notionalPct / 100)
    : basePositionStop;
  return roundCurrency(Math.min(maxStop, Math.max(basePositionStop, notionalStop)));
}

function buildExitCandidate({ symbol, snapshot, latestQuote, currentPrice, previousClose, spreadPct, positionQty, options }) {
  const unrealized = safeNumber(options.position?.unrealized_pl ?? options.position?.unrealizedPnl ?? options.position?.unrealized_intraday_pl, null);
  const trailingRecord = options.trailingState?.positions?.[symbol] || {};
  const stopLossDollars = options.stopLossDollars ?? 1;
  const stopLossNotionalPct = Math.max(0, safeNumber(options.stopLossNotionalPct, 0));
  const stopLossMaxDollars = Math.max(Math.abs(stopLossDollars), safeNumber(options.stopLossMaxDollars, Math.abs(stopLossDollars)));
  const trailingStart = options.trailingProfitStartDollars ?? 0.5;
  const trailingGiveback = options.trailingProfitGivebackDollars ?? 0.3;
  const sellNetProfitFloorDollars = Math.max(0, safeNumber(options.sellNetProfitFloorDollars, 0));
  const peak = safeNumber(trailingRecord.peak_unrealized_pl, null);
  const openedAt = normalizeIso(options.position?.opened_at || options.position?.filled_at || trailingRecord.opened_at || trailingRecord.first_seen_at || null);
  const peakUpdatedAt = normalizeIso(trailingRecord.peak_updated_at || trailingRecord.trailing_started_at || openedAt || null);
  const heldSeconds = openedAt ? Math.max(0, (new Date(options.receivedAt || nowIso()).getTime() - new Date(openedAt).getTime()) / 1000) : null;
  const secondsSincePeak = peakUpdatedAt ? Math.max(0, (new Date(options.receivedAt || nowIso()).getTime() - new Date(peakUpdatedAt).getTime()) / 1000) : null;
  const staleExitEnabled = Boolean(options.stalePositionExitEnabled);
  const staleMaxHoldSeconds = Math.max(1, safeNumber(options.stalePositionMaxHoldMinutes, 12)) * 60;
  const staleMinPeakProfit = Math.max(0, safeNumber(options.stalePositionMinPeakProfitDollars, 0.25));
  const staleMaxExitPnl = safeNumber(options.stalePositionMaxExitPnlDollars, 0);
  const stalledWinnerExitEnabled = Boolean(options.stalledWinnerExitEnabled);
  const stalledWinnerMaxHoldSeconds = Math.max(1, safeNumber(options.stalledWinnerMaxHoldMinutes, 18)) * 60;
  const stalledWinnerMaxSecondsSincePeak = Math.max(1, safeNumber(options.stalledWinnerMaxMinutesSincePeak, 8)) * 60;
  const stalledWinnerMinProfit = Math.max(0, safeNumber(options.stalledWinnerMinProfitDollars, 1));
  const entryPrice = safeNumber(options.position?.avg_entry_price ?? options.position?.avgEntryPrice ?? options.position_avg_entry_price, null);
  const entrySlippage = Math.max(0, safeNumber(options.position?.entry_slippage ?? options.position?.entrySlippage, 0));
  const exitSlippage = Math.max(0, safeNumber(options.exitSlippage ?? options.position?.exit_slippage ?? options.position?.exitSlippage, 0));
  const fees = Math.max(0, safeNumber(options.fees ?? options.position?.fees ?? options.position?.estimated_fees, 0));
  const executionDrag = entrySlippage + exitSlippage + fees;
  const effectiveTrailingStart = Math.max(trailingStart, sellNetProfitFloorDollars + trailingGiveback + executionDrag);
  const staleRecyclePeakCeiling = Math.max(staleMinPeakProfit, effectiveTrailingStart);
  const trailingActive = Number.isFinite(peak) && peak >= effectiveTrailingStart;
  const trailingSellAt = trailingActive ? peak - trailingGiveback : null;
  const brokerPnlTrusted = options.position?.current_price !== undefined || options.position?.currentPrice !== undefined || options.position?.market_value !== undefined || options.position?.marketValue !== undefined;
  const grossPnl = brokerPnlTrusted && Number.isFinite(unrealized)
    ? unrealized
    : Number.isFinite(entryPrice)
      ? (currentPrice - entryPrice) * Math.abs(positionQty)
      : null;
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
    positionQuantity: positionQty,
  });
  const stopLossPerShare = Math.abs(positionQty) > 0 ? effectiveStopLossDollars / Math.abs(positionQty) : null;
  const hardStopPrice = Number.isFinite(entryPrice) && Number.isFinite(stopLossPerShare)
    ? Math.max(0.01, entryPrice - stopLossPerShare)
    : null;
  const distanceToStopPerShare = Number.isFinite(currentPrice) && Number.isFinite(hardStopPrice)
    ? currentPrice - hardStopPrice
    : null;
  let exitReason = null;
  let exitMode = trailingActive ? 'profit_protection_active' : 'pre_target_hard_stop_only';
  if (Number.isFinite(unrealized) && unrealized <= -effectiveStopLossDollars) {
    exitReason = 'STOP_LOSS_DOLLARS';
    exitMode = 'hard_stop_triggered';
  } else if (trailingActive && Number.isFinite(unrealized) && unrealized <= trailingSellAt) {
    exitReason = 'TRAILING_PROFIT_GIVEBACK';
    exitMode = 'trailing_profit_giveback_triggered';
  } else if (
    stalledWinnerExitEnabled
    && trailingActive
    && Number.isFinite(heldSeconds)
    && heldSeconds >= stalledWinnerMaxHoldSeconds
    && Number.isFinite(secondsSincePeak)
    && secondsSincePeak >= stalledWinnerMaxSecondsSincePeak
    && Number.isFinite(netPnl)
    && netPnl >= stalledWinnerMinProfit
  ) {
    exitReason = 'STALLED_WINNER_TIMEOUT';
    exitMode = 'stalled_winner_recycle';
  } else if (
    staleExitEnabled
    && !trailingActive
    && Number.isFinite(heldSeconds)
    && heldSeconds >= staleMaxHoldSeconds
    && safeNumber(peak, Number.NEGATIVE_INFINITY) < staleRecyclePeakCeiling
    && Number.isFinite(netPnl)
    && netPnl <= staleMaxExitPnl
  ) {
    exitReason = 'STALE_POSITION_TIMEOUT';
    exitMode = 'stale_position_recycle';
  }
  const exitState = {
    symbol,
    exit_mode: exitMode,
    unrealized_pl: Number.isFinite(unrealized) ? roundCurrency(unrealized) : null,
    stop_loss_dollars: roundCurrency(effectiveStopLossDollars),
    stop_loss_total_dollars: roundCurrency(effectiveStopLossDollars),
    stop_loss_per_share: Number.isFinite(stopLossPerShare) ? roundCurrency(stopLossPerShare) : null,
    hard_stop_price: Number.isFinite(hardStopPrice) ? roundCurrency(hardStopPrice) : null,
    base_stop_loss_dollars: roundCurrency(Math.abs(stopLossDollars)),
    stop_loss_notional_pct: roundCurrency(stopLossNotionalPct),
    stop_loss_max_dollars: roundCurrency(stopLossMaxDollars),
    position_market_value: Number.isFinite(positionMarketValue) ? roundCurrency(positionMarketValue) : null,
    distance_to_stop_dollars: Number.isFinite(unrealized) ? roundCurrency(unrealized + effectiveStopLossDollars) : null,
    distance_to_stop_per_share: Number.isFinite(distanceToStopPerShare) ? roundCurrency(distanceToStopPerShare) : null,
    profit_protection_active: trailingActive,
    trailing_active: trailingActive,
    trailing_peak_unrealized_pl: Number.isFinite(peak) ? roundCurrency(peak) : null,
    trailing_activation_profit_dollars: roundCurrency(effectiveTrailingStart),
    trailing_sell_if_unrealized_pl_at_or_below: Number.isFinite(trailingSellAt) ? roundCurrency(trailingSellAt) : null,
    sell_net_profit_floor_dollars: roundCurrency(sellNetProfitFloorDollars),
    sell_price: Number.isFinite(currentPrice) ? roundCurrency(currentPrice) : null,
    entry_price: Number.isFinite(entryPrice) ? roundCurrency(entryPrice) : null,
    quantity: Number(Math.abs(positionQty).toFixed(6)),
    opened_at: openedAt,
    peak_updated_at: peakUpdatedAt,
    held_seconds: Number.isFinite(heldSeconds) ? Math.round(heldSeconds) : null,
    seconds_since_peak: Number.isFinite(secondsSincePeak) ? Math.round(secondsSincePeak) : null,
    stale_position_exit_enabled: staleExitEnabled,
    stale_position_max_hold_seconds: Math.round(staleMaxHoldSeconds),
    stale_position_min_peak_profit_dollars: roundCurrency(staleMinPeakProfit),
    stale_position_max_exit_pnl_dollars: roundCurrency(staleMaxExitPnl),
    stalled_winner_exit_enabled: stalledWinnerExitEnabled,
    stalled_winner_max_hold_seconds: Math.round(stalledWinnerMaxHoldSeconds),
    stalled_winner_max_seconds_since_peak: Math.round(stalledWinnerMaxSecondsSincePeak),
    stalled_winner_min_profit_dollars: roundCurrency(stalledWinnerMinProfit),
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
    options.skipTracker?.record?.('EXIT_TARGET_NOT_MET', {
      symbol,
      exit_mode: exitState.exit_mode,
      profit_protection_active: exitState.profit_protection_active,
      unrealized_pl: exitState.unrealized_pl,
      net_pnl: exitState.net_pnl,
      sell_net_profit_floor_dollars: exitState.sell_net_profit_floor_dollars,
      trailing_activation_profit_dollars: exitState.trailing_activation_profit_dollars,
      held_seconds: exitState.held_seconds,
      seconds_since_peak: exitState.seconds_since_peak,
      stale_position_max_hold_seconds: exitState.stale_position_max_hold_seconds,
      stalled_winner_max_hold_seconds: exitState.stalled_winner_max_hold_seconds,
      stalled_winner_max_seconds_since_peak: exitState.stalled_winner_max_seconds_since_peak,
    });
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

function assessRecentUpwardMomentum({
  currentPrice,
  minuteBar = null,
  minRecentMovePct = 0.03,
  minRecentRangePct = 0.05,
  minRecentCloseLocationPct = 60,
} = {}) {
  const price = safeNumber(currentPrice, null);
  const open = safeNumber(minuteBar?.o ?? minuteBar?.open, null);
  const high = safeNumber(minuteBar?.h ?? minuteBar?.high, null);
  const low = safeNumber(minuteBar?.l ?? minuteBar?.low, null);
  const close = safeNumber(minuteBar?.c ?? minuteBar?.close ?? price, price);
  const minMove = Math.max(0, safeNumber(minRecentMovePct, 0.03));
  const minRange = Math.max(0, safeNumber(minRecentRangePct, 0.05));
  const minCloseLocation = Math.max(0, Math.min(100, safeNumber(minRecentCloseLocationPct, 60)));
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(close) || close <= 0) {
    return { accepted: false, reason_code: 'RECENT_MOMENTUM_PRICE_UNAVAILABLE' };
  }
  const recentMovePct = Number.isFinite(open) && open > 0 ? ((close - open) / open) * 100 : null;
  const recentRangePct = Number.isFinite(high) && Number.isFinite(low) && low > 0 && high >= low
    ? ((high - low) / low) * 100
    : null;
  const closeLocationPct = Number.isFinite(high) && Number.isFinite(low) && high > low
    ? ((close - low) / (high - low)) * 100
    : null;
  const moveAccepted = Number.isFinite(recentMovePct) && recentMovePct >= minMove;
  const pressureAccepted = Number.isFinite(recentRangePct)
    && recentRangePct >= minRange
    && Number.isFinite(closeLocationPct)
    && closeLocationPct >= minCloseLocation;
  return {
    accepted: moveAccepted || pressureAccepted,
    reason_code: moveAccepted || pressureAccepted ? null : 'RECENT_UPWARD_MOMENTUM_WEAK',
    recent_move_pct: Number.isFinite(recentMovePct) ? roundScore(recentMovePct) : null,
    min_recent_move_pct: roundScore(minMove),
    recent_range_pct: Number.isFinite(recentRangePct) ? roundScore(recentRangePct) : null,
    min_recent_range_pct: roundScore(minRange),
    close_location_pct: Number.isFinite(closeLocationPct) ? roundScore(closeLocationPct) : null,
    min_recent_close_location_pct: roundScore(minCloseLocation),
  };
}

function buildBuyCandidate({ symbol, snapshot, latestQuote, currentPrice, previousClose, spreadPct, options }) {
  const movePct = ((currentPrice - previousClose) / previousClose) * 100;
  const notional = safeNumber(options.notional, 150);
  const minBuyNotional = Math.max(1, safeNumber(options.minBuyNotional ?? options.allocation?.floor ?? 25, 25));
  if (!Number.isFinite(notional) || notional <= 0) {
    options.skipTracker?.record?.('BELOW_MINIMUM_BUY_NOTIONAL', { symbol, notional });
    return null;
  }
  const minMovePct = Math.max(0, safeNumber(options.minMovePct, 0));
  if (options.allowContrarianEntries !== true && movePct < minMovePct) {
    options.skipTracker?.record?.('SESSION_MOVE_BELOW_ENTRY_MINIMUM', {
      symbol,
      move_pct: roundScore(movePct),
      min_move_pct: roundScore(minMovePct),
    });
    return null;
  }
  const recentMomentum = assessRecentUpwardMomentum({
    currentPrice,
    minuteBar: snapshot.minuteBar || snapshot.minute_bar || null,
    minRecentMovePct: options.minRecentMovePct,
    minRecentRangePct: options.minRecentRangePct,
    minRecentCloseLocationPct: options.minRecentCloseLocationPct,
  });
  if (options.requireRecentMomentum === true && !recentMomentum.accepted) {
    options.skipTracker?.record?.(recentMomentum.reason_code || 'RECENT_MOMENTUM_WEAK', {
      symbol,
      ...recentMomentum,
    });
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
  let buyingPowerSizing = null;
  let structureStop = null;
  let sizingMethod = 'fixed_notional';
  const positionSizingMode = String(options.positionSizingMode || (options.riskBudgetSizingEnabled ? 'risk_budget' : 'fixed_notional')).trim().toLowerCase();
  const sizingExplanation = {
    mode: positionSizingMode,
    requested_notional: roundCurrency(notional),
    target_notional: roundCurrency(notional),
    submitted_notional: roundCurrency(notional),
    submitted_quantity: null,
    supports_fractional_shares: true,
    limiter: 'BUY_NOTIONAL_TARGET',
    notes: [],
  };
  if (positionSizingMode === 'buying_power') {
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
    const buyingPower = safeNumber(options.portfolio?.buying_power ?? options.portfolio?.buyingPower ?? options.portfolio?.account?.buying_power ?? null, null);
    const cash = safeNumber(options.portfolio?.cash ?? options.portfolio?.account?.cash ?? null, null);
    const maxNotional = safeNumber(options.maxTradeNotional, 0) > 0 ? options.maxTradeNotional : null;
    buyingPowerSizing = calculateBuyingPowerSize({
      symbol,
      side: 'buy',
      price: currentPrice,
      buyingPower,
      cash,
      deploymentPct: options.maxBuyingPowerDeploymentPct,
      marketOrderBufferPct: options.buyingPowerMarketOrderBufferPct,
      cashReserve: options.buyingPowerCashReserve,
      maxNotional,
      minNotional: options.allocation?.floor ?? minBuyNotional,
      allowFractionalShares: options.allowBuyingPowerFractionalShares,
    });
    if (!buyingPowerSizing.accepted) {
      for (const reason of buyingPowerSizing.reason_codes || ['BUYING_POWER_SIZING_REJECTED']) {
        options.skipTracker?.record?.(reason, {
          symbol,
          buying_power_sizing: buyingPowerSizing,
          structure_stop: structureStop,
        });
      }
      return null;
    }
    candidateQuantity = buyingPowerSizing.quantity;
    candidateNotional = buyingPowerSizing.notional;
    candidateSupportsFractionalShares = buyingPowerSizing.allow_fractional_shares;
    stopLossOverride = structureStop.stop_price;
    takeProfitOverride = roundEquityPrice(currentPrice + Math.max(structureStop.stop_distance * 1.8, currentPrice * 0.02));
    sizingMethod = 'buying_power';
    sizingExplanation.requested_notional = roundCurrency(buyingPowerSizing.requested_notional);
    sizingExplanation.target_notional = roundCurrency(buyingPowerSizing.deployable_notional);
    sizingExplanation.submitted_notional = roundCurrency(candidateNotional);
    sizingExplanation.submitted_quantity = candidateQuantity;
    sizingExplanation.supports_fractional_shares = Boolean(candidateSupportsFractionalShares);
    sizingExplanation.limiter = buyingPowerSizing.capped_by?.length ? buyingPowerSizing.capped_by.join('+').toUpperCase() : 'BUYING_POWER';
    sizingExplanation.buying_power_sizing = buyingPowerSizing;
    sizingExplanation.notes.push('Buying-power deployment sizing is active.');
  } else if (positionSizingMode === 'risk_budget' || options.riskBudgetSizingEnabled) {
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
    sizingExplanation.target_notional = roundCurrency(maxNotional);
    sizingExplanation.submitted_notional = roundCurrency(candidateNotional);
    sizingExplanation.submitted_quantity = candidateQuantity;
    sizingExplanation.supports_fractional_shares = Boolean(candidateSupportsFractionalShares);
    sizingExplanation.limiter = riskBudgetSizing.max_notional_limiter ? 'MAX_TRADE_NOTIONAL' : 'RISK_BUDGET';
    sizingExplanation.notes.push('Risk-budget sizing is active.');
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
    sizingExplanation.submitted_notional = roundCurrency(candidateNotional);
    sizingExplanation.submitted_quantity = candidateQuantity;
    sizingExplanation.limiter = 'EXECUTION_QUALITY_SIZE_MULTIPLIER';
    sizingExplanation.notes.push('Execution-quality size reduction was applied.');
  }
  if (options.allocation?.accepted && Number.isFinite(safeNumber(options.allocation?.requested, null)) && Number.isFinite(safeNumber(options.allocation?.notional, null)) && options.allocation.notional < options.allocation.requested) {
    sizingExplanation.target_notional = roundCurrency(options.allocation.requested);
    sizingExplanation.submitted_notional = roundCurrency(Math.min(candidateNotional, options.allocation.notional));
    sizingExplanation.limiter = options.allocation.cash_limited ? 'BUYING_POWER_CAP' : (options.allocation.reason || 'ALLOCATION_CAP');
    sizingExplanation.notes.push('Portfolio allocation reduced the requested buy size.');
  }
  if (Number.isFinite(candidateQuantity)) {
    sizingExplanation.submitted_quantity = candidateQuantity;
  }
  sizingExplanation.supports_fractional_shares = Boolean(candidateSupportsFractionalShares);
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
    buyingPowerSizing,
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
    sizingExplanation,
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

function getNewestMarketTimestampMs(snapshot = {}, latestQuote = null) {
  const timestamps = [
    latestQuote?.t,
    latestQuote?.timestamp,
    snapshot.latestQuote?.t,
    snapshot.latestQuote?.timestamp,
    snapshot.latestTrade?.t,
    snapshot.latestTrade?.timestamp,
    snapshot.minuteBar?.t,
    snapshot.minuteBar?.timestamp,
    snapshot.dailyBar?.t,
    snapshot.dailyBar?.timestamp,
    snapshot.prevDailyBar?.t,
    snapshot.prevDailyBar?.timestamp,
  ]
    .map((value) => (value ? new Date(value).getTime() : Number.NaN))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return null;
  return Math.max(...timestamps);
}

function calculateSpreadRankPenalty(spreadPct, { thresholdPct = 0.75, penaltyPerPct = 25, cap = 80 } = {}) {
  const spread = Math.max(0, safeNumber(spreadPct, 0));
  const threshold = Math.max(0, safeNumber(thresholdPct, 0.75));
  const rate = Math.max(0, safeNumber(penaltyPerPct, 25));
  const maxPenalty = Math.max(0, safeNumber(cap, 80));
  const excess = Math.max(0, spread - threshold);
  return Math.min(maxPenalty, excess * rate);
}

function getStopoutClusterBlock(recentPenalty, { blockMinutes = 30, blockCount = 2 } = {}) {
  const requiredCount = Math.max(0, Math.floor(safeNumber(blockCount, 2)));
  const blockWindowSeconds = Math.max(0, safeNumber(blockMinutes, 30)) * 60;
  if (!recentPenalty || requiredCount <= 0 || blockWindowSeconds <= 0) {
    return { blocked: false, stop_exit_count: 0, required_count: requiredCount };
  }
  const stopComponents = (Array.isArray(recentPenalty.components) ? recentPenalty.components : [])
    .filter((component) => component?.reason === 'recent_stop_exit' || component?.reason === 'hard_stopout' || component?.reason === 'execution_bad_loss' || component?.reason === 'churn_exit' || component?.classification === 'hard_stopout' || component?.classification === 'execution_bad_loss' || component?.classification === 'churn_exit')
    .filter((component) => safeNumber(component.remaining_seconds, 0) > 0)
    .filter((component) => {
      const ageSeconds = safeNumber(component.age_seconds, 0);
      return ageSeconds <= blockWindowSeconds;
    });
  if (stopComponents.length < requiredCount) {
    return {
      blocked: false,
      stop_exit_count: stopComponents.length,
      required_count: requiredCount,
    };
  }
  const componentsByRemaining = [...stopComponents].sort((a, b) => safeNumber(a.remaining_seconds, 0) - safeNumber(b.remaining_seconds, 0));
  const unblockComponent = componentsByRemaining[Math.max(0, stopComponents.length - requiredCount)];
  return {
    blocked: true,
    stop_exit_count: stopComponents.length,
    required_count: requiredCount,
    remaining_seconds: safeNumber(unblockComponent?.remaining_seconds, 0),
    expires_at: unblockComponent?.expires_at || null,
  };
}

function buildSignalCandidate({ symbol, side, currentPrice, previousClose, spreadPct, snapshot, latestQuote, options, quantity, notional, supportsFractionalShares = true, stopLossOverride = null, takeProfitOverride = null, sizingMethod = 'fixed_notional', riskBudgetSizing = null, buyingPowerSizing = null, structureStop = null, rankScore = 0, baseRankScore = rankScore, recentTradeRankPenalty = 0, setupRankPenalty = 0, executionQualityPenalty = 0, executionQualityEntry = null, executionQualitySizeMultiplier = 1, spreadRankPenalty = 0, totalRankPenalty = recentTradeRankPenalty + setupRankPenalty + spreadRankPenalty, recentTradePenalty = null, setupPenalty = null, setupFatigue = null, sessionGuards = null, exitState = null, setupKey = null, sizingExplanation = null }) {
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
      session_guard_blocked: side === 'buy' ? Boolean(sessionGuards?.buy_blocked) && !options.previewMode : false,
      candidate_lifecycle_status: side === 'buy' ? candidateLifecycleEntry?.status || (options.candidateLifecycleEnabled ? 'watching' : null) : null,
      candidate_lifecycle_reason_codes: side === 'buy' ? candidateLifecycleEntry?.reason_codes || [] : [],
      candidate_lifecycle_decayed_rank: side === 'buy' ? roundScore(candidateLifecycleEntry?.decayed_rank ?? rankScore) : null,
      candidate_lifecycle_selected: side === 'buy' ? Boolean(candidateLifecycleEntry?.status === 'selected' || candidateLifecycleEntry?.status === 'entered') : false,
      source_mode: side === 'buy' ? options.sourceMode || null : null,
      source_list: side === 'buy' ? options.sourceList || null : null,
      source_lists: side === 'buy' ? uniqueSourceLabels(options.sourceLists || []) : [],
      preview_only: Boolean(options.previewMode) && side === 'buy',
      execution_blocked: Boolean(options.previewMode) && side === 'buy',
      market_closed_execution_block: Boolean(options.previewMode) && side === 'buy' && options.requireMarketOpen && options.marketOpen === false,
      preview_reason_codes: side === 'buy' ? (options.previewReasonCodes || []) : [],
      sizing_method: side === 'buy' ? sizingMethod : null,
      sizing_explanation: side === 'buy' ? sizingExplanation : null,
      risk_budget_sizing: side === 'buy' ? riskBudgetSizing : null,
      buying_power_sizing: side === 'buy' ? buyingPowerSizing : null,
      structure_stop: side === 'buy' ? structureStop : null,
      execution_quality: side === 'buy' ? executionQualityEntry || null : null,
      execution_quality_state: side === 'buy' ? options.executionQualitySummary || null : null,
      setup_fatigue: side === 'buy' ? setupFatigue : null,
      session_guards: side === 'buy' ? summarizeSessionGuards(sessionGuards) : null,
      execution_status: side === 'buy' ? (options.previewMode ? 'preview_only' : 'eligible_for_risk_check') : 'exit_candidate',
      waiting_reason: side === 'buy' ? (options.previewMode ? 'MARKET_CLOSED_FOR_STOCKS' : null) : null,
    },
    volume,
    average_volume: dailyVolume > 0 ? dailyVolume : null,
      volume_multiple: Number.isFinite(dailyVolume) && dailyVolume > 0
        ? Number((volume / dailyVolume).toFixed(4))
        : null,
      source_mode: options.sourceMode || null,
      source_list: options.sourceList || null,
      source_lists: uniqueSourceLabels(options.sourceLists || []),
      dynamic_watchlist_member: Boolean(options.dynamicWatchlistMember),
      priority_override_eligible: Boolean(options.priorityOverrideEligible),
      priority_override_applied: Boolean(options.priorityOverrideApplied),
      priority_override_bonus: Number.isFinite(Number(options.priorityOverrideBonus)) ? roundScore(options.priorityOverrideBonus) : 0,
      priority_override_block_reason: options.priorityOverrideBlockReason || null,
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
  const singleSourceMomentumOverride = shouldAllowSingleSourceMomentum({
    side,
    assetType: options.assetType,
    rankScore,
    providerConfirmation,
    enabled: options.singleSourceMomentumEnabled,
    minRankScore: options.singleSourceMomentumMinRankScore,
  });
  if (singleSourceMomentumOverride) {
    marketContext.single_source_momentum_override = {
      enabled: true,
      reason_code: 'SINGLE_SOURCE_MOMENTUM_OVERRIDE',
      rank_score: roundScore(rankScore),
      min_rank_score: safeNumber(options.singleSourceMomentumMinRankScore, 500),
      provider_confirmation: providerConfirmation || null,
    };
  }
  if (options.requireMultiSourceConfirmation && !providerConfirmation?.confirmed && !singleSourceMomentumOverride) {
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
    stop_loss: side === 'buy' ? stopLoss : null,
    take_profit: side === 'buy' ? takeProfit : null,
    sizing_method: side === 'buy' ? sizingMethod : null,
    risk_budget_sizing: side === 'buy' ? riskBudgetSizing : null,
    buying_power_sizing: side === 'buy' ? buyingPowerSizing : null,
    structure_stop: side === 'buy' ? structureStop : null,
    risk_budget: side === 'buy' ? riskBudgetSizing : null,
    allow_bracket: false,
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
    single_source_momentum_override: Boolean(singleSourceMomentumOverride),
    preview_only: Boolean(options.previewMode) && side === 'buy',
    execution_blocked: Boolean(options.previewMode) && side === 'buy',
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
    dynamicWatchlistMember: Boolean(options.dynamicWatchlistMember),
    priorityOverrideEligible: Boolean(options.priorityOverrideEligible),
    priorityOverrideApplied: Boolean(options.priorityOverrideApplied),
    priorityOverrideBonus: Number.isFinite(Number(options.priorityOverrideBonus)) ? roundScore(options.priorityOverrideBonus) : 0,
    previewOnly: Boolean(options.previewMode) && side === 'buy',
    previewReasonCodes: side === 'buy' ? (options.previewReasonCodes || []) : [],
  };
}

function shouldAllowSingleSourceMomentum({
  side,
  assetType,
  rankScore,
  providerConfirmation,
  enabled = false,
  minRankScore = 500,
} = {}) {
  if (!enabled) return false;
  if (String(side || '').toLowerCase() !== 'buy') return false;
  if (String(assetType || 'stock').toLowerCase() !== 'stock') return false;
  if (providerConfirmation?.confirmed) return false;
  return safeNumber(rankScore, 0) >= safeNumber(minRankScore, 500);
}

function filterApprovedPositions(positions = [], approvedSymbols = []) {
  if (!Array.isArray(approvedSymbols) || !approvedSymbols.length) return Array.isArray(positions) ? positions : [];
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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

function normalizeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

module.exports = {
  APPROVED_LIVE_MARKET_SYMBOLS,
  buildStockCandidateForSymbol,
  calculateSpreadRankPenalty,
  calculateEffectiveStopLossDollars,
  createStockScanner,
  normalizeRecentTradePenaltyMap,
  rankScannerBuyCandidates,
  resolveMemeWatchlistAttention: resolveScannerWatchConfig,
  resolveScannerWatchConfig,
};
