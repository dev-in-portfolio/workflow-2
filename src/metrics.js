const { clamp, nowIso, safeNumber } = require('./util');

const DEFAULT_MAX_OPEN_POSITIONS = 2;

function generateDailySummary({ date, signals = [], riskDecisions = [], orders = [], events = [], policySnapshot = null }) {
  return generateDailyLiveResultsReport({ date, signals, riskDecisions, paperOutcomes: orders, events, policySnapshot });
}

function generateDailyLiveResultsReport({ date, signals = [], riskDecisions = [], paperOutcomes = [], events = [], policySnapshot = null }) {
  const summaryDate = date || nowIso().slice(0, 10);
  const blockedCount = riskDecisions.filter((decision) => decision.decision === 'BLOCKED').length;
  const approvedCount = riskDecisions.filter((decision) => decision.decision === 'APPROVED_FOR_PAPER').length;
  const alertOnlyCount = riskDecisions.filter((decision) => decision.decision === 'ALERT_ONLY').length;
  const paperPnl = paperOutcomes.reduce((sum, outcome) => sum + safeNumber(outcome.pnl, 0), 0);
  const drawdown = calculateDrawdown(paperOutcomes);
  const executionDrag = paperOutcomes.reduce((sum, outcome) => sum + safeNumber(outcome.execution_drag, 0), 0);
  const executionDragRatio = paperOutcomes.length
    ? paperOutcomes.reduce((sum, outcome) => {
      const drag = safeNumber(outcome.execution_drag, 0);
      const pnl = Math.abs(safeNumber(outcome.pnl, 0));
      const fallbackRatio = drag > 0 ? drag / Math.max(1, pnl + drag) : 0;
      return sum + safeNumber(outcome.execution_drag_ratio, fallbackRatio);
    }, 0) / paperOutcomes.length
    : 0;
  const fillQualitySummary = summarizeFillQuality(paperOutcomes);
  const pnlByExitReason = summarizePnlBy(paperOutcomes, 'exit_reason');
  const pnlBySymbol = summarizePnlBy(paperOutcomes, 'symbol');
  const pnlByRegime = summarizePnlBy(paperOutcomes, 'regime');
  const profitFactor = calculateProfitFactor(paperOutcomes);
  const churn = summarizeChurn(paperOutcomes);
  const stopoutClustering = summarizeStopoutClustering(paperOutcomes);
  const tradeDuration = summarizeTradeDuration(paperOutcomes);
  const slippageSummary = summarizeSlippage(paperOutcomes);
  const executionQualitySummary = summarizeExecutionQuality(paperOutcomes);
  const falsePositives = paperOutcomes.filter((outcome) => outcome.false_positive || outcome.win_loss === 'loss' && outcome.calibration_bucket === '90-100').length;
  const calibrationBuckets = summarizeCalibrationBuckets(paperOutcomes);
  const falsePositiveBuckets = summarizeFalsePositiveBuckets(paperOutcomes);
  const signalQualitySummary = summarizeSignalQuality(signals);
  const signalQualityOutliers = summarizeSignalQualityOutliers(signals);
  const blockReasons = countReasons(riskDecisions);
  const blockedReasonCounts = blockReasons.reduce((map, item) => {
    map[item.reason] = item.count;
    return map;
  }, {});
  const dominantBlockReason = blockReasons[0] || null;
  const bestSignal = chooseBestSignal(signals, paperOutcomes);
  const worstSignal = chooseWorstSignal(signals, paperOutcomes);
  const bestCalibrationBucket = calibrationBuckets.slice().sort((a, b) => b.average_pnl - a.average_pnl || b.win_rate - a.win_rate)[0] || null;
  const worstCalibrationBucket = calibrationBuckets.slice().sort((a, b) => a.average_pnl - b.average_pnl || a.win_rate - b.win_rate)[0] || null;
  const rejectionRate = riskDecisions.length ? blockedCount / riskDecisions.length : 0;
  const rejectionPressureScore = clamp((rejectionRate * 100) + Math.min(25, blockReasons.length * 3), 0, 100);
  const recommendedMaxOpenPositions = recommendOpenPositionCapFromReport({
    currentMaxOpenPositions: safeNumber(policySnapshot?.policy?.maxOpenPositions, DEFAULT_MAX_OPEN_POSITIONS),
    paperPnl,
    winRate: paperOutcomes.length ? paperOutcomes.filter((outcome) => outcome.win_loss === 'win').length / paperOutcomes.length : 0,
    blockedRate: rejectionRate,
    falsePositives,
    drawdown,
    executionDrag,
    fillRate: fillQualitySummary.fill_rate,
    partialFillRate: fillQualitySummary.partial_fill_rate,
    rejectionRate,
  });

  return {
    date: summaryDate,
    signal_count: signals.length,
    blocked_count: blockedCount,
    approved_count: approvedCount,
    alert_only_count: alertOnlyCount,
    paper_orders: paperOutcomes.length,
    paper_fills: paperOutcomes.filter((outcome) => outcome.win_loss !== 'unknown' || outcome.paper_result).length,
    paper_pnl: paperPnl,
    drawdown,
    execution_drag: executionDrag,
    execution_drag_ratio: executionDragRatio,
    fill_quality_summary: fillQualitySummary,
    pnl_by_exit_reason: pnlByExitReason,
    pnl_by_symbol: pnlBySymbol,
    pnl_by_regime: pnlByRegime,
    profit_factor: profitFactor,
    churn,
    stopout_clustering: stopoutClustering,
    trade_duration_summary: tradeDuration,
    partial_fill_rate: fillQualitySummary.partial_fill_rate,
    slippage_summary: slippageSummary,
    execution_quality_summary: executionQualitySummary,
    false_positives: falsePositives,
    false_positive_buckets: falsePositiveBuckets,
    signal_quality_summary: signalQualitySummary,
    signal_quality_outliers: signalQualityOutliers,
    best_signal: bestSignal,
    worst_signal: worstSignal,
    calibration_buckets: calibrationBuckets,
    best_calibration_bucket: bestCalibrationBucket,
    worst_calibration_bucket: worstCalibrationBucket,
    top_block_reasons: blockReasons.slice(0, 5),
    blocked_reason_counts: blockedReasonCounts,
    dominant_block_reason: dominantBlockReason,
    rejection_rate: rejectionRate,
    rejection_pressure_score: rejectionPressureScore,
    recommended_max_open_positions: recommendedMaxOpenPositions,
    data_quality_issues: events.filter((event) => String(event.event_type || '').includes('data')).length,
    recommended_tuning_notes: buildTuningNotes({ signals, riskDecisions, orders: paperOutcomes }),
    paper_outcomes: paperOutcomes,
    paper_outcome_count: paperOutcomes.length,
    realized_paper_pnl: paperPnl,
    unrealized_paper_pnl: 0,
    max_drawdown: drawdown,
    approved_for_paper: approvedCount,
    blocked_by_risk: blockedCount,
    alert_only: alertOnlyCount,
    total_signals: signals.length,
  };
}

