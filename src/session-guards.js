const fs = require('fs');
const path = require('path');
const { nowIso, safeNumber } = require('./util');
const { readPaperOutcomesFromHistory, summarizeSetupFatigueState } = require('./setup-fatigue');
const { resolveIntradayStockRegime } = require('./market-hours');

const SessionGuardReason = {
  DAILY_DRAWDOWN_GUARD_ACTIVE: 'DAILY_DRAWDOWN_GUARD_ACTIVE',
  ROLLING_DRAWDOWN_GUARD_ACTIVE: 'ROLLING_DRAWDOWN_GUARD_ACTIVE',
  CONSECUTIVE_LOSS_GUARD_ACTIVE: 'CONSECUTIVE_LOSS_GUARD_ACTIVE',
  STOPOUT_CLUSTER_GUARD_ACTIVE: 'STOPOUT_CLUSTER_GUARD_ACTIVE',
  LOW_PROFIT_HIGH_CHURN_GUARD_ACTIVE: 'LOW_PROFIT_HIGH_CHURN_GUARD_ACTIVE',
  BAD_SESSION_GUARD_ACTIVE: 'BAD_SESSION_GUARD_ACTIVE',
  MARKET_OUTCOME_GUARD_ACTIVE: 'MARKET_OUTCOME_GUARD_ACTIVE',
  MANAGE_ONLY_MODE_ACTIVE: 'MANAGE_ONLY_MODE_ACTIVE',
  SETUP_FATIGUE_ACTIVE: 'SETUP_FATIGUE_ACTIVE',
};

const DEFAULTS = {
  dailyDrawdownEnabled: true,
  maxDailyDrawdownDollars: 5,
  rollingDrawdownEnabled: true,
  maxRollingDrawdownDollars: 6,
  consecutiveLossEnabled: true,
  maxConsecutiveLosses: 3,
  stopoutClusterEnabled: true,
  stopoutClusterWindowSeconds: 60 * 60,
  stopoutClusterMaxStopouts: 2,
  stopoutClusterCooldownSeconds: 30 * 60,
  badSessionEnabled: true,
  lowProfitHighChurnEnabled: true,
  rollingWindowHours: 6,
  historyMaxBytes: 512 * 1024,
  lowProfitThresholdDollars: 0.5,
  highChurnTradeCount: 5,
  badSessionMinTrades: 4,
  badSessionWinRateThreshold: 0.4,
};

