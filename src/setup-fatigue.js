const path = require('path');
const { classifyExitOutcome } = require('./anti-churn-engine');
const { nowIso, safeNumber, minutesBetween, resolveRepoRoot } = require('./util');
const { JsonFileStore } = require('./storage');
const { readCompleteJsonlTail } = require('./history-tail-reader');
const { isOutcomeAccountingValid } = require('./paper-outcomes');

const SetupFatigueReason = {
  SETUP_FATIGUE_ACTIVE: 'SETUP_FATIGUE_ACTIVE',
  SETUP_FATIGUE_RECENT_LOSS: 'SETUP_FATIGUE_RECENT_LOSS',
  SETUP_FATIGUE_RECENT_STOPOUT: 'SETUP_FATIGUE_RECENT_STOPOUT',
  SETUP_FATIGUE_BAD_LOSS: 'SETUP_FATIGUE_BAD_LOSS',
  SETUP_FATIGUE_GOOD_LOSS: 'SETUP_FATIGUE_GOOD_LOSS',
  SETUP_FATIGUE_EXECUTION_BAD_LOSS: 'SETUP_FATIGUE_EXECUTION_BAD_LOSS',
  SETUP_FATIGUE_CLEAN_WIN_RECOVERY: 'SETUP_FATIGUE_CLEAN_WIN_RECOVERY',
  SETUP_FATIGUE_PARTIAL_FILL_PROBLEM: 'SETUP_FATIGUE_PARTIAL_FILL_PROBLEM',
  SETUP_FATIGUE_SAME_REGIME_FAILURE: 'SETUP_FATIGUE_SAME_REGIME_FAILURE',
};

const DEFAULTS = {
  enabled: true,
  threshold: 60,
  decayPerHour: 8,
  stopoutPoints: 28,
  badLossPoints: 16,
  goodLossPoints: 6,
  cleanWinRecoveryPoints: 10,
  pauseSeconds: 15 * 60,
  maxPauseSeconds: 90 * 60,
  retentionHours: 24,
  historyMaxBytes: 512 * 1024,
  recentOutcomeLimit: 300,
};

function defaultSetupFatigueStatePath({ env = process.env, repoRoot = resolveRepoRoot() } = {}) {
  return path.resolve(env.SETUP_FATIGUE_STATE_PATH || path.join(repoRoot, 'data', 'state', 'setup-fatigue-state.json'));
}

function loadSetupFatigueState(filePathOrOptions = {}) {
  const filePath = typeof filePathOrOptions === 'string'
    ? filePathOrOptions
    : defaultSetupFatigueStatePath(filePathOrOptions);
  const store = new JsonFileStore(path.dirname(filePath));
  const name = path.basename(filePath);
  try {
    const data = store.read(name);
    return data ? normalizeSetupFatigueState(data) : normalizeSetupFatigueState({});
  } catch {
    return normalizeSetupFatigueState({});
  }
}

function saveSetupFatigueState(state, filePathOrOptions = {}) {
  const filePath = typeof filePathOrOptions === 'string'
    ? filePathOrOptions
    : defaultSetupFatigueStatePath(filePathOrOptions);
  const store = new JsonFileStore(path.dirname(filePath));
  const payload = normalizeSetupFatigueState(state);
  payload.updated_at = nowIso();
  store.write(path.basename(filePath), payload);
  return payload;
}

function normalizeSetupFatigueState(state = {}) {
  const setups = state.setups && typeof state.setups === 'object'
    ? state.setups
    : state.setup_fatigue && typeof state.setup_fatigue === 'object'
      ? state.setup_fatigue
      : {};
  return {
    version: state.version || '2026-06-25.setup-fatigue-state.1',
    updated_at: state.updated_at || null,
    last_reconciled_at: state.last_reconciled_at || null,
    setups: normalizeSetupMap(setups),
  };
}

function normalizeSetupMap(source = {}) {
  const map = {};
  for (const [key, value] of Object.entries(source || {})) {
    const normalized = normalizeSetupEntry(value, key);
    if (normalized) map[normalized.setup_key] = normalized;
  }
  return map;
}

