const fs = require('fs');
const path = require('path');
const { nowIso, safeNumber, resolveRepoRoot } = require('./util');
const { JsonFileStore } = require('./storage');

const AntiChurnClassification = {
  CLEAN_WIN: 'clean_win',
  TRAILING_WIN: 'trailing_win',
  SMALL_WIN: 'small_win',
  GOOD_LOSS: 'good_loss',
  BAD_LOSS: 'bad_loss',
  HARD_STOPOUT: 'hard_stopout',
  EXECUTION_BAD_LOSS: 'execution_bad_loss',
  PARTIAL_FILL_PROBLEM: 'partial_fill_problem',
  CHURN_EXIT: 'churn_exit',
  UNKNOWN: 'unknown',
};

const AntiChurnReason = {
  RECENT_WINNER_PROTECTED: 'RECENT_WINNER_PROTECTED',
  TRAILING_WIN_LIGHT_PENALTY: 'TRAILING_WIN_LIGHT_PENALTY',
  CLEAN_WIN_NO_PENALTY: 'CLEAN_WIN_NO_PENALTY',
  CHURN_RATE_GUARD_ACTIVE: 'CHURN_RATE_GUARD_ACTIVE',
  RAPID_ROUND_TRIP_CHURN: 'RAPID_ROUND_TRIP_CHURN',
  TINY_EXIT_CHURN: 'TINY_EXIT_CHURN',
  REPEATED_STOPOUT_CHURN: 'REPEATED_STOPOUT_CHURN',
  SYMBOL_CHURN_ACTIVE: 'SYMBOL_CHURN_ACTIVE',
  SETUP_CHURN_ACTIVE: 'SETUP_CHURN_ACTIVE',
  ANTI_CHURN_COOLDOWN_ACTIVE: 'ANTI_CHURN_COOLDOWN_ACTIVE',
  SYMBOL_COOLDOWN_ACTIVE: 'SYMBOL_COOLDOWN_ACTIVE',
  SETUP_COOLDOWN_ACTIVE: 'SETUP_COOLDOWN_ACTIVE',
  PARTIAL_FILL_PROBLEM: 'PARTIAL_FILL_PROBLEM',
  EXECUTION_SLIPPAGE_DOMINANT: 'EXECUTION_SLIPPAGE_DOMINANT',
  HARD_STOPOUT: 'HARD_STOPOUT',
  BAD_LOSS: 'BAD_LOSS',
  GOOD_LOSS: 'GOOD_LOSS',
  SMALL_WIN: 'SMALL_WIN',
  CLEAN_WIN: 'CLEAN_WIN',
  TRAILING_WIN: 'TRAILING_WIN',
  CHURN_EXIT: 'CHURN_EXIT',
  UNKNOWN: 'UNKNOWN',
};

const DEFAULTS = {
  antiChurnEnabled: true,
  cleanWinCooldownSeconds: 0,
  trailingWinCooldownSeconds: 5 * 60,
  smallWinCooldownSeconds: 5 * 60,
  goodLossCooldownSeconds: 15 * 60,
  badLossCooldownSeconds: 30 * 60,
  hardStopoutCooldownSeconds: 45 * 60,
  executionBadLossCooldownSeconds: 35 * 60,
  partialFillProblemCooldownSeconds: 20 * 60,
  churnExitCooldownSeconds: 60 * 60,
  unknownCooldownSeconds: 5 * 60,
  repeatedStopoutMultiplier: 2,
  maxCooldownSeconds: 90 * 60,
  recentWinnerProtectionEnabled: true,
  recentWinnerWindowSeconds: 30 * 60,
  tinyExitDollars: 0.5,
  rapidRoundTripSeconds: 10 * 60,
  churnWindowSeconds: 60 * 60,
  churnGuardTradeCount: 4,
  churnGuardStopoutCount: 2,
  churnGuardTinyExitCount: 2,
  churnGuardRoundTripCount: 2,
  churnGuardSymbolLoopCount: 3,
  churnGuardSetupLoopCount: 3,
  churnGuardScoreThreshold: 60,
  retentionHours: 24,
};

function defaultAntiChurnStatePath({ env = process.env, repoRoot = resolveRepoRoot() } = {}) {
  return path.resolve(env.ANTI_CHURN_STATE_PATH || path.join(repoRoot, 'data', 'state', 'anti-churn-state.json'));
}

function loadAntiChurnState(filePathOrOptions = {}) {
  const filePath = typeof filePathOrOptions === 'string'
    ? filePathOrOptions
    : defaultAntiChurnStatePath(filePathOrOptions);
  const store = new JsonFileStore(path.dirname(filePath));
  const name = path.basename(filePath);
  try {
    const data = store.read(name);
    return data ? normalizeAntiChurnState(data) : normalizeAntiChurnState({});
  } catch {
    return normalizeAntiChurnState({});
  }
}

function saveAntiChurnState(state, filePathOrOptions = {}) {
  const filePath = typeof filePathOrOptions === 'string'
    ? filePathOrOptions
    : defaultAntiChurnStatePath(filePathOrOptions);
  const store = new JsonFileStore(path.dirname(filePath));
  const payload = normalizeAntiChurnState(state);
  payload.updated_at = nowIso();
  store.write(path.basename(filePath), payload);
  return payload;
}

function normalizeAntiChurnState(state = {}) {
  return {
    version: state.version || '2026-06-25.anti-churn-state.1',
    updated_at: state.updated_at || null,
    last_reconciled_at: state.last_reconciled_at || null,
    symbol_cooldowns: normalizeCooldownMap(state.symbol_cooldowns),
    setup_cooldowns: normalizeCooldownMap(state.setup_cooldowns),
    recent_classifications: Array.isArray(state.recent_classifications) ? state.recent_classifications.slice(-100) : [],
    churn_guard: normalizeChurnGuard(state.churn_guard),
    recent_winner_protection: normalizeCooldownMap(state.recent_winner_protection),
  };
}

function normalizeCooldownMap(source) {
  const map = {};
  if (!source || typeof source !== 'object') return map;
  for (const [key, value] of Object.entries(source)) {
    const normalized = normalizeCooldownEntry(value, { fallbackKey: key });
    if (normalized) map[key] = normalized;
  }
  return map;
}