function countReasons(riskDecisions) {
  const counts = new Map();
  for (const decision of riskDecisions) {
    for (const reason of decision.reason_codes || []) {
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
}

function summarizeCalibrationBuckets(paperOutcomes = []) {
  const buckets = new Map();
  for (const outcome of paperOutcomes) {
    const bucket = outcome.calibration_bucket || 'unknown';
    const current = buckets.get(bucket) || {
      bucket,
      count: 0,
      wins: 0,
      losses: 0,
      false_positives: 0,
      total_pnl: 0,
    };
    current.count += 1;
    current.total_pnl += safeNumber(outcome.pnl, 0);
    if (outcome.win_loss === 'win') current.wins += 1;
    if (outcome.win_loss === 'loss') current.losses += 1;
    if (outcome.false_positive) current.false_positives += 1;
    buckets.set(bucket, current);
  }
  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    win_rate: bucket.count ? bucket.wins / bucket.count : 0,
    average_pnl: bucket.count ? bucket.total_pnl / bucket.count : 0,
  }));
}

function summarizeSignalQuality(signals = []) {
  const stats = {
    count: signals.length,
    average_confidence: 0,
    average_freshness: 0,
    average_source_quality: 0,
    average_contradiction: 0,
    average_risk: 0,
    average_provider_confirmation: 0,
    average_edge: 0,
  };

  if (!signals.length) return stats;

  for (const signal of signals) {
    stats.average_confidence += safeNumber(signal.confidence_score, 0);
    stats.average_freshness += safeNumber(signal.freshness_score, 0);
    stats.average_source_quality += safeNumber(signal.source_quality_score, 0);
    stats.average_contradiction += safeNumber(signal.contradiction_score, 0);
    stats.average_risk += safeNumber(signal.risk_score, 0);
    stats.average_provider_confirmation += safeNumber(signal.provider_confirmation_score, 0);
    stats.average_edge += safeNumber(signal.edge_score, safeNumber(signal.confidence_score, 0));
  }

  stats.average_confidence /= signals.length;
  stats.average_freshness /= signals.length;
  stats.average_source_quality /= signals.length;
  stats.average_contradiction /= signals.length;
  stats.average_risk /= signals.length;
  stats.average_provider_confirmation /= signals.length;
  stats.average_edge /= signals.length;
  return stats;
}

