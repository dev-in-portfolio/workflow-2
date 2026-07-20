const { clamp, safeNumber } = require('./util');

const SetupClassification = {
  MOMENTUM_CONTINUATION: 'MOMENTUM_CONTINUATION',
  BREAKOUT_CONTINUATION: 'BREAKOUT_CONTINUATION',
  PULLBACK_CONTINUATION: 'PULLBACK_CONTINUATION',
  MEAN_REVERSION: 'MEAN_REVERSION',
  REVERSAL: 'REVERSAL',
  UNCLASSIFIED: 'UNCLASSIFIED',
};

const ReasonCode = {
  ENTRY_OVEREXTENDED_FROM_VWAP: 'ENTRY_OVEREXTENDED_FROM_VWAP',
  MOMENTUM_DECELERATING: 'MOMENTUM_DECELERATING',
  FAILED_BREAKOUT: 'FAILED_BREAKOUT',
  REJECTED_FROM_DAY_HIGH: 'REJECTED_FROM_DAY_HIGH',
  INSUFFICIENT_REWARD_REMAINING: 'INSUFFICIENT_REWARD_REMAINING',
  RELATIVE_VOLUME_TOO_LOW: 'RELATIVE_VOLUME_TOO_LOW',
  SPREAD_TOO_WIDE_FOR_EXPECTED_GAIN: 'SPREAD_TOO_WIDE_FOR_EXPECTED_GAIN',
  RELATIVE_VOLUME_BASELINE_UNAVAILABLE: 'RELATIVE_VOLUME_BASELINE_UNAVAILABLE',
  RELATIVE_VOLUME_SOURCE_MISMATCH: 'RELATIVE_VOLUME_SOURCE_MISMATCH',
  RELATIVE_VOLUME_OUTLIER: 'RELATIVE_VOLUME_OUTLIER',
  SESSION_FRACTION_UNAVAILABLE: 'SESSION_FRACTION_UNAVAILABLE',
  INTRADAY_MOMENTUM_NOT_QUALIFIED: 'INTRADAY_MOMENTUM_NOT_QUALIFIED',
};

function buildSelectionV2Score({
  symbol,
  snapshot = {},
  latestQuote = {},
  currentPrice,
  previousClose,
  spreadPct = 0,
  receivedAt = new Date().toISOString(),
  structureStop = null,
  regularWatchEntry = null,
  priorityOverride = null,
  options = {},
} = {}) {
  const features = buildMarketFeatures({
    snapshot,
    latestQuote,
    currentPrice,
    previousClose,
    spreadPct,
    receivedAt,
    structureStop,
  });
  const setup = classifySetup(features);
  const reasonCodes = new Set(setup.reason_codes || []);
  const penalties = buildPenalties(features, options);
  for (const reason of penalties.reason_codes) reasonCodes.add(reason);

  const trendQualityScore = scoreTrendQuality(features, setup.setup_classification);
  const momentumScore = scoreMomentum(features, setup.setup_classification);
  const relativeVolumeScore = scoreRelativeVolume(features);
  const liquidityScore = scoreLiquidity(features);
  const structureScore = scoreStructure(features, setup.setup_classification);
  const catalystScore = scoreCatalyst(regularWatchEntry);
  const rewardRiskScore = scoreRewardRisk(features);
  const freshnessScore = scoreFreshness(features);
  const marketScore = trendQualityScore
    + momentumScore
    + relativeVolumeScore
    + liquidityScore
    + structureScore
    + catalystScore
    + rewardRiskScore
    + freshnessScore;

  const regularWatchBonus = buildBoundedRegularWatchBonus(regularWatchEntry, options);
  const priorityOverrideBonus = buildBoundedPriorityOverrideBonus({
    priorityOverride,
    features,
    setup,
    options,
  });
  const totalPenalty = penalties.overextension_penalty
    + penalties.spread_penalty
    + penalties.reversal_penalty
    + penalties.staleness_penalty
    + penalties.reward_risk_penalty;
  const finalOpportunityScore = clamp(
    marketScore + regularWatchBonus.bonus + priorityOverrideBonus.bonus - totalPenalty,
    0,
    100,
  );
  const qualified = Boolean(
    Number.isFinite(features.current_price)
    && features.current_price > 0
    && Number.isFinite(features.previous_close)
    && features.previous_close > 0
    && features.spread_pct <= safeNumber(options.selectionV2MaxSpreadPct, 2.5)
    && (features.relative_volume_available === false || features.relative_volume >= safeNumber(options.selectionV2MinRelativeVolume, 0.25))
    && features.freshness_score >= safeNumber(options.selectionV2MinFreshnessScore, 35)
    && (options.intradayMomentumRequired !== true || features.intraday_momentum_qualified === true)
    && !penalties.hard_block,
  );

  if (!qualified) reasonCodes.add('SELECTION_V2_QUALIFICATION_FAILED');

  return {
    version: '2026-07-07.selection-v2.shadow.1',
    symbol: String(symbol || '').toUpperCase(),
    shadow_only: true,
    qualified,
    setup_classification: setup.setup_classification,
    setup_reason_codes: setup.reason_codes,
    final_opportunity_score: roundScore(finalOpportunityScore),
    market_score: roundScore(marketScore),
    components: {
      trend_quality_score: roundScore(trendQualityScore),
      momentum_score: roundScore(momentumScore),
      relative_volume_score: roundScore(relativeVolumeScore),
      liquidity_score: roundScore(liquidityScore),
      structure_score: roundScore(structureScore),
      catalyst_score: roundScore(catalystScore),
      reward_risk_score: roundScore(rewardRiskScore),
      freshness_score: roundScore(freshnessScore),
    },
    penalties: {
      overextension_penalty: roundScore(penalties.overextension_penalty),
      spread_penalty: roundScore(penalties.spread_penalty),
      reversal_penalty: roundScore(penalties.reversal_penalty),
      staleness_penalty: roundScore(penalties.staleness_penalty),
      reward_risk_penalty: roundScore(penalties.reward_risk_penalty),
    },
    bonuses: {
      regular_watch_bonus: regularWatchBonus,
      priority_override_bonus: priorityOverrideBonus,
    },
    features,
    reason_codes: [...reasonCodes],
  };
}

