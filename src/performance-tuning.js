const { summarizeFillQuality } = require('./metrics');
const { safeNumber } = require('./util');
const { isOutcomeAccountingValid } = require('./paper-outcomes');

const DEFAULT_MAX_OPEN_POSITIONS = 2;

function summarizeOutcomeBuckets(paperOutcomes = []) {
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
      total_execution_drag: 0,
      total_execution_drag_ratio: 0,
      total_mfe: 0,
      total_mae: 0,
    };
    current.count += 1;
    current.total_pnl += safeNumber(outcome.pnl, 0);
    current.total_execution_drag += safeNumber(outcome.execution_drag, 0);
    const drag = safeNumber(outcome.execution_drag, 0);
    const pnl = Math.abs(safeNumber(outcome.pnl, 0));
    const fallbackRatio = drag > 0 ? drag / Math.max(1, pnl + drag) : 0;
    current.total_execution_drag_ratio += safeNumber(outcome.execution_drag_ratio, fallbackRatio);
    current.total_mfe += safeNumber(outcome.max_favorable_excursion, 0);
    current.total_mae += safeNumber(outcome.max_adverse_excursion, 0);
    if (outcome.win_loss === 'win') current.wins += 1;
    if (outcome.win_loss === 'loss') current.losses += 1;
    if (outcome.false_positive) current.false_positives += 1;
    buckets.set(bucket, current);
  }
  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    win_rate: bucket.count ? bucket.wins / bucket.count : 0,
    false_positive_rate: bucket.count ? bucket.false_positives / bucket.count : 0,
    average_execution_drag: bucket.count ? bucket.total_execution_drag / bucket.count : 0,
    average_execution_drag_ratio: bucket.count ? bucket.total_execution_drag_ratio / bucket.count : 0,
    average_pnl: bucket.count ? bucket.total_pnl / bucket.count : 0,
    average_mfe: bucket.count ? bucket.total_mfe / bucket.count : 0,
    average_mae: bucket.count ? bucket.total_mae / bucket.count : 0,
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