async function evaluateSessionGuards(options = {}) {
  const now = options.now || nowIso();
  const env = options.env || process.env;
  const repoRoot = options.repoRoot || process.cwd();
  const setupFatigueSummary = options.setupFatigueSummary || summarizeSetupFatigueState(options.setupFatigueState || {});
  const intradayRegime = options.intradayRegime || resolveIntradayStockRegime(new Date(now), {
    openingNoiseMinutes: safeNumber(options.openingNoiseMinutes, 5),
    nearCloseMinutes: safeNumber(options.nearCloseManageOnlyMinutes, 15),
  });

  const outcomes = Array.isArray(options.paperOutcomes)
    ? options.paperOutcomes
    : readPaperOutcomesFromHistory(options.performanceHistoryPath || path.join(repoRoot, 'data', 'performance-history.jsonl'), safeNumber(options.historyMaxBytes, DEFAULTS.historyMaxBytes));
  const normalizedOutcomes = normalizeOutcomeList(outcomes, now)
    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());

  const recentOutcomes = normalizedOutcomes.filter((outcome) => isWithinHours(outcome.recorded_at, now, safeNumber(options.rollingWindowHours, DEFAULTS.rollingWindowHours)));
  const dayOutcomes = normalizedOutcomes.filter((outcome) => sameUtcDay(outcome.recorded_at, now));

  const activeGuards = [];
  const reasonCodes = new Set();
  let earliestExpiry = null;

  function addGuard(guard) {
    activeGuards.push(guard);
    for (const code of guard.reason_codes || []) reasonCodes.add(code);
    if (guard.expires_at) {
      earliestExpiry = earliestExpiry ? (new Date(guard.expires_at).getTime() < new Date(earliestExpiry).getTime() ? guard.expires_at : earliestExpiry) : guard.expires_at;
    }
  }

  const dailyPnl = sumPnl(dayOutcomes);
  const dailyCurve = buildEquityCurve(dayOutcomes);
  const rollingCurve = buildEquityCurve(recentOutcomes);
  const dailyDrawdown = dailyCurve.drawdown;
  const rollingDrawdown = rollingCurve.drawdown;
  const consecutiveLosses = countConsecutiveLosses(recentOutcomes);
  const stopoutCount = recentOutcomes.filter((outcome) => outcome.stop_exit || /STOP/i.test(String(outcome.exit_reason || ''))).length;
  const winRate = recentOutcomes.length ? recentOutcomes.filter((outcome) => outcome.net_pnl >= 0).length / recentOutcomes.length : 0;
  const churnScore = recentOutcomes.length >= 2
    ? recentOutcomes.length / Math.max(1, hoursBetween(recentOutcomes[0].recorded_at, recentOutcomes[recentOutcomes.length - 1].recorded_at) || 1)
    : 0;
  const totalPnl = sumPnl(recentOutcomes);

  const dailyThreshold = Math.abs(safeNumber(options.maxDailyDrawdownDollars ?? env.MAX_DAILY_DRAWDOWN_DOLLARS, DEFAULTS.maxDailyDrawdownDollars));
  const rollingThreshold = Math.abs(safeNumber(options.maxRollingDrawdownDollars ?? env.MAX_ROLLING_DRAWDOWN_DOLLARS, DEFAULTS.maxRollingDrawdownDollars));
  const consecutiveThreshold = Math.max(1, Math.round(safeNumber(options.maxConsecutiveLosses ?? env.MAX_CONSECUTIVE_LOSSES, DEFAULTS.maxConsecutiveLosses)));
  const stopoutClusterWindowSeconds = Math.max(60, safeNumber(options.stopoutClusterWindowSeconds ?? env.STOPOUT_CLUSTER_WINDOW_SECONDS, DEFAULTS.stopoutClusterWindowSeconds));
  const stopoutClusterMaxStopouts = Math.max(1, Math.round(safeNumber(options.stopoutClusterMaxStopouts ?? env.STOPOUT_CLUSTER_MAX_STOPOUTS, DEFAULTS.stopoutClusterMaxStopouts)));
  const stopoutClusterCooldownSeconds = Math.max(60, safeNumber(options.stopoutClusterCooldownSeconds ?? env.STOPOUT_CLUSTER_COOLDOWN_SECONDS, DEFAULTS.stopoutClusterCooldownSeconds));

  if (parseBoolish(options.dailyDrawdownEnabled ?? env.DAILY_DRAWDOWN_GUARD_ENABLED, DEFAULTS.dailyDrawdownEnabled) && ((Number.isFinite(dailyPnl) && dailyPnl <= -dailyThreshold) || (Number.isFinite(dailyDrawdown) && dailyDrawdown <= -dailyThreshold))) {
    addGuard(buildGuard({
      guard: 'daily_drawdown',
      reasonCodes: [SessionGuardReason.DAILY_DRAWDOWN_GUARD_ACTIVE],
      expiresAt: endOfUtcDay(now),
      explanation: `Daily PnL ${formatMoney(dailyPnl)} and drawdown ${formatMoney(dailyDrawdown)} are at or below the daily drawdown limit of ${formatMoney(-dailyThreshold)}.`,
      details: { daily_pnl: dailyPnl, daily_drawdown: dailyDrawdown, threshold: -dailyThreshold },
    }));
  }

  if (parseBoolish(options.rollingDrawdownEnabled ?? env.ROLLING_DRAWDOWN_GUARD_ENABLED, DEFAULTS.rollingDrawdownEnabled) && Number.isFinite(rollingDrawdown) && rollingDrawdown <= -rollingThreshold) {
    addGuard(buildGuard({
      guard: 'rolling_drawdown',
      reasonCodes: [SessionGuardReason.ROLLING_DRAWDOWN_GUARD_ACTIVE],
      expiresAt: inferredRollingExpiry(recentOutcomes, now),
      explanation: `Rolling drawdown ${formatMoney(rollingDrawdown)} is at or below the rolling drawdown limit of ${formatMoney(-rollingThreshold)}.`,
      details: { rolling_drawdown: rollingDrawdown, threshold: -rollingThreshold },
    }));
  }

  if (parseBoolish(options.consecutiveLossEnabled ?? env.CONSECUTIVE_LOSS_GUARD_ENABLED, DEFAULTS.consecutiveLossEnabled) && consecutiveLosses >= consecutiveThreshold) {
    addGuard(buildGuard({
      guard: 'consecutive_loss',
      reasonCodes: [SessionGuardReason.CONSECUTIVE_LOSS_GUARD_ACTIVE],
      expiresAt: endOfUtcDay(now),
      explanation: `${consecutiveLosses} consecutive loss(es) reached the limit of ${consecutiveThreshold}.`,
      details: { consecutive_losses: consecutiveLosses, threshold: consecutiveThreshold },
    }));
  }

  if (parseBoolish(options.stopoutClusterEnabled ?? env.STOPOUT_CLUSTER_GUARD_ENABLED, DEFAULTS.stopoutClusterEnabled)) {
    const clusteredStopouts = countRecentStopouts(recentOutcomes, now, stopoutClusterWindowSeconds);
    if (clusteredStopouts >= stopoutClusterMaxStopouts) {
      addGuard(buildGuard({
        guard: 'stopout_cluster',
        reasonCodes: [SessionGuardReason.STOPOUT_CLUSTER_GUARD_ACTIVE],
        expiresAt: new Date(new Date(now).getTime() + (stopoutClusterCooldownSeconds * 1000)).toISOString(),
        explanation: `${clusteredStopouts} stopout(s) occurred inside the recent cluster window.`,
        details: { stopouts: clusteredStopouts, window_seconds: stopoutClusterWindowSeconds, cooldown_seconds: stopoutClusterCooldownSeconds },
      }));
    }
  }

  if (parseBoolish(options.lowProfitHighChurnEnabled ?? env.LOW_PROFIT_HIGH_CHURN_GUARD_ENABLED, DEFAULTS.lowProfitHighChurnEnabled)) {
    const highChurn = recentOutcomes.length >= safeNumber(options.highChurnTradeCount ?? env.LOW_PROFIT_HIGH_CHURN_TRADE_COUNT, DEFAULTS.highChurnTradeCount);
    const lowProfit = totalPnl <= safeNumber(options.lowProfitThresholdDollars ?? env.LOW_PROFIT_HIGH_CHURN_LOW_PROFIT_DOLLARS, DEFAULTS.lowProfitThresholdDollars);
    if (highChurn && lowProfit) {
      addGuard(buildGuard({
        guard: 'low_profit_high_churn',
        reasonCodes: [SessionGuardReason.LOW_PROFIT_HIGH_CHURN_GUARD_ACTIVE],
        expiresAt: endOfUtcDay(now),
        explanation: `Recent trading is busy (${recentOutcomes.length} trades) but profit is only ${formatMoney(totalPnl)}.`,
        details: { recent_trade_count: recentOutcomes.length, total_pnl: totalPnl },
      }));
    }
  }

  if (parseBoolish(options.badSessionEnabled ?? env.BAD_SESSION_GUARD_ENABLED, DEFAULTS.badSessionEnabled)) {
    const minTrades = Math.max(1, Math.round(safeNumber(options.badSessionMinTrades ?? env.BAD_SESSION_MIN_TRADES, DEFAULTS.badSessionMinTrades)));
    const winRateThreshold = Math.max(0, safeNumber(options.badSessionWinRateThreshold ?? env.BAD_SESSION_WIN_RATE_THRESHOLD, DEFAULTS.badSessionWinRateThreshold));
    if (recentOutcomes.length >= minTrades && winRate < winRateThreshold && totalPnl < 0) {
      addGuard(buildGuard({
        guard: 'bad_session',
        reasonCodes: [SessionGuardReason.BAD_SESSION_GUARD_ACTIVE],
        expiresAt: endOfUtcDay(now),
        explanation: `Session quality is weak: win rate ${Math.round(winRate * 100)}% and PnL ${formatMoney(totalPnl)}.`,
        details: { win_rate: winRate, total_pnl: totalPnl },
      }));
    }
  }

  if (setupFatigueSummary.active_setup_count > 0) {
    addGuard(buildGuard({
      guard: 'setup_fatigue',
      reasonCodes: [SessionGuardReason.SETUP_FATIGUE_ACTIVE],
      expiresAt: earliestSetupPause(setupFatigueSummary, now),
      explanation: `${setupFatigueSummary.active_setup_count} setup(s) are paused for fatigue.`,
      details: { active_setup_count: setupFatigueSummary.active_setup_count },
    }));
  }

  if (intradayRegime.manage_only) {
    addGuard(buildGuard({
      guard: 'market_outcome',
      reasonCodes: [SessionGuardReason.MARKET_OUTCOME_GUARD_ACTIVE],
      expiresAt: intradayRegime.regime === 'closed'
        ? endOfUtcDay(now)
        : intradayRegime.minutes_until_close
          ? new Date(new Date(now).getTime() + (intradayRegime.minutes_until_close * 60 * 1000)).toISOString()
          : null,
      explanation: `Intraday regime ${intradayRegime.regime} is manage-only.`,
      details: { regime: intradayRegime.regime, market_open: intradayRegime.market_open },
    }));
  }

  const buyBlocked = activeGuards.length > 0;
  const manageOnly = buyBlocked || Boolean(intradayRegime.manage_only);
  if (manageOnly) reasonCodes.add(SessionGuardReason.MANAGE_ONLY_MODE_ACTIVE);

  return {
    status: activeGuards.length ? 'ACTIVE' : 'CLEAR',
    active_guards: activeGuards,
    buy_blocked: buyBlocked,
    sells_allowed: true,
    manage_only: manageOnly,
    reason_codes: [...reasonCodes],
    expires_at: earliestExpiry || null,
    explanation: activeGuards.length
      ? activeGuards.map((guard) => guard.explanation).filter(Boolean).join(' ')
      : 'No active session guards.',
    intraday_regime: intradayRegime,
    metrics: {
      recent_trade_count: recentOutcomes.length,
      daily_pnl: dailyPnl,
      rolling_drawdown: rollingDrawdown,
      consecutive_losses: consecutiveLosses,
      stopout_count: stopoutCount,
      win_rate: winRate,
      churn_score: roundNumber(churnScore),
    },
    setup_fatigue_summary: setupFatigueSummary,
  };
}