function normalizeSetupEntry(entry = {}, fallbackKey = null) {
  if (!entry || typeof entry !== 'object') return null;
  const setupKey = resolveSetupKey(entry.setup_key || fallbackKey || entry.setupKey || null);
  if (!setupKey) return null;
  const reasonCodes = normalizeReasonCodes(entry.reason_codes);
  const recentOutcomes = Array.isArray(entry.recent_outcomes) ? entry.recent_outcomes.slice(-20) : [];
  return {
    setup_key: setupKey,
    recent_trades: Math.max(0, Math.round(safeNumber(entry.recent_trades, 0))),
    recent_losses: Math.max(0, Math.round(safeNumber(entry.recent_losses, 0))),
    recent_stopouts: Math.max(0, Math.round(safeNumber(entry.recent_stopouts, 0))),
    recent_wins: Math.max(0, Math.round(safeNumber(entry.recent_wins, 0))),
    net_pnl: roundNumber(safeNumber(entry.net_pnl, 0)),
    last_failure_at: normalizeIso(entry.last_failure_at || null),
    last_success_at: normalizeIso(entry.last_success_at || null),
    last_trade_at: normalizeIso(entry.last_trade_at || null),
    last_regime: normalizeText(entry.last_regime || null) || null,
    same_regime_loss_streak: Math.max(0, Math.round(safeNumber(entry.same_regime_loss_streak, 0))),
    fatigue_score: roundNumber(safeNumber(entry.fatigue_score, 0)),
    paused_until: normalizeIso(entry.paused_until || null),
    active: Boolean(entry.active),
    reason_codes: reasonCodes,
    explanation: String(entry.explanation || '').trim(),
    warnings: normalizeReasonCodes(entry.warnings),
    updated_at: normalizeIso(entry.updated_at || null),
    last_reconciled_at: normalizeIso(entry.last_reconciled_at || null),
    recent_outcomes: recentOutcomes.map((outcome) => normalizeOutcomeSummary(outcome)).filter(Boolean),
  };
}