function summarizeFalsePositiveBuckets(paperOutcomes = []) {
  const buckets = new Map();
  for (const outcome of paperOutcomes) {
    const bucket = outcome.calibration_bucket || 'unknown';
    const current = buckets.get(bucket) || {
      bucket,
      count: 0,
      false_positives: 0,
      false_positive_rate: 0,
      total_pnl: 0,
    };
    current.count += 1;
    current.total_pnl += safeNumber(outcome.pnl, 0);
    if (outcome.false_positive) current.false_positives += 1;
    buckets.set(bucket, current);
  }
  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    false_positive_rate: bucket.count ? bucket.false_positives / bucket.count : 0,
    average_pnl: bucket.count ? bucket.total_pnl / bucket.count : 0,
  })).filter((bucket) => bucket.false_positives > 0)
    .sort((a, b) => b.false_positive_rate - a.false_positive_rate || b.false_positives - a.false_positives);
}

function summarizeSignalQualityOutliers(signals = []) {
  return signals
    .map((signal) => {
      const confidence = safeNumber(signal.confidence_score, 0);
      const freshness = safeNumber(signal.freshness_score, 0);
      const sourceQuality = safeNumber(signal.source_quality_score, 0);
      const providerConfirmation = safeNumber(signal.provider_confirmation_score, 0);
      const edge = safeNumber(signal.edge_score, confidence);
      const risk = safeNumber(signal.risk_score, 0);
      const outlierScore = (
        (100 - confidence) * 0.22
        + (100 - freshness) * 0.18
        + (100 - sourceQuality) * 0.18
        + (100 - providerConfirmation) * 0.16
        + (100 - edge) * 0.18
        + risk * 0.08
      );
      return {
        signal_id: signal.signal_id || null,
        symbol: signal.symbol || null,
        confidence_score: confidence,
        freshness_score: freshness,
        source_quality_score: sourceQuality,
        provider_confirmation_score: providerConfirmation,
        edge_score: edge,
        risk_score: risk,
        outlier_score: Number(outlierScore.toFixed(2)),
      };
    })
    .sort((a, b) => b.outlier_score - a.outlier_score || a.confidence_score - b.confidence_score)
    .slice(0, 3);
}