function normalizeCooldownEntry(entry = {}, { fallbackKey = null } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const components = Array.isArray(entry.components)
    ? entry.components.map((component) => normalizePenaltyComponent(component)).filter(Boolean)
    : [];
  const penalty = safeNumber(entry.penalty ?? entry.penalty_points ?? 0, 0);
  const remainingSeconds = safeNumber(entry.remaining_seconds, null);
  const reasonCodes = normalizeReasonCodes(entry.reason_codes);
  const symbol = normalizeSymbol(entry.symbol || fallbackKey);
  const setupKey = normalizeSetupKey(entry.setup_key || null);
  const activeComponents = components.filter((component) => Number.isFinite(component.remaining_seconds) ? component.remaining_seconds > 0 : true);
  const activePenalty = activeComponents.reduce((sum, component) => sum + safeNumber(component.penalty_points, 0), 0);
  const resolvedPenalty = activePenalty || penalty;
  const lastComponent = [...components].sort((a, b) => new Date(normalizeIso(b.triggered_at || b.traded_at || b.recorded_at || b.expires_at || 0)).getTime() - new Date(normalizeIso(a.triggered_at || a.traded_at || a.recorded_at || a.expires_at || 0)).getTime())[0] || null;
  const expiresAt = normalizeIso(entry.expires_at || entry.cooldown_until || lastComponent?.expires_at || null);
  const remaining = Number.isFinite(remainingSeconds)
    ? Math.max(0, remainingSeconds)
    : activeComponents.length
      ? Math.max(...activeComponents.map((component) => safeNumber(component.remaining_seconds, 0)))
      : 0;
  return {
    symbol,
    setup_key: setupKey,
    last_traded_at: normalizeIso(entry.last_traded_at || lastComponent?.triggered_at || lastComponent?.traded_at || null),
    age_seconds: safeNumber(entry.age_seconds, lastComponent?.age_seconds ?? 0),
    window_seconds: safeNumber(entry.window_seconds, lastComponent?.window_seconds ?? 0),
    remaining_seconds: remaining,
    penalty: roundNumber(resolvedPenalty),
    penalty_points: roundNumber(entry.penalty_points ?? resolvedPenalty),
    reason: String(entry.reason || lastComponent?.reason || summarizePenaltyCodes(reasonCodes) || 'anti_churn').trim(),
    reason_codes: reasonCodes,
    loss_exit: Boolean(entry.loss_exit ?? components.some((component) => component.loss_exit)),
    stop_exit: Boolean(entry.stop_exit ?? components.some((component) => component.stop_exit)),
    exit_reason: entry.exit_reason || lastComponent?.exit_reason || null,
    classification: entry.classification || lastComponent?.classification || null,
    severity: entry.severity || lastComponent?.severity || null,
    cooldown_until: expiresAt,
    expires_at: expiresAt,
    triggered_at: normalizeIso(entry.triggered_at || lastComponent?.triggered_at || lastComponent?.traded_at || null),
    recent_winner_protected: Boolean(entry.recent_winner_protected ?? components.some((component) => component.recent_winner_protected)),
    trade_count: safeNumber(entry.trade_count, components.length),
    repeated_stopout_count: safeNumber(entry.repeated_stopout_count, components.filter((component) => component.stop_exit).length),
    explanation: String(entry.explanation || lastComponent?.explanation || '').trim(),
    components: components.map((component) => ({ ...component })),
  };
}

function normalizePenaltyComponent(component = {}) {
  if (!component || typeof component !== 'object') return null;
  const classification = normalizeClassification(component.classification || component.reason || null);
  const reasonCodes = normalizeReasonCodes(component.reason_codes);
  return {
    symbol: normalizeSymbol(component.symbol || null),
    setup_key: normalizeSetupKey(component.setup_key || null),
    classification,
    reason: component.reason || classification || 'anti_churn',
    reason_codes: reasonCodes,
    penalty_points: roundNumber(component.penalty_points ?? component.penalty ?? 0),
    cooldown_seconds: Math.max(0, roundNumber(component.cooldown_seconds ?? 0)),
    remaining_seconds: Math.max(0, roundNumber(component.remaining_seconds ?? 0)),
    cooldown_until: normalizeIso(component.cooldown_until || component.expires_at || null),
    expires_at: normalizeIso(component.expires_at || component.cooldown_until || null),
    triggered_at: normalizeIso(component.triggered_at || component.traded_at || component.recorded_at || null),
    age_seconds: Math.max(0, roundNumber(component.age_seconds ?? 0)),
    window_seconds: Math.max(0, roundNumber(component.window_seconds ?? 0)),
    recent_winner_protected: Boolean(component.recent_winner_protected),
    loss_exit: Boolean(component.loss_exit),
    stop_exit: Boolean(component.stop_exit),
    exit_reason: component.exit_reason || null,
    severity: component.severity || null,
    explanation: String(component.explanation || '').trim(),
  };
}

function normalizeChurnGuard(guard = {}) {
  if (!guard || typeof guard !== 'object') {
    return {
      active: false,
      triggered_at: null,
      expires_at: null,
      window_seconds: 0,
      trade_count: 0,
      churn_score: 0,
      reason_codes: [],
      explanation: '',
    };
  }
  return {
    active: Boolean(guard.active),
    triggered_at: normalizeIso(guard.triggered_at || null),
    expires_at: normalizeIso(guard.expires_at || null),
    window_seconds: Math.max(0, safeNumber(guard.window_seconds, 0)),
    trade_count: Math.max(0, safeNumber(guard.trade_count, 0)),
    churn_score: Math.max(0, safeNumber(guard.churn_score, 0)),
    reason_codes: normalizeReasonCodes(guard.reason_codes),
    explanation: String(guard.explanation || '').trim(),
    indicators: guard.indicators && typeof guard.indicators === 'object' ? guard.indicators : {},
  };
}