async function reconcileSetupFatigueState({
  previousState = {},
  performanceHistoryPath = null,
  paperOutcomes = null,
  now = nowIso(),
  env = process.env,
  repoRoot = resolveRepoRoot(),
  setupFatigueEnabled = parseBoolish(env.SETUP_FATIGUE_ENABLED, DEFAULTS.enabled),
  threshold = safeNumber(env.SETUP_FATIGUE_THRESHOLD, DEFAULTS.threshold),
  decayPerHour = safeNumber(env.SETUP_FATIGUE_DECAY_PER_HOUR, DEFAULTS.decayPerHour),
  stopoutPoints = safeNumber(env.SETUP_FATIGUE_STOPOUT_POINTS, DEFAULTS.stopoutPoints),
  badLossPoints = safeNumber(env.SETUP_FATIGUE_BAD_LOSS_POINTS, DEFAULTS.badLossPoints),
  goodLossPoints = safeNumber(env.SETUP_FATIGUE_GOOD_LOSS_POINTS, DEFAULTS.goodLossPoints),
  cleanWinRecoveryPoints = safeNumber(env.SETUP_FATIGUE_CLEAN_WIN_RECOVERY_POINTS, DEFAULTS.cleanWinRecoveryPoints),
  pauseSeconds = safeNumber(env.SETUP_FATIGUE_PAUSE_SECONDS, DEFAULTS.pauseSeconds),
  maxPauseSeconds = safeNumber(env.SETUP_FATIGUE_MAX_PAUSE_SECONDS, DEFAULTS.maxPauseSeconds),
  retentionHours = safeNumber(env.SETUP_FATIGUE_RETENTION_HOURS, DEFAULTS.retentionHours),
  historyMaxBytes = safeNumber(env.SETUP_FATIGUE_HISTORY_MAX_BYTES, DEFAULTS.historyMaxBytes),
} = {}) {
  const state = normalizeSetupFatigueState(previousState);
  const outcomes = Array.isArray(paperOutcomes)
    ? paperOutcomes
    : readPaperOutcomesFromHistory(performanceHistoryPath || path.join(repoRoot, 'data', 'performance-history.jsonl'), historyMaxBytes);
  const normalizedOutcomes = outcomes
    .filter(isOutcomeAccountingValid)
    .map((outcome) => normalizePaperOutcome(outcome))
    .filter(Boolean)
    .filter(isExitOutcome)
    .filter((outcome) => isWithinRetentionWindow(outcome.recorded_at, now, retentionHours))
    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());

  const entries = new Map();
  const priorEntries = new Map(Object.values(state.setups || {}).map((entry) => [entry.setup_key, { ...entry }]));

  for (const outcome of normalizedOutcomes) {
    const setupKey = resolveSetupKey(outcome);
    if (!setupKey) continue;
    const current = entries.get(setupKey) || cloneBaseEntry({ setup_key: setupKey }, setupKey);
    const classification = classifyExitOutcome(outcome);
    const points = computeContributionPoints(classification.classification, outcome, {
      stopoutPoints,
      badLossPoints,
      goodLossPoints,
      cleanWinRecoveryPoints,
    });
    const ageHours = Math.max(0, minutesBetween(outcome.recorded_at, now) / 60);
    const decayedPoints = decayContribution(points, ageHours, decayPerHour);
    const regime = resolveOutcomeRegime(outcome);
    const isLoss = isLossOutcome(classification.classification, outcome);
    const isWin = isWinOutcome(classification.classification, outcome);
    const isStopout = isStopoutOutcome(classification.classification, outcome);
    const previousRegime = current.last_regime || null;

    current.recent_trades += 1;
    current.net_pnl = roundNumber(current.net_pnl + safeNumber(outcome.net_pnl, 0));
    current.last_trade_at = outcome.recorded_at;
    current.same_regime_loss_streak = isLoss && regime && regime === previousRegime
      ? current.same_regime_loss_streak + 1
      : isLoss
        ? 1
        : 0;
    current.last_regime = regime || previousRegime || null;

    if (isLoss) {
      current.recent_losses += 1;
      current.last_failure_at = outcome.recorded_at;
      if (isStopout) current.recent_stopouts += 1;
    }
    if (isWin) {
      current.recent_wins += 1;
      current.last_success_at = outcome.recorded_at;
    }

    const sameRegimeMultiplier = isLoss && regime && current.same_regime_loss_streak > 1
      ? 1 + Math.min(1.5, 0.25 * (current.same_regime_loss_streak - 1))
      : 1;
    const adjustedContribution = isLoss ? decayedPoints * sameRegimeMultiplier : decayedPoints;
    current.fatigue_score = roundNumber(Math.max(0, current.fatigue_score + adjustedContribution));
    current.reason_codes = mergeCodes(current.reason_codes, buildReasonCodes({ classification: classification.classification, outcome, sameRegimeMultiplier, isLoss, isWin, isStopout }));
    current.recent_outcomes = [...current.recent_outcomes, normalizeOutcomeSummary({ ...outcome, classification: classification.classification })].filter(Boolean).slice(-12);
    current.updated_at = now;
    current.last_reconciled_at = now;
    entries.set(setupKey, current);
  }

  for (const [setupKey, prior] of priorEntries.entries()) {
    if (entries.has(setupKey)) continue;
    const ageHours = Number.isFinite(new Date(prior.updated_at || prior.last_reconciled_at || now).getTime())
      ? Math.max(0, minutesBetween(prior.updated_at || prior.last_reconciled_at || now, now) / 60)
      : 0;
    const decayedScore = Math.max(0, roundNumber(safeNumber(prior.fatigue_score, 0) - (ageHours * decayPerHour)));
    const next = cloneBaseEntry(prior, setupKey);
    next.fatigue_score = roundNumber(decayedScore);
    next.active = false;
    next.paused_until = null;
    next.reason_codes = mergeCodes(next.reason_codes, decayedScore > 0 ? [SetupFatigueReason.SETUP_FATIGUE_RECENT_LOSS] : []);
    next.updated_at = now;
    next.last_reconciled_at = now;
    entries.set(setupKey, next);
  }

  const normalized = normalizeSetupFatigueState({
    version: state.version,
    updated_at: now,
    last_reconciled_at: now,
    setups: Object.fromEntries([...entries.values()].map((entry) => {
      const evaluated = evaluateSetupEntry(entry, { now, threshold, pauseSeconds, maxPauseSeconds, setupFatigueEnabled });
      return [evaluated.setup_key, evaluated];
    })),
  });

  return normalized;
}

