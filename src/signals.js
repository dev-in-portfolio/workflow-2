const { asArray, clamp, hashObject, nowIso, safeNumber } = require('./util');
const { buildProviderConfirmationFromContext } = require('./market-data');

function detectContradictions(evidence = []) {
  const items = asArray(evidence);
  const positive = items.filter((item) => ['bullish', 'positive', 'up', 'buy'].includes(String(item.sentiment || item.direction || '').toLowerCase()));
  const negative = items.filter((item) => ['bearish', 'negative', 'down', 'sell'].includes(String(item.sentiment || item.direction || '').toLowerCase()));
  const retractions = items.filter((item) => item.retracts || item.retracted || item.contradiction === true);
  const conflicts = Math.min(4, (positive.length > 0 && negative.length > 0 ? 1 : 0) + retractions.length + Math.max(0, items.filter((item) => item.claim_strength === 'low').length - 1));
  const score = clamp(conflicts * 35, 0, 100);
  return {
    contradiction_score: score,
    contradiction_count: conflicts,
    reasons: [
      ...(positive.length > 0 && negative.length > 0 ? ['MIXED_SENTIMENT'] : []),
      ...(retractions.length > 0 ? ['RETRACTED_OR_CONTRADICTED_SOURCE'] : []),
    ],
  };
}

function freshnessScoreFromAgeSeconds(ageSeconds, maxAgeSeconds) {
  if (ageSeconds === null || ageSeconds === undefined) return 0;
  if (ageSeconds <= 0) return 100;
  if (ageSeconds >= maxAgeSeconds) return 0;
  return clamp(100 - (ageSeconds / maxAgeSeconds) * 100, 0, 100);
}

function calculateSignalScores(signal, context = {}) {
  const freshnessScore = clamp(
    safeNumber(signal.freshness_score, freshnessScoreFromAgeSeconds(signal.age_seconds ?? context.age_seconds, context.max_age_seconds ?? 300)),
    0,
    100,
  );
  const sourceQualityScore = clamp(
    safeNumber(signal.source_quality_score, (safeNumber(signal.unique_sources, 1) * 20) + safeNumber(signal.avg_provider_reliability, 50) / 2),
    0,
    100,
  );
  const contradiction = signal.contradiction_score ?? detectContradictions(signal.evidence_refs || signal.evidence || []).contradiction_score;
  const contradictionPenalty = contradiction;
  const liquidityScore = clamp(safeNumber(signal.liquidity_score, context.liquidity_score ?? 50), 0, 100);
  const catalystScore = clamp(safeNumber(signal.catalyst_score, context.catalyst_score ?? 50), 0, 100);
  const alignmentScore = clamp(safeNumber(signal.alignment_score, context.alignment_score ?? 50), 0, 100);
  const riskScore = clamp(safeNumber(signal.risk_score, context.risk_score ?? 35), 0, 100);
  const providerConfirmation = resolveProviderConfirmation(signal, context);
  const providerConfirmationScore = providerConfirmation
    ? providerConfirmation.confirmed
      ? clamp(100 - safeNumber(providerConfirmation.discrepancy_score, 0), 0, 100)
      : clamp(35 - safeNumber(providerConfirmation.discrepancy_score, 0), 0, 100)
    : 50;
  const freshBonus = freshnessScore * 0.22;
  const sourceBonus = sourceQualityScore * 0.2;
  const liquidityBonus = liquidityScore * 0.15;
  const catalystBonus = catalystScore * 0.12;
  const alignmentBonus = alignmentScore * 0.1;
  const providerConfirmationBonus = providerConfirmationScore * 0.1;
  const contradictionPenaltyScaled = contradictionPenalty * 0.18;
  const riskPenalty = riskScore * 0.15;
  const frequencyPenalty = clamp(safeNumber(signal.signal_frequency_penalty, context.signal_frequency_penalty ?? 0), 0, 100) * 0.2;
  const missingPlanPenalty = signal.stop_loss ? 0 : 12;
  const missingPortfolioPenalty = context.portfolio_context_available === false ? 8 : 0;
  const baselineConfidence = clamp(safeNumber(signal.confidence_score, 50), 0, 100) * 0.1;
  const edgeScore = clamp(
    freshBonus + sourceBonus + liquidityBonus + catalystBonus + alignmentBonus + 20
      + providerConfirmationBonus
      - contradictionPenaltyScaled
      - riskPenalty
      - frequencyPenalty
      - missingPlanPenalty
      - missingPortfolioPenalty,
    0,
    100,
  );

  return {
    freshness_score: freshnessScore,
    source_quality_score: sourceQualityScore,
    contradiction_score: contradiction,
    liquidity_score: liquidityScore,
    catalyst_score: catalystScore,
    alignment_score: alignmentScore,
    risk_score: riskScore,
    provider_confirmation_score: providerConfirmationScore,
    edge_score: edgeScore,
    confidence_score: clamp(edgeScore + baselineConfidence, 0, 100),
  };
}