function classifyExitOutcome(input = {}) {
  const exitReason = normalizeText(
    input.exit_reason
      || input.original_signal?.market_context?.exit_state?.exit_reason
      || input.market_context?.exit_state?.exit_reason
      || input.exit_state?.exit_reason
      || null,
  );
  const exitReasonUpper = exitReason.toUpperCase();
  const pnl = firstFinite(input.net_pnl, input.adjusted_pnl, input.pnl, input.gross_pnl, input.profit, null);
  const grossPnl = firstFinite(input.gross_pnl, input.pnl, input.net_pnl, null);
  const executionDrag = Math.max(0, safeNumber(input.execution_drag ?? input.slippage ?? input.execution_slippage ?? input.fees, 0));
  const tradeDurationSeconds = firstFinite(
    input.trade_duration_seconds,
    input.position_duration_seconds,
    input.duration_seconds,
    input.holding_period_seconds,
    null,
  );
  const partialFill = hasPartialFillProblem(input);
  const trailingExit = Boolean(
    input.trailing_exit
      || input.trailing_profit_exit
      || input.trailing_active
      || /TRAIL/i.test(exitReasonUpper),
  );
  const stoppedOut = Boolean(
    input.stopped_out
      || input.stop_out
      || input.stop_exit
      || /STOP/i.test(exitReasonUpper),
  );
  const tinyExitDollars = Math.max(0, safeNumber(input.tiny_exit_dollars, DEFAULTS.tinyExitDollars));
  const rapidRoundTripSeconds = Math.max(1, safeNumber(input.rapid_round_trip_seconds, DEFAULTS.rapidRoundTripSeconds));
  const priorHistory = Array.isArray(input.prior_history) ? input.prior_history : [];
  const sameSymbolRecentCount = priorHistory.filter((item) => {
    if (!item) return false;
    const symbol = normalizeSymbol(item.symbol || item.original_signal?.symbol || null);
    if (symbol !== normalizeSymbol(input.symbol || input.original_signal?.symbol || null)) return false;
    const outcomeTime = new Date(item.recorded_at || item.triggered_at || item.expires_at || 0).getTime();
    const currentTime = new Date(input.now || nowIso()).getTime();
    return Number.isFinite(outcomeTime) && Number.isFinite(currentTime) && currentTime - outcomeTime <= DEFAULTS.churnWindowSeconds * 1000;
  }).length;
  const rapidRoundTrip = Number.isFinite(tradeDurationSeconds) && tradeDurationSeconds <= rapidRoundTripSeconds;
  const absolutePnl = Math.abs(Number.isFinite(pnl) ? pnl : firstFinite(grossPnl, 0));
  const tinyExit = Number.isFinite(absolutePnl) && absolutePnl <= tinyExitDollars;
  const churnLike = Boolean(
    input.churn_exit
      || input.churn_score >= DEFAULTS.churnGuardScoreThreshold
      || (rapidRoundTrip && tinyExit)
      || (sameSymbolRecentCount >= 2 && rapidRoundTrip)
      || (sameSymbolRecentCount >= 3 && tinyExit)
      || (Number.isFinite(tradeDurationSeconds) && tradeDurationSeconds <= rapidRoundTripSeconds / 2 && Number.isFinite(pnl) && pnl <= 0),
  );

  if (partialFill) {
    return withClassification({
      classification: AntiChurnClassification.PARTIAL_FILL_PROBLEM,
      severity: 'medium',
      reasonCodes: [AntiChurnReason.PARTIAL_FILL_PROBLEM],
      explanation: 'Partial fill or residual exposure requires cooldown.',
      stopExit: false,
      trailingExit,
      pnl,
      grossPnl,
      executionDrag,
      tradeDurationSeconds,
      partialFill: true,
      churnLike,
    });
  }

  if (churnLike) {
    return withClassification({
      classification: AntiChurnClassification.CHURN_EXIT,
      severity: 'high',
      reasonCodes: [AntiChurnReason.CHURN_EXIT],
      explanation: 'Exit appears to be part of a churn loop.',
      stopExit: stoppedOut,
      trailingExit,
      pnl,
      grossPnl,
      executionDrag,
      tradeDurationSeconds,
      partialFill: false,
      churnLike: true,
    });
  }

  if (Number.isFinite(pnl) && pnl > 0) {
    if (trailingExit) {
      return withClassification({
        classification: AntiChurnClassification.TRAILING_WIN,
        severity: 'low',
        reasonCodes: [AntiChurnReason.RECENT_WINNER_PROTECTED, AntiChurnReason.TRAILING_WIN_LIGHT_PENALTY],
        explanation: 'Trailing winner gets a light anti-churn penalty.',
        stopExit: false,
        trailingExit: true,
        pnl,
        grossPnl,
        executionDrag,
        tradeDurationSeconds,
        recentWinnerProtected: true,
      });
    }
    if (absolutePnl <= tinyExitDollars) {
      return withClassification({
        classification: AntiChurnClassification.SMALL_WIN,
        severity: 'low',
        reasonCodes: [AntiChurnReason.RECENT_WINNER_PROTECTED],
        explanation: 'Small win stays eligible with only a light cooling effect.',
        stopExit: false,
        trailingExit: false,
        pnl,
        grossPnl,
        executionDrag,
        tradeDurationSeconds,
        recentWinnerProtected: true,
      });
    }
    return withClassification({
      classification: AntiChurnClassification.CLEAN_WIN,
      severity: 'low',
      reasonCodes: [AntiChurnReason.RECENT_WINNER_PROTECTED, AntiChurnReason.CLEAN_WIN_NO_PENALTY],
      explanation: 'Clean winner receives no anti-churn penalty.',
      stopExit: false,
      trailingExit: false,
      pnl,
      grossPnl,
      executionDrag,
      tradeDurationSeconds,
      recentWinnerProtected: true,
    });
  }

  if (stoppedOut) {
    return withClassification({
      classification: AntiChurnClassification.HARD_STOPOUT,
      severity: 'critical',
      reasonCodes: [AntiChurnReason.HARD_STOPOUT],
      explanation: 'Stop-based exit gets a strong cooldown.',
      stopExit: true,
      trailingExit,
      pnl,
      grossPnl,
      executionDrag,
      tradeDurationSeconds,
    });
  }

  if (Number.isFinite(executionDrag) && executionDrag > 0 && Number.isFinite(pnl) && pnl < 0) {
    const dragDominates = Math.abs(executionDrag) >= Math.max(0.5, Math.abs(Number.isFinite(grossPnl) ? grossPnl : pnl) * 0.5);
    if (dragDominates) {
      return withClassification({
        classification: AntiChurnClassification.EXECUTION_BAD_LOSS,
        severity: 'high',
        reasonCodes: [AntiChurnReason.EXECUTION_SLIPPAGE_DOMINANT],
        explanation: 'Loss is dominated by execution drag or slippage.',
        stopExit: false,
        trailingExit,
        pnl,
        grossPnl,
        executionDrag,
        tradeDurationSeconds,
      });
    }
  }

  if (Number.isFinite(pnl) && pnl < 0) {
    if (absolutePnl <= Math.max(1, tinyExitDollars * 2)) {
      return withClassification({
        classification: AntiChurnClassification.GOOD_LOSS,
        severity: 'medium',
        reasonCodes: [AntiChurnReason.GOOD_LOSS],
        explanation: 'Managed loss gets a moderate cooldown.',
        stopExit: false,
        trailingExit,
        pnl,
        grossPnl,
        executionDrag,
        tradeDurationSeconds,
      });
    }
    return withClassification({
      classification: AntiChurnClassification.BAD_LOSS,
      severity: 'high',
      reasonCodes: [AntiChurnReason.BAD_LOSS],
      explanation: 'Loss is large enough to warrant stronger rotation pressure.',
      stopExit: false,
      trailingExit,
      pnl,
      grossPnl,
      executionDrag,
      tradeDurationSeconds,
    });
  }

  return withClassification({
    classification: AntiChurnClassification.UNKNOWN,
    severity: 'none',
    reasonCodes: [AntiChurnReason.UNKNOWN],
    explanation: 'Insufficient data to classify exit outcome.',
    stopExit: stoppedOut,
    trailingExit,
    pnl,
    grossPnl,
    executionDrag,
    tradeDurationSeconds,
    partialFill: false,
  });
}

