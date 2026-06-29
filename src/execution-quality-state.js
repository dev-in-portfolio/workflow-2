const fs = require('fs');
const path = require('path');
const { nowIso, safeNumber, clamp } = require('./util');

const EXECUTION_QUALITY_STATE_VERSION = '2026-06-25.execution-quality-state.1';
const DEFAULT_STATE_PATH = path.resolve(process.cwd(), 'data', 'runtime', 'execution-quality-state.json');

function defaultExecutionQualityState() {
  return {
    version: EXECUTION_QUALITY_STATE_VERSION,
    updated_at: null,
    last_reconciled_at: null,
    entries: {},
  };
}

function resolveExecutionQualityStatePath(input = {}) {
  if (typeof input === 'string') return path.resolve(input);
  if (input?.executionQualityPath) return path.resolve(input.executionQualityPath);
  if (input?.filePath) return path.resolve(input.filePath);
  if (input?.path) return path.resolve(input.path);
  if (input?.repoRoot) return path.resolve(input.repoRoot, 'data', 'runtime', 'execution-quality-state.json');
  return DEFAULT_STATE_PATH;
}

function loadExecutionQualityState(input = {}) {
  const filePath = resolveExecutionQualityStatePath(input);
  if (!filePath || !fs.existsSync(filePath)) {
    return defaultExecutionQualityState();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeExecutionQualityState(raw);
  } catch {
    return defaultExecutionQualityState();
  }
}