function buildMarketFeatures({
  snapshot = {},
  latestQuote = {},
  currentPrice,
  previousClose,
  spreadPct = 0,
  receivedAt = new Date().toISOString(),
  structureStop = null,
} = {}) {
  const price = safeNumber(currentPrice, null);
  const prevClose = safeNumber(previousClose, null);
  const minuteBar = snapshot.minuteBar || snapshot.minute_bar || {};
  const dailyBar = snapshot.dailyBar || snapshot.daily_bar || {};
  const prevDailyBar = snapshot.prevDailyBar || snapshot.prev_daily_bar || {};
  const open = safeNumber(dailyBar.o ?? dailyBar.open ?? prevClose, prevClose);
  const high = safeNumber(dailyBar.h ?? dailyBar.high ?? minuteBar.h ?? minuteBar.high ?? price, price);
  const low = safeNumber(dailyBar.l ?? dailyBar.low ?? minuteBar.l ?? minuteBar.low ?? price, price);
  const minuteOpen = safeNumber(minuteBar.o ?? minuteBar.open ?? price, price);
  const minuteHigh = safeNumber(minuteBar.h ?? minuteBar.high ?? price, price);
  const minuteLow = safeNumber(minuteBar.l ?? minuteBar.low ?? price, price);
  const minuteClose = safeNumber(minuteBar.c ?? minuteBar.close ?? price, price);
  const vwap = safeNumber(minuteBar.vw ?? minuteBar.vwap ?? dailyBar.vw ?? dailyBar.vwap ?? snapshot.vwap ?? null, null);
  const currentVolume = safeNumber(dailyBar.v ?? dailyBar.volume ?? snapshot.volume ?? minuteBar.v ?? 0, 0);
  const currentVolumeSource = Number.isFinite(safeNumber(dailyBar.v ?? dailyBar.volume ?? null, null))
    ? 'current_day_cumulative_volume'
    : Number.isFinite(safeNumber(snapshot.volume ?? null, null))
      ? 'snapshot_volume'
      : Number.isFinite(safeNumber(minuteBar.v ?? minuteBar.volume ?? null, null))
        ? 'one_minute_bar_volume'
        : 'unavailable';
  const minuteVolume = safeNumber(minuteBar.v ?? minuteBar.volume ?? 0, 0);
  const explicitAverageVolume = safeNumber(snapshot.averageVolume ?? snapshot.average_volume ?? null, null);
  const previousDayVolume = safeNumber(prevDailyBar.v ?? prevDailyBar.volume ?? null, null);
  const averageVolume = Number.isFinite(explicitAverageVolume) ? explicitAverageVolume : previousDayVolume;
  const baselineVolumeSource = Number.isFinite(explicitAverageVolume)
    ? 'average_daily_volume'
    : Number.isFinite(previousDayVolume)
      ? 'previous_day_full_volume'
      : 'unavailable';
  const elapsedFraction = estimateSessionElapsedFraction(receivedAt);
  const normalComparableVolume = Number.isFinite(averageVolume) && averageVolume > 0
    ? Math.max(averageVolume * elapsedFraction, averageVolume * 0.03)
    : null;
  const relativeVolume = Number.isFinite(normalComparableVolume) && normalComparableVolume > 0
    ? currentVolume / normalComparableVolume
    : null;
  const relativeVolumeAvailable = Number.isFinite(relativeVolume);
  const relativeVolumeMethod = relativeVolumeAvailable
    ? baselineVolumeSource === 'average_daily_volume'
      ? 'average_daily_volume_time_adjusted'
      : 'previous_day_time_adjusted_approximation'
    : 'unavailable';
  const signedMovePct = Number.isFinite(price) && Number.isFinite(prevClose) && prevClose > 0
    ? ((price - prevClose) / prevClose) * 100
    : null;
  const gapPct = Number.isFinite(open) && Number.isFinite(prevClose) && prevClose > 0
    ? ((open - prevClose) / prevClose) * 100
    : null;
  const oneMinuteReturnPct = Number.isFinite(minuteOpen) && minuteOpen > 0
    ? ((minuteClose - minuteOpen) / minuteOpen) * 100
    : null;
  const range = Number.isFinite(high) && Number.isFinite(low) ? Math.max(0, high - low) : 0;
  const positionWithinRangePct = range > 0 && Number.isFinite(price)
    ? ((price - low) / range) * 100
    : 50;
  const distanceFromHighPct = Number.isFinite(price) && Number.isFinite(high) && high > 0
    ? ((high - price) / high) * 100
    : 0;
  const distanceFromLowPct = Number.isFinite(price) && Number.isFinite(low) && low > 0
    ? ((price - low) / low) * 100
    : 0;
  const distanceFromVwapPct = Number.isFinite(price) && Number.isFinite(vwap) && vwap > 0
    ? ((price - vwap) / vwap) * 100
    : null;
  const minuteRange = Number.isFinite(minuteHigh) && Number.isFinite(minuteLow) ? Math.max(0, minuteHigh - minuteLow) : 0;
  const minuteCloseLocationPct = minuteRange > 0 && Number.isFinite(minuteClose)
    ? ((minuteClose - minuteLow) / minuteRange) * 100
    : positionWithinRangePct;
  const quoteAgeSeconds = ageSeconds(latestQuote.t || latestQuote.timestamp || snapshot.latestTrade?.t || minuteBar.t || receivedAt, receivedAt);
  const barAgeSeconds = ageSeconds(minuteBar.t || minuteBar.timestamp || receivedAt, receivedAt);
  const freshnessScore = clamp(100 - Math.max(quoteAgeSeconds || 0, barAgeSeconds || 0) / 3, 0, 100);
  const stopDistance = safeNumber(structureStop?.stop_distance ?? null, null);
  const targetDistance = Number.isFinite(stopDistance) ? Math.max(stopDistance * 1.8, price * 0.02) : null;
  const rewardRiskRatio = Number.isFinite(stopDistance) && stopDistance > 0 && Number.isFinite(targetDistance)
    ? targetDistance / stopDistance
    : null;
  const intraday = snapshot.intradayMomentum || snapshot.intraday_momentum || null;
  const episode = snapshot.momentumEpisode || snapshot.momentum_episode || null;

  return {
    current_price: roundScore(price),
    previous_close: roundScore(prevClose),
    signed_move_pct: roundScore(signedMovePct),
    absolute_move_pct: roundScore(Math.abs(safeNumber(signedMovePct, 0))),
    gap_pct: roundScore(gapPct),
    distance_from_vwap_pct: Number.isFinite(distanceFromVwapPct) ? roundScore(distanceFromVwapPct) : null,
    distance_from_intraday_high_pct: roundScore(distanceFromHighPct),
    distance_from_intraday_low_pct: roundScore(distanceFromLowPct),
    position_within_daily_range_pct: roundScore(positionWithinRangePct),
    one_minute_return_pct: Number.isFinite(safeNumber(intraday?.one_minute_return_pct, null))
      ? roundScore(intraday.one_minute_return_pct)
      : (Number.isFinite(oneMinuteReturnPct) ? roundScore(oneMinuteReturnPct) : null),
    three_minute_return_pct: roundScore(intraday?.three_minute_return_pct),
    five_minute_return_pct: roundScore(intraday?.five_minute_return_pct),
    fifteen_minute_return_pct: roundScore(intraday?.fifteen_minute_return_pct),
    momentum_vs_daily_move_heuristic: Number.isFinite(oneMinuteReturnPct) && Number.isFinite(signedMovePct)
      ? roundScore(oneMinuteReturnPct - (signedMovePct / 20))
      : null,
    momentum_acceleration_pct: roundScore(intraday?.acceleration_pct),
    momentum_data_quality: intraday?.measured ? 'rolling_minute_bars' : 'single_bar_heuristic',
    momentum_bar_count: intraday?.bar_count ?? (Number.isFinite(oneMinuteReturnPct) ? 1 : 0),
    intraday_momentum_measured: Boolean(intraday?.measured),
    intraday_momentum_qualified: Boolean(intraday?.qualified && episode?.active),
    intraday_momentum_reason_codes: Array.isArray(intraday?.reason_codes) ? intraday.reason_codes : [],
    momentum_episode_id: episode?.active ? episode.episode_id || null : null,
    momentum_episode_started_at: episode?.active ? episode.started_at || null : null,
    trend_consistency_score: intraday?.measured
      ? roundScore(clamp(safeNumber(intraday?.trend_consistency, 0) * 100, 0, 100))
      : roundScore(clamp((positionWithinRangePct - 40) * 1.25 + safeNumber(oneMinuteReturnPct, 0) * 10, 0, 100)),
    volume_acceleration: roundScore(intraday?.volume_acceleration),
    distance_from_rolling_vwap_pct: roundScore(intraday?.distance_from_rolling_vwap_pct),
    fade_from_rolling_high_pct: roundScore(intraday?.fade_from_rolling_high_pct),
    reversal_from_peak_pct: roundScore(distanceFromHighPct),
    pullback_depth_pct: Number.isFinite(distanceFromHighPct) ? roundScore(distanceFromHighPct) : null,
    current_volume: currentVolume,
    current_volume_source: currentVolumeSource,
    minute_volume: minuteVolume,
    average_volume: Number.isFinite(averageVolume) ? averageVolume : null,
    baseline_volume_source: baselineVolumeSource,
    elapsed_session_fraction: roundScore(elapsedFraction),
    normal_comparable_volume: Number.isFinite(normalComparableVolume) ? roundScore(normalComparableVolume) : null,
    relative_volume: relativeVolumeAvailable ? roundScore(relativeVolume) : null,
    relative_volume_available: relativeVolumeAvailable,
    relative_volume_method: relativeVolumeMethod,
    relative_volume_approximation: baselineVolumeSource === 'previous_day_full_volume',
    dollar_volume: Number.isFinite(price) ? roundScore(currentVolume * price) : null,
    spread_pct: roundScore(spreadPct),
    estimated_slippage_pct: roundScore(Math.max(0, safeNumber(spreadPct, 0)) / 2),
    minute_close_location_pct: roundScore(minuteCloseLocationPct),
    stop_distance: Number.isFinite(stopDistance) ? roundScore(stopDistance) : null,
    target_distance: Number.isFinite(targetDistance) ? roundScore(targetDistance) : null,
    expected_reward_risk: Number.isFinite(rewardRiskRatio) ? roundScore(rewardRiskRatio) : null,
    quote_age_seconds: Number.isFinite(quoteAgeSeconds) ? quoteAgeSeconds : null,
    bar_age_seconds: Number.isFinite(barAgeSeconds) ? barAgeSeconds : null,
    freshness_score: roundScore(freshnessScore),
  };
}