function evaluateSetupEntry(entry, { now, threshold, pauseSeconds, maxPauseSeconds, setupFatigueEnabled }) {
  const score = roundNumber(safeNumber(entry.fatigue_score, 0));
  const reasonCodes = [...new Set(normalizeReasonCodes(entry.reason_codes))];
  const active = Boolean(setupFatigueEnabled && score >= threshold);
  const stopoutMultiplier = 1 + Math.min(4, Math.max(0, Math.round(safeNumber(entry.recent_stopouts, 0))));
  const lossMultiplier = 1 + Math.min(3, Math.max(0, Math.round(safeNumber(entry.recent_losses, 0) - 1)));
  const computedPauseSeconds = active
    ? Math.min(maxPauseSeconds, Math.max(pauseSeconds, pauseSeconds * stopoutMultiplier * lossMultiplier))
    : 0;
  const pausedUntil = active ? new Date(new Date(now).getTime() + (computedPauseSeconds * 1000)).toISOString() : null;
  const explanation = buildSetupExplanation({
    active,
    threshold,
    score,
    entry,
    computedPauseSeconds,
  });
  const nextReasonCodes = mergeCodes(reasonCodes, active ? [SetupFatigueReason.SETUP_FATIGUE_ACTIVE] : []);
  return {
    ...entry,
    fatigue_score: score,
    reason_codes: nextReasonCodes,
    active,
    paused_until: pausedUntil,
    explanation,
    warnings: mergeCodes(entry.warnings, active ? [SetupFatigueReason.SETUP_FATIGUE_ACTIVE] : []),
    updated_at: entry.updated_at || now,
    last_reconciled_at: now,
  };
}

function summarizeSetupFatigueState(state = {}) {
  const normalized = normalizeSetupFatigueState(state);
  const setups = Object.values(normalized.setups || {});
  const activeSetups = setups.filter((setup) => setup.active);
  const pausedSetups = setups.filter((setup) => setup.paused_until);
  const warnings = [...new Set(setups.flatMap((setup) => setup.warnings || []))];
  const recommendedActions = [];
  if (activeSetups.length) {
    recommendedActions.push('Avoid new buys in setups flagged by setup fatigue until pauses clear.');
  }
  return {
    setup_count: setups.length,
    active_setup_count: activeSetups.length,
    paused_setup_count: pausedSetups.length,
    total_recent_trades: setups.reduce((sum, setup) => sum + safeNumber(setup.recent_trades, 0), 0),
    total_recent_losses: setups.reduce((sum, setup) => sum + safeNumber(setup.recent_losses, 0), 0),
    total_recent_stopouts: setups.reduce((sum, setup) => sum + safeNumber(setup.recent_stopouts, 0), 0),
    total_recent_wins: setups.reduce((sum, setup) => sum + safeNumber(setup.recent_wins, 0), 0),
    total_net_pnl: roundNumber(setups.reduce((sum, setup) => sum + safeNumber(setup.net_pnl, 0), 0)),
    active_setups: activeSetups.sort((a, b) => b.fatigue_score - a.fatigue_score).slice(0, 10),
    paused_setups: pausedSetups.sort((a, b) => new Date(a.paused_until || 0).getTime() - new Date(b.paused_until || 0).getTime()).slice(0, 10),
    warnings,
    recommended_actions: recommendedActions,
    last_reconciled_at: normalized.last_reconciled_at || null,
  };
}