function scoreSignal(signal, context = {}) {
  const scores = calculateSignalScores(signal, context);
  const contradiction = scores.contradiction_score;
  const risk = scores.risk_score;
  const confidence = scores.confidence_score;
  const edge = scores.edge_score;
  const providerConfirmation = resolveProviderConfirmation(signal, context);
  const issues = [];

  if (edge < (context.min_edge_score ?? 60)) issues.push('LOW_EDGE_SCORE');
  if (contradiction >= 60) issues.push('HIGH_CONTRADICTION');
  if (risk >= 75) issues.push('RISK_TOO_HIGH');
  if (providerConfirmation && !providerConfirmation.confirmed) issues.push('MULTI_SOURCE_CONFIRMATION_FAILED');
  if (!signal.stop_loss) issues.push('MISSING_STOP_LOSS');
  if (!signal.take_profit) issues.push('MISSING_TAKE_PROFIT');

  let finalDecision = 'needs_review';
  if (issues.includes('LOW_EDGE_SCORE') || issues.includes('RISK_TOO_HIGH') || issues.includes('MULTI_SOURCE_CONFIRMATION_FAILED')) {
    finalDecision = 'blocked';
  } else if (confidence >= (context.min_confidence_for_paper ?? 80) && risk < 55 && contradiction < 50) {
    finalDecision = 'approved_for_paper';
  } else if (confidence >= 65 && contradiction < 65) {
    finalDecision = 'needs_review';
  } else if (confidence >= 45) {
    finalDecision = 'alert_only';
  } else {
    finalDecision = 'watchlist';
  }

  const actionCandidate =
    finalDecision === 'approved_for_paper' ? (signal.direction === 'bearish' ? 'paper_sell' : 'paper_buy')
      : finalDecision === 'blocked' ? 'ignore'
        : finalDecision === 'alert_only' ? 'alert'
          : 'watch';

  return {
    signal_id: signal.signal_id || `sig_${hashObject(signal).slice(0, 12)}`,
    asset_id: signal.asset_id || null,
    symbol: signal.symbol || null,
    asset_type: signal.asset_type || 'stock',
    strategy_name: signal.strategy_name || 'unknown',
    timeframe: signal.timeframe || 'unknown',
    direction: signal.direction || 'neutral',
    action_candidate: actionCandidate,
    confidence_score: scores.confidence_score,
    source_quality_score: scores.source_quality_score,
    freshness_score: scores.freshness_score,
    contradiction_score: scores.contradiction_score,
    risk_score: scores.risk_score,
    provider_confirmation_score: scores.provider_confirmation_score,
    edge_score: scores.edge_score,
    final_decision: finalDecision,
    explanation: signal.explanation || buildSignalExplanation(signal, scores, finalDecision, issues),
    evidence_refs: asArray(signal.evidence_refs || signal.evidence || []),
    created_at: signal.created_at || nowIso(),
    expires_at: signal.expires_at || null,
    prompt_version: signal.prompt_version || null,
    model_name: signal.model_name || null,
    deterministic_rules_version: signal.deterministic_rules_version || '2026-06-14.paper-first.1',
    scores,
    decision_reasons: issues,
    stop_loss: signal.stop_loss ?? null,
    take_profit: signal.take_profit ?? null,
    entry_price: signal.entry_price ?? null,
    price: signal.price ?? null,
    notional: signal.notional ?? null,
    quantity: signal.quantity ?? null,
    limit_price: signal.limit_price ?? null,
    volume: signal.volume ?? null,
    liquidity_score: signal.liquidity_score ?? null,
    sector: signal.sector ?? null,
    market_context: signal.market_context || null,
  };
}

function buildSignalExplanation(signal, scores, finalDecision, issues) {
  return [
    `${signal.symbol || 'unknown'} ${signal.direction || 'neutral'} signal scored ${Math.round(scores.confidence_score)}/100.`,
    `Freshness ${Math.round(scores.freshness_score)}/100, contradiction ${Math.round(scores.contradiction_score)}/100, provider confirmation ${Math.round(scores.provider_confirmation_score)}/100, risk ${Math.round(scores.risk_score)}/100.`,
    `Edge score ${Math.round(scores.edge_score)}/100.`,
    finalDecision === 'approved_for_paper' ? 'Signal cleared for paper review.' : `Decision: ${finalDecision}.`,
    issues.length ? `Flags: ${issues.join(', ')}.` : 'No hard blockers detected.',
  ].join(' ');
}

function resolveProviderConfirmation(signal, context) {
  if (context.provider_confirmation && typeof context.provider_confirmation.confirmed === 'boolean') {
    return context.provider_confirmation;
  }
  const marketContext = context.market_context || context.marketContext || signal.market_context || signal.marketContext || context;
  const tradeSide = String(
    context.trade_side
      || context.tradeSide
      || signal.side
      || signal.direction
      || '',
  ).trim().toLowerCase();
  const confirmation = buildProviderConfirmationFromContext(marketContext, {
    ...(context.provider_confirmation_options || context),
    trade_side: tradeSide,
  });
  return confirmation;
}

module.exports = {
  calculateSignalScores,
  detectContradictions,
  freshnessScoreFromAgeSeconds,
  scoreSignal,
};