function saveExecutionQualityState(state, input = {}) {
  const filePath = resolveExecutionQualityStatePath(input);
  const normalized = normalizeExecutionQualityState(state);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function normalizeExecutionQualityState(state = {}) {
  const normalized = defaultExecutionQualityState();
  const entries = state.entries && typeof state.entries === 'object' ? state.entries : {};
  normalized.version = state.version || EXECUTION_QUALITY_STATE_VERSION;
  normalized.updated_at = state.updated_at || null;
  normalized.last_reconciled_at = state.last_reconciled_at || null;
  normalized.entries = {};
  for (const [key, entry] of Object.entries(entries)) {
    normalized.entries[normalizeExecutionQualityKey(entry.symbol, entry.setup_key, entry.side, entry.time_regime) || key] = normalizeExecutionQualityEntry(entry, key);
  }
  return normalized;
}

function normalizeExecutionQualityEntry(entry = {}, fallbackKey = null) {
  const symbol = normalizeSymbol(entry.symbol || null);
  const setupKey = normalizeSetupKey(entry.setup_key || entry.setupKey || null);
  const side = normalizeSide(entry.side || null);
  const timeRegime = normalizeTimeRegime(entry.time_regime || entry.timeRegime || null);
  return {
    key: fallbackKey || normalizeExecutionQualityKey(symbol, setupKey, side, timeRegime),
    symbol,
    setup_key: setupKey,
    side,
    time_regime: timeRegime,
    trade_count: Math.max(0, Math.floor(safeNumber(entry.trade_count, 0))),
    average_quality_score: clampNumber(entry.average_quality_score, 0, 100),
    average_slippage: safeNumber(entry.average_slippage, null),
    average_execution_drag: safeNumber(entry.average_execution_drag, null),
    partial_fill_count: Math.max(0, Math.floor(safeNumber(entry.partial_fill_count, 0))),
    rejection_count: Math.max(0, Math.floor(safeNumber(entry.rejection_count, 0))),
    cancellation_count: Math.max(0, Math.floor(safeNumber(entry.cancellation_count, 0))),
    duplicate_risk_count: Math.max(0, Math.floor(safeNumber(entry.duplicate_risk_count, 0))),
    last_bad_execution_at: entry.last_bad_execution_at || null,
    penalty_points: Math.max(0, safeNumber(entry.penalty_points, 0)),
    size_multiplier: clampNumber(entry.size_multiplier, 0, 1),
    updated_at: entry.updated_at || null,
    recent_records: Array.isArray(entry.recent_records) ? entry.recent_records.slice(0, 10) : [],
    classifications: normalizeClassificationCounts(entry.classifications),
  };
}

function normalizeClassificationCounts(input = {}) {
  const counts = {};
  for (const key of [
    'excellent_fill',
    'normal_fill',
    'high_slippage',
    'partial_fill',
    'bad_fill',
    'rejected_order',
    'canceled_order',
    'stale_execution',
    'duplicate_risk',
    'unknown',
  ]) {
    counts[key] = Math.max(0, Math.floor(safeNumber(input?.[key], 0)));
  }
  return counts;
}

function classifyExecutionQuality(input = {}, options = {}) {
  const submittedPrice = safeNumber(input.submitted_price ?? input.expected_price ?? input.expectedPrice ?? input.submittedPrice, null);
  const filledPrice = safeNumber(input.filled_avg_price ?? input.filled_price ?? input.average_fill_price ?? input.filledPrice, null);
  const slippage = safeNumber(input.slippage, Number.isFinite(submittedPrice) && Number.isFinite(filledPrice) && submittedPrice > 0
    ? Math.abs(filledPrice - submittedPrice) / submittedPrice * 100
    : null);
  const executionDrag = Math.max(0, safeNumber(input.execution_drag, 0));
  const submittedQty = Math.max(0, safeNumber(input.submitted_qty ?? input.submitted_quantity, 0));
  const filledQty = Math.max(0, safeNumber(input.filled_qty ?? input.filled_quantity, 0));
  const partialFill = Boolean(input.partial_fill)
    || (submittedQty > 0 && filledQty > 0 && filledQty < submittedQty)
    || String(input.status || '').toLowerCase() === 'partially_filled';
  const rejected = Boolean(input.rejected) || String(input.status || '').toLowerCase() === 'rejected';
  const canceled = Boolean(input.canceled) || String(input.status || '').toLowerCase().includes('cancel');
  const duplicateRisk = Boolean(input.duplicate_risk);
  const timestamp = input.timestamp || input.filled_at || input.created_at || nowIso();
  const latencyMs = Math.max(0, safeNumber(input.latency_ms, 0));
  const ageSeconds = Number.isFinite(new Date(timestamp).getTime()) ? Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 1000) : null;
  const staleThresholdSeconds = Math.max(1, safeNumber(options.staleThresholdSeconds, 5 * 60));
  const staleExecution = Number.isFinite(latencyMs)
    ? latencyMs >= Math.max(120_000, staleThresholdSeconds * 1000)
    : Number.isFinite(ageSeconds) && ageSeconds >= staleThresholdSeconds;

  let classification = 'unknown';
  const reasonCodes = [];
  const warnings = [];
  let cooldownRecommendation = null;

  if (duplicateRisk) {
    classification = 'duplicate_risk';
    reasonCodes.push('DUPLICATE_RISK');
    cooldownRecommendation = { minutes: 10, reason: 'duplicate_risk' };
  } else if (rejected) {
    classification = 'rejected_order';
    reasonCodes.push('ORDER_REJECTED');
    cooldownRecommendation = { minutes: 15, reason: 'rejected_order' };
  } else if (canceled) {
    classification = 'canceled_order';
    reasonCodes.push('ORDER_CANCELED');
    cooldownRecommendation = { minutes: 5, reason: 'canceled_order' };
  } else if (staleExecution) {
    classification = 'stale_execution';
    reasonCodes.push('STALE_EXECUTION');
    cooldownRecommendation = { minutes: 10, reason: 'stale_execution' };
  } else if (partialFill) {
    classification = 'partial_fill';
    reasonCodes.push('PARTIAL_FILL');
    cooldownRecommendation = { minutes: 5, reason: 'partial_fill' };
  } else if (Number.isFinite(slippage) && slippage >= Math.max(0, safeNumber(options.badFillThresholdPct, 2))) {
    classification = 'bad_fill';
    reasonCodes.push('BAD_FILL_SLIPPAGE');
    cooldownRecommendation = { minutes: 10, reason: 'bad_fill' };
  } else if (Number.isFinite(slippage) && slippage >= Math.max(0, safeNumber(options.highSlippageThresholdPct, 0.5))) {
    classification = 'high_slippage';
    reasonCodes.push('HIGH_SLIPPAGE');
    cooldownRecommendation = { minutes: 5, reason: 'high_slippage' };
  } else if (filledQty > 0) {
    classification = Number.isFinite(slippage) && slippage <= Math.max(0.08, safeNumber(options.excellentSlippageThresholdPct, 0.1))
      && executionDrag <= Math.max(0.02, safeNumber(options.excellentExecutionDrag, 0.15))
      ? 'excellent_fill'
      : 'normal_fill';
  }

  if (!Number.isFinite(slippage)) {
    warnings.push('SLIPPAGE_UNAVAILABLE');
  }
  if (executionDrag > 0.75 && classification === 'normal_fill') {
    classification = 'high_slippage';
    reasonCodes.push('EXECUTION_DRAG_HIGH');
    cooldownRecommendation = cooldownRecommendation || { minutes: 5, reason: 'high_slippage' };
  }
  if (classification === 'partial_fill' && submittedQty > 0 && filledQty > 0) {
    const ratio = filledQty / submittedQty;
    if (ratio < 0.5) {
      reasonCodes.push('PARTIAL_FILL_LOW_RATIO');
    }
  }

  const classificationPenalty = {
    excellent_fill: 0,
    normal_fill: 5,
    high_slippage: 22,
    partial_fill: 18,
    bad_fill: 35,
    rejected_order: 45,
    canceled_order: 20,
    stale_execution: 15,
    duplicate_risk: 30,
    unknown: 0,
  }[classification] || 0;
  const slippagePenalty = Number.isFinite(slippage) ? Math.min(25, Math.max(0, slippage) * 5) : 0;
  const dragPenalty = Math.min(20, executionDrag * 8);
  const latencyPenalty = Number.isFinite(latencyMs) ? Math.min(10, latencyMs / 30_000) : 0;
  const execution_penalty_points = Math.max(0, Math.min(100, Math.round(classificationPenalty + slippagePenalty + dragPenalty + latencyPenalty)));
  const execution_quality_score = Math.max(0, Math.min(100, Math.round(100 - execution_penalty_points)));
  const sizeMultiplierFloor = clampNumber(options.minSizeMultiplier, 0.5, 1);
  const size_multiplier = classification === 'excellent_fill'
    ? 1
    : Math.max(sizeMultiplierFloor, Number((1 - (execution_penalty_points / 200)).toFixed(2)));

  if (classification === 'bad_fill' || classification === 'rejected_order' || classification === 'duplicate_risk') {
    reasonCodes.push('EXECUTION_QUALITY_PENALTY');
  }

  return {
    execution_quality_score,
    execution_penalty_points,
    size_multiplier: clampNumber(size_multiplier, sizeMultiplierFloor, 1),
    cooldown_recommendation: cooldownRecommendation,
    reason_codes: [...new Set(reasonCodes)],
    warnings,
    classification,
    slippage: Number.isFinite(slippage) ? Number(slippage.toFixed(4)) : null,
    execution_drag: roundNumber(executionDrag, 4),
    latency_ms: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
    partial_fill: partialFill,
    duplicate_risk: duplicateRisk,
    rejected,
    canceled,
    stale_execution: staleExecution,
  };
}