function classifySetup(features = {}) {
  const move = safeNumber(features.signed_move_pct, 0);
  const oneMinute = safeNumber(features.one_minute_return_pct, 0);
  const rangePosition = safeNumber(features.position_within_daily_range_pct, 50);
  const highDistance = safeNumber(features.distance_from_intraday_high_pct, 0);
  const vwapDistance = safeNumber(features.distance_from_vwap_pct, 0);
  const relativeVolume = safeNumber(features.relative_volume, 1);
  const reasonCodes = [];

  if (features.intraday_momentum_qualified === true) {
    reasonCodes.push('INTRADAY_MOMENTUM_EPISODE_CONFIRMED');
    return { setup_classification: SetupClassification.MOMENTUM_CONTINUATION, reason_codes: reasonCodes };
  }

  if (move >= 1.5 && highDistance <= 1.2 && rangePosition >= 75 && oneMinute >= 0) {
    reasonCodes.push('BREAKOUT_CONFIRMED');
    return { setup_classification: SetupClassification.BREAKOUT_CONTINUATION, reason_codes: reasonCodes };
  }
  if (move > 0 && rangePosition >= 60 && oneMinute >= 0 && relativeVolume >= 0.8) {
    reasonCodes.push('MOMENTUM_CONTINUATION_CONFIRMED');
    return { setup_classification: SetupClassification.MOMENTUM_CONTINUATION, reason_codes: reasonCodes };
  }
  if (move > 0 && highDistance >= 1 && highDistance <= 5 && oneMinute > 0 && vwapDistance >= -0.5) {
    reasonCodes.push('PULLBACK_RECLAIM_CONFIRMED');
    return { setup_classification: SetupClassification.PULLBACK_CONTINUATION, reason_codes: reasonCodes };
  }
  if (move <= -2 && oneMinute > 0 && rangePosition >= 35) {
    reasonCodes.push('OVERSOLD_STABILIZATION_DETECTED');
    return { setup_classification: SetupClassification.MEAN_REVERSION, reason_codes: reasonCodes };
  }
  if (move < 0 && oneMinute > 0) {
    reasonCodes.push('REVERSAL_ATTEMPT_DETECTED');
    return { setup_classification: SetupClassification.REVERSAL, reason_codes: reasonCodes };
  }
  return { setup_classification: SetupClassification.UNCLASSIFIED, reason_codes: ['SETUP_UNCLASSIFIED'] };
}