function summarizeFillQuality(paperOutcomes = []) {
  const summary = {
    count: paperOutcomes.length,
    filled_count: 0,
    partially_filled_count: 0,
    rejected_count: 0,
    canceled_count: 0,
    other_count: 0,
    average_partial_fill_percentage: null,
    repeated_partial_fill_symbols: [],
  };
  const partialPercentages = [];
  const partialSymbols = new Map();

  for (const outcome of paperOutcomes) {
    const status = String(outcome.status || outcome.paper_result?.status || outcome.paper_result?.order_status || '').toLowerCase();
    if (['filled', 'closed'].includes(status)) {
      summary.filled_count += 1;
    } else if (status === 'partially_filled') {
      summary.partially_filled_count += 1;
      const submitted = safeNumber(outcome.partial_fill?.submitted_quantity ?? outcome.paper_result?.submitted_quantity, null);
      const filled = safeNumber(outcome.partial_fill?.filled_quantity ?? outcome.paper_result?.filled_quantity, null);
      if (Number.isFinite(submitted) && submitted > 0 && Number.isFinite(filled)) {
        partialPercentages.push(filled / submitted);
      }
      const symbol = outcome.symbol || outcome.original_signal?.symbol || outcome.paper_result?.original_signal?.symbol || null;
      if (symbol) partialSymbols.set(symbol, (partialSymbols.get(symbol) || 0) + 1);
    } else if (status === 'rejected') {
      summary.rejected_count += 1;
    } else if (status === 'cancelled' || status === 'canceled') {
      summary.canceled_count += 1;
    } else if (status) {
      summary.other_count += 1;
    }
  }

  const total = Math.max(1, summary.count);
  summary.fill_rate = summary.filled_count / total;
  summary.partial_fill_rate = summary.partially_filled_count / total;
  summary.rejection_rate = summary.rejected_count / total;
  summary.cancel_rate = summary.canceled_count / total;
  summary.average_partial_fill_percentage = partialPercentages.length
    ? partialPercentages.reduce((sum, value) => sum + value, 0) / partialPercentages.length
    : null;
  summary.repeated_partial_fill_symbols = [...partialSymbols.entries()]
    .filter(([, count]) => count > 1)
    .map(([symbol, count]) => ({ symbol, count }));
  return summary;
}

function summarizePnlBy(paperOutcomes = [], key = 'symbol') {
  const buckets = new Map();
  for (const outcome of paperOutcomes) {
    const bucketKey = outcome?.[key]
      || outcome?.original_signal?.[key]
      || outcome?.paper_result?.original_signal?.[key]
      || outcome?.market_context?.[key]
      || 'unknown';
    const bucket = buckets.get(bucketKey) || { key: bucketKey, count: 0, wins: 0, losses: 0, pnl: 0 };
    const pnl = safeNumber(outcome.pnl ?? outcome.net_pnl ?? outcome.adjusted_pnl, 0);
    bucket.count += 1;
    bucket.pnl += pnl;
    if (pnl > 0) bucket.wins += 1;
    if (pnl < 0) bucket.losses += 1;
    buckets.set(bucketKey, bucket);
  }
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      average_pnl: bucket.count ? bucket.pnl / bucket.count : 0,
      win_rate: bucket.count ? bucket.wins / bucket.count : 0,
    }))
    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
}

function calculateProfitFactor(paperOutcomes = []) {
  const grossProfit = paperOutcomes.reduce((sum, outcome) => {
    const pnl = safeNumber(outcome.pnl ?? outcome.net_pnl ?? outcome.adjusted_pnl, 0);
    return pnl > 0 ? sum + pnl : sum;
  }, 0);
  const grossLoss = Math.abs(paperOutcomes.reduce((sum, outcome) => {
    const pnl = safeNumber(outcome.pnl ?? outcome.net_pnl ?? outcome.adjusted_pnl, 0);
    return pnl < 0 ? sum + pnl : sum;
  }, 0));
  if (grossProfit === 0 && grossLoss === 0) return null;
  if (grossLoss === 0) return Number.POSITIVE_INFINITY;
  return grossProfit / grossLoss;
}

function summarizeChurn(paperOutcomes = []) {
  const bySymbol = new Map();
  for (const outcome of paperOutcomes) {
    const symbol = outcome.symbol || outcome.original_signal?.symbol || 'unknown';
    bySymbol.set(symbol, (bySymbol.get(symbol) || 0) + 1);
  }
  const counts = [...bySymbol.entries()].map(([symbol, count]) => ({ symbol, count })).sort((a, b) => b.count - a.count);
  return {
    unique_symbols: bySymbol.size,
    total_trades: paperOutcomes.length,
    max_symbol_trades: counts[0] || null,
    repeated_symbol_count: counts.filter((item) => item.count > 1).length,
    by_symbol: counts,
  };
}

function summarizeStopoutClustering(paperOutcomes = []) {
  const stopouts = paperOutcomes.filter((outcome) => {
    const reason = String(outcome.exit_reason || outcome.original_signal?.market_context?.exit_state?.exit_reason || '').toUpperCase();
    return reason.includes('STOP');
  });
  return {
    count: stopouts.length,
    by_symbol: summarizePnlBy(stopouts, 'symbol'),
    recent_symbols: stopouts.slice(-5).map((outcome) => outcome.symbol || outcome.original_signal?.symbol || 'unknown'),
  };
}

