const { writeScannerRuntimeState } = require('../scanner-runtime-state');
const { resolveRepoRoot, roundScore, roundCurrency } = require('../util');
const { summarizeAntiChurnState } = require('../anti-churn-engine');
const { summarizeSetupFatigueState } = require('../setup-fatigue');
const { summarizeSessionGuards } = require('../session-guards');
const { summarizeCandidateLifecycleState } = require('../candidate-lifecycle-state');
const { isApprovedPostResult, summarizePostResult } = require('./candidate-builder');
const { summarizeRecentTradePenalties } = require('./rank-penalties');

function writeRuntimeSnapshot(state, closureVars) {
  const {
    runtimeStateEnabled,
    symbols,
    excludedBuySymbols,
    stopLossDollars,
    stopLossNotionalPct,
    stopLossMaxDollars,
    trailingProfitStartDollars,
    trailingProfitGivebackDollars,
    volatilityStopEnabled,
    marketQualityRankingEnabled,
    executionQualityFeedbackEnabled,
    executionQualityRankPenaltyEnabled,
    executionQualitySizeMultiplierEnabled,
    executionQualityCooldownEnabled,
    riskBudgetSizingEnabled,
    maxRiskPerTradeDollars,
    maxRiskPerTradePctEquity,
    maxTradeNotional,
    minStopDistanceDollars,
    maxStopDistanceDollars,
    allowRiskBudgetFractionalShares,
    riskBudgetRequireBrokerEquity,
    executionQualityDecayPerHour,
    minAdjustedRankScore,
    env,
  } = closureVars;

  const {
    receivedAt, durationMs, portfolio = null, allocation = null, brokerState = null, intradayRegime = null, optionalHooks = null, trailingState = null, partialFillSummary = null, executionQualityState = null, executionQualitySummary = null, antiChurnState = null, antiChurnSummary = null, setupFatigueState = null, setupFatigueSummary = null, sessionGuards = null, candidateLifecycleState = null, candidateLifecycleSummary = null, skipSummary = null, recentSkips = [], candidates = [], results = [], recentTradePenalties = new Map(), error = null,
  } = state;

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
    execution_quality_state: executionQualityState || null,
    execution_quality_summary: executionQualitySummary || null,
    broker_state: brokerState,
    intraday_regime: intradayRegime,
    optional_hooks: optionalHooks || {
      volatility_stop_enabled: Boolean(volatilityStopEnabled),
      market_quality_ranking_enabled: Boolean(marketQualityRankingEnabled),
      execution_quality_feedback_enabled: Boolean(executionQualityFeedbackEnabled),
      execution_quality_rank_penalty_enabled: Boolean(executionQualityRankPenaltyEnabled),
      execution_quality_size_multiplier_enabled: Boolean(executionQualitySizeMultiplierEnabled),
      execution_quality_cooldown_enabled: Boolean(executionQualityCooldownEnabled),
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
    execution_quality: executionQualitySummary,
    position_exit_state: candidates
      .filter((candidate) => candidate.exitState)
      .map((candidate) => candidate.exitState),
    trailing_state: trailingState ? {
      updated_at: trailingState.updated_at,
      positions: trailingState.positions,
    } : null,
    session_guard_overview: summarizeSessionGuards(sessionGuards),
  }, { env, repoRoot: resolveRepoRoot() });
}

module.exports = { writeRuntimeSnapshot };
