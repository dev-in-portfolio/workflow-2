const { resolveMemeEscalationPolicy } = require('./meme-escalation-policy');

function classifyHotHotCandidate({
  symbol,
  memeHeatScore,
  marketConfirmation = null,
  policy = null,
  sourceProfile = null,
  now = new Date(),
}) {
  const resolvedPolicy = policy || resolveMemeEscalationPolicy(process.env);
  const expiresAt = new Date(now.getTime() + resolvedPolicy.hotListTtlMinutes * 60_000).toISOString();
  const heat = clampScore(memeHeatScore);
  const marketScore = marketConfirmation?.available === false ? null : (Number.isFinite(marketConfirmation?.marketConfirmationScore) ? clampScore(marketConfirmation.marketConfirmationScore) : null);
  const marketReasons = Array.isArray(marketConfirmation?.reasonCodes) ? marketConfirmation.reasonCodes : [];
  const warnings = new Set(Array.isArray(marketConfirmation?.riskWarnings) ? marketConfirmation.riskWarnings : []);
  const reasonCodes = [];
  const tierCounts = sourceProfile?.tierCounts || {};
  const hasTier1Or2 = Number(tierCounts.tier_1 || 0) > 0 || Number(tierCounts.tier_2 || 0) > 0;
  const hasTier3Sources = Number(tierCounts.tier_3 || 0) > 0;
  const hasTickerSpecificSources = Number(tierCounts.ticker_specific || 0) > 0;
  const hasOptionalHighNoiseSources = Number(tierCounts.optional_high_noise || 0) > 0;
  const hasTier3Only = !hasTier1Or2 && hasTier3Sources && !hasTickerSpecificSources && !hasOptionalHighNoiseSources;
  const onlyTickerSpecific = !hasTier1Or2 && hasTickerSpecificSources && !hasTier3Sources && !hasOptionalHighNoiseSources;

  if (heat >= resolvedPolicy.hotHotMinScore) {
    reasonCodes.push('hot_hot_threshold_passed');
  } else {
    reasonCodes.push('hot_hot_threshold_failed');
  }

  if (marketScore === null) {
    reasonCodes.push('market_confirmation_unavailable');
  } else if (marketScore >= resolvedPolicy.marketConfirmationMinScore) {
    reasonCodes.push('market_confirmation_passed');
  } else {
    reasonCodes.push('market_confirmation_failed');
  }

  for (const code of marketReasons) {
    if (code === 'tradable_confirmed') reasonCodes.push('tradable_confirmed');
    if (code === 'not_tradable') reasonCodes.push('not_tradable');
    if (code === 'excluded_symbol') reasonCodes.push('excluded_symbol');
    if (code === 'spread_acceptable') reasonCodes.push('spread_acceptable');
    if (code === 'spread_too_wide') reasonCodes.push('spread_too_wide');
    if (code === 'volume_confirmed') reasonCodes.push('volume_confirmed');
    if (code === 'volume_not_confirmed') reasonCodes.push('volume_not_confirmed');
    if (code === 'price_acceleration_confirmed') reasonCodes.push('price_acceleration_confirmed');
    if (code === 'price_acceleration_not_confirmed') reasonCodes.push('price_acceleration_not_confirmed');
    if (code === 'stale_market_data') reasonCodes.push('stale_market_data');
    if (code === 'possible_halt_risk') reasonCodes.push('possible_halt_risk');
    if (code === 'halt_status_unknown') reasonCodes.push('halt_status_unknown');
  }

  const hotHotEligible = heat >= resolvedPolicy.hotHotMinScore
    && marketScore !== null
    && marketScore >= resolvedPolicy.marketConfirmationMinScore
    && !reasonCodes.includes('not_tradable')
    && !reasonCodes.includes('excluded_symbol')
    && !reasonCodes.includes('spread_too_wide')
    && !reasonCodes.includes('possible_halt_risk')
    && !reasonCodes.includes('stale_market_data');

  const status = hotHotEligible
    ? 'hot_hot'
    : marketScore === null
      ? (heat >= resolvedPolicy.dynamicMinScore ? 'dynamic_watch' : heat >= 40 ? 'watch_only' : 'ignore')
      : heat >= resolvedPolicy.hotCandidateMinScore
        ? 'hot_candidate'
        : heat >= resolvedPolicy.dynamicMinScore
          ? 'dynamic_watch'
          : heat >= 40
            ? 'watch_only'
            : 'ignore';

  if (hotHotEligible) {
    if (hasTier3Only && (marketScore === null || marketScore < Math.min(90, resolvedPolicy.marketConfirmationMinScore + 10))) {
      reasonCodes.push('tier_3_context_only');
    } else if (onlyTickerSpecific && (marketScore === null || marketScore < Math.min(92, resolvedPolicy.marketConfirmationMinScore + 12))) {
      reasonCodes.push('ticker_specific_requires_stronger_confirmation');
    } else {
      reasonCodes.push('hot_hot_threshold_passed');
    }
  }

  const guardedHotHotEligible = hotHotEligible
    && !reasonCodes.includes('tier_3_context_only')
    && !reasonCodes.includes('ticker_specific_requires_stronger_confirmation');

  const guardedStatus = guardedHotHotEligible
    ? 'hot_hot'
    : status === 'hot_hot'
      ? (marketScore === null ? 'dynamic_watch' : 'hot_candidate')
      : status;

  return {
    symbol,
    memeHeatScore: heat,
    marketConfirmationScore: marketScore,
    status: guardedStatus,
    priorityOverrideEligible: false,
    rotationEligible: false,
    reasonCodes: [...new Set(reasonCodes)],
    riskWarnings: [...new Set(warnings)],
    expiresAt,
    marketConfirmationAvailable: marketConfirmation?.available !== false && marketScore !== null,
    marketConfirmationReasonCodes: marketReasons,
    marketConfirmationDetails: normalizeMarketConfirmationDetails(marketConfirmation?.details),
    sourceProfile,
  };
}

function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeMarketConfirmationDetails(details = null) {
  const source = details && typeof details === 'object' ? details : {};
  return {
    currentPrice: source.currentPrice ?? null,
    previousClose: source.previousClose ?? null,
    openPrice: source.openPrice ?? null,
    volume: source.volume ?? null,
    averageVolume: source.averageVolume ?? null,
    bid: source.bid ?? null,
    ask: source.ask ?? null,
    spreadPct: source.spreadPct ?? null,
    liquidity: source.liquidity ?? null,
    ageSeconds: source.ageSeconds ?? null,
    stale: Boolean(source.stale),
    tradable: source.tradable ?? null,
    halted: source.halted ?? null,
    excluded: source.excluded ?? null,
  };
}

module.exports = {
  classifyHotHotCandidate,
};