function buildPenalties(features = {}, options = {}) {
  const reasonCodes = [];
  const vwapDistance = safeNumber(features.distance_from_vwap_pct, 0);
  const highDistance = safeNumber(features.distance_from_intraday_high_pct, 0);
  const spreadPct = safeNumber(features.spread_pct, 0);
  const relativeVolume = safeNumber(features.relative_volume, 1);
  const oneMinute = safeNumber(features.one_minute_return_pct, 0);
  const move = safeNumber(features.signed_move_pct, 0);
  const rewardRisk = safeNumber(features.expected_reward_risk, null);
  const overextensionLimit = safeNumber(options.selectionV2MaxVwapExtensionPct, 7);
  const overextensionPenalty = Math.max(0, vwapDistance - overextensionLimit) * 3;
  if (overextensionPenalty > 0) reasonCodes.push(ReasonCode.ENTRY_OVEREXTENDED_FROM_VWAP);
  const reversalPenalty = Math.max(0, highDistance - 2) * 4 + (move > 3 && oneMinute < 0 ? 12 : 0);
  if (move > 3 && oneMinute < 0) reasonCodes.push(ReasonCode.MOMENTUM_DECELERATING);
  if (highDistance > 4 && move > 0) reasonCodes.push(ReasonCode.REJECTED_FROM_DAY_HIGH);
  const spreadPenalty = Math.max(0, spreadPct - safeNumber(options.selectionV2SpreadPenaltyThresholdPct, 0.75)) * 10;
  if (spreadPct > safeNumber(options.selectionV2MaxSpreadPct, 2.5)) reasonCodes.push(ReasonCode.SPREAD_TOO_WIDE_FOR_EXPECTED_GAIN);
  const stalenessPenalty = Math.max(0, 70 - safeNumber(features.freshness_score, 100)) * 0.5;
  const rewardRiskPenalty = Number.isFinite(rewardRisk) && rewardRisk < 1.4 ? (1.4 - rewardRisk) * 15 : 0;
  if (Number.isFinite(rewardRisk) && rewardRisk < 1.4) reasonCodes.push(ReasonCode.INSUFFICIENT_REWARD_REMAINING);
  if (features.relative_volume_available === false) {
    reasonCodes.push(ReasonCode.RELATIVE_VOLUME_BASELINE_UNAVAILABLE);
  } else if (relativeVolume < safeNumber(options.selectionV2MinRelativeVolume, 0.25)) {
    reasonCodes.push(ReasonCode.RELATIVE_VOLUME_TOO_LOW);
  }
  if (Number.isFinite(relativeVolume) && relativeVolume > 50) reasonCodes.push(ReasonCode.RELATIVE_VOLUME_OUTLIER);
  if (options.intradayMomentumRequired === true && features.intraday_momentum_qualified !== true) {
    reasonCodes.push(ReasonCode.INTRADAY_MOMENTUM_NOT_QUALIFIED);
    for (const reason of features.intraday_momentum_reason_codes || []) reasonCodes.push(reason);
  }

  return {
    overextension_penalty: overextensionPenalty,
    spread_penalty: spreadPenalty,
    reversal_penalty: reversalPenalty,
    staleness_penalty: stalenessPenalty,
    reward_risk_penalty: rewardRiskPenalty,
    hard_block: spreadPct > safeNumber(options.selectionV2HardBlockSpreadPct, 5),
    reason_codes: reasonCodes,
  };
}