function buildThresholdProposal({
  currentPolicy = {},
  signals = [],
  paperOutcomes = [],
  riskDecisions = [],
} = {}) {
  paperOutcomes = paperOutcomes.filter(isOutcomeAccountingValid);
  const bucketStats = summarizeOutcomeBuckets(paperOutcomes);
  const signalStats = summarizeSignalQuality(signals);
  const outcomeStats = summarizeOutcomePerformance(paperOutcomes);
  const exitEfficiency = summarizeExitEfficiency(paperOutcomes);
  const fillQuality = summarizeFillQuality(paperOutcomes);
  const reasonStats = summarizeRiskReasons(riskDecisions);
  const profitableBuckets = bucketStats.filter((bucket) => bucket.count >= 3 && bucket.average_pnl > 0 && bucket.win_rate >= 0.55);
  const weakestBuckets = bucketStats.filter((bucket) => bucket.count >= 3 && bucket.average_pnl <= 0);
  const blockedCalibrationBuckets = bucketStats
    .filter((bucket) => bucket.count >= 3 && (bucket.average_pnl <= 0 || bucket.false_positive_rate >= 0.34 || bucket.average_execution_drag >= 2 || bucket.average_execution_drag_ratio >= 0.08))
    .map((bucket) => bucket.bucket)
    .filter((bucket) => bucket !== 'unknown');
  const proposal = {
    current_policy: currentPolicy,
    proposed_policy: {
      minConfidenceForPaper: currentPolicy.minConfidenceForPaper ?? 72,
      minFreshnessScore: currentPolicy.minFreshnessScore ?? 55,
      minSourceQualityScore: currentPolicy.minSourceQualityScore ?? 40,
      minProviderConfirmationScore: currentPolicy.minProviderConfirmationScore ?? 70,
      minEdgeScore: currentPolicy.minEdgeScore ?? 60,
      blockedCalibrationBuckets: Array.isArray(currentPolicy.blockedCalibrationBuckets)
        ? currentPolicy.blockedCalibrationBuckets.slice()
        : [],
      maxContradictionScore: currentPolicy.maxContradictionScore ?? 50,
      maxRiskScore: currentPolicy.maxRiskScore ?? 70,
      minLiquidityScore: currentPolicy.minLiquidityScore ?? 40,
      maxOpenPositions: currentPolicy.maxOpenPositions ?? DEFAULT_MAX_OPEN_POSITIONS,
      positionSizeMultiplier: currentPolicy.positionSizeMultiplier ?? 1,
      sellProfitThresholdPct: currentPolicy.sellProfitThresholdPct ?? 5,
      sellNetProfitFloorDollars: currentPolicy.sellNetProfitFloorDollars ?? 1,
      positionStopLossDollars: currentPolicy.positionStopLossDollars ?? 1,
      positionStopLossNotionalPct: currentPolicy.positionStopLossNotionalPct ?? 0.75,
      positionStopLossMaxDollars: currentPolicy.positionStopLossMaxDollars ?? 2.5,
      trailingProfitStartDollars: currentPolicy.trailingProfitStartDollars ?? 0.5,
      trailingProfitGivebackDollars: currentPolicy.trailingProfitGivebackDollars ?? 0.3,
    },
    reason_codes: [],
    notes: [],
    bucket_stats: bucketStats,
    signal_stats: signalStats,
    reason_stats: reasonStats,
    expected_focus: null,
  };

  const blockedRate = riskDecisions.length ? riskDecisions.filter((decision) => decision.decision === 'BLOCKED').length / riskDecisions.length : 0;
  const winRate = paperOutcomes.length ? paperOutcomes.filter((outcome) => outcome.win_loss === 'win').length / paperOutcomes.length : 0;

  if (winRate < 0.5) {
    proposal.proposed_policy.minConfidenceForPaper = clampInt(proposal.proposed_policy.minConfidenceForPaper + 3, 50, 95);
    proposal.reason_codes.push('LOW_OVERALL_WIN_RATE');
  } else if (profitableBuckets.length) {
    const bestBucket = profitableBuckets.slice().sort((a, b) => b.average_pnl - a.average_pnl || b.win_rate - a.win_rate)[0];
    if (bestBucket.bucket === '90-100') {
      proposal.proposed_policy.minConfidenceForPaper = clampInt(Math.max(proposal.proposed_policy.minConfidenceForPaper, 88), 50, 95);
      proposal.reason_codes.push('HIGH_CONFIDENCE_BUCKET_OUTPERFORMS');
    } else if (['80-89', '70-79'].includes(bestBucket.bucket)) {
      proposal.proposed_policy.minConfidenceForPaper = clampInt(Math.min(proposal.proposed_policy.minConfidenceForPaper, bestBucket.bucket === '70-79' ? 70 : 80), 50, 95);
      proposal.reason_codes.push('MID_BUCKET_OUTPERFORMS');
    }
  }

  if (weakestBuckets.length) {
    proposal.proposed_policy.minFreshnessScore = clampInt(proposal.proposed_policy.minFreshnessScore + 5, 0, 100);
    proposal.proposed_policy.maxContradictionScore = clampInt(proposal.proposed_policy.maxContradictionScore - 5, 0, 100);
    proposal.reason_codes.push('WEAK_BUCKETS_NEED_STRICTER_EVIDENCE');
  }
  if (blockedCalibrationBuckets.length) {
    proposal.proposed_policy.blockedCalibrationBuckets = mergeUniqueBuckets([
      ...proposal.proposed_policy.blockedCalibrationBuckets,
      ...blockedCalibrationBuckets,
    ]);
    proposal.reason_codes.push('BLOCKED_CALIBRATION_BUCKETS');
  }

  const highFalsePositiveBuckets = bucketStats.filter((bucket) => bucket.count >= 3 && bucket.false_positive_rate >= 0.34);
  if (highFalsePositiveBuckets.length) {
    proposal.proposed_policy.blockedCalibrationBuckets = mergeUniqueBuckets([
      ...proposal.proposed_policy.blockedCalibrationBuckets,
      ...highFalsePositiveBuckets.map((bucket) => bucket.bucket).filter((bucket) => bucket !== 'unknown'),
    ]);
    proposal.proposed_policy.minConfidenceForPaper = clampInt(Math.max(proposal.proposed_policy.minConfidenceForPaper, 75), 50, 95);
    proposal.reason_codes.push('HIGH_FALSE_POSITIVE_BUCKETS');
  }

  const highExecutionDragBuckets = bucketStats.filter((bucket) => bucket.count >= 3 && (bucket.average_execution_drag >= 2 || bucket.average_execution_drag_ratio >= 0.08));
  if (highExecutionDragBuckets.length) {
    proposal.proposed_policy.blockedCalibrationBuckets = mergeUniqueBuckets([
      ...proposal.proposed_policy.blockedCalibrationBuckets,
      ...highExecutionDragBuckets.map((bucket) => bucket.bucket).filter((bucket) => bucket !== 'unknown'),
    ]);
    proposal.proposed_policy.positionSizeMultiplier = clampMultiplier({
      current: Math.min(proposal.proposed_policy.positionSizeMultiplier, 0.95),
      winRate,
      blockedRate,
      weakestBuckets,
      profitableBuckets,
      falsePositiveBuckets: bucketStats.filter((bucket) => bucket.count >= 3 && bucket.false_positive_rate >= 0.34),
      signalStats,
      outcomeStats: {
        ...outcomeStats,
        executionDrag: bucketStats.reduce((sum, bucket) => sum + safeNumber(bucket.average_execution_drag, 0), 0) / Math.max(1, bucketStats.length),
      },
    });
    proposal.proposed_policy.positionSizeMultiplier = Math.min(proposal.proposed_policy.positionSizeMultiplier, 0.9);
    proposal.reason_codes.push('HIGH_EXECUTION_DRAG_BUCKETS');
  }

  if (signalStats.average_freshness < 60) {
    proposal.proposed_policy.minFreshnessScore = clampInt(Math.max(proposal.proposed_policy.minFreshnessScore, 60), 0, 100);
    proposal.reason_codes.push('LOW_AVERAGE_FRESHNESS');
  }

  if (signalStats.average_edge < 60) {
    proposal.proposed_policy.minEdgeScore = clampInt(Math.max(proposal.proposed_policy.minEdgeScore, 60), 0, 100);
    proposal.reason_codes.push('LOW_AVERAGE_EDGE_SCORE');
  }

  if (signalStats.average_source_quality < 50) {
    proposal.proposed_policy.minSourceQualityScore = clampInt(Math.max(proposal.proposed_policy.minSourceQualityScore, 50), 0, 100);
    proposal.reason_codes.push('LOW_AVERAGE_SOURCE_QUALITY');
  }

  if (signalStats.average_provider_confirmation < 70) {
    proposal.proposed_policy.minProviderConfirmationScore = clampInt(Math.max(proposal.proposed_policy.minProviderConfirmationScore, 70), 0, 100);
    proposal.reason_codes.push('LOW_AVERAGE_PROVIDER_CONFIRMATION');
  }

  if (signalStats.average_contradiction > 35) {
    proposal.proposed_policy.maxContradictionScore = clampInt(Math.min(proposal.proposed_policy.maxContradictionScore, 35), 0, 100);
    proposal.reason_codes.push('HIGH_AVERAGE_CONTRADICTION');
  }

  if (signalStats.average_risk > 50) {
    proposal.proposed_policy.maxRiskScore = clampInt(Math.min(proposal.proposed_policy.maxRiskScore, 50), 0, 100);
    proposal.reason_codes.push('HIGH_AVERAGE_SIGNAL_RISK');
  }

  const openPositionBlocks = reasonStats.find((item) => item.reason === 'MAX_OPEN_POSITIONS_EXCEEDED');
  if (openPositionBlocks && openPositionBlocks.count > 0) {
    if (outcomeStats.paperPnl >= 0 && outcomeStats.drawdown <= Math.max(5, Math.abs(outcomeStats.paperPnl) * 0.5)) {
      proposal.proposed_policy.maxOpenPositions = clampInt(proposal.proposed_policy.maxOpenPositions + 1, 1, 15);
      proposal.reason_codes.push('OPEN_POSITION_CAP_TOO_TIGHT');
    } else if (outcomeStats.paperPnl < 0 || outcomeStats.drawdown > 0) {
      proposal.proposed_policy.maxOpenPositions = clampInt(proposal.proposed_policy.maxOpenPositions, 1, 15);
      proposal.reason_codes.push('OPEN_POSITION_CAP_HELD_FOR_RISK');
    }
  }

  const healthyActivity = paperOutcomes.length >= 3
    && outcomeStats.paperPnl > 0
    && winRate >= 0.6
    && outcomeStats.drawdown <= Math.max(5, Math.abs(outcomeStats.paperPnl) * 0.4)
    && fillQuality.fill_rate >= 0.85
    && fillQuality.partial_fill_rate <= 0.05
    && fillQuality.rejection_rate <= 0.05
    && outcomeStats.falsePositives === 0;
  if (healthyActivity && proposal.proposed_policy.maxOpenPositions < 15) {
    const bump = outcomeStats.paperPnl > 25 && winRate >= 0.7 ? 2 : 1;
    proposal.proposed_policy.maxOpenPositions = clampInt(proposal.proposed_policy.maxOpenPositions + bump, 1, 15);
    proposal.reason_codes.push('HEALTHY_ACTIVITY_EXPANDS_OPEN_POSITIONS');
  }

  if (blockedRate > 0.6) {
    proposal.proposed_policy.minConfidenceForPaper = clampInt(proposal.proposed_policy.minConfidenceForPaper + 2, 50, 95);
    proposal.reason_codes.push('BLOCK_RATE_TOO_HIGH');
  }

  proposal.proposed_policy.positionSizeMultiplier = clampMultiplier({
    current: proposal.proposed_policy.positionSizeMultiplier,
    winRate,
    blockedRate,
    weakestBuckets,
    profitableBuckets,
    falsePositiveBuckets: bucketStats.filter((bucket) => bucket.count >= 3 && bucket.false_positive_rate >= 0.34),
    signalStats,
    outcomeStats,
  });
  if (highExecutionDragBuckets.length) {
    proposal.proposed_policy.positionSizeMultiplier = Math.min(proposal.proposed_policy.positionSizeMultiplier, 0.9);
  }
  if (proposal.proposed_policy.positionSizeMultiplier < 1) {
    proposal.reason_codes.push('SIZE_DOWN_FOR_RISK_CONTROL');
  } else if (proposal.proposed_policy.positionSizeMultiplier > 1) {
    proposal.reason_codes.push('SIZE_UP_FOR_CONFIRMED_EDGE');
  }

  const exitTuning = tuneExitRules({
    currentPolicy,
    outcomeStats,
    paperOutcomes,
    winRate,
    fillQuality,
    exitEfficiency,
  });
  Object.assign(proposal.proposed_policy, exitTuning.policy);
  proposal.reason_codes.push(...exitTuning.reason_codes);

  proposal.expected_focus = buildExpectedFocus(proposal.proposed_policy, bucketStats);
  proposal.notes = buildNotes(proposal, winRate, blockedRate);
  proposal.notes.push(...exitTuning.notes);
  return proposal;
}

