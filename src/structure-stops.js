const { safeNumber } = require('./util');

function roundEquityPrice(value) {
  return Number(Math.max(0.01, value).toFixed(4));
}

function positiveNumber(value, fallback = null) {
  const parsed = safeNumber(value, fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function calculateStructureAwareStop(options = {}) {
  const symbol = String(options.symbol || '').trim().toUpperCase() || null;
  const side = String(options.side || 'buy').trim().toLowerCase();
  const price = positiveNumber(options.price, null);
  const marketData = options.marketData || {};
  const minDistance = Math.max(0.01, safeNumber(options.minStopDistanceDollars, 0.01));
  const maxDistance = positiveNumber(options.maxStopDistanceDollars, Number.POSITIVE_INFINITY);
  const fixedStopDollars = positiveNumber(options.fixedStopDollars, null);
  const spreadPct = Math.max(0, safeNumber(options.spreadPct ?? marketData.spread_pct, 0));
  const spreadDistance = price ? price * (spreadPct / 100) : 0;
  const minimumDistance = Math.max(minDistance, spreadDistance);

  const candidates = [];
  if (!price) {
    return {
      accepted: false,
      symbol,
      side,
      method: null,
      stop_price: null,
      stop_distance: null,
      reason_codes: ['STRUCTURE_STOP_PRICE_UNAVAILABLE'],
      candidates,
    };
  }

  const swingLow = firstPositive(
    marketData.recent_swing_low,
    marketData.swing_low,
    marketData.support_level,
    marketData.minute_low,
    marketData.low_price,
    marketData.minuteBar?.l,
    marketData.dailyBar?.l,
  );
  const swingHigh = firstPositive(
    marketData.recent_swing_high,
    marketData.swing_high,
    marketData.resistance_level,
    marketData.minute_high,
    marketData.high_price,
    marketData.minuteBar?.h,
    marketData.dailyBar?.h,
  );

  if (side === 'buy' && swingLow) {
    candidates.push(buildCandidate('swing_low', price, swingLow, side, minimumDistance, maxDistance));
  }
  if (side === 'sell' && swingHigh) {
    candidates.push(buildCandidate('swing_high', price, swingHigh, side, minimumDistance, maxDistance));
  }

  if (fixedStopDollars) {
    const stopPrice = side === 'sell' ? price + fixedStopDollars : price - fixedStopDollars;
    candidates.push(buildCandidate('fixed_dollar', price, stopPrice, side, minimumDistance, maxDistance));
  }

  const fallbackDistance = clampDistance(minimumDistance, maxDistance);
  const fallbackStop = side === 'sell' ? price + fallbackDistance : price - fallbackDistance;
  candidates.push(buildCandidate('safe_fallback', price, fallbackStop, side, minimumDistance, maxDistance));

  const selected = candidates.find((candidate) => candidate.accepted) || candidates[candidates.length - 1];
  return {
    accepted: Boolean(selected?.accepted),
    symbol,
    side,
    method: selected?.method || null,
    stop_price: selected?.stop_price || null,
    stop_distance: selected?.stop_distance || null,
    minimum_stop_distance: Number(minimumDistance.toFixed(6)),
    maximum_stop_distance: Number.isFinite(maxDistance) ? Number(maxDistance.toFixed(6)) : null,
    spread_distance: Number(spreadDistance.toFixed(6)),
    reason_codes: selected?.accepted ? [] : (selected?.reason_codes || ['STRUCTURE_STOP_UNAVAILABLE']),
    candidates,
  };
}

function buildCandidate(method, price, stopPrice, side, minDistance, maxDistance) {
  const reasons = [];
  const distance = Math.abs(price - stopPrice);
  if (side === 'buy' && stopPrice >= price) reasons.push('STRUCTURE_STOP_NOT_BELOW_ENTRY');
  if (side === 'sell' && stopPrice <= price) reasons.push('STRUCTURE_STOP_NOT_ABOVE_ENTRY');
  if (distance < minDistance) reasons.push('STRUCTURE_STOP_DISTANCE_TOO_SMALL');
  if (Number.isFinite(maxDistance) && distance > maxDistance) reasons.push('STRUCTURE_STOP_DISTANCE_TOO_LARGE');
  return {
    method,
    stop_price: roundEquityPrice(stopPrice),
    stop_distance: Number(distance.toFixed(6)),
    accepted: reasons.length === 0,
    reason_codes: reasons,
  };
}

function clampDistance(minDistance, maxDistance) {
  if (Number.isFinite(maxDistance)) return Math.min(Math.max(minDistance, 0.01), maxDistance);
  return Math.max(minDistance, 0.01);
}

function firstPositive(...values) {
  for (const value of values) {
    const parsed = positiveNumber(value, null);
    if (parsed) return parsed;
  }
  return null;
}

module.exports = {
  calculateStructureAwareStop,
};
