const { clamp, hashObject, safeNumber } = require('./util');

function normalizeBars(input = []) {
  return (Array.isArray(input) ? input : [])
    .map((bar) => ({
      timestamp: bar?.t || bar?.timestamp || null,
      open: safeNumber(bar?.o ?? bar?.open, null),
      high: safeNumber(bar?.h ?? bar?.high, null),
      low: safeNumber(bar?.l ?? bar?.low, null),
      close: safeNumber(bar?.c ?? bar?.close, null),
      volume: safeNumber(bar?.v ?? bar?.volume, null),
      vwap: safeNumber(bar?.vw ?? bar?.vwap, null),
    }))
    .filter((bar) => bar.timestamp && [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function returnPct(bars, minutes) {
  if (bars.length < minutes + 1) return null;
  const end = bars[bars.length - 1].close;
  const start = bars[bars.length - 1 - minutes].close;
  return start > 0 ? ((end - start) / start) * 100 : null;
}

function ratio(values, predicate) {
  if (!values.length) return null;
  return values.filter(predicate).length / values.length;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function buildIntradayMomentumFeatures(inputBars = [], options = {}) {
  const bars = normalizeBars(inputBars).slice(-Math.max(16, safeNumber(options.lookbackBars, 20)));
  const receivedAt = options.receivedAt || new Date().toISOString();
  const latest = bars[bars.length - 1] || null;
  const latestMs = latest ? Date.parse(latest.timestamp) : Number.NaN;
  const receivedMs = Date.parse(receivedAt);
  const barAgeSeconds = Number.isFinite(latestMs) && Number.isFinite(receivedMs)
    ? Math.max(0, (receivedMs - latestMs) / 1000)
    : null;
  const recentFive = bars.slice(-5);
  const transitions = recentFive.slice(1).map((bar, index) => ({ current: bar, prior: recentFive[index] }));
  const positiveCloseRatio = ratio(transitions, ({ current, prior }) => current.close > prior.close);
  const higherHighRatio = ratio(transitions, ({ current, prior }) => current.high >= prior.high);
  const higherLowRatio = ratio(transitions, ({ current, prior }) => current.low >= prior.low);
  const trendConsistency = average([positiveCloseRatio, higherHighRatio, higherLowRatio]);
  const recentVolumes = bars.slice(-3).map((bar) => bar.volume);
  const priorVolumes = bars.slice(-8, -3).map((bar) => bar.volume);
  const recentAverageVolume = average(recentVolumes);
  const priorAverageVolume = average(priorVolumes);
  const volumeAcceleration = Number.isFinite(recentAverageVolume) && Number.isFinite(priorAverageVolume) && priorAverageVolume > 0
    ? recentAverageVolume / priorAverageVolume
    : null;
  const weightedVolume = bars.reduce((sum, bar) => sum + (Number.isFinite(bar.volume) ? bar.volume : 0), 0);
  const rollingVwap = weightedVolume > 0
    ? bars.reduce((sum, bar) => sum + (Number.isFinite(bar.vwap) ? bar.vwap : bar.close) * (Number.isFinite(bar.volume) ? bar.volume : 0), 0) / weightedVolume
    : average(bars.map((bar) => bar.vwap ?? bar.close));
  const currentPrice = latest?.close ?? null;
  const distanceFromRollingVwapPct = Number.isFinite(currentPrice) && Number.isFinite(rollingVwap) && rollingVwap > 0
    ? ((currentPrice - rollingVwap) / rollingVwap) * 100
    : null;
  const rollingHigh = bars.length ? Math.max(...bars.map((bar) => bar.high)) : null;
  const fadeFromRollingHighPct = Number.isFinite(currentPrice) && Number.isFinite(rollingHigh) && rollingHigh > 0
    ? ((rollingHigh - currentPrice) / rollingHigh) * 100
    : null;
  const oneMinuteReturnPct = returnPct(bars, 1);
  const threeMinuteReturnPct = returnPct(bars, 3);
  const fiveMinuteReturnPct = returnPct(bars, 5);
  const fifteenMinuteReturnPct = returnPct(bars, 15);
  const expectedThreeMinuteFromFifteen = Number.isFinite(fifteenMinuteReturnPct) ? fifteenMinuteReturnPct / 5 : null;
  const accelerationPct = Number.isFinite(threeMinuteReturnPct) && Number.isFinite(expectedThreeMinuteFromFifteen)
    ? threeMinuteReturnPct - expectedThreeMinuteFromFifteen
    : null;
  const minBars = Math.max(6, safeNumber(options.minBars, 8));
  const minThreeMinuteReturnPct = safeNumber(options.minThreeMinuteReturnPct, 0.12);
  const maxThreeMinuteReturnPct = Math.max(minThreeMinuteReturnPct, safeNumber(options.maxThreeMinuteReturnPct, 1.0));
  const minFiveMinuteReturnPct = safeNumber(options.minFiveMinuteReturnPct, 0.20);
  const minOneMinuteReturnPct = safeNumber(options.minOneMinuteReturnPct, 0.03);
  const minFifteenMinuteReturnPct = safeNumber(options.minFifteenMinuteReturnPct, 0.25);
  const minTrendConsistency = clamp(safeNumber(options.minTrendConsistency, 0.55), 0, 1);
  const minVolumeAcceleration = Math.max(0, safeNumber(options.minVolumeAcceleration, 0.9));
  const maxFadeFromHighPct = Math.max(0, safeNumber(options.maxFadeFromHighPct, 0.45));
  const maxBarAgeSeconds = Math.max(1, safeNumber(options.maxBarAgeSeconds, 120));
  const reasonCodes = [];
  if (bars.length < minBars) reasonCodes.push('INTRADAY_MOMENTUM_BARS_INSUFFICIENT');
  if (!Number.isFinite(barAgeSeconds) || barAgeSeconds > maxBarAgeSeconds) reasonCodes.push('INTRADAY_MOMENTUM_BARS_STALE');
  if (!Number.isFinite(oneMinuteReturnPct) || oneMinuteReturnPct < minOneMinuteReturnPct) reasonCodes.push('INTRADAY_ENTRY_MOMENTUM_NOT_UPWARD');
  if (!Number.isFinite(threeMinuteReturnPct) || threeMinuteReturnPct < minThreeMinuteReturnPct) reasonCodes.push('INTRADAY_THREE_MINUTE_MOMENTUM_WEAK');
  if (Number.isFinite(threeMinuteReturnPct) && threeMinuteReturnPct > maxThreeMinuteReturnPct) reasonCodes.push('INTRADAY_MOMENTUM_BURST_OVEREXTENDED');
  if (!Number.isFinite(fiveMinuteReturnPct) || fiveMinuteReturnPct < minFiveMinuteReturnPct) reasonCodes.push('INTRADAY_FIVE_MINUTE_MOMENTUM_WEAK');
  if (Number.isFinite(fifteenMinuteReturnPct) && fifteenMinuteReturnPct < minFifteenMinuteReturnPct) reasonCodes.push('INTRADAY_FIFTEEN_MINUTE_TREND_WEAK');
  if (!Number.isFinite(trendConsistency) || trendConsistency < minTrendConsistency) reasonCodes.push('INTRADAY_TREND_NOT_PERSISTENT');
  if (Number.isFinite(volumeAcceleration) && volumeAcceleration < minVolumeAcceleration) reasonCodes.push('INTRADAY_VOLUME_NOT_EXPANDING');
  if (!Number.isFinite(distanceFromRollingVwapPct) || distanceFromRollingVwapPct < 0) reasonCodes.push('INTRADAY_BELOW_ROLLING_VWAP');
  if (!Number.isFinite(fadeFromRollingHighPct) || fadeFromRollingHighPct > maxFadeFromHighPct) reasonCodes.push('INTRADAY_MOMENTUM_FADED');
  return {
    measured: bars.length >= minBars,
    qualified: reasonCodes.length === 0,
    reason_codes: reasonCodes,
    bar_count: bars.length,
    latest_bar_timestamp: latest?.timestamp || null,
    bar_age_seconds: round(barAgeSeconds, 3),
    one_minute_return_pct: round(oneMinuteReturnPct),
    three_minute_return_pct: round(threeMinuteReturnPct),
    five_minute_return_pct: round(fiveMinuteReturnPct),
    fifteen_minute_return_pct: round(fifteenMinuteReturnPct),
    acceleration_pct: round(accelerationPct),
    trend_consistency: round(trendConsistency),
    higher_high_ratio: round(higherHighRatio),
    higher_low_ratio: round(higherLowRatio),
    positive_close_ratio: round(positiveCloseRatio),
    volume_acceleration: round(volumeAcceleration),
    rolling_vwap: round(rollingVwap, 6),
    distance_from_rolling_vwap_pct: round(distanceFromRollingVwapPct),
    fade_from_rolling_high_pct: round(fadeFromRollingHighPct),
  };
}

function updateMomentumEpisode(previous = null, features = {}, { symbol, receivedAt, maxEpisodeAgeSeconds = 420 } = {}) {
  const now = receivedAt || new Date().toISOString();
  const nowMs = Date.parse(now);
  const startedMs = Date.parse(previous?.started_at || '');
  const expired = previous?.active && Number.isFinite(nowMs) && Number.isFinite(startedMs)
    && (nowMs - startedMs) / 1000 > Math.max(30, safeNumber(maxEpisodeAgeSeconds, 420));
  if (previous?.requires_reset && features.qualified) {
    return {
      ...previous,
      active: false,
      latest_features: features,
      invalidation_reason_codes: previous.invalidation_reason_codes || ['INTRADAY_MOMENTUM_EPISODE_MAX_AGE'],
    };
  }
  if (!features.qualified || expired) {
    return {
      ...(previous || {}),
      active: false,
      requires_reset: Boolean(expired),
      invalidated_at: now,
      invalidation_reason_codes: expired ? ['INTRADAY_MOMENTUM_EPISODE_MAX_AGE'] : features.reason_codes || [],
      latest_features: features,
    };
  }
  if (previous?.active) {
    return { ...previous, active: true, last_confirmed_at: now, latest_features: features };
  }
  const episodeId = hashObject({ symbol: String(symbol || '').toUpperCase(), at: features.latest_bar_timestamp || now }).slice(0, 12);
  return {
    episode_id: episodeId,
    symbol: String(symbol || '').toUpperCase(),
    active: true,
    requires_reset: false,
    started_at: now,
    last_confirmed_at: now,
    invalidated_at: null,
    invalidation_reason_codes: [],
    latest_features: features,
  };
}

module.exports = { normalizeBars, buildIntradayMomentumFeatures, updateMomentumEpisode };