function scoreTrendQuality(features, setupClassification) {
  const move = safeNumber(features.signed_move_pct, 0);
  const rangePosition = safeNumber(features.position_within_daily_range_pct, 50);
  if (setupClassification === SetupClassification.MEAN_REVERSION || setupClassification === SetupClassification.REVERSAL) {
    return clamp(8 + rangePosition * 0.08 + Math.max(0, -move) * 0.8, 0, 15);
  }
  return clamp(5 + Math.max(0, move) * 1.2 + Math.max(0, rangePosition - 50) * 0.12, 0, 18);
}

function scoreMomentum(features, setupClassification) {
  const oneMinute = safeNumber(features.one_minute_return_pct, 0);
  const heuristic = safeNumber(features.momentum_vs_daily_move_heuristic, 0);
  const base = setupClassification === SetupClassification.UNCLASSIFIED ? 2 : 6;
  if (features.momentum_data_quality === 'rolling_minute_bars') {
    const threeMinute = safeNumber(features.three_minute_return_pct, 0);
    const fiveMinute = safeNumber(features.five_minute_return_pct, 0);
    const acceleration = safeNumber(features.momentum_acceleration_pct, 0);
    const consistency = safeNumber(features.trend_consistency_score, 0) / 100;
    const volumeAcceleration = safeNumber(features.volume_acceleration, 1);
    return clamp(3 + Math.max(0, oneMinute) * 5 + Math.max(0, threeMinute) * 10 + Math.max(0, fiveMinute) * 5
      + Math.max(0, acceleration) * 4 + consistency * 5 + Math.max(0, volumeAcceleration - 1) * 2, 0, 18);
  }
  return clamp(base + Math.max(0, oneMinute) * 12 + Math.max(0, heuristic) * 2, 0, 18);
}