function tuneExitRules({ currentPolicy = {}, outcomeStats = {}, paperOutcomes = [], winRate = 0, fillQuality = {}, exitEfficiency = null } = {}) {
  const current = {
    sellProfitThresholdPct: positiveNumber(currentPolicy.sellProfitThresholdPct, 5),
    sellNetProfitFloorDollars: positiveNumber(currentPolicy.sellNetProfitFloorDollars, 1),
    positionStopLossDollars: positiveNumber(currentPolicy.positionStopLossDollars, 1),
    positionStopLossNotionalPct: Math.max(0, safeNumber(currentPolicy.positionStopLossNotionalPct, 0.75)),
    positionStopLossMaxDollars: positiveNumber(currentPolicy.positionStopLossMaxDollars, 2.5),
    trailingProfitStartDollars: positiveNumber(currentPolicy.trailingProfitStartDollars, 0.5),
    trailingProfitGivebackDollars: positiveNumber(currentPolicy.trailingProfitGivebackDollars, 0.3),
  };
  const policy = { ...current };
  const reasonCodes = [];
  const notes = [];
  const closedOutcomes = paperOutcomes.filter((outcome) => Number.isFinite(Number(outcome.pnl)));
  if (closedOutcomes.length < 3) {
    notes.push('Exit rules held steady until at least three closed outcomes are available.');
    return { policy, reason_codes: reasonCodes, notes };
  }

  const averageMfe = averagePositive(closedOutcomes.map((outcome) => safeNumber(outcome.max_favorable_excursion, 0)));
  const averageMae = averagePositive(closedOutcomes.map((outcome) => Math.abs(safeNumber(outcome.max_adverse_excursion, 0))));
  const efficiency = exitEfficiency || summarizeExitEfficiency(closedOutcomes);
  const drawdown = safeNumber(outcomeStats.drawdown, 0);
  const paperPnl = safeNumber(outcomeStats.paperPnl, 0);
  const falsePositives = safeNumber(outcomeStats.falsePositives, 0);
  const poorPeakCapture = efficiency.count >= 3
    && efficiency.average_peak_profit > 0
    && efficiency.average_capture_ratio < 0.5
    && efficiency.average_giveback_dollars > Math.max(0.25, current.trailingProfitGivebackDollars * 0.75);
  const costDragHigh = efficiency.count >= 3
    && (
      efficiency.average_execution_drag_ratio >= 0.08
      || efficiency.average_execution_drag >= Math.max(0.25, Math.abs(efficiency.average_net_profit) * 0.25)
    );
  const realGainErosion = efficiency.count >= 3
    && efficiency.gross_win_rate > efficiency.real_gain_rate
    && efficiency.real_gain_rate < 0.6;
  const weakExits = winRate < 0.5 || paperPnl < 0 || falsePositives > 0 || drawdown > Math.max(5, Math.abs(paperPnl) * 0.5);
  const healthyExits = winRate >= 0.6
    && paperPnl > 0
    && falsePositives === 0
    && drawdown <= Math.max(5, Math.abs(paperPnl) * 0.35)
    && safeNumber(fillQuality.partial_fill_rate, 0) <= 0.05
    && safeNumber(fillQuality.rejection_rate, 0) <= 0.05;

  if (weakExits) {
    policy.positionStopLossDollars = roundPolicyNumber(Math.max(0.25, current.positionStopLossDollars * 0.85));
    policy.positionStopLossNotionalPct = roundPolicyNumber(Math.max(0.1, current.positionStopLossNotionalPct * 0.9));
    policy.positionStopLossMaxDollars = roundPolicyNumber(Math.max(policy.positionStopLossDollars, current.positionStopLossMaxDollars * 0.85));
    policy.trailingProfitStartDollars = roundPolicyNumber(Math.max(0.25, current.trailingProfitStartDollars * 0.9));
    policy.trailingProfitGivebackDollars = roundPolicyNumber(Math.max(0.1, Math.min(policy.trailingProfitStartDollars, current.trailingProfitGivebackDollars * 0.85)));
    policy.sellProfitThresholdPct = roundPolicyNumber(Math.max(0.5, current.sellProfitThresholdPct * 0.9));
    policy.sellNetProfitFloorDollars = roundPolicyNumber(Math.max(0.25, current.sellNetProfitFloorDollars * 0.9));
    reasonCodes.push('EXIT_RULES_TIGHTENED_FOR_DRAWDOWN');
    notes.push('Exit rules tightened because recent closed outcomes show weak win rate, drawdown, or false positives.');
  } else if (healthyExits) {
    if (averageMfe > current.trailingProfitStartDollars) {
      policy.trailingProfitStartDollars = roundPolicyNumber(Math.min(current.trailingProfitStartDollars * 1.2, Math.max(current.trailingProfitStartDollars, averageMfe * 0.7)));
      policy.trailingProfitGivebackDollars = roundPolicyNumber(Math.max(0.1, Math.min(policy.trailingProfitStartDollars * 0.75, Math.max(current.trailingProfitGivebackDollars, averageMfe * 0.25))));
      policy.sellProfitThresholdPct = roundPolicyNumber(Math.max(current.sellProfitThresholdPct, current.sellProfitThresholdPct * 1.05));
      reasonCodes.push('EXIT_RULES_LET_WINNERS_RUN');
      notes.push('Exit rules nudged to let stronger winners breathe based on favorable excursion history.');
    }
    if (averageMae > 0 && averageMae < current.positionStopLossDollars * 0.5) {
      policy.positionStopLossDollars = roundPolicyNumber(Math.max(current.positionStopLossDollars * 0.9, averageMae * 1.5, 0.25));
      policy.positionStopLossMaxDollars = roundPolicyNumber(Math.max(policy.positionStopLossDollars, current.positionStopLossMaxDollars * 0.95));
      reasonCodes.push('EXIT_RULES_REDUCE_UNUSED_LOSS_ROOM');
      notes.push('Stop room reduced because recent winners did not need the full adverse-excursion allowance.');
    }
  } else {
    notes.push('Exit rules held steady because outcome quality is mixed.');
  }

  if (poorPeakCapture) {
    policy.trailingProfitStartDollars = roundPolicyNumber(Math.max(0.25, Math.min(current.trailingProfitStartDollars * 0.9, efficiency.average_peak_profit * 0.45)));
    policy.trailingProfitGivebackDollars = roundPolicyNumber(Math.max(0.1, Math.min(current.trailingProfitGivebackDollars * 0.85, Math.max(0.1, efficiency.average_giveback_dollars * 0.5))));
    policy.sellProfitThresholdPct = roundPolicyNumber(Math.max(0.5, Math.min(policy.sellProfitThresholdPct, current.sellProfitThresholdPct * 0.95)));
    reasonCodes.push('LOW_PEAK_CAPTURE_TIGHTEN_TRAILING');
    notes.push(`Peak capture is low (${Math.round(efficiency.average_capture_ratio * 100)}%); trailing start/giveback tightened to keep more of the sale peak.`);
  }

  if (costDragHigh || realGainErosion) {
    const dragBuffer = Math.max(current.sellNetProfitFloorDollars, efficiency.average_execution_drag * 2, 0.25);
    policy.sellNetProfitFloorDollars = roundPolicyNumber(Math.max(policy.sellNetProfitFloorDollars, dragBuffer));
    policy.sellProfitThresholdPct = roundPolicyNumber(Math.max(policy.sellProfitThresholdPct, current.sellProfitThresholdPct * 1.05));
    reasonCodes.push(costDragHigh ? 'EXIT_COSTS_REQUIRE_HIGHER_PROFIT_FLOOR' : 'REAL_GAIN_EROSION_REQUIRE_HIGHER_PROFIT_FLOOR');
    notes.push(`Sale costs are eroding exits: average drag ${roundPolicyNumber(efficiency.average_execution_drag)}, fees ${roundPolicyNumber(efficiency.average_fees)}, real-gain rate ${Math.round(efficiency.real_gain_rate * 100)}%.`);
  }

  return { policy, reason_codes: reasonCodes, notes };
}