function calculateExecutionPenalty(input = {}, options = {}) {
  return classifyExecutionQuality(input, options);
}

function updateExecutionQualityState(state, executionRecord = {}, options = {}) {
  const normalizedState = normalizeExecutionQualityState(state);
  const assessment = executionRecord.execution_quality || classifyExecutionQuality(executionRecord, options);
  const symbol = normalizeSymbol(executionRecord.symbol || executionRecord.original_signal?.symbol || null);
  const setupKey = normalizeSetupKey(executionRecord.setup_key || executionRecord.setupKey || executionRecord.original_signal?.market_context?.setup_key || null);
  const side = normalizeSide(executionRecord.side || executionRecord.original_signal?.side || executionRecord.paper_result?.side || null);
  const timeRegime = normalizeTimeRegime(executionRecord.time_regime || executionRecord.market_context?.regime || executionRecord.market_context?.time_regime || null);
  const key = normalizeExecutionQualityKey(symbol, setupKey, side, timeRegime) || `unknown::${normalizedState.updated_at || nowIso()}`;
  const previous = normalizedState.entries[key] || normalizeExecutionQualityEntry({ symbol, setup_key: setupKey, side, time_regime: timeRegime }, key);
  const tradeCount = previous.trade_count + 1;
  const qualityScore = safeNumber(assessment.execution_quality_score, 100);
  const slippage = safeNumber(assessment.slippage, null);
  const executionDrag = safeNumber(assessment.execution_drag, null);
  const penaltyPoints = Math.max(0, previous.penalty_points + safeNumber(assessment.execution_penalty_points, 0));
  const sizeMultiplierFloor = clampNumber(options.minSizeMultiplier, 0.5, 1);
  const sizeMultiplier = Math.max(sizeMultiplierFloor, Number((1 - (penaltyPoints / 200)).toFixed(2)));
  const classification = String(assessment.classification || 'unknown');
  const updatedRecord = {
    timestamp: executionRecord.timestamp || executionRecord.recorded_at || executionRecord.filled_at || nowIso(),
    classification,
    execution_quality_score: qualityScore,
    execution_penalty_points: safeNumber(assessment.execution_penalty_points, 0),
    slippage,
    execution_drag: executionDrag,
    reason_codes: Array.isArray(assessment.reason_codes) ? assessment.reason_codes.slice() : [],
    symbol,
    setup_key: setupKey,
    side,
    time_regime: timeRegime,
  };

  const entry = {
    ...previous,
    key,
    symbol,
    setup_key: setupKey,
    side,
    time_regime: timeRegime,
    trade_count: tradeCount,
    average_quality_score: roundAverage(previous.average_quality_score, qualityScore, tradeCount),
    average_slippage: roundAverage(previous.average_slippage, slippage, tradeCount),
    average_execution_drag: roundAverage(previous.average_execution_drag, executionDrag, tradeCount),
    partial_fill_count: previous.partial_fill_count + (assessment.classification === 'partial_fill' ? 1 : 0),
    rejection_count: previous.rejection_count + (assessment.classification === 'rejected_order' ? 1 : 0),
    cancellation_count: previous.cancellation_count + (assessment.classification === 'canceled_order' ? 1 : 0),
    duplicate_risk_count: previous.duplicate_risk_count + (assessment.classification === 'duplicate_risk' ? 1 : 0),
    last_bad_execution_at: assessment.classification !== 'excellent_fill' && assessment.classification !== 'normal_fill'
      ? updatedRecord.timestamp
      : previous.last_bad_execution_at,
    penalty_points: penaltyPoints,
    size_multiplier: clampNumber(sizeMultiplier, sizeMultiplierFloor, 1),
    updated_at: updatedRecord.timestamp,
    recent_records: [updatedRecord, ...(previous.recent_records || [])].slice(0, 10),
    classifications: {
      ...previous.classifications,
      [assessment.classification || 'unknown']: (previous.classifications?.[assessment.classification || 'unknown'] || 0) + 1,
    },
    last_classification: assessment.classification || 'unknown',
  };

  normalizedState.entries[key] = entry;
  normalizedState.updated_at = updatedRecord.timestamp;
  normalizedState.last_reconciled_at = updatedRecord.timestamp;

  const summary = summarizeExecutionQualityState(normalizedState, options);
  return {
    state: normalizedState,
    entry,
    summary,
    execution_quality: assessment,
  };
}