function summarizeTradeDuration(paperOutcomes = []) {
  const durations = paperOutcomes.map((outcome) => {
    const startedAt = new Date(outcome.entry_at || outcome.created_at || outcome.original_signal?.created_at || 0).getTime();
    const endedAt = new Date(outcome.recorded_at || outcome.filled_at || outcome.paper_result?.filled_at || 0).getTime();
    return Number.isFinite(startedAt) && Number.isFinite(endedAt) && startedAt > 0 && endedAt >= startedAt
      ? (endedAt - startedAt) / 1000
      : null;
  }).filter(Number.isFinite);
  if (!durations.length) return { count: 0, average_seconds: null, min_seconds: null, max_seconds: null };
  return {
    count: durations.length,
    average_seconds: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    min_seconds: Math.min(...durations),
    max_seconds: Math.max(...durations),
  };
}

function summarizeSlippage(paperOutcomes = []) {
  const values = paperOutcomes
    .map((outcome) => safeNumber(outcome.slippage ?? outcome.execution_slippage ?? outcome.paper_result?.slippage, null))
    .filter(Number.isFinite);
  if (!values.length) return { count: 0, average: null, total: null };
  return {
    count: values.length,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    total: values.reduce((sum, value) => sum + value, 0),
  };
}

function summarizeExecutionQuality(paperOutcomes = []) {
  const bySymbol = new Map();
  const bySetup = new Map();
  const recentBadFills = [];
  let totalTrades = 0;
  let totalScore = 0;
  let totalPenalty = 0;
  let totalSlippage = 0;
  let totalExecutionDrag = 0;
  let partialFillCount = 0;
  let rejectionCount = 0;
  let cancellationCount = 0;
  let duplicateRiskCount = 0;

  for (const outcome of paperOutcomes) {
    const quality = outcome.execution_quality || {};
    const symbol = String(outcome.symbol || outcome.original_signal?.symbol || 'unknown').trim().toUpperCase() || 'UNKNOWN';
    const setupKey = String(outcome.setup_key || outcome.original_signal?.market_context?.setup_key || 'unknown').trim().toLowerCase() || 'unknown';
    const score = safeNumber(quality.execution_quality_score, safeNumber(outcome.execution_quality_score, null));
    const penalty = safeNumber(quality.execution_penalty_points, safeNumber(outcome.execution_penalty_points, 0));
    const slippage = safeNumber(quality.slippage, safeNumber(outcome.slippage ?? outcome.execution_slippage ?? outcome.paper_result?.slippage, null));
    const drag = safeNumber(quality.execution_drag, safeNumber(outcome.execution_drag, null));
    const classification = String(quality.classification || outcome.execution_quality_classification || 'unknown');
    const isBad = !['excellent_fill', 'normal_fill'].includes(classification);

    totalTrades += 1;
    totalScore += Number.isFinite(score) ? score : 100;
    totalPenalty += penalty;
    totalSlippage += Number.isFinite(slippage) ? slippage : 0;
    totalExecutionDrag += Number.isFinite(drag) ? drag : 0;
    if (classification === 'partial_fill') partialFillCount += 1;
    if (classification === 'rejected_order') rejectionCount += 1;
    if (classification === 'canceled_order') cancellationCount += 1;
    if (classification === 'duplicate_risk') duplicateRiskCount += 1;

    if (isBad) {
      recentBadFills.push({
        symbol,
        setup_key: setupKey,
        classification,
        execution_quality_score: Number.isFinite(score) ? score : null,
        execution_penalty_points: penalty,
        slippage,
        execution_drag: drag,
        side: outcome.side || outcome.paper_result?.side || null,
        recorded_at: outcome.recorded_at || outcome.paper_result?.filled_at || null,
      });
    }

    const symbolBucket = bySymbol.get(symbol) || {
      symbol,
      trade_count: 0,
      average_quality_score: 0,
      average_slippage: 0,
      average_execution_drag: 0,
      partial_fill_count: 0,
      rejection_count: 0,
      cancellation_count: 0,
      duplicate_risk_count: 0,
      penalty_points: 0,
      classifications: {},
    };
    symbolBucket.trade_count += 1;
    symbolBucket.average_quality_score += Number.isFinite(score) ? score : 100;
    symbolBucket.average_slippage += Number.isFinite(slippage) ? slippage : 0;
    symbolBucket.average_execution_drag += Number.isFinite(drag) ? drag : 0;
    symbolBucket.partial_fill_count += classification === 'partial_fill' ? 1 : 0;
    symbolBucket.rejection_count += classification === 'rejected_order' ? 1 : 0;
    symbolBucket.cancellation_count += classification === 'canceled_order' ? 1 : 0;
    symbolBucket.duplicate_risk_count += classification === 'duplicate_risk' ? 1 : 0;
    symbolBucket.penalty_points += penalty;
    symbolBucket.classifications[classification] = (symbolBucket.classifications[classification] || 0) + 1;
    bySymbol.set(symbol, symbolBucket);

    const setupBucket = bySetup.get(setupKey) || {
      setup_key: setupKey,
      trade_count: 0,
      average_quality_score: 0,
      average_slippage: 0,
      average_execution_drag: 0,
      partial_fill_count: 0,
      rejection_count: 0,
      cancellation_count: 0,
      duplicate_risk_count: 0,
      penalty_points: 0,
      classifications: {},
    };
    setupBucket.trade_count += 1;
    setupBucket.average_quality_score += Number.isFinite(score) ? score : 100;
    setupBucket.average_slippage += Number.isFinite(slippage) ? slippage : 0;
    setupBucket.average_execution_drag += Number.isFinite(drag) ? drag : 0;
    setupBucket.partial_fill_count += classification === 'partial_fill' ? 1 : 0;
    setupBucket.rejection_count += classification === 'rejected_order' ? 1 : 0;
    setupBucket.cancellation_count += classification === 'canceled_order' ? 1 : 0;
    setupBucket.duplicate_risk_count += classification === 'duplicate_risk' ? 1 : 0;
    setupBucket.penalty_points += penalty;
    setupBucket.classifications[classification] = (setupBucket.classifications[classification] || 0) + 1;
    bySetup.set(setupKey, setupBucket);
  }

  const finalize = (bucket) => ({
    ...bucket,
    average_quality_score: bucket.trade_count ? bucket.average_quality_score / bucket.trade_count : 0,
    average_slippage: bucket.trade_count ? bucket.average_slippage / bucket.trade_count : null,
    average_execution_drag: bucket.trade_count ? bucket.average_execution_drag / bucket.trade_count : null,
  });

  return {
    total_trades: totalTrades,
    average_quality_score: totalTrades ? totalScore / totalTrades : 0,
    average_execution_penalty_points: totalTrades ? totalPenalty / totalTrades : 0,
    average_slippage: totalTrades ? totalSlippage / totalTrades : null,
    average_execution_drag: totalTrades ? totalExecutionDrag / totalTrades : null,
    partial_fill_rate: totalTrades ? partialFillCount / totalTrades : 0,
    rejection_rate: totalTrades ? rejectionCount / totalTrades : 0,
    cancellation_rate: totalTrades ? cancellationCount / totalTrades : 0,
    duplicate_risk_rate: totalTrades ? duplicateRiskCount / totalTrades : 0,
    by_symbol: [...bySymbol.values()].map(finalize).sort((a, b) => b.penalty_points - a.penalty_points || a.symbol.localeCompare(b.symbol)),
    by_setup: [...bySetup.values()].map(finalize).sort((a, b) => b.penalty_points - a.penalty_points || a.setup_key.localeCompare(b.setup_key)),
    recent_bad_fills: recentBadFills.slice(-12).reverse(),
  };
}