function calculateAntiChurnPenalty(input = {}) {
  const now = input.now || nowIso();
  const nowMs = new Date(now).getTime();
  const classificationResult = input.classification && input.classification.classification
    ? input.classification
    : classifyExitOutcome(input);
  const cfg = { ...DEFAULTS, ...normalizePenaltyConfig(input) };
  const priorHistory = Array.isArray(input.prior_history) ? input.prior_history : [];
  const symbol = normalizeSymbol(input.symbol || input.original_signal?.symbol || null);
  const setupKey = normalizeSetupKey(input.setup_key || input.original_signal?.setup_key || input.market_context?.setup_key || null);
  const repeatedStopouts = priorHistory.filter((item) => {
    const itemSymbol = normalizeSymbol(item.symbol || item.original_signal?.symbol || null);
    if (symbol && itemSymbol !== symbol) return false;
    const itemClass = normalizeClassification(item.classification || item.exit_classification || item.reason || null);
    return itemClass === AntiChurnClassification.HARD_STOPOUT || Boolean(item.stop_exit || item.stopped_out);
  }).length;
  const base = resolveBasePenaltyAndCooldown(classificationResult.classification, cfg);
  let penaltyPoints = base.penalty_points;
  let cooldownSeconds = base.cooldown_seconds;
  const reasonCodes = new Set(base.reason_codes);
  const recentWinnerProtected = Boolean(base.recent_winner_protected);
  const stopExit = Boolean(classificationResult.stop_exit || input.stopped_out || input.stop_exit);
  const trailingExit = Boolean(classificationResult.trailing_exit || input.trailing_exit);

  if (stopExit && repeatedStopouts > 0) {
    cooldownSeconds = Math.round(cooldownSeconds * Math.pow(Math.max(1, cfg.repeatedStopoutMultiplier), repeatedStopouts));
    penaltyPoints = Math.round(penaltyPoints * Math.pow(Math.max(1, cfg.repeatedStopoutMultiplier), Math.max(0, repeatedStopouts - 1)));
    reasonCodes.add(AntiChurnReason.REPEATED_STOPOUT_CHURN);
  }

  if (classificationResult.classification === AntiChurnClassification.CLEAN_WIN && cfg.recentWinnerProtectionEnabled) {
    penaltyPoints = 0;
    cooldownSeconds = cfg.cleanWinCooldownSeconds;
    reasonCodes.add(AntiChurnReason.RECENT_WINNER_PROTECTED);
  }

  if (classificationResult.classification === AntiChurnClassification.TRAILING_WIN && cfg.recentWinnerProtectionEnabled) {
    penaltyPoints = Math.min(penaltyPoints, 5);
    reasonCodes.add(AntiChurnReason.RECENT_WINNER_PROTECTED);
    reasonCodes.add(AntiChurnReason.TRAILING_WIN_LIGHT_PENALTY);
  }

  cooldownSeconds = Math.min(cfg.maxCooldownSeconds, Math.max(0, Math.round(cooldownSeconds)));
  penaltyPoints = Math.max(0, Math.round(penaltyPoints));
  const cooldownUntil = cooldownSeconds > 0 ? new Date(nowMs + cooldownSeconds * 1000).toISOString() : null;
  const severity = classificationResult.severity || severityFromPenalty(penaltyPoints);
  const explanation = classificationResult.explanation
    || `${classificationResult.classification} -> ${penaltyPoints} point anti-churn penalty`;

  return {
    symbol,
    setup_key: setupKey,
    classification: classificationResult.classification,
    severity,
    penalty_points: penaltyPoints,
    penalty: penaltyPoints,
    cooldown_until: cooldownUntil,
    expires_at: cooldownUntil,
    cooldown_seconds: cooldownSeconds,
    recent_winner_protected: recentWinnerProtected || classificationResult.recent_winner_protected,
    reason_codes: [...reasonCodes],
    explanation,
    stop_exit: stopExit,
    trailing_exit: trailingExit,
    trade_duration_seconds: classificationResult.trade_duration_seconds ?? firstFinite(input.trade_duration_seconds, null),
    gross_pnl: classificationResult.gross_pnl ?? firstFinite(input.gross_pnl, input.pnl, input.net_pnl, null),
    net_pnl: classificationResult.pnl ?? firstFinite(input.net_pnl, input.adjusted_pnl, input.pnl, null),
    execution_drag: classificationResult.execution_drag ?? safeNumber(input.execution_drag, 0),
    churn_like: classificationResult.classification === AntiChurnClassification.CHURN_EXIT,
    repeated_stopout_count: repeatedStopouts,
    triggered_at: normalizeIso(input.triggered_at || input.recorded_at || now),
    last_traded_at: normalizeIso(input.last_traded_at || input.recorded_at || now),
    age_seconds: Number.isFinite(input.age_seconds) ? Math.max(0, roundNumber(input.age_seconds)) : 0,
    window_seconds: Number.isFinite(input.window_seconds) ? Math.max(0, roundNumber(input.window_seconds)) : cooldownSeconds,
    components: input.components ? input.components.slice() : [],
  };
}

function evaluateChurnGuard(input = {}) {
  const now = input.now || nowIso();
  const nowMs = new Date(now).getTime();
  const windowSeconds = Math.max(1, safeNumber(input.window_seconds ?? input.churn_window_seconds, DEFAULTS.churnWindowSeconds));
  const rapidRoundTripSeconds = Math.max(1, safeNumber(input.rapid_round_trip_seconds, DEFAULTS.rapidRoundTripSeconds));
  const tinyExitDollars = Math.max(0, safeNumber(input.tiny_exit_dollars, DEFAULTS.tinyExitDollars));
  const scoreThreshold = Math.max(1, safeNumber(input.churn_guard_score_threshold, DEFAULTS.churnGuardScoreThreshold));
  const minTradeCount = Math.max(0, safeNumber(input.churn_guard_trade_count, DEFAULTS.churnGuardTradeCount));
  const minStopouts = Math.max(0, safeNumber(input.churn_guard_stopout_count, DEFAULTS.churnGuardStopoutCount));
  const minTinyExits = Math.max(0, safeNumber(input.churn_guard_tiny_exit_count, DEFAULTS.churnGuardTinyExitCount));
  const minRoundTrips = Math.max(0, safeNumber(input.churn_guard_round_trip_count, DEFAULTS.churnGuardRoundTripCount));
  const minSymbolLoops = Math.max(0, safeNumber(input.churn_guard_symbol_loop_count, DEFAULTS.churnGuardSymbolLoopCount));
  const minSetupLoops = Math.max(0, safeNumber(input.churn_guard_setup_loop_count, DEFAULTS.churnGuardSetupLoopCount));

  const outcomes = normalizeOutcomeList(input.paperOutcomes || input.events || input.history || []);
  const recent = outcomes.filter((outcome) => {
    const ts = new Date(outcome.recorded_at || outcome.triggered_at || 0).getTime();
    return Number.isFinite(ts) && nowMs - ts <= windowSeconds * 1000;
  });

  const bySymbol = new Map();
  const bySetup = new Map();
  let stopoutCount = 0;
  let tinyExitCount = 0;
  let roundTripCount = 0;
  let negativePnlCount = 0;
  let totalDuration = 0;
  let durationCount = 0;

  for (const outcome of recent) {
    const symbol = normalizeSymbol(outcome.symbol || outcome.original_signal?.symbol || null) || 'UNKNOWN';
    const setupKey = normalizeSetupKey(resolveSetupKey(outcome)) || null;
    bySymbol.set(symbol, (bySymbol.get(symbol) || 0) + 1);
    if (setupKey) bySetup.set(setupKey, (bySetup.get(setupKey) || 0) + 1);

    const classification = normalizeClassification(outcome.classification || classifyExitOutcome(outcome).classification);
    const pnl = firstFinite(outcome.net_pnl, outcome.adjusted_pnl, outcome.pnl, outcome.gross_pnl, null);
    const duration = firstFinite(outcome.trade_duration_seconds, outcome.duration_seconds, outcome.position_duration_seconds, null);
    if (classification === AntiChurnClassification.HARD_STOPOUT || Boolean(outcome.stopped_out || outcome.stop_exit)) stopoutCount += 1;
    if (Number.isFinite(pnl) && Math.abs(pnl) <= tinyExitDollars) tinyExitCount += 1;
    if (Number.isFinite(duration)) {
      totalDuration += duration;
      durationCount += 1;
      if (duration <= rapidRoundTripSeconds) roundTripCount += 1;
    }
    if (Number.isFinite(pnl) && pnl < 0) negativePnlCount += 1;
  }

  const avgDurationSeconds = durationCount ? totalDuration / durationCount : null;
  const symbolLoopCount = [...bySymbol.values()].filter((count) => count >= 2).length;
  const setupLoopCount = [...bySetup.values()].filter((count) => count >= 2).length;
  const churnScore = Math.round(
    (roundTripCount * 20)
    + (tinyExitCount * 15)
    + (stopoutCount * 25)
    + (Math.max(0, negativePnlCount - 1) * 8)
    + (symbolLoopCount * 10)
    + (setupLoopCount * 10)
    + (Number.isFinite(avgDurationSeconds) && avgDurationSeconds <= rapidRoundTripSeconds ? 10 : 0),
  );
  const reasonCodes = [];
  if (roundTripCount >= minRoundTrips) reasonCodes.push(AntiChurnReason.RAPID_ROUND_TRIP_CHURN);
  if (tinyExitCount >= minTinyExits) reasonCodes.push(AntiChurnReason.TINY_EXIT_CHURN);
  if (stopoutCount >= minStopouts) reasonCodes.push(AntiChurnReason.REPEATED_STOPOUT_CHURN);
  if (symbolLoopCount >= minSymbolLoops) reasonCodes.push(AntiChurnReason.SYMBOL_CHURN_ACTIVE);
  if (setupLoopCount >= minSetupLoops) reasonCodes.push(AntiChurnReason.SETUP_CHURN_ACTIVE);

  const active = recent.length >= minTradeCount && (
    churnScore >= scoreThreshold
    || reasonCodes.length >= 2
    || (stopoutCount >= minStopouts && roundTripCount >= minRoundTrips)
    || (Number.isFinite(avgDurationSeconds) && avgDurationSeconds <= rapidRoundTripSeconds / 2 && negativePnlCount >= Math.max(2, minTradeCount - 1))
  );
  if (active) reasonCodes.unshift(AntiChurnReason.CHURN_RATE_GUARD_ACTIVE);

  const triggeredAt = active ? recent[recent.length - 1]?.recorded_at || now : null;
  const expiresAt = active
    ? new Date(Math.min(nowMs + windowSeconds * 1000, nowMs + Math.max(windowSeconds, rapidRoundTripSeconds) * 1000)).toISOString()
    : null;
  const explanation = active
    ? `Churn score ${churnScore} across ${recent.length} trades is above the guard threshold.`
    : `Churn score ${churnScore} is below the guard threshold.`;

  return {
    active,
    triggered_at: triggeredAt,
    expires_at: expiresAt,
    window_seconds: windowSeconds,
    trade_count: recent.length,
    churn_score: churnScore,
    reason_codes: [...new Set(reasonCodes)],
    explanation,
    indicators: {
      rapid_round_trip_count: roundTripCount,
      tiny_exit_count: tinyExitCount,
      repeated_stopout_count: stopoutCount,
      symbol_loop_count: symbolLoopCount,
      setup_loop_count: setupLoopCount,
      negative_pnl_count: negativePnlCount,
      average_duration_seconds: Number.isFinite(avgDurationSeconds) ? roundNumber(avgDurationSeconds) : null,
    },
  };
}