function summarizeExecutionQualityState(state, options = {}) {
  const normalizedState = normalizeExecutionQualityState(state);
  const now = options.now || nowIso();
  const decayPerHour = Math.max(0, safeNumber(options.decayPerHour, 0));
  const minSizeMultiplier = clampNumber(options.minSizeMultiplier, 0.5, 1);
  const entries = Object.values(normalizedState.entries || {}).map((entry) => {
    const updatedAt = entry.updated_at || normalizedState.updated_at || now;
    const ageHours = ageInHours(updatedAt, now);
    const decayedPenalty = Math.max(0, entry.penalty_points - (decayPerHour * ageHours));
    const effectiveSizeMultiplier = clampNumber(1 - (decayedPenalty / 200), minSizeMultiplier, 1);
    return {
      ...entry,
      effective_penalty_points: roundNumber(decayedPenalty, 3),
      effective_size_multiplier: roundNumber(effectiveSizeMultiplier, 3),
      age_hours: roundNumber(ageHours, 3),
    };
  });
  const bySymbol = aggregateEntries(entries, 'symbol');
  const bySetup = aggregateEntries(entries, 'setup_key');
  const badEntries = entries
    .filter((entry) => (entry.last_classification || 'unknown') !== 'excellent_fill' && (entry.last_classification || 'unknown') !== 'normal_fill')
    .sort((a, b) => (b.effective_penalty_points - a.effective_penalty_points) || (b.updated_at || '').localeCompare(a.updated_at || ''));
  const totals = entries.reduce((acc, entry) => {
    acc.trade_count += entry.trade_count;
    acc.quality_score += entry.average_quality_score * entry.trade_count;
    acc.slippage += (Number.isFinite(entry.average_slippage) ? entry.average_slippage : 0) * entry.trade_count;
    acc.execution_drag += (Number.isFinite(entry.average_execution_drag) ? entry.average_execution_drag : 0) * entry.trade_count;
    acc.partial_fill_count += entry.partial_fill_count;
    acc.rejection_count += entry.rejection_count;
    acc.cancellation_count += entry.cancellation_count;
    acc.duplicate_risk_count += entry.duplicate_risk_count;
    acc.penalty_points += entry.effective_penalty_points;
    return acc;
  }, {
    trade_count: 0,
    quality_score: 0,
    slippage: 0,
    execution_drag: 0,
    partial_fill_count: 0,
    rejection_count: 0,
    cancellation_count: 0,
    duplicate_risk_count: 0,
    penalty_points: 0,
  });
  const tradeCount = Math.max(1, totals.trade_count);
  const averageQualityScore = totals.trade_count ? totals.quality_score / tradeCount : 0;
  const averageSlippage = totals.trade_count ? totals.slippage / tradeCount : null;
  const averageExecutionDrag = totals.trade_count ? totals.execution_drag / tradeCount : null;
  const partialFillRate = totals.trade_count ? totals.partial_fill_count / tradeCount : 0;
  const rejectionRate = totals.trade_count ? totals.rejection_count / tradeCount : 0;
  const cancellationRate = totals.trade_count ? totals.cancellation_count / tradeCount : 0;
  const duplicateRiskRate = totals.trade_count ? totals.duplicate_risk_count / tradeCount : 0;
  return {
    status: entries.length ? 'active' : 'empty',
    updated_at: normalizedState.updated_at || null,
    last_reconciled_at: normalizedState.last_reconciled_at || normalizedState.updated_at || null,
    total_entries: entries.length,
    total_trades: totals.trade_count,
    average_quality_score: roundNumber(averageQualityScore, 3),
    average_slippage: roundMaybe(averageSlippage),
    average_execution_drag: roundMaybe(averageExecutionDrag),
    partial_fill_rate: roundNumber(partialFillRate, 4),
    rejection_rate: roundNumber(rejectionRate, 4),
    cancellation_rate: roundNumber(cancellationRate, 4),
    duplicate_risk_rate: roundNumber(duplicateRiskRate, 4),
    by_symbol: bySymbol,
    by_setup: bySetup,
    recent_bad_fills: badEntries.slice(0, 12).map((entry) => ({
      symbol: entry.symbol,
      setup_key: entry.setup_key,
      side: entry.side,
      classification: entry.last_classification || 'unknown',
      penalty_points: entry.effective_penalty_points,
      size_multiplier: entry.effective_size_multiplier,
      last_bad_execution_at: entry.last_bad_execution_at,
      updated_at: entry.updated_at,
      recent_records: entry.recent_records || [],
    })),
    penalty_symbols: bySymbol
      .filter((entry) => safeNumber(entry.effective_penalty_points, 0) > 0)
      .sort((a, b) => b.effective_penalty_points - a.effective_penalty_points)
      .slice(0, 8),
    size_reduction_symbols: bySymbol
      .filter((entry) => safeNumber(entry.effective_size_multiplier, 1) < 1)
      .sort((a, b) => a.effective_size_multiplier - b.effective_size_multiplier)
      .slice(0, 8),
    warnings: buildExecutionQualityWarnings({
      averageQualityScore,
      averageSlippage,
      averageExecutionDrag,
      partialFillRate,
      rejectionRate,
      cancellationRate,
      duplicateRiskRate,
      badEntries,
    }),
  };
}