function summarizeSessionGuards(guards = null) {
  if (!guards) return null;
  return {
    status: guards.status || null,
    buy_blocked: Boolean(guards.buy_blocked),
    sells_allowed: Boolean(guards.sells_allowed),
    manage_only: Boolean(guards.manage_only),
    active_guard_count: Array.isArray(guards.active_guards) ? guards.active_guards.length : 0,
    active_guards: guards.active_guards || [],
    reason_codes: guards.reason_codes || [],
    expires_at: guards.expires_at || null,
    explanation: guards.explanation || '',
    metrics: guards.metrics || {},
    intraday_regime: guards.intraday_regime || null,
    setup_fatigue_summary: guards.setup_fatigue_summary || null,
  };
}

function normalizeOutcomeList(outcomes = [], now = nowIso()) {
  return (Array.isArray(outcomes) ? outcomes : [outcomes])
    .map((entry) => entry?.record || entry)
    .filter(Boolean)
    .map((record) => ({
      recorded_at: normalizeIso(record.recorded_at || record.paper_result?.filled_at || record.paper_result?.filledAt || now),
      net_pnl: safeNumber(record.net_pnl ?? record.adjusted_pnl ?? record.pnl, 0),
      exit_reason: record.exit_reason || record.original_signal?.market_context?.exit_state?.exit_reason || record.market_context?.exit_state?.exit_reason || record.exit_state?.exit_reason || null,
      stop_exit: Boolean(record.stop_exit || record.stopped_out || record.paper_result?.stop_exit),
      trailing_exit: Boolean(record.trailing_exit || record.trailing_profit_exit || record.paper_result?.trailing_exit),
      regime: record.regime || record.market_context?.regime || record.original_signal?.market_context?.regime || null,
    }))
    .filter((outcome) => Number.isFinite(new Date(outcome.recorded_at).getTime()));
}