function summarizeAntiChurnState(state = {}) {
  const normalized = normalizeAntiChurnState(state);
  const symbolEntries = Object.values(normalized.symbol_cooldowns);
  const setupEntries = Object.values(normalized.setup_cooldowns);
  const activeSymbolEntries = symbolEntries.filter((entry) => isActiveCooldownEntry(entry));
  const activeSetupEntries = setupEntries.filter((entry) => isActiveCooldownEntry(entry));
  const penaltyPoints = activeSymbolEntries.reduce((sum, entry) => sum + safeNumber(entry.penalty, 0), 0)
    + activeSetupEntries.reduce((sum, entry) => sum + safeNumber(entry.penalty, 0), 0);
  const reasonCodes = [...new Set([
    ...(normalized.churn_guard?.reason_codes || []),
    ...activeSymbolEntries.flatMap((entry) => entry.reason_codes || []),
    ...activeSetupEntries.flatMap((entry) => entry.reason_codes || []),
  ])];
  const cooldownExpiryTimes = [
    ...activeSymbolEntries.map((entry) => ({
      symbol: entry.symbol,
      cooldown_until: entry.cooldown_until || null,
      remaining_seconds: safeNumber(entry.remaining_seconds, 0),
    })),
    ...activeSetupEntries.map((entry) => ({
      setup_key: entry.setup_key,
      cooldown_until: entry.cooldown_until || null,
      remaining_seconds: safeNumber(entry.remaining_seconds, 0),
    })),
  ].sort((a, b) => safeNumber(b.remaining_seconds, 0) - safeNumber(a.remaining_seconds, 0));
  const recentWinnerProtection = Object.values(normalized.recent_winner_protection || {}).filter((entry) => entry.recent_winner_protected || includesReason(entry.reason_codes, AntiChurnReason.RECENT_WINNER_PROTECTED));
  return {
    version: normalized.version,
    updated_at: normalized.updated_at,
    last_reconciled_at: normalized.last_reconciled_at,
    active_churn_guard: Boolean(normalized.churn_guard?.active),
    churn_guard: normalized.churn_guard,
    symbols_under_cooldown: activeSymbolEntries,
    setups_under_cooldown: activeSetupEntries,
    recent_exit_classifications: normalized.recent_classifications.slice(-20),
    recent_winner_protection: recentWinnerProtection,
    penalty_points: roundNumber(penaltyPoints),
    cooldown_expiry_times: cooldownExpiryTimes,
    reason_codes: reasonCodes,
    symbol_cooldown_count: activeSymbolEntries.length,
    setup_cooldown_count: activeSetupEntries.length,
    recent_exit_count: normalized.recent_classifications.length,
    symbol_cooldowns: normalized.symbol_cooldowns,
    setup_cooldowns: normalized.setup_cooldowns,
    recent_classifications: normalized.recent_classifications,
  };
}

async function reconcileAntiChurnState({
  previousState = {},
  paperOutcomes = null,
  performanceHistoryPath = null,
  now = nowIso(),
  env = process.env,
  repoRoot = resolveRepoRoot(),
  antiChurnEnabled = DEFAULTS.antiChurnEnabled,
  retentionHours = DEFAULTS.retentionHours,
  ...config
} = {}) {
  const baseState = normalizeAntiChurnState(previousState);
  if (!antiChurnEnabled) {
    return normalizeAntiChurnState({
      ...baseState,
      updated_at: now,
      last_reconciled_at: now,
      churn_guard: evaluateChurnGuard({ paperOutcomes: [], now, ...config }),
    });
  }
  const historyPath = performanceHistoryPath || path.join(repoRoot, 'data', 'performance-history.jsonl');
  const outcomes = Array.isArray(paperOutcomes) ? paperOutcomes : readPaperOutcomesFromHistory(historyPath, config.historyMaxBytes || 512 * 1024);
  const recentOutcomes = normalizeOutcomeList(outcomes)
    .filter(isExitOutcome)
    .filter((outcome) => require('./setup-fatigue').isWithinRetentionWindow(outcome.recorded_at, now, retentionHours))
    .sort((a, b) => new Date(a.recorded_at || 0).getTime() - new Date(b.recorded_at || 0).getTime());

  const symbolBuckets = new Map();
  const setupBuckets = new Map();
  const classifications = [];

  for (const outcome of recentOutcomes) {
    const symbol = normalizeSymbol(outcome.symbol || outcome.original_signal?.symbol || null) || 'UNKNOWN';
    const setupKey = normalizeSetupKey(resolveSetupKey(outcome)) || null;
    const priorHistory = symbolBuckets.get(symbol) || [];
    const classification = classifyExitOutcome({ ...outcome, prior_history: priorHistory, now });
    const penalty = calculateAntiChurnPenalty({
      ...outcome,
      classification,
      prior_history: priorHistory,
      now,
      ...config,
    });
    const component = buildPenaltyComponentFromResult({
      outcome,
      classification,
      penalty,
    });
    classifications.push(component);
    symbolBuckets.set(symbol, [...priorHistory, component]);
    if (setupKey) {
      const priorSetupHistory = setupBuckets.get(setupKey) || [];
      setupBuckets.set(setupKey, [...priorSetupHistory, component]);
    }
  }

  const symbolCooldowns = collapsePenaltyBuckets(symbolBuckets, { kind: 'symbol', now });
  const setupCooldowns = collapsePenaltyBuckets(setupBuckets, { kind: 'setup', now });
  const churnGuard = evaluateChurnGuard({
    paperOutcomes: recentOutcomes,
    now,
    ...config,
  });

  return normalizeAntiChurnState({
    ...baseState,
    updated_at: now,
    last_reconciled_at: now,
    symbol_cooldowns: symbolCooldowns,
    setup_cooldowns: setupCooldowns,
    recent_classifications: classifications.slice(-100),
    churn_guard: churnGuard,
    recent_winner_protection: buildRecentWinnerProtection(symbolCooldowns),
  });
}