function buildExecutionQualityWarnings({
  averageQualityScore = 0,
  averageSlippage = null,
  averageExecutionDrag = null,
  partialFillRate = 0,
  rejectionRate = 0,
  cancellationRate = 0,
  duplicateRiskRate = 0,
  badEntries = [],
} = {}) {
  const warnings = [];
  if (averageQualityScore > 0 && averageQualityScore < 60) warnings.push('EXECUTION_QUALITY_AVERAGE_LOW');
  if (Number.isFinite(averageSlippage) && averageSlippage > 1) warnings.push('EXECUTION_SLIPPAGE_ELEVATED');
  if (Number.isFinite(averageExecutionDrag) && averageExecutionDrag > 0.5) warnings.push('EXECUTION_DRAG_ELEVATED');
  if (partialFillRate > 0.1) warnings.push('PARTIAL_FILL_RATE_ELEVATED');
  if (rejectionRate > 0.05) warnings.push('REJECTION_RATE_ELEVATED');
  if (cancellationRate > 0.05) warnings.push('CANCELLATION_RATE_ELEVATED');
  if (duplicateRiskRate > 0.02) warnings.push('DUPLICATE_RISK_ELEVATED');
  if (badEntries.length) warnings.push('RECENT_BAD_EXECUTIONS_PRESENT');
  return warnings;
}