function buildEquityCurve(outcomes = []) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const outcome of outcomes) {
    equity += safeNumber(outcome.net_pnl, 0);
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity - peak);
  }
  return { equity, peak, drawdown };
}

function countConsecutiveLosses(outcomes = []) {
  let count = 0;
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    if (safeNumber(outcomes[index].net_pnl, 0) < 0) count += 1;
    else break;
  }
  return count;
}

function countRecentStopouts(outcomes = [], now = nowIso(), windowSeconds = DEFAULTS.stopoutClusterWindowSeconds) {
  const threshold = new Date(new Date(now).getTime() - (windowSeconds * 1000)).getTime();
  return outcomes.filter((outcome) => {
    const recorded = new Date(outcome.recorded_at).getTime();
    return recorded >= threshold && (outcome.stop_exit || /STOP/i.test(String(outcome.exit_reason || '')));
  }).length;
}

function sumPnl(outcomes = []) {
  return roundNumber(outcomes.reduce((sum, outcome) => sum + safeNumber(outcome.net_pnl, 0), 0));
}

function sameUtcDay(a, b) {
  const first = new Date(a);
  const second = new Date(b);
  if (Number.isNaN(first.getTime()) || Number.isNaN(second.getTime())) return false;
  return first.toISOString().slice(0, 10) === second.toISOString().slice(0, 10);
}