function buildRecentWinnerProtection(symbolCooldowns = {}) {
  const entries = Object.values(symbolCooldowns || {});
  const winners = entries.filter((entry) => entry.recent_winner_protected || includesReason(entry.reason_codes, AntiChurnReason.RECENT_WINNER_PROTECTED));
  const map = {};
  for (const entry of winners) {
    if (!entry.symbol) continue;
    map[entry.symbol] = {
      symbol: entry.symbol,
      cooldown_until: entry.cooldown_until || null,
      remaining_seconds: safeNumber(entry.remaining_seconds, 0),
      penalty: safeNumber(entry.penalty, 0),
      reason_codes: entry.reason_codes || [],
      recent_winner_protected: true,
    };
  }
  return map;
}

function collapsePenaltyBuckets(bucketMap, { kind = 'symbol', now = nowIso() } = {}) {
  const nowMs = new Date(now).getTime();
  const output = {};
  for (const [key, components] of bucketMap.entries()) {
    const activeComponents = components
      .filter((component) => !component.expires_at || new Date(component.expires_at).getTime() > nowMs)
      .map((component) => normalizePenaltyComponent(component))
      .filter(Boolean);
    if (!activeComponents.length) continue;
    const latest = [...activeComponents].sort((a, b) => new Date(normalizeIso(b.triggered_at || b.expires_at || 0)).getTime() - new Date(normalizeIso(a.triggered_at || a.expires_at || 0)).getTime())[0];
    const penalty = activeComponents.reduce((sum, component) => sum + safeNumber(component.penalty_points, 0), 0);
    const remainingSeconds = Math.max(...activeComponents.map((component) => safeNumber(component.remaining_seconds, 0)));
    const cooldownSeconds = Math.max(...activeComponents.map((component) => safeNumber(component.cooldown_seconds, 0)));
    const reasonCodes = [...new Set(activeComponents.flatMap((component) => component.reason_codes || []))];
    const expiresAt = latest?.expires_at || latest?.cooldown_until || null;
    const record = {
      [kind === 'setup' ? 'setup_key' : 'symbol']: key,
      ...(kind === 'setup' ? { setup_key: key } : { symbol: key }),
      classification: latest?.classification || AntiChurnClassification.UNKNOWN,
      severity: latest?.severity || severityFromPenalty(penalty),
      penalty_points: roundNumber(penalty),
      penalty: roundNumber(penalty),
      cooldown_seconds: roundNumber(cooldownSeconds),
      cooldown_until: expiresAt,
      expires_at: expiresAt,
      remaining_seconds: roundNumber(remainingSeconds),
      triggered_at: latest?.triggered_at || latest?.expires_at || now,
      last_traded_at: latest?.triggered_at || latest?.traded_at || latest?.recorded_at || now,
      age_seconds: safeNumber(latest?.age_seconds, 0),
      window_seconds: safeNumber(latest?.window_seconds, cooldownSeconds),
      reason: summarizePenaltyCodes(reasonCodes),
      reason_codes: reasonCodes,
      loss_exit: activeComponents.some((component) => component.loss_exit),
      stop_exit: activeComponents.some((component) => component.stop_exit),
      exit_reason: latest?.exit_reason || null,
      recent_winner_protected: activeComponents.some((component) => component.recent_winner_protected),
      trade_count: components.length,
      repeated_stopout_count: activeComponents.filter((component) => component.stop_exit).length,
      explanation: latest?.explanation || '',
      components: activeComponents.map((component) => ({ ...component })),
    };
    output[key] = normalizeCooldownEntry(record, { fallbackKey: key });
  }
  return output;
}

function buildPenaltyComponentFromResult({ outcome = {}, classification = {}, penalty = {} } = {}) {
  return normalizePenaltyComponent({
    symbol: normalizeSymbol(outcome.symbol || outcome.original_signal?.symbol || null),
    setup_key: normalizeSetupKey(resolveSetupKey(outcome)),
    classification: classification.classification,
    severity: penalty.severity || classification.severity || 'low',
    penalty_points: penalty.penalty_points,
    cooldown_seconds: penalty.cooldown_seconds,
    cooldown_until: penalty.cooldown_until,
    expires_at: penalty.expires_at,
    triggered_at: normalizeIso(outcome.recorded_at || outcome.paper_result?.filled_at || outcome.filled_at || nowIso()),
    age_seconds: firstFinite(outcome.age_seconds, null),
    window_seconds: penalty.cooldown_seconds,
    recent_winner_protected: Boolean(penalty.recent_winner_protected),
    loss_exit: Boolean(penalty.stop_exit || outcome.stopped_out || outcome.stop_exit),
    stop_exit: Boolean(penalty.stop_exit || outcome.stopped_out || outcome.stop_exit),
    exit_reason: outcome.exit_reason || outcome.original_signal?.market_context?.exit_state?.exit_reason || null,
    explanation: penalty.explanation || '',
    reason: classification.classification,
    reason_codes: penalty.reason_codes || classification.reason_codes || [],
    pnl: penalty.net_pnl ?? outcome.net_pnl ?? outcome.adjusted_pnl ?? outcome.pnl ?? null,
  });
}

function resolveBasePenaltyAndCooldown(classification, cfg) {
  switch (classification) {
    case AntiChurnClassification.CLEAN_WIN:
      return {
        penalty_points: 0,
        cooldown_seconds: cfg.cleanWinCooldownSeconds,
        reason_codes: [AntiChurnReason.CLEAN_WIN_NO_PENALTY],
        recent_winner_protected: true,
      };
    case AntiChurnClassification.TRAILING_WIN:
      return {
        penalty_points: 5,
        cooldown_seconds: cfg.trailingWinCooldownSeconds,
        reason_codes: [AntiChurnReason.TRAILING_WIN_LIGHT_PENALTY, AntiChurnReason.RECENT_WINNER_PROTECTED],
        recent_winner_protected: true,
      };
    case AntiChurnClassification.SMALL_WIN:
      return {
        penalty_points: 2,
        cooldown_seconds: cfg.smallWinCooldownSeconds,
        reason_codes: [AntiChurnReason.RECENT_WINNER_PROTECTED],
        recent_winner_protected: true,
      };
    case AntiChurnClassification.GOOD_LOSS:
      return {
        penalty_points: 15,
        cooldown_seconds: cfg.goodLossCooldownSeconds,
        reason_codes: [AntiChurnReason.GOOD_LOSS],
        recent_winner_protected: false,
      };
    case AntiChurnClassification.BAD_LOSS:
      return {
        penalty_points: 25,
        cooldown_seconds: cfg.badLossCooldownSeconds,
        reason_codes: [AntiChurnReason.BAD_LOSS],
        recent_winner_protected: false,
      };
    case AntiChurnClassification.HARD_STOPOUT:
      return {
        penalty_points: 40,
        cooldown_seconds: cfg.hardStopoutCooldownSeconds,
        reason_codes: [AntiChurnReason.HARD_STOPOUT],
        recent_winner_protected: false,
      };
    case AntiChurnClassification.EXECUTION_BAD_LOSS:
      return {
        penalty_points: 30,
        cooldown_seconds: cfg.executionBadLossCooldownSeconds,
        reason_codes: [AntiChurnReason.EXECUTION_SLIPPAGE_DOMINANT],
        recent_winner_protected: false,
      };
    case AntiChurnClassification.PARTIAL_FILL_PROBLEM:
      return {
        penalty_points: 20,
        cooldown_seconds: cfg.partialFillProblemCooldownSeconds,
        reason_codes: [AntiChurnReason.PARTIAL_FILL_PROBLEM],
        recent_winner_protected: false,
      };
    case AntiChurnClassification.CHURN_EXIT:
      return {
        penalty_points: 50,
        cooldown_seconds: cfg.churnExitCooldownSeconds,
        reason_codes: [AntiChurnReason.CHURN_EXIT],
        recent_winner_protected: false,
      };
    default:
      return {
        penalty_points: 8,
        cooldown_seconds: cfg.unknownCooldownSeconds,
        reason_codes: [AntiChurnReason.UNKNOWN],
        recent_winner_protected: false,
      };
  }
}