function recommendOpenPositionCapFromReport({
  currentMaxOpenPositions = 12,
  paperPnl = 0,
  winRate = 0,
  blockedRate = 0,
  falsePositives = 0,
  drawdown = 0,
  executionDrag = 0,
  fillRate = 0,
  partialFillRate = 0,
  rejectionRate = 0,
} = {}) {
  let cap = Math.max(1, Math.round(safeNumber(currentMaxOpenPositions, 12)));
  const healthyRun = paperPnl > 0 && winRate >= 0.6 && drawdown <= Math.max(5, Math.abs(paperPnl) * 0.4) && falsePositives === 0;
  const excellentRun = healthyRun && paperPnl > 25 && winRate >= 0.7 && fillRate >= 0.9 && partialFillRate <= 0.03 && rejectionRate <= 0.03;
  if (healthyRun) cap += 1;
  if (excellentRun) cap += 1;
  if (blockedRate > 0.6 || falsePositives > 0 || drawdown > Math.max(10, Math.abs(paperPnl) * 0.5)) cap -= 1;
  if (executionDrag > Math.max(10, Math.abs(paperPnl) * 0.5)) cap -= 1;
  if (fillRate > 0 && fillRate < 0.8) cap -= 1;
  if (partialFillRate > 0.1 || rejectionRate > 0.1) cap -= 1;
  return clamp(cap, 1, 15);
}