function aggregateEntries(entries = [], keyField = 'symbol') {
  const buckets = new Map();
  for (const entry of entries) {
    const key = String(entry?.[keyField] || 'unknown').trim().toUpperCase() || 'UNKNOWN';
    const bucket = buckets.get(key) || {
      key,
      symbol: keyField === 'symbol' ? key : null,
      setup_key: keyField === 'setup_key' ? key.toLowerCase() : null,
      trade_count: 0,
      average_quality_score: 0,
      average_slippage: 0,
      average_execution_drag: 0,
      partial_fill_count: 0,
      rejection_count: 0,
      cancellation_count: 0,
      duplicate_risk_count: 0,
      penalty_points: 0,
      effective_penalty_points: 0,
      size_multiplier: 1,
      effective_size_multiplier: 1,
      last_bad_execution_at: null,
      updated_at: null,
      classifications: {},
      recent_records: [],
    };
    bucket.trade_count += entry.trade_count;
    bucket.average_quality_score += entry.average_quality_score * entry.trade_count;
    bucket.average_slippage += (Number.isFinite(entry.average_slippage) ? entry.average_slippage : 0) * entry.trade_count;
    bucket.average_execution_drag += (Number.isFinite(entry.average_execution_drag) ? entry.average_execution_drag : 0) * entry.trade_count;
    bucket.partial_fill_count += entry.partial_fill_count;
    bucket.rejection_count += entry.rejection_count;
    bucket.cancellation_count += entry.cancellation_count;
    bucket.duplicate_risk_count += entry.duplicate_risk_count;
    bucket.penalty_points += entry.penalty_points;
    bucket.effective_penalty_points += entry.effective_penalty_points;
    bucket.size_multiplier = Math.min(bucket.size_multiplier, entry.size_multiplier);
    bucket.effective_size_multiplier = Math.min(bucket.effective_size_multiplier, entry.effective_size_multiplier);
    if (!bucket.last_bad_execution_at || (entry.last_bad_execution_at && entry.last_bad_execution_at > bucket.last_bad_execution_at)) {
      bucket.last_bad_execution_at = entry.last_bad_execution_at;
    }
    if (!bucket.updated_at || (entry.updated_at && entry.updated_at > bucket.updated_at)) {
      bucket.updated_at = entry.updated_at;
    }
    bucket.recent_records = [...entry.recent_records || [], ...bucket.recent_records].slice(0, 10);
    for (const [classification, count] of Object.entries(entry.classifications || {})) {
      bucket.classifications[classification] = (bucket.classifications[classification] || 0) + count;
    }
    buckets.set(key, bucket);
  }

  return [...buckets.values()].map((bucket) => {
    const tradeCount = Math.max(1, bucket.trade_count);
    return {
      ...bucket,
      trade_count: bucket.trade_count,
      average_quality_score: roundNumber(bucket.average_quality_score / tradeCount, 3),
      average_slippage: bucket.trade_count ? roundMaybe(bucket.average_slippage / tradeCount) : null,
      average_execution_drag: bucket.trade_count ? roundMaybe(bucket.average_execution_drag / tradeCount) : null,
      penalty_points: roundNumber(bucket.penalty_points, 3),
      effective_penalty_points: roundNumber(bucket.effective_penalty_points, 3),
      size_multiplier: roundNumber(bucket.size_multiplier, 3),
      effective_size_multiplier: roundNumber(bucket.effective_size_multiplier, 3),
    };
  }).sort((a, b) => b.effective_penalty_points - a.effective_penalty_points || b.trade_count - a.trade_count);
}