function isWithinHours(recordedAt, now, hours) {
  return Number.isFinite(hours) && hours > 0
    ? hoursBetween(recordedAt, now) <= hours
    : true;
}

function hoursBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 3_600_000;
}

function inferredRollingExpiry(outcomes = [], now = nowIso()) {
  if (!outcomes.length) return endOfUtcDay(now);
  return outcomes[outcomes.length - 1].recorded_at || endOfUtcDay(now);
}

function earliestSetupPause(setupFatigueStateOrSummary = null, now = nowIso()) {
  const paused = Array.isArray(setupFatigueStateOrSummary?.active_setups)
    ? setupFatigueStateOrSummary.active_setups
    : summarizeSetupFatigueState(setupFatigueStateOrSummary || {}).paused_setups;
  const candidates = paused.map((entry) => entry.paused_until).filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] || null;
}

function buildGuard({ guard, reasonCodes = [], expiresAt = null, explanation = '', details = {} } = {}) {
  return {
    guard,
    active: true,
    expires_at: normalizeIso(expiresAt),
    reason_codes: [...new Set(reasonCodes.filter(Boolean))],
    explanation: String(explanation || '').trim(),
    details,
  };
}

function normalizeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function endOfUtcDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCHours(23, 59, 59, 999);
  return date.toISOString();
}

function formatMoney(value) {
  const numeric = safeNumber(value, 0);
  return `${numeric < 0 ? '-' : '+'}$${Math.abs(numeric).toFixed(2)}`;
}

function parseBoolish(value, fallback = false) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return Boolean(fallback);
}

function roundNumber(value) {
  const numeric = safeNumber(value, 0);
  return Math.round(numeric * 1000) / 1000;
}

module.exports = {
  DEFAULTS,
  SessionGuardReason,
  evaluateSessionGuards,
  summarizeSessionGuards,
};