function aggregateBy(items, key) {
  const buckets = new Map();
  for (const item of items) {
    const bucketKey = item?.[key] || 'unknown';
    const bucket = buckets.get(bucketKey) || { key: bucketKey, count: 0, average_confidence: 0 };
    bucket.count += 1;
    bucket.average_confidence += safeNumber(item.confidence_score, 0);
    buckets.set(bucketKey, bucket);
  }
  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    average_confidence: bucket.count ? bucket.average_confidence / bucket.count : 0,
  }));
}

function buildTuningNotes({ signals, riskDecisions, orders }) {
  const avgConfidence = signals.length ? signals.reduce((sum, signal) => sum + safeNumber(signal.confidence_score, 0), 0) / signals.length : 0;
  const avgFreshness = signals.length ? signals.reduce((sum, signal) => sum + safeNumber(signal.freshness_score, 0), 0) / signals.length : 0;
  const avgSourceQuality = signals.length ? signals.reduce((sum, signal) => sum + safeNumber(signal.source_quality_score, 0), 0) / signals.length : 0;
  const avgEdge = signals.length ? signals.reduce((sum, signal) => sum + safeNumber(signal.edge_score, safeNumber(signal.confidence_score, 0)), 0) / signals.length : 0;
  const avgProviderConfirmation = signals.length ? signals.reduce((sum, signal) => sum + safeNumber(signal.provider_confirmation_score, 0), 0) / signals.length : 0;
  const blockRate = riskDecisions.length ? riskDecisions.filter((decision) => decision.decision === 'BLOCKED').length / riskDecisions.length : 0;
  const reasonCounts = countReasons(riskDecisions);
  const falsePositiveBuckets = summarizeFalsePositiveBuckets(orders);
  const executionDrag = orders.reduce((sum, order) => sum + safeNumber(order.execution_drag, 0), 0);
  const executionDragRatio = orders.length
    ? orders.reduce((sum, order) => {
      const drag = safeNumber(order.execution_drag, 0);
      const pnl = Math.abs(safeNumber(order.pnl, 0));
      const fallbackRatio = drag > 0 ? drag / Math.max(1, pnl + drag) : 0;
      return sum + safeNumber(order.execution_drag_ratio, fallbackRatio);
    }, 0) / orders.length
    : 0;
  const fillQualitySummary = summarizeFillQuality(orders);
  const fillRate = orders.length
    ? orders.filter((order) => ['filled', 'partially_filled', 'reconciled'].includes(order.status) || order.win_loss).length / orders.length
    : 0;
  const notes = [];
  if (avgConfidence < 70) notes.push('Raise evidence quality or lower noise sources before widening approvals.');
  if (avgFreshness < 60) notes.push('Average freshness is weak; stale data is still leaking into the decision loop.');
  if (avgSourceQuality < 60) notes.push('Average source quality is weak; tighten provider agreement and source vetting before expanding activity.');
  if (avgEdge < 60) notes.push('Average edge is weak; require stronger combined confirmation before letting more setups through.');
  if (avgProviderConfirmation < 70) notes.push('Provider agreement is weak; tighten Alpaca and Twelve Data confirmation before expanding size.');
  if (blockRate > 0.5) notes.push('Too many candidates are failing the risk gate; review thresholds and stale-data policies.');
  if (reasonCounts.some((item) => item.reason === 'STALE_DATA' || item.reason === 'INVALID_TIMESTAMP')) {
    notes.push('A material share of rejections comes from stale or invalid provider timestamps; tighten freshness checks or provider latency.');
  }
  if (reasonCounts.some((item) => item.reason === 'MULTI_SOURCE_CONFIRMATION_FAILED')) {
    notes.push('Multi-source disagreement is suppressing approvals; require stronger Alpaca and Twelve Data agreement before expanding size.');
  }
  if (reasonCounts.some((item) => item.reason === 'MAX_OPEN_POSITIONS_EXCEEDED')) {
    notes.push('Open-position demand is running into the cap; consider widening maxOpenPositions if outcomes remain healthy.');
  }
  if (falsePositiveBuckets.length) {
    const worstBucket = falsePositiveBuckets[0];
    notes.push(`False positives are clustering in calibration bucket ${worstBucket.bucket} (${Math.round(worstBucket.false_positive_rate * 100)}% false-positive rate); tighten filters there first.`);
  }
  if (executionDrag > 0) {
    notes.push(`Execution drag totaled ${executionDrag.toFixed(2)}; review slippage, fees, and fill quality before scaling further.`);
  }
  if (executionDragRatio > 0.03) {
    notes.push(`Execution drag is absorbing ${Math.round(executionDragRatio * 100)}% of trade quality on average; reduce slippage or size before adding more activity.`);
  }
  if (fillQualitySummary.partial_fill_rate > 0.1) {
    notes.push(`Partial fills are running at ${Math.round(fillQualitySummary.partial_fill_rate * 100)}%; tighten order sizing or liquidity checks.`);
  }
  if (fillQualitySummary.rejection_rate > 0.05) {
    notes.push(`Rejected fills are running at ${Math.round(fillQualitySummary.rejection_rate * 100)}%; review order routing and execution constraints.`);
  }
  if (signals.length) {
    const weakestSignal = summarizeSignalQualityOutliers(signals)[0];
    if (weakestSignal) {
      notes.push(`Weakest signal today: ${weakestSignal.signal_id || 'unknown'} (${weakestSignal.symbol || 'unknown'}) with confidence ${Math.round(weakestSignal.confidence_score)}/100 and source quality ${Math.round(weakestSignal.source_quality_score)}/100.`);
    }
  }
  if (fillRate < 0.6) notes.push('Paper execution is weak; inspect slippage assumptions and order sizing.');
  if (!notes.length) notes.push('Current controls look balanced; preserve the paper-first gating model.');
  return notes;
}

