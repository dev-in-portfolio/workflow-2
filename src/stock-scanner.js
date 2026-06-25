const fs = require('fs');
const path = require('path');
const { buildProviderConfirmationFromContext, normalizeMarketData } = require('./market-data');
const { parseBool } = require('./config');
const { nowIso, safeNumber, hashObject, clamp } = require('./util');
const { APPROVED_LIVE_MARKET_SYMBOLS, parseSymbolList } = require('./volatile-stock-universe');
const { allocateBuyNotional, buildPortfolioSnapshot } = require('./portfolio-allocation');
const { writeScannerRuntimeState } = require('./scanner-runtime-state');
const { loadTrailingState, saveTrailingState, updateTrailingSnapshot } = require('./position-trailing-state');
const { isRegularUsMarketHours, resolveIntradayStockRegime } = require('./market-hours');
const { assertSignalCandidate } = require('./module-contracts');
const { loadPartialFillState, summarizePartialFillState } = require('./partial-fill-state');
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
const {
  loadAntiChurnState,
  reconcileAntiChurnState,
  saveAntiChurnState,
  normalizeAntiChurnState,
  summarizeAntiChurnState,
} = require('./anti-churn-engine');
const { calculateRiskBudgetSize } = require('./risk-budget-sizing');
const { calculateStructureAwareStop } = require('./structure-stops');

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
  const excludedBuySymbols = parseSymbolList(options.excludedBuySymbols ?? env.STOCK_SCANNER_EXCLUDED_BUY_SYMBOLS, []);
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
  const riskBudgetSizingEnabled = options.riskBudgetSizingEnabled ?? parseBool(env.RISK_BUDGET_SIZING_ENABLED, false);
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
    let previousCandidateLifecycleState = null;
    let scannerMode = 'hunt';
    let candidateLifecycleResult = null;
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
      const positions = positionsState.data;
      const openOrders = openOrdersState.data;
      const account = accountState.data;
      const brokerState = buildScannerBrokerState({ accountState, positionsState, openOrdersState });
      const approvedPositions = filterApprovedPositions(positions, symbols);
      const partialFillState = options.partialFillState || loadPartialFillState({ env, repoRoot: process.cwd() });
      const partialFillSummary = summarizePartialFillState(partialFillState);
      const previousAntiChurnState = options.antiChurnState || loadAntiChurnState({ env, repoRoot: process.cwd() });
      let antiChurnState = normalizeAntiChurnState(previousAntiChurnState);
      if (!options.antiChurnState) {
        try {
          antiChurnState = await reconcileAntiChurnState({
            previousState: previousAntiChurnState,
            performanceHistoryPath: resolvePerformanceHistoryPath(env, process.cwd()),
            now: receivedAt,
            env,
            repoRoot: process.cwd(),
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
          if (typeof options.logger === 'function') {
            options.logger({ level: 'warn', event: 'anti_churn_state_reconcile_failed', message: error.message });
          }
        }
      }
      if (!options.antiChurnState) {
        saveAntiChurnState(antiChurnState, { env, repoRoot: process.cwd() });
      }
      const antiChurnSummary = summarizeAntiChurnState(antiChurnState);
      const performanceHistoryPath = resolvePerformanceHistoryPath(env, process.cwd());
      const previousSetupFatigueState = options.setupFatigueState || loadSetupFatigueState({ env, repoRoot: process.cwd() });
      let setupFatigueState = normalizeSetupFatigueState(previousSetupFatigueState);
      if (!options.setupFatigueState) {
        try {
          setupFatigueState = await reconcileSetupFatigueState({
            previousState: previousSetupFatigueState,
            performanceHistoryPath,
            now: receivedAt,
            env,
            repoRoot: process.cwd(),
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
          if (typeof options.logger === 'function') {
            options.logger({ level: 'warn', event: 'setup_fatigue_state_reconcile_failed', message: error.message });
          }
        }
      }
      if (!options.setupFatigueState) {
        saveSetupFatigueState(setupFatigueState, { env, repoRoot: process.cwd() });
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
            repoRoot: process.cwd(),
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
        repoRoot: process.cwd(),
        now: receivedAt,
        windowMinutes: recentTradePenaltyMinutes,
        penalty: recentTradeRankPenalty,
        lossWindowMinutes: recentLossPenaltyMinutes,
        lossPenalty: recentLossRankPenalty,
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
      const previousTrailingState = loadTrailingState({ env, repoRoot: process.cwd() });
      const trailingState = updateTrailingSnapshot({
        positions: approvedPositions,
        startDollars: trailingProfitStartDollars,
        givebackDollars: trailingProfitGivebackDollars,
        previousState: previousTrailingState,
      });
      saveTrailingState(trailingState, { env, repoRoot: process.cwd() });
      previousCandidateLifecycleState = options.candidateLifecycleState || loadCandidateLifecycleState({ env, repoRoot: process.cwd() });
      scannerMode = determineScannerMode({
        sessionGuards,
        portfolio,
        openOrders,
        huntToMonitorLatchEnabled,
        manageOnlyBlocksBuys,
      });
      const { candidates, candidateLifecycleResult: computedCandidateLifecycleResult } = buildCandidates(bundle, {
        receivedAt,
        maxCandidatesPerRun,
        maxBuyCandidates: Math.min(maxCandidatesPerRun, Math.max(0, portfolio.remaining_position_slots ?? maxOpenPositions)),
        notional: allocation.accepted ? allocation.notional : notional,
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
        stopoutClusterBlockMinutes,
        stopoutClusterBlockCount,
        maxBuyRiskScore,
        spreadRankPenaltyThresholdPct,
        spreadRankPenaltyPerPct,
        spreadRankPenaltyCap,
        intradayRegime,
        scannerMode,
        optionalHooks: {
          volatility_stop_enabled: Boolean(volatilityStopEnabled),
          market_quality_ranking_enabled: Boolean(marketQualityRankingEnabled),
          risk_budget_sizing_enabled: Boolean(riskBudgetSizingEnabled),
        },
        riskBudgetSizingEnabled,
        maxRiskPerTradeDollars,
        maxRiskPerTradePctEquity,
        maxTradeNotional,
        minStopDistanceDollars,
        maxStopDistanceDollars,
        allowRiskBudgetFractionalShares,
        riskBudgetRequireBrokerEquity,
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
        saveCandidateLifecycleState(candidateLifecycleResult.state, { env, repoRoot: process.cwd() });
      }

      const results = [];
      for (const candidate of candidates) {
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
        antiChurnState,
        antiChurnSummary,
        setupFatigueState,
        setupFatigueSummary,
        sessionGuards,
        trailingState,
        partialFillSummary,
        skipSummary: skipTracker.summary(),
        recentSkips: skipTracker.recent(),
        candidates,
        results,
        recentTradePenalties,
        brokerState,
        candidateLifecycleState: candidateLifecycleResult?.state || previousCandidateLifecycleState,
        candidateLifecycleSummary: candidateLifecycleResult?.summary || summarizeCandidateLifecycleState(previousCandidateLifecycleState || {}),
      });
      return {
        accepted: true,
        candidates: results,
        received_at: receivedAt,
        portfolio,
        allocation,
        broker_state: brokerState,
        partial_fill_state: partialFillSummary,
        anti_churn_state: antiChurnState,
        anti_churn_summary: antiChurnSummary,
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
        candidateLifecycleState: previousCandidateLifecycleState || null,
        candidateLifecycleSummary: summarizeCandidateLifecycleState(previousCandidateLifecycleState || {}),
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
    },
  };

  return controller;

  function writeRuntimeSnapshot({ receivedAt, durationMs, portfolio = null, allocation = null, brokerState = null, intradayRegime = null, optionalHooks = null, trailingState = null, partialFillSummary = null, antiChurnState = null, antiChurnSummary = null, setupFatigueState = null, setupFatigueSummary = null, sessionGuards = null, candidateLifecycleState = null, candidateLifecycleSummary = null, skipSummary = null, recentSkips = [], candidates = [], results = [], recentTradePenalties = new Map(), error = null }) {
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
      anti_churn_state: antiChurnState || null,
      anti_churn_summary: antiChurnSummary || summarizeAntiChurnState(antiChurnState || {}),
      setup_fatigue_state: setupFatigueState || null,
      setup_fatigue_summary: setupFatigueSummary || summarizeSetupFatigueState(setupFatigueState || {}),
      session_guards: sessionGuards || null,
      candidate_lifecycle_state: candidateLifecycleState || null,
      candidate_lifecycle_summary: candidateLifecycleSummary || summarizeCandidateLifecycleState(candidateLifecycleState || {}),
      candidate_rank_details: candidates
        .filter((candidate) => candidate.payload?.side === 'buy')
        .map((candidate) => ({
          symbol: candidate.symbol,
          setup_key: candidate.setupKey || null,
          rank_score: roundScore(candidate.rankScore),
          base_rank_score: roundScore(candidate.baseRankScore ?? candidate.rankScore),
          recent_trade_rank_penalty: roundScore(candidate.recentTradeRankPenalty || 0),
          setup_rank_penalty: roundScore(candidate.setupRankPenalty || 0),
          spread_rank_penalty: roundScore(candidate.spreadRankPenalty || 0),
          total_rank_penalty: roundScore(candidate.totalRankPenalty ?? candidate.recentTradeRankPenalty ?? 0),
          adjusted_rank_score: roundScore(candidate.rankScore),
          min_adjusted_rank_score: roundScore(minAdjustedRankScore),
          recent_trade_at: candidate.recentTradePenalty?.last_traded_at || null,
          sizing_method: candidate.payload?.sizing_method || 'fixed_notional',
          risk_budget_sizing: candidate.payload?.risk_budget_sizing || null,
          structure_stop: candidate.payload?.structure_stop || null,
          candidate_lifecycle_status: candidate.payload?.market_context?.scanner?.candidate_lifecycle_status || null,
          candidate_lifecycle_reason_codes: candidate.payload?.market_context?.scanner?.candidate_lifecycle_reason_codes || [],
          candidate_lifecycle_decayed_rank: candidate.payload?.market_context?.scanner?.candidate_lifecycle_decayed_rank || null,
          anti_churn_recent_winner_protected: Boolean(candidate.payload?.market_context?.scanner?.anti_churn_recent_winner_protected),
          anti_churn_reason: candidate.recentTradePenalty?.reason || null,
          setup_trade_penalty_reason: candidate.setupPenalty?.reason || null,
          setup_fatigue_score: candidate.setupFatigue?.fatigue_score ?? null,
          setup_fatigue_active: Boolean(candidate.setupFatigue?.active),
          setup_fatigue_paused_until: candidate.setupFatigue?.paused_until || null,
          setup_fatigue_reason_codes: candidate.setupFatigue?.reason_codes || [],
          session_guard_blocked: Boolean(sessionGuards?.buy_blocked),
        })),
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
      broker_state: brokerState,
      intraday_regime: intradayRegime,
      optional_hooks: optionalHooks || {
        volatility_stop_enabled: Boolean(volatilityStopEnabled),
        market_quality_ranking_enabled: Boolean(marketQualityRankingEnabled),
        risk_budget_sizing_enabled: Boolean(riskBudgetSizingEnabled),
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
        latest_candidates: candidates
          .filter((candidate) => candidate.payload?.side === 'buy')
          .map((candidate) => ({
            symbol: candidate.symbol,
            sizing_method: candidate.payload?.sizing_method || 'fixed_notional',
            risk_budget_sizing: candidate.payload?.risk_budget_sizing || null,
            structure_stop: candidate.payload?.structure_stop || null,
          })),
      },
      rank_floor: {
        min_adjusted_rank_score: roundScore(minAdjustedRankScore),
        skip_reason: 'ADJUSTED_RANK_BELOW_FLOOR',
      },
      approved_symbols: symbols,
      excluded_buy_symbols: excludedBuySymbols,
      exit_rules: {
        stop_loss_dollars: stopLossDollars,
        stop_loss_notional_pct: stopLossNotionalPct,
        stop_loss_max_dollars: stopLossMaxDollars,
        trailing_profit_start_dollars: trailingProfitStartDollars,
        trailing_profit_giveback_dollars: trailingProfitGivebackDollars,
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
      position_exit_state: candidates
        .filter((candidate) => candidate.exitState)
        .map((candidate) => candidate.exitState),
      trailing_state: trailingState ? {
        updated_at: trailingState.updated_at,
        positions: trailingState.positions,
      } : null,
      session_guard_overview: summarizeSessionGuards(sessionGuards),
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

function loadRecentTradePenalties({ env = process.env, repoRoot = process.cwd(), now = nowIso(), windowMinutes = 5, penalty = 8, lossWindowMinutes = 10, lossPenalty = 60, stopWindowMinutes = 30, stopPenalty = 80, overrides = null } = {}) {
  if ((!windowMinutes || !penalty) && (!lossWindowMinutes || !lossPenalty) && (!stopWindowMinutes || !stopPenalty)) return new Map();
  if (overrides) return normalizeRecentTradePenaltyMap(overrides, { now, windowMinutes, penalty, lossWindowMinutes, lossPenalty, stopWindowMinutes, stopPenalty });
  const historyPath = resolvePerformanceHistoryPath(env, repoRoot);
  const lines = readTailLines(historyPath, 512 * 1024);
  return normalizeRecentTradePenaltyMap(lines.map(parseJsonLine).filter(Boolean), { now, windowMinutes, penalty, lossWindowMinutes, lossPenalty, stopWindowMinutes, stopPenalty });
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

function normalizeRecentTradePenaltyMap(source, { now = nowIso(), windowMinutes = 15, penalty = 20, lossWindowMinutes = 10, lossPenalty = 60, stopWindowMinutes = 30, stopPenalty = 80 } = {}) {
  const map = new Map();
  const nowMs = new Date(now).getTime();
  const windowMs = Math.max(0, safeNumber(windowMinutes, 15)) * 60_000;
  const lossWindowMs = Math.max(0, safeNumber(lossWindowMinutes, 10)) * 60_000;
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
  return {
    symbol,
    traded_at: tradedAt,
    side,
    loss_exit: lossExit,
    stop_exit: stopExit,
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
  const spreadRankPenalty = calculateSpreadRankPenalty(spreadPct, {
    thresholdPct: options.spreadRankPenaltyThresholdPct,
    penaltyPerPct: options.spreadRankPenaltyPerPct,
    cap: options.spreadRankPenaltyCap,
  });
  const totalRankPenalty = recentTradeRankPenalty + setupRankPenalty + spreadRankPenalty;
  const rankScore = baseRankScore - totalRankPenalty;
  const minAdjustedRankScore = safeNumber(options.minAdjustedRankScore, Number.NEGATIVE_INFINITY);
  if (rankScore < minAdjustedRankScore) {
    options.skipTracker?.record?.('ADJUSTED_RANK_BELOW_FLOOR', {
      symbol,
      base_rank_score: roundScore(baseRankScore),
      recent_trade_rank_penalty: roundScore(recentTradeRankPenalty),
      setup_rank_penalty: roundScore(setupRankPenalty),
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

function buildSignalCandidate({ symbol, side, currentPrice, previousClose, spreadPct, snapshot, latestQuote, options, quantity, notional, supportsFractionalShares = true, stopLossOverride = null, takeProfitOverride = null, sizingMethod = 'fixed_notional', riskBudgetSizing = null, structureStop = null, rankScore = 0, baseRankScore = rankScore, recentTradeRankPenalty = 0, setupRankPenalty = 0, spreadRankPenalty = 0, totalRankPenalty = recentTradeRankPenalty + setupRankPenalty + spreadRankPenalty, recentTradePenalty = null, setupPenalty = null, setupFatigue = null, sessionGuards = null, exitState = null, setupKey = null }) {
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
      spread_rank_penalty: side === 'buy' ? roundScore(spreadRankPenalty) : 0,
      total_rank_penalty: side === 'buy' ? roundScore(totalRankPenalty) : 0,
      adjusted_rank_score: side === 'buy' ? roundScore(rankScore) : null,
      min_adjusted_rank_score: side === 'buy' ? roundScore(safeNumber(options.minAdjustedRankScore, Number.NEGATIVE_INFINITY)) : null,
      recent_trade_at: side === 'buy' ? recentTradePenalty?.last_traded_at || null : null,
      recent_trade_penalty_reason: side === 'buy' ? recentTradePenalty?.reason || null : null,
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
  calculateSpreadRankPenalty,
  calculateEffectiveStopLossDollars,
  createStockScanner,
  normalizeRecentTradePenaltyMap,
};