function evaluateSetupFatigueCandidate({ setupFatigueState = null, setupKey = null, now = nowIso() } = {}) {
  const normalizedKey = resolveSetupKey(setupKey);
  if (!normalizedKey) return null;
  const entry = normalizeSetupFatigueState(setupFatigueState).setups[normalizedKey] || null;
  if (!entry) {return {
    setup_key: normalizedKey,
    active: false,
    fatigue_score: 0,
    paused_until: null,
    reason_codes: [],
    explanation: '',
  };}
  return {
    setup_key: normalizedKey,
    active: Boolean(entry.active),
    fatigue_score: safeNumber(entry.fatigue_score, 0),
    paused_until: entry.paused_until || null,
    reason_codes: entry.reason_codes || [],
    explanation: entry.explanation || '',
    age_seconds: Number.isFinite(new Date(entry.updated_at || now).getTime()) ? Math.max(0, (new Date(now).getTime() - new Date(entry.updated_at || now).getTime()) / 1000) : null,
    recent_trades: safeNumber(entry.recent_trades, 0),
    recent_losses: safeNumber(entry.recent_losses, 0),
    recent_stopouts: safeNumber(entry.recent_stopouts, 0),
    recent_wins: safeNumber(entry.recent_wins, 0),
  };
}

function resolveSetupKey(source = {}) {
  if (!source || typeof source !== 'object') {
    return normalizeSetupKey(source);
  }
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

function normalizeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeReasonCodes(value) {
  return [...new Set((Array.isArray(value) ? value : [value]).filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeOutcomeSummary(outcome = {}) {
  const normalized = normalizePaperOutcome(outcome);
  if (!normalized) return null;
  const classification = classifyExitOutcome(normalized).classification || normalized.classification || null;
  return {
    symbol: normalized.symbol,
    setup_key: normalized.setup_key,
    recorded_at: normalized.recorded_at,
    classification,
    net_pnl: normalized.net_pnl,
    exit_reason: normalized.exit_reason || null,
    regime: normalized.regime || null,
    reason_codes: normalized.reason_codes || [],
    stop_exit: Boolean(normalized.stop_exit),
    trailing_exit: Boolean(normalized.trailing_exit),
    partial_fill: Boolean(normalized.partial_fill),
  };
}

function normalizePaperOutcome(record = {}) {
  if (!record || typeof record !== 'object') return null;
  const source = record.record || record;
  const setupKey = resolveSetupKey(source);
  const symbol = normalizeSymbol(source.symbol || source.paper_result?.symbol || null);
  const recordedAt = normalizeIso(source.recorded_at || source.paper_result?.filled_at || source.paper_result?.filledAt || source.filled_at || source.timestamp || nowIso());
  const paperResult = source.paper_result || {};
  return {
    setup_key: setupKey,
    symbol,
    recorded_at: recordedAt,
    side: String(source.side || paperResult.side || '').trim().toLowerCase() || null,
    position_exit: Boolean(source.position_exit || source.positionExit),
    quantity: safeNumber(paperResult.filled_quantity ?? source.quantity ?? paperResult.quantity, 0),
    pnl: safeNumber(source.pnl ?? source.net_pnl ?? source.adjusted_pnl, 0),
    gross_pnl: safeNumber(source.gross_pnl ?? source.pnl, 0),
    net_pnl: safeNumber(source.net_pnl ?? source.adjusted_pnl ?? source.pnl, safeNumber(source.pnl, 0)),
    execution_drag: safeNumber(source.execution_drag, 0),
    exit_reason: normalizeText(
      source.exit_reason
      || source.original_signal?.market_context?.exit_state?.exit_reason
      || source.market_context?.exit_state?.exit_reason
      || source.exit_state?.exit_reason
      || null,
    ),
    regime: normalizeText(
      source.regime
      || source.market_context?.regime
      || source.marketContext?.regime
      || source.original_signal?.market_context?.regime
      || source.original_signal?.regime
      || null,
    ) || null,
    stop_exit: Boolean(source.stop_exit || source.stopped_out || paperResult.stop_exit),
    trailing_exit: Boolean(source.trailing_exit || source.trailing_profit_exit || paperResult.trailing_exit),
    partial_fill: hasPartialFillProblem(source),
    reason_codes: normalizeReasonCodes(source.reason_codes),
    original_signal: source.original_signal || null,
  };
}

function readPaperOutcomesFromHistory(historyPath, maxBytes = DEFAULTS.historyMaxBytes) {
  try {
    const records = [];
    for (const parsed of readCompleteJsonlTail(historyPath, maxBytes, {
      includeArchives: true,
      matches: (entry) => ['paper_outcome', 'execution_outcome'].includes(entry?.entry_type) && Boolean(entry.record),
    })) {
      if (['paper_outcome', 'execution_outcome'].includes(parsed.entry_type) && parsed.record) {
        records.push(parsed.record);
      }
    }
    return records;
  } catch {
    return [];
  }
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
      || outcome.stop_exit
      || outcome.stopped_out
      || outcome.trailing_exit
      || outcome.trailing_profit_exit,
  );
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

function isWithinRetentionWindow(recordedAt, now, retentionHours) {
  const ageHours = minutesBetween(recordedAt, now) / 60;
  return Number.isFinite(ageHours) ? ageHours <= Math.max(1, safeNumber(retentionHours, DEFAULTS.retentionHours)) : true;
}

function cloneBaseEntry(entry = {}, fallbackKey = null) {
  const normalized = normalizeSetupEntry(entry, fallbackKey) || normalizeSetupEntry({ setup_key: fallbackKey });
  return normalized || {
    setup_key: resolveSetupKey(fallbackKey),
    recent_trades: 0,
    recent_losses: 0,
    recent_stopouts: 0,
    recent_wins: 0,
    net_pnl: 0,
    last_failure_at: null,
    last_success_at: null,
    last_trade_at: null,
    last_regime: null,
    same_regime_loss_streak: 0,
    fatigue_score: 0,
    paused_until: null,
    active: false,
    reason_codes: [],
    explanation: '',
    warnings: [],
    updated_at: null,
    last_reconciled_at: null,
    recent_outcomes: [],
  };
}

function computeContributionPoints(classification, outcome, {
  stopoutPoints,
  badLossPoints,
  goodLossPoints,
  cleanWinRecoveryPoints,
} = {}) {
  const lossMagnitude = Math.abs(safeNumber(outcome.net_pnl, safeNumber(outcome.pnl, 0)));
  const executionDrag = Math.max(0, safeNumber(outcome.execution_drag, 0));
  switch (classification) {
    case 'hard_stopout':
      return Math.max(stopoutPoints, badLossPoints * 1.5);
    case 'bad_loss':
      return Math.max(badLossPoints, lossMagnitude + 4);
    case 'execution_bad_loss':
      return Math.max(badLossPoints * 1.25, executionDrag * 2 + badLossPoints);
    case 'partial_fill_problem':
      return Math.max(8, Math.round(badLossPoints * 0.6));
    case 'good_loss':
      return Math.max(1, goodLossPoints);
    case 'small_win':
      return -Math.max(1, Math.round(cleanWinRecoveryPoints * 0.25));
    case 'trailing_win':
      return -Math.max(1, Math.round(cleanWinRecoveryPoints * 0.6));
    case 'clean_win':
      return -Math.max(1, cleanWinRecoveryPoints);
    default:
      if (safeNumber(outcome.net_pnl, 0) < 0) return Math.max(1, goodLossPoints);
      if (safeNumber(outcome.net_pnl, 0) > 0) return -Math.max(1, Math.round(cleanWinRecoveryPoints * 0.5));
      return 0;
  }
}

function decayContribution(points, ageHours, decayPerHour) {
  const magnitude = Math.abs(safeNumber(points, 0));
  if (!magnitude) return 0;
  const decayed = Math.max(0, magnitude - (Math.max(0, safeNumber(ageHours, 0)) * Math.max(0, safeNumber(decayPerHour, 0))));
  return points < 0 ? -decayed : decayed;
}

function buildReasonCodes({ classification, outcome, sameRegimeMultiplier, isLoss, isWin, isStopout }) {
  const codes = [];
  if (isLoss) codes.push(SetupFatigueReason.SETUP_FATIGUE_RECENT_LOSS);
  if (isStopout) codes.push(SetupFatigueReason.SETUP_FATIGUE_RECENT_STOPOUT);
  if (classification === 'bad_loss') codes.push(SetupFatigueReason.SETUP_FATIGUE_BAD_LOSS);
  if (classification === 'good_loss') codes.push(SetupFatigueReason.SETUP_FATIGUE_GOOD_LOSS);
  if (classification === 'execution_bad_loss') codes.push(SetupFatigueReason.SETUP_FATIGUE_EXECUTION_BAD_LOSS);
  if (classification === 'partial_fill_problem') codes.push(SetupFatigueReason.SETUP_FATIGUE_PARTIAL_FILL_PROBLEM);
  if (isWin) codes.push(SetupFatigueReason.SETUP_FATIGUE_CLEAN_WIN_RECOVERY);
  if (sameRegimeMultiplier > 1) codes.push(SetupFatigueReason.SETUP_FATIGUE_SAME_REGIME_FAILURE);
  if (safeNumber(outcome.net_pnl, 0) < 0 && !codes.length) codes.push(SetupFatigueReason.SETUP_FATIGUE_RECENT_LOSS);
  return [...new Set(codes)];
}

function buildSetupExplanation({ active, threshold, score, entry, computedPauseSeconds }) {
  const parts = [];
  parts.push(`Setup fatigue score ${roundNumber(score)} of threshold ${roundNumber(threshold)}.`);
  parts.push(`Recent trades ${safeNumber(entry.recent_trades, 0)}, losses ${safeNumber(entry.recent_losses, 0)}, stopouts ${safeNumber(entry.recent_stopouts, 0)}, wins ${safeNumber(entry.recent_wins, 0)}.`);
  if (entry.last_failure_at) parts.push(`Last failure ${entry.last_failure_at}.`);
  if (entry.last_success_at) parts.push(`Last success ${entry.last_success_at}.`);
  if (active) {
    parts.push(`Paused for about ${Math.round(computedPauseSeconds / 60)} minute(s).`);
  } else {
    parts.push('Setup is currently eligible for new buys.');
  }
  return parts.join(' ');
}

function isLossOutcome(classification, outcome) {
  return ['good_loss', 'bad_loss', 'hard_stopout', 'execution_bad_loss', 'partial_fill_problem'].includes(classification)
    || safeNumber(outcome.net_pnl, 0) < 0;
}

function isWinOutcome(classification, outcome) {
  return ['clean_win', 'trailing_win', 'small_win'].includes(classification)
    || safeNumber(outcome.net_pnl, 0) >= 0;
}

function isStopoutOutcome(classification, outcome) {
  return classification === 'hard_stopout'
    || Boolean(outcome.stop_exit)
    || Boolean(outcome.trailing_exit && safeNumber(outcome.net_pnl, 0) < 0)
    || /STOP/i.test(String(outcome.exit_reason || ''));
}

function resolveOutcomeRegime(outcome = {}) {
  return normalizeText(
    outcome.regime
      || outcome.market_context?.regime
      || outcome.marketContext?.regime
      || outcome.original_signal?.market_context?.regime
      || outcome.original_signal?.regime
      || '',
  ) || null;
}

function parseBoolish(value, fallback = false) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return Boolean(fallback);
}

function mergeCodes(...groups) {
  return [...new Set(groups.flatMap((group) => normalizeReasonCodes(group)).filter(Boolean))];
}

function roundNumber(value) {
  const numeric = safeNumber(value, 0);
  return Math.round(numeric * 1000) / 1000;
}

module.exports = {
  DEFAULTS,
  SetupFatigueReason,
  defaultSetupFatigueStatePath,
  evaluateSetupFatigueCandidate,
  isWithinRetentionWindow,
  loadSetupFatigueState,
  normalizeSetupFatigueState,
  readPaperOutcomesFromHistory,
  reconcileSetupFatigueState,
  resolveSetupKey,
  saveSetupFatigueState,
  summarizeSetupFatigueState,
};