function summarizeExitEfficiency(paperOutcomes = []) {
  const stats = {
    count: 0,
    gross_win_count: 0,
    real_gain_count: 0,
    total_peak_profit: 0,
    total_sale_profit: 0,
    total_net_profit: 0,
    total_fees: 0,
    total_execution_drag: 0,
    total_execution_drag_ratio: 0,
    total_capture_ratio: 0,
    total_giveback_dollars: 0,
  };

  for (const outcome of paperOutcomes) {
    const peakProfit = safeNumber(outcome.max_favorable_excursion ?? outcome.trailing_peak_unrealized_pl, null);
    const saleProfit = safeNumber(outcome.gross_pnl ?? outcome.pnl, null);
    const netProfit = safeNumber(outcome.net_pnl ?? outcome.adjusted_pnl ?? outcome.pnl, null);
    if (!Number.isFinite(saleProfit) && !Number.isFinite(netProfit)) continue;
    const executionDrag = Math.max(0, safeNumber(outcome.execution_drag, 0));
    const fees = Math.max(0, safeNumber(outcome.fees ?? outcome.estimated_fees ?? outcome.paper_result?.estimated_fees, 0));
    const effectivePeak = Number.isFinite(peakProfit) && peakProfit > 0
      ? peakProfit
      : Math.max(0, Number.isFinite(saleProfit) ? saleProfit : netProfit);
    const effectiveSale = Number.isFinite(saleProfit) ? saleProfit : netProfit;
    const effectiveNet = Number.isFinite(netProfit) ? netProfit : effectiveSale - executionDrag;
    const captureRatio = effectivePeak > 0 ? clampNumber(effectiveNet / effectivePeak, -1, 1.5) : null;
    const giveback = effectivePeak > 0 && Number.isFinite(effectiveSale) ? Math.max(0, effectivePeak - effectiveSale) : 0;
    const fallbackDragRatio = executionDrag > 0 ? executionDrag / Math.max(1, Math.abs(effectiveNet) + executionDrag) : 0;
    const dragRatio = safeNumber(outcome.execution_drag_ratio, fallbackDragRatio);

    stats.count += 1;
    if (Number.isFinite(effectiveSale) && effectiveSale > 0) stats.gross_win_count += 1;
    if (Number.isFinite(effectiveNet) && effectiveNet > 0) stats.real_gain_count += 1;
    stats.total_peak_profit += effectivePeak;
    stats.total_sale_profit += Number.isFinite(effectiveSale) ? effectiveSale : 0;
    stats.total_net_profit += Number.isFinite(effectiveNet) ? effectiveNet : 0;
    stats.total_fees += fees;
    stats.total_execution_drag += executionDrag;
    stats.total_execution_drag_ratio += Number.isFinite(dragRatio) ? dragRatio : 0;
    stats.total_capture_ratio += Number.isFinite(captureRatio) ? captureRatio : 0;
    stats.total_giveback_dollars += giveback;
  }

  if (!stats.count) {
    return {
      count: 0,
      gross_win_rate: 0,
      real_gain_rate: 0,
      average_peak_profit: 0,
      average_sale_profit: 0,
      average_net_profit: 0,
      average_fees: 0,
      average_execution_drag: 0,
      average_execution_drag_ratio: 0,
      average_capture_ratio: 0,
      average_giveback_dollars: 0,
    };
  }

  return {
    count: stats.count,
    gross_win_rate: stats.gross_win_count / stats.count,
    real_gain_rate: stats.real_gain_count / stats.count,
    average_peak_profit: stats.total_peak_profit / stats.count,
    average_sale_profit: stats.total_sale_profit / stats.count,
    average_net_profit: stats.total_net_profit / stats.count,
    average_fees: stats.total_fees / stats.count,
    average_execution_drag: stats.total_execution_drag / stats.count,
    average_execution_drag_ratio: stats.total_execution_drag_ratio / stats.count,
    average_capture_ratio: stats.total_capture_ratio / stats.count,
    average_giveback_dollars: stats.total_giveback_dollars / stats.count,
  };
}