function normalizePenaltyConfig(input = {}) {
  return {
    antiChurnEnabled: parseBoolish(input.anti_churn_enabled ?? input.antiChurnEnabled, DEFAULTS.antiChurnEnabled),
    cleanWinCooldownSeconds: secondsOrDefault(input.clean_win_cooldown_seconds ?? input.cleanWinCooldownSeconds, DEFAULTS.cleanWinCooldownSeconds),
    trailingWinCooldownSeconds: secondsOrDefault(input.trailing_win_cooldown_seconds ?? input.trailingWinCooldownSeconds, DEFAULTS.trailingWinCooldownSeconds),
    smallWinCooldownSeconds: secondsOrDefault(input.small_win_cooldown_seconds ?? input.smallWinCooldownSeconds, DEFAULTS.smallWinCooldownSeconds),
    goodLossCooldownSeconds: secondsOrDefault(input.good_loss_cooldown_seconds ?? input.goodLossCooldownSeconds, DEFAULTS.goodLossCooldownSeconds),
    badLossCooldownSeconds: secondsOrDefault(input.bad_loss_cooldown_seconds ?? input.badLossCooldownSeconds, DEFAULTS.badLossCooldownSeconds),
    hardStopoutCooldownSeconds: secondsOrDefault(input.hard_stopout_cooldown_seconds ?? input.hardStopoutCooldownSeconds, DEFAULTS.hardStopoutCooldownSeconds),
    executionBadLossCooldownSeconds: secondsOrDefault(input.execution_bad_loss_cooldown_seconds ?? input.executionBadLossCooldownSeconds, DEFAULTS.executionBadLossCooldownSeconds),
    partialFillProblemCooldownSeconds: secondsOrDefault(input.partial_fill_problem_cooldown_seconds ?? input.partialFillProblemCooldownSeconds, DEFAULTS.partialFillProblemCooldownSeconds),
    churnExitCooldownSeconds: secondsOrDefault(input.churn_exit_cooldown_seconds ?? input.churnExitCooldownSeconds, DEFAULTS.churnExitCooldownSeconds),
    unknownCooldownSeconds: secondsOrDefault(input.unknown_cooldown_seconds ?? input.unknownCooldownSeconds, DEFAULTS.unknownCooldownSeconds),
    repeatedStopoutMultiplier: Math.max(1, safeNumber(input.repeated_stopout_multiplier ?? input.repeatedStopoutMultiplier, DEFAULTS.repeatedStopoutMultiplier)),
    maxCooldownSeconds: Math.max(0, secondsOrDefault(input.max_cooldown_seconds ?? input.maxCooldownSeconds, DEFAULTS.maxCooldownSeconds)),
    recentWinnerProtectionEnabled: parseBoolish(input.recent_winner_protection_enabled ?? input.recentWinnerProtectionEnabled, DEFAULTS.recentWinnerProtectionEnabled),
    recentWinnerWindowSeconds: secondsOrDefault(input.recent_winner_window_seconds ?? input.recentWinnerWindowSeconds, DEFAULTS.recentWinnerWindowSeconds),
    tinyExitDollars: Math.max(0, safeNumber(input.tiny_exit_dollars ?? input.tinyExitDollars, DEFAULTS.tinyExitDollars)),
    rapidRoundTripSeconds: Math.max(1, secondsOrDefault(input.rapid_round_trip_seconds ?? input.rapidRoundTripSeconds, DEFAULTS.rapidRoundTripSeconds)),
    churnWindowSeconds: Math.max(1, secondsOrDefault(input.churn_window_seconds ?? input.churnWindowSeconds, DEFAULTS.churnWindowSeconds)),
    churnGuardTradeCount: Math.max(0, safeNumber(input.churn_guard_trade_count ?? input.churnGuardTradeCount, DEFAULTS.churnGuardTradeCount)),
    churnGuardStopoutCount: Math.max(0, safeNumber(input.churn_guard_stopout_count ?? input.churnGuardStopoutCount, DEFAULTS.churnGuardStopoutCount)),
    churnGuardTinyExitCount: Math.max(0, safeNumber(input.churn_guard_tiny_exit_count ?? input.churnGuardTinyExitCount, DEFAULTS.churnGuardTinyExitCount)),
    churnGuardRoundTripCount: Math.max(0, safeNumber(input.churn_guard_round_trip_count ?? input.churnGuardRoundTripCount, DEFAULTS.churnGuardRoundTripCount)),
    churnGuardSymbolLoopCount: Math.max(0, safeNumber(input.churn_guard_symbol_loop_count ?? input.churnGuardSymbolLoopCount, DEFAULTS.churnGuardSymbolLoopCount)),
    churnGuardSetupLoopCount: Math.max(0, safeNumber(input.churn_guard_setup_loop_count ?? input.churnGuardSetupLoopCount, DEFAULTS.churnGuardSetupLoopCount)),
    churnGuardScoreThreshold: Math.max(1, safeNumber(input.churn_guard_score_threshold ?? input.churnGuardScoreThreshold, DEFAULTS.churnGuardScoreThreshold)),
    retentionHours: Math.max(1, safeNumber(input.retention_hours ?? input.retentionHours, DEFAULTS.retentionHours)),
    historyMaxBytes: Math.max(64 * 1024, safeNumber(input.history_max_bytes ?? input.historyMaxBytes, 512 * 1024)),
  };
}

function parseBoolish(value, fallback = false) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return Boolean(fallback);
}