function calculateDrawdown(paperOutcomes) {
  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  for (const outcome of paperOutcomes) {
    equity += safeNumber(outcome.pnl, 0);
    if (equity > peak) peak = equity;
    const currentDrawdown = peak - equity;
    if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
  }
  return maxDrawdown;
}

function chooseBestSignal(signals, paperOutcomes) {
  if (paperOutcomes.length) {
    return paperOutcomes.slice().sort((a, b) => safeNumber(b.pnl, -Infinity) - safeNumber(a.pnl, -Infinity))[0] || null;
  }
  return signals.slice().sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0))[0] || null;
}

function chooseWorstSignal(signals, paperOutcomes) {
  if (paperOutcomes.length) {
    return paperOutcomes.slice().sort((a, b) => safeNumber(a.pnl, Infinity) - safeNumber(b.pnl, Infinity))[0] || null;
  }
  return signals.slice().sort((a, b) => (a.confidence_score || 0) - (b.confidence_score || 0))[0] || null;
}

module.exports = {
  aggregateBy,
  buildTuningNotes,
  calculateDrawdown,
  chooseBestSignal,
  chooseWorstSignal,
  calculateProfitFactor,
  generateDailySummary,
  generateDailyLiveResultsReport,
  summarizeCalibrationBuckets,
  summarizeFalsePositiveBuckets,
  summarizeSignalQualityOutliers,
  summarizeFillQuality,
  summarizeExecutionQuality,
  summarizePnlBy,
  summarizeChurn,
  summarizeStopoutClustering,
  summarizeTradeDuration,
  summarizeSlippage,
  recommendOpenPositionCapFromReport,
  summarizeSignalQuality,
};