function scoreRelativeVolume(features) {
  if (features.relative_volume_available === false) return 0;
  const relativeVolume = safeNumber(features.relative_volume, null);
  if (!Number.isFinite(relativeVolume)) return 0;
  return clamp(4 + Math.log10(Math.max(0.1, relativeVolume)) * 12, 0, 16);
}

function scoreLiquidity(features) {
  const dollarVolume = safeNumber(features.dollar_volume, 0);
  const spreadPct = safeNumber(features.spread_pct, 0);
  return clamp(Math.log10(Math.max(10_000, dollarVolume)) * 2 - spreadPct * 2, 0, 14);
}

function scoreStructure(features, setupClassification) {
  const rangePosition = safeNumber(features.position_within_daily_range_pct, 50);
  const highDistance = safeNumber(features.distance_from_intraday_high_pct, 0);
  if (setupClassification === SetupClassification.BREAKOUT_CONTINUATION) {
    return clamp(14 - highDistance * 2, 0, 16);
  }
  if (setupClassification === SetupClassification.PULLBACK_CONTINUATION) {
    return clamp(8 + Math.min(highDistance, 4), 0, 14);
  }
  return clamp((rangePosition - 35) * 0.18, 0, 12);
}

function scoreCatalyst(regularWatchEntry = null) {
  return clamp(safeNumber(regularWatchEntry?.secCatalystScore ?? 0, 0) * 0.12, 0, 6);
}