function secondsOrDefault(value, fallback) {
  const parsed = safeNumber(value, null);
  if (!Number.isFinite(parsed)) return Math.max(0, fallback);
  return Math.max(0, Math.round(parsed));
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = safeNumber(value, null);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeOutcomeList(list = []) {
  return (Array.isArray(list) ? list : [list]).map((item) => normalizeOutcomeRecord(item)).filter(Boolean);
}

function normalizeOutcomeRecord(record = {}) {
  if (!record || typeof record !== 'object') return null;
  const source = record.record || record;
  const symbol = normalizeSymbol(source.symbol || source.original_signal?.symbol || source.paper_result?.symbol || null);
  const side = normalizeText(source.side || source.paper_result?.side || source.original_signal?.side || null);
  const recordedAt = normalizeIso(source.recorded_at || source.paper_result?.filled_at || source.paper_result?.filledAt || source.filled_at || source.created_at || source.timestamp || nowIso());
  const setupKey = normalizeSetupKey(resolveSetupKey(source));
  const pnl = firstFinite(source.net_pnl, source.adjusted_pnl, source.pnl, source.gross_pnl, null);
  const grossPnl = firstFinite(source.gross_pnl, source.pnl, source.net_pnl, null);
  const executionDrag = Math.max(0, safeNumber(source.execution_drag, 0));
  const exitReason = normalizeText(
    source.exit_reason
      || source.original_signal?.market_context?.exit_state?.exit_reason
      || source.market_context?.exit_state?.exit_reason
      || source.exit_state?.exit_reason
      || null,
  );
  const tradeDurationSeconds = firstFinite(
    source.trade_duration_seconds,
    source.position_duration_seconds,
    source.duration_seconds,
    source.original_signal?.trade_duration_seconds,
    null,
  );
  const partialFill = hasPartialFillProblem(source);
  const classification = normalizeClassification(source.classification || source.exit_classification || null);
  return {
    symbol,
    side,
    setup_key: setupKey,
    recorded_at: recordedAt,
    position_exit: Boolean(source.position_exit || source.positionExit),
    classification,
    pnl,
    gross_pnl: grossPnl,
    net_pnl: firstFinite(source.net_pnl, source.adjusted_pnl, source.pnl, null),
    execution_drag: executionDrag,
    exit_reason: exitReason || null,
    trade_duration_seconds: tradeDurationSeconds,
    partial_fill: partialFill,
    stopped_out: Boolean(source.stopped_out || source.stop_exit || /STOP/i.test(exitReason)),
    trailing_exit: Boolean(source.trailing_exit || source.trailing_profit_exit || /TRAIL/i.test(exitReason)),
    churn_exit: Boolean(source.churn_exit),
    original_signal: source.original_signal || null,
  };
}

function isExitOutcome(outcome = {}) {
  const side = normalizeText(outcome.side || outcome.paper_result?.side || outcome.original_signal?.side || null);
  const exitReason = normalizeText(
    outcome.exit_reason
      || outcome.original_signal?.market_context?.exit_state?.exit_reason
      || outcome.market_context?.exit_state?.exit_reason
      || outcome.exit_state?.exit_reason
      || null,
  );
  return Boolean(
    outcome.position_exit
      || outcome.positionExit
      || side === 'sell'
      || exitReason
      || outcome.stopped_out
      || outcome.stop_exit
      || outcome.trailing_exit
      || outcome.trailing_profit_exit,
  );
}

function readPaperOutcomesFromHistory(historyPath, maxBytes = 512 * 1024) {
  try {
    const lines = readTailLines(historyPath, maxBytes);
    const records = [];
    for (const line of lines) {
      const parsed = parseJsonLine(line);
      if (!parsed) continue;
      if (parsed.entry_type === 'paper_outcome' && parsed.record) {
        records.push(parsed.record);
      }
    }
    return records;
  } catch {
    return [];
  }
}

function hasPartialFillProblem(source = {}) {
  if (source.partial_fill_problem === true) return true;
  const status = String(source.status || source.paper_result?.status || source.partial_fill?.status || '').trim().toLowerCase();
  if (status === 'partially_filled') return true;

  const directRemaining = safeNumber(source.remaining_quantity ?? source.remaining_qty, 0);
  if (directRemaining > 0) return true;

  const partial = source.partial_fill && typeof source.partial_fill === 'object' ? source.partial_fill : null;
  if (partial) {
    const remaining = safeNumber(partial.remaining_quantity ?? partial.remaining_qty, 0);
    const filled = safeNumber(partial.filled_quantity ?? partial.filled_qty, null);
    const submitted = safeNumber(partial.submitted_quantity ?? partial.submitted_qty, null);
    if (remaining > 0) return true;
    if (Number.isFinite(filled) && Number.isFinite(submitted) && submitted > 0 && filled + 1e-6 < submitted) return true;
  } else if (source.partial_fill === true) {
    return true;
  }

  const partialState = source.partial_fill_state && typeof source.partial_fill_state === 'object' ? source.partial_fill_state : null;
  if (partialState) {
    const count = safeNumber(partialState.count, 0);
    const reserved = safeNumber(partialState.reserved_buy_notional, 0);
    const activeBuys = Array.isArray(partialState.partial_buys) ? partialState.partial_buys.length : 0;
    const activeSells = Array.isArray(partialState.partial_sells) ? partialState.partial_sells.length : 0;
    if (count > 0 || reserved > 0 || activeBuys > 0 || activeSells > 0) return true;
  }

  return false;
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

function resolveSetupKey(source = {}) {
  return normalizeSetupKey(
    source.setup_key
      || source.setupKey
      || source.strategy_setup_key
      || source.market_context?.setup_key
      || source.marketContext?.setup_key
      || source.original_signal?.setup_key
      || source.original_signal?.market_context?.setup_key
      || null,
  );
}

function normalizeSetupKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return key || null;
}

function normalizeSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  return symbol || null;
}

function normalizeClassification(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (Object.values(AntiChurnClassification).includes(normalized)) return normalized;
  return null;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeReasonCodes(value) {
  return [...new Set((Array.isArray(value) ? value : [value]).filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];
}

function summarizePenaltyCodes(reasonCodes = []) {
  return normalizeReasonCodes(reasonCodes).join(',') || 'anti_churn';
}

function severityFromPenalty(penaltyPoints) {
  const points = Math.max(0, safeNumber(penaltyPoints, 0));
  if (points >= 50) return 'critical';
  if (points >= 30) return 'high';
  if (points >= 10) return 'medium';
  if (points > 0) return 'low';
  return 'none';
}

function isActiveCooldownEntry(entry = {}) {
  const remaining = safeNumber(entry.remaining_seconds, 0);
  return remaining > 0 || Boolean(entry.cooldown_until && new Date(entry.cooldown_until).getTime() > Date.now());
}

function withClassification({
  classification,
  severity,
  reasonCodes = [],
  explanation = '',
  stopExit = false,
  trailingExit = false,
  pnl = null,
  grossPnl = null,
  executionDrag = null,
  tradeDurationSeconds = null,
  partialFill = false,
  churnLike = false,
  recentWinnerProtected = false,
}) {
  return {
    classification,
    severity,
    reason_codes: normalizeReasonCodes(reasonCodes),
    explanation: String(explanation || '').trim(),
    stop_exit: Boolean(stopExit),
    trailing_exit: Boolean(trailingExit),
    pnl: Number.isFinite(pnl) ? pnl : null,
    gross_pnl: Number.isFinite(grossPnl) ? grossPnl : null,
    execution_drag: Number.isFinite(executionDrag) ? executionDrag : 0,
    trade_duration_seconds: Number.isFinite(tradeDurationSeconds) ? tradeDurationSeconds : null,
    partial_fill: Boolean(partialFill),
    churn_like: Boolean(churnLike),
    recent_winner_protected: Boolean(recentWinnerProtected),
  };
}

function includesReason(reasonCodes = [], reason) {
  return normalizeReasonCodes(reasonCodes).includes(reason);
}

function roundNumber(value) {
  const numeric = safeNumber(value, 0);
  return Math.round(numeric * 1000) / 1000;
}

module.exports = {
  AntiChurnClassification,
  AntiChurnReason,
  calculateAntiChurnPenalty,
  classifyExitOutcome,
  defaultAntiChurnStatePath,
  evaluateChurnGuard,
  loadAntiChurnState,
  normalizeAntiChurnState,
  reconcileAntiChurnState,
  saveAntiChurnState,
  summarizeAntiChurnState,
  hasPartialFillProblem,
};