function normalizeExecutionQualityKey(symbol, setupKey, side, timeRegime) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return null;
  const normalizedSetup = normalizeSetupKey(setupKey);
  const normalizedSide = normalizeSide(side) || 'unknown';
  const normalizedRegime = normalizeTimeRegime(timeRegime) || 'unknown';
  return `${normalizedSymbol}::${normalizedSetup || 'unknown'}::${normalizedSide}::${normalizedRegime}`;
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase() || null;
}

function normalizeSetupKey(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function normalizeSide(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['buy', 'sell'].includes(normalized) ? normalized : null;
}

function normalizeTimeRegime(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function ageInHours(timestamp, now = nowIso()) {
  const timestampMs = new Date(timestamp).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, (nowMs - timestampMs) / 3_600_000);
}

function roundNumber(value, decimals = 3) {
  if (!Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(decimals));
}

function roundAverage(previousAverage, nextValue, count) {
  const priorCount = Math.max(0, count - 1);
  const current = Number.isFinite(Number(previousAverage)) ? Number(previousAverage) : 0;
  const value = Number.isFinite(Number(nextValue)) ? Number(nextValue) : 0;
  if (count <= 1) return roundNumber(value, 3);
  return roundNumber(((current * priorCount) + value) / count, 3);
}

function roundMaybe(value) {
  return Number.isFinite(Number(value)) ? roundNumber(value, 3) : null;
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return max;
  return Math.max(min, Math.min(max, numeric));
}

module.exports = {
  EXECUTION_QUALITY_STATE_VERSION,
  calculateExecutionPenalty,
  classifyExecutionQuality,
  defaultExecutionQualityState,
  loadExecutionQualityState,
  normalizeExecutionQualityState,
  normalizeExecutionQualityKey,
  resolveExecutionQualityStatePath,
  saveExecutionQualityState,
  summarizeExecutionQualityState,
  updateExecutionQualityState,
};