function scoreRewardRisk(features) {
  const ratio = safeNumber(features.expected_reward_risk, 1.5);
  return clamp(ratio * 4, 0, 10);
}

function scoreFreshness(features) {
  return clamp(safeNumber(features.freshness_score, 100) * 0.1, 0, 10);
}

function buildBoundedRegularWatchBonus(regularWatchEntry = null, options = {}) {
  const rawScore = safeNumber(regularWatchEntry?.score, null);
  const maxBonus = Math.max(0, safeNumber(options.selectionV2RegularWatchMaxBonus, 12));
  const ageSeconds = safeNumber(regularWatchEntry?.ageSeconds ?? regularWatchEntry?.age_seconds ?? null, null);
  const stale = Boolean(regularWatchEntry?.stale || (Number.isFinite(ageSeconds) && ageSeconds > safeNumber(options.selectionV2RegularWatchMaxAgeSeconds, 180)));
  const normalized = Number.isFinite(rawScore) ? clamp((rawScore - 50) / 50, 0, 1) : 0;
  const bonus = stale ? 0 : normalized * maxBonus;
  return {
    applied: bonus > 0,
    raw_score: Number.isFinite(rawScore) ? rawScore : null,
    max_bonus: maxBonus,
    bonus: roundScore(bonus),
    stale,
    source_freshness_seconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
  };
}

function buildBoundedPriorityOverrideBonus({ priorityOverride = null, features = {}, setup = {}, options = {} } = {}) {
  const eligible = Boolean(priorityOverride?.eligible);
  const appliedToLegacyRank = Boolean(priorityOverride?.legacy_applied);
  const maxBonus = Math.max(0, safeNumber(options.selectionV2PriorityOverrideMaxBonus, 15));
  const marketConfirmed = Boolean(
    setup?.setup_classification
    && setup.setup_classification !== SetupClassification.UNCLASSIFIED
    && safeNumber(features.spread_pct, 99) <= safeNumber(options.selectionV2MaxSpreadPct, 2.5)
    && features.relative_volume_available !== false
    && safeNumber(features.relative_volume, 0) >= safeNumber(options.selectionV2MinRelativeVolume, 0.25),
  );
  const bonus = eligible && marketConfirmed ? maxBonus : 0;
  return {
    eligible,
    legacy_applied: appliedToLegacyRank,
    market_confirmed: marketConfirmed,
    max_bonus: maxBonus,
    bonus: roundScore(bonus),
    blocked_reason: eligible && !marketConfirmed ? 'PRIORITY_OVERRIDE_MARKET_QUALITY_NOT_CONFIRMED' : null,
  };
}

function estimateSessionElapsedFraction(receivedAt) {
  const date = new Date(receivedAt);
  if (!Number.isFinite(date.getTime())) return 0.5;
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const easternMinutesApprox = utcMinutes - 4 * 60;
  const minutesSinceOpen = easternMinutesApprox - (9 * 60 + 30);
  return clamp(minutesSinceOpen / 390, 0.03, 1);
}

function ageSeconds(timestamp, receivedAt) {
  const then = new Date(timestamp).getTime();
  const now = new Date(receivedAt).getTime();
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.round((now - then) / 1000));
}

function roundScore(value) {
  const numeric = safeNumber(value, null);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(3)) : null;
}

module.exports = {
  SetupClassification,
  ReasonCode,
  buildSelectionV2Score,
  buildMarketFeatures,
  classifySetup,
  buildBoundedRegularWatchBonus,
  buildBoundedPriorityOverrideBonus,
};