function buildExpectedFocus(policy, buckets) {
  const targetBucket = buckets.slice().sort((a, b) => b.average_pnl - a.average_pnl || b.win_rate - a.win_rate)[0];
  return targetBucket
    ? `Prioritize signals that map to confidence bucket ${targetBucket.bucket} with stronger freshness, lower contradiction, provider agreement, and controlled risk.`
    : `Use policy thresholds: confidence >= ${policy.minConfidenceForPaper}, freshness >= ${policy.minFreshnessScore}, source quality >= ${policy.minSourceQualityScore}, provider confirmation >= ${policy.minProviderConfirmationScore}, edge >= ${policy.minEdgeScore}.`;
}

function buildNotes(proposal, winRate, blockedRate) {
  const notes = [];
  const highExecutionDragBuckets = (proposal.bucket_stats || []).filter((bucket) => bucket.count >= 3 && (bucket.average_execution_drag >= 2 || bucket.average_execution_drag_ratio >= 0.08));
  notes.push(`Observed paper win rate ${Math.round(winRate * 100)}%.`);
  notes.push(`Blocked rate ${Math.round(blockedRate * 100)}%.`);
  if (proposal.reason_codes.includes('OPEN_POSITION_CAP_TOO_TIGHT')) {
    notes.push('Open-position demand is healthy and the concurrency cap is restricting otherwise valid setups.');
  }
  if (proposal.reason_codes.includes('OPEN_POSITION_CAP_HELD_FOR_RISK')) {
    notes.push('Open-position pressure is present, but recent outcomes do not justify widening the cap yet.');
  }
  if (proposal.reason_codes.includes('HEALTHY_ACTIVITY_EXPANDS_OPEN_POSITIONS')) {
    notes.push('Recent paper results and fill quality are strong enough to widen open-position capacity without loosening the risk brakes.');
  }
  if (proposal.reason_codes.includes('MID_BUCKET_OUTPERFORMS')) {
    notes.push('The mid-confidence cohort is outperforming; widen only if freshness and contradiction remain clean.');
  }
  if (proposal.reason_codes.includes('HIGH_CONFIDENCE_BUCKET_OUTPERFORMS')) {
    notes.push('High-confidence signals are winning; tighten entry criteria around the strongest evidence only.');
  }
  if (proposal.reason_codes.includes('WEAK_BUCKETS_NEED_STRICTER_EVIDENCE')) {
    notes.push('Weak buckets are losing; require stronger confirmation before admitting similar trades.');
  }
  if (proposal.reason_codes.includes('LOW_AVERAGE_PROVIDER_CONFIRMATION')) {
    notes.push('Provider disagreement is costing edge; require stronger Alpaca and Twelve Data agreement before paper approval.');
  }
  if (proposal.reason_codes.includes('BLOCKED_CALIBRATION_BUCKETS')) {
    notes.push(`Negative calibration buckets are blocked: ${proposal.proposed_policy.blockedCalibrationBuckets.join(', ')}.`);
  }
  if (proposal.reason_codes.includes('HIGH_FALSE_POSITIVE_BUCKETS')) {
    notes.push('One or more calibration buckets are producing too many false positives; tighten evidence requirements or block the affected buckets.');
  }
  if (proposal.reason_codes.includes('HIGH_EXECUTION_DRAG_BUCKETS')) {
    notes.push('Execution drag is concentrated in one or more calibration buckets; reduce size or tighten fill quality before scaling those setups.');
    notes.push(`Worst execution drag bucket ${highExecutionDragBuckets[0].bucket} is running at ${Math.round((highExecutionDragBuckets[0].average_execution_drag_ratio || 0) * 100)}% relative drag.`);
  }
  if (!notes.length) {
    notes.push('Policy appears balanced based on current paper results.');
  }
  return notes;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function positiveNumber(value, fallback) {
  const numeric = safeNumber(value, fallback);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function averagePositive(values = []) {
  const positives = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (!positives.length) return 0;
  return positives.reduce((sum, value) => sum + value, 0) / positives.length;
}

function roundPolicyNumber(value) {
  return Number(Number(value).toFixed(4));
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function clampMultiplier({ current = 1, winRate = 0, blockedRate = 0, weakestBuckets = [], profitableBuckets = [], falsePositiveBuckets = [], signalStats = {}, outcomeStats = {} } = {}) {
  let multiplier = safeNumber(current, 1);
  const { drawdown = 0, paperPnl = 0, falsePositives = 0, executionDrag = 0 } = outcomeStats;
  if (winRate < 0.5 || blockedRate > 0.6 || signalStats.average_risk > 60 || signalStats.average_contradiction > 45) {
    multiplier -= 0.15;
  }
  if (profitableBuckets.length && winRate >= 0.6 && blockedRate < 0.4 && signalStats.average_risk < 45 && signalStats.average_contradiction <= 30) {
    multiplier += 0.15;
  }
  if (signalStats.average_edge >= 75 && signalStats.average_provider_confirmation >= 80 && signalStats.average_source_quality >= 80) {
    multiplier += 0.05;
  }
  if (weakestBuckets.length) {
    multiplier -= 0.05;
  }
  if (falsePositiveBuckets.length) {
    multiplier -= 0.08;
  }
  if (executionDrag > 0) {
    multiplier -= executionDrag >= Math.max(10, Math.abs(paperPnl) * 0.5) ? 0.12 : 0.05;
  }
  if (drawdown > 0) {
    multiplier -= drawdown >= Math.max(10, Math.abs(paperPnl) * 0.5) ? 0.15 : 0.05;
  }
  if (falsePositives > 0 && paperPnl < 0) {
    multiplier -= 0.05;
  }
  if (paperPnl > 0 && drawdown === 0 && falsePositives === 0 && winRate >= 0.65) {
    multiplier += 0.1;
  }
  return Number(Math.max(0.5, Math.min(1.35, multiplier)).toFixed(2));
}

function summarizeOutcomePerformance(paperOutcomes = []) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  let falsePositives = 0;
  let paperPnl = 0;
  for (const outcome of paperOutcomes) {
    const pnl = safeNumber(outcome.pnl, 0);
    paperPnl += pnl;
    equity += pnl;
    if (equity > peak) peak = equity;
    drawdown = Math.max(drawdown, peak - equity);
    if (outcome.false_positive) falsePositives += 1;
  }
  return {
    paperPnl,
    drawdown,
    falsePositives,
  };
}

function summarizeRiskReasons(riskDecisions = []) {
  const counts = new Map();
  for (const decision of riskDecisions) {
    for (const reason of decision.reason_codes || []) {
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
}

function mergeUniqueBuckets(buckets) {
  return [...new Set(buckets.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

module.exports = {
  buildThresholdProposal,
  clampMultiplier,
  summarizeExitEfficiency,
  summarizeOutcomeBuckets,
  summarizeOutcomePerformance,
  summarizeRiskReasons,
  summarizeSignalQuality,
};
