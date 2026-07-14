const { clamp, safeNumber } = require('../util');

function scoreRegularWatchSymbol(symbol, context = {}, options = {}) {
  const reasonCodes = new Set();
  const riskWarnings = new Set();
  let score = 0;

  const currentPrice = safeNumber(context.currentPrice ?? context.price ?? null, null);
  const previousClose = safeNumber(context.previousClose ?? context.previous_close ?? null, null);
  const openPrice = safeNumber(context.openPrice ?? context.open_price ?? null, null);
  const volume = safeNumber(context.volume ?? null, null);
  const averageVolume = safeNumber(context.averageVolume ?? context.average_volume ?? null, null);
  const bid = safeNumber(context.bid ?? null, null);
  const ask = safeNumber(context.ask ?? null, null);
  const spreadPctValue = safeNumber(context.spreadPct ?? context.spread_pct ?? null, null);
  const spreadPct = Number.isFinite(spreadPctValue)
    ? spreadPctValue
    : Number.isFinite(bid) && Number.isFinite(ask) && ask > 0
      ? ((ask - bid) / ((ask + bid) / 2)) * 100
      : null;
  const movePctValue = safeNumber(context.movePct ?? context.move_pct ?? null, null);
  const movePct = Number.isFinite(movePctValue)
    ? movePctValue
    : Number.isFinite(currentPrice) && Number.isFinite(previousClose) && previousClose > 0
      ? ((currentPrice - previousClose) / previousClose) * 100
      : null;
  const volatilityPctValue = safeNumber(context.volatilityPct ?? context.volatility_pct ?? null, null);
  const volatilityPct = Number.isFinite(volatilityPctValue)
    ? volatilityPctValue
    : Number.isFinite(movePct)
      ? Math.abs(movePct)
      : null;
  const tradable = context.tradable ?? context.isTradable ?? context.tradableStatus === 'tradable';
  const halted = Boolean(context.halted ?? context.isHalted ?? context.haltStatus === 'halted');
  const ageSeconds = safeNumber(context.ageSeconds ?? context.age_seconds ?? null, null);
  const stale = Boolean(context.stale ?? context.marketDataStale ?? (Number.isFinite(ageSeconds) ? ageSeconds > 90 : false));
  const assetStatus = String(context.assetStatus || context.tradableStatus || '').toLowerCase();
  const secRiskBlockScore = safeNumber(context.secRiskBlockScore ?? 0, 0);
  const secCatalystScore = safeNumber(context.secCatalystScore ?? 0, 0);
  const marketConfirmationScore = safeNumber(context.marketConfirmationScore ?? context.marketConfirmation?.score ?? null, null);
  const polygonScore = safeNumber(context.polygonScore ?? context.polygonConfirmationScore ?? null, null);
  const alphaScore = safeNumber(context.alphaVantageScore ?? context.alphaScore ?? null, null);
  const independentlyConfirmed = Number.isFinite(polygonScore) || Number.isFinite(alphaScore);
  const elapsedSessionFraction = resolveElapsedSessionFraction(context.receivedAt ?? context.received_at ?? options.receivedAt);
  let relativeVolume = null;

  if (assetStatus === 'blocked' || tradable === false) {
    reasonCodes.add('not_tradable');
    riskWarnings.add('not_tradable');
    return buildBlockedScore(symbol, {
      score: 0,
      reasonCodes,
      riskWarnings,
      blockedReason: 'not_tradable',
      status: 'blocked',
      context,
      marketConfirmationScore,
    });
  }

  if (halted) {
    reasonCodes.add('halted');
    riskWarnings.add('halted');
    return buildBlockedScore(symbol, {
      score: 0,
      reasonCodes,
      riskWarnings,
      blockedReason: 'halted',
      status: 'blocked',
      context,
      marketConfirmationScore,
    });
  }

  if (Number.isFinite(movePct)) {
    if (movePct >= 8) {
      score += 34;
      reasonCodes.add('very_strong_mover');
    } else if (movePct >= 4) {
      score += 26;
      reasonCodes.add('strong_mover');
    } else if (movePct >= 2) {
      score += 18;
      reasonCodes.add('moving');
    } else if (movePct >= 0.75) {
      score += 8;
      reasonCodes.add('quiet_mover');
    } else if (movePct <= -8) {
      score -= 24;
      reasonCodes.add('sharp_decline_long_block');
      riskWarnings.add('negative_momentum');
    } else if (movePct <= -4) {
      score -= 14;
      reasonCodes.add('declining_long_candidate');
      riskWarnings.add('negative_momentum');
    } else if (movePct < 0) {
      score -= 4;
      reasonCodes.add('negative_move');
    } else {
      score += 3;
      reasonCodes.add('quiet_symbol');
    }
  } else {
    reasonCodes.add('move_unavailable');
  }

  if (Number.isFinite(volatilityPct)) {
    score += movePct >= 0 ? clamp(volatilityPct * 2, 0, 10) : 0;
  }

  if (Number.isFinite(volume) && Number.isFinite(averageVolume) && averageVolume > 0) {
    const comparableVolume = Math.max(averageVolume * elapsedSessionFraction, averageVolume * 0.05);
    const ratio = volume / comparableVolume;
    relativeVolume = ratio;
    if (ratio >= 3) {
      score += 18;
      reasonCodes.add('volume_surging');
    } else if (ratio >= 1.5) {
      score += 14;
      reasonCodes.add('volume_confirmed');
    } else if (ratio >= 1.05) {
      score += 7;
      reasonCodes.add('volume_trending');
    } else {
      score += 1;
      reasonCodes.add('volume_quiet');
    }
  } else if (Number.isFinite(volume)) {
    if (volume >= 2_000_000) {
      score += 16;
      reasonCodes.add('volume_confirmed');
    } else if (volume >= 200_000) {
      score += 8;
      reasonCodes.add('volume_trending');
    } else {
      score += 2;
      reasonCodes.add('volume_quiet');
    }
  } else {
    reasonCodes.add('volume_unavailable');
  }

  if (Number.isFinite(spreadPct)) {
    if (spreadPct <= 0.4) {
      score += 12;
      reasonCodes.add('spread_tight');
    } else if (spreadPct <= 1) {
      score += 6;
      reasonCodes.add('spread_acceptable');
    } else if (spreadPct <= 2) {
      score -= 8;
      riskWarnings.add('wide_spread');
      reasonCodes.add('spread_wide');
    } else {
      score -= 18;
      riskWarnings.add('wide_spread');
      reasonCodes.add('spread_too_wide');
    }
  }

  if (Number.isFinite(marketConfirmationScore)) {
    score += clamp((marketConfirmationScore - 50) * 0.35, 0, 17.5);
    if (marketConfirmationScore >= 70) {
      reasonCodes.add('market_confirmation_passed');
    } else {
      reasonCodes.add('market_confirmation_soft');
    }
  } else if (Number.isFinite(polygonScore) || Number.isFinite(alphaScore)) {
    const fallback = Math.max(Number.isFinite(polygonScore) ? polygonScore : 0, Number.isFinite(alphaScore) ? alphaScore : 0);
    score += clamp((fallback - 45) * 0.25, 0, 12.5);
    reasonCodes.add('secondary_market_confirmation');
  } else {
    reasonCodes.add('market_confirmation_unavailable');
    score -= 4;
  }

  if (Number.isFinite(secCatalystScore) && secCatalystScore > 0) {
    score += clamp(secCatalystScore * 0.3, 0, 12);
    reasonCodes.add('sec_catalyst_support');
  }

  if (Number.isFinite(secRiskBlockScore) && secRiskBlockScore > 0) {
    score -= clamp(secRiskBlockScore, 0, 45);
    reasonCodes.add('sec_risk_present');
    riskWarnings.add('sec_risk_present');
  }

  if (!independentlyConfirmed) {
    reasonCodes.add('independent_confirmation_unavailable');
    riskWarnings.add('single_provider_evidence');
  } else {
    reasonCodes.add('independent_confirmation_present');
  }

  if (stale) {
    score -= 14;
    reasonCodes.add('stale_market_data');
    riskWarnings.add('stale_market_data');
  }

  if (Number.isFinite(openPrice) && Number.isFinite(currentPrice) && openPrice > 0 && currentPrice > 0) {
    const openMovePct = ((currentPrice - openPrice) / openPrice) * 100;
    if (openMovePct >= 2.5) {
      score += 8;
      reasonCodes.add('session_momentum');
    } else if (openMovePct <= -2.5) {
      score -= 6;
      reasonCodes.add('negative_session_momentum');
      riskWarnings.add('negative_momentum');
    }
  }

  if (context.sourceContributors?.length) {
    score += Math.min(8, context.sourceContributors.length * 2);
  }

  score = clamp(Math.round(score), 0, 100);

  if (score >= 80) {
    reasonCodes.add('opportunity_strong');
  } else if (score >= 55) {
    reasonCodes.add('opportunity_watch');
  } else {
    reasonCodes.add('opportunity_quiet');
  }

  return {
    symbol,
    score,
    status: score >= 80 ? 'moving' : score >= 55 ? 'watching' : 'quiet',
    blockedReason: null,
    reasonCodes: [...reasonCodes],
    riskWarnings: [...riskWarnings],
    marketConfirmationScore: Number.isFinite(marketConfirmationScore) ? marketConfirmationScore : null,
    independentlyConfirmed,
    spreadPct: Number.isFinite(spreadPct) ? Number(spreadPct.toFixed(4)) : null,
    movePct: Number.isFinite(movePct) ? Number(movePct.toFixed(4)) : null,
    volatilityPct: Number.isFinite(volatilityPct) ? Number(volatilityPct.toFixed(4)) : null,
    ageSeconds: Number.isFinite(ageSeconds) ? Number(ageSeconds.toFixed(2)) : null,
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    volume: Number.isFinite(volume) ? volume : null,
    averageVolume: Number.isFinite(averageVolume) ? averageVolume : null,
    relativeVolume: Number.isFinite(relativeVolume) ? Number(relativeVolume.toFixed(3)) : null,
    relativeVolumeMethod: Number.isFinite(relativeVolume) ? 'previous_day_time_adjusted' : null,
    bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null,
    sourceContributors: Array.isArray(context.sourceContributors) ? context.sourceContributors.slice() : [],
  };
}

function resolveElapsedSessionFraction(value = null) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return 1;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return clamp(((hour * 60 + minute) - 570) / 390, 0.05, 1);
}

function buildBlockedScore(symbol, { score = 0, reasonCodes = new Set(), riskWarnings = new Set(), blockedReason = 'blocked', status = 'blocked', context = {}, marketConfirmationScore = null } = {}) {
  return {
    symbol,
    score,
    status,
    blockedReason,
    reasonCodes: [...reasonCodes, blockedReason].filter(Boolean),
    riskWarnings: [...riskWarnings],
    marketConfirmationScore: Number.isFinite(marketConfirmationScore) ? marketConfirmationScore : null,
    spreadPct: Number.isFinite(safeNumber(context.spreadPct ?? context.spread_pct ?? null, null)) ? safeNumber(context.spreadPct ?? context.spread_pct ?? null, null) : null,
    movePct: Number.isFinite(safeNumber(context.movePct ?? context.move_pct ?? null, null)) ? safeNumber(context.movePct ?? context.move_pct ?? null, null) : null,
    volatilityPct: Number.isFinite(safeNumber(context.volatilityPct ?? context.volatility_pct ?? null, null)) ? safeNumber(context.volatilityPct ?? context.volatility_pct ?? null, null) : null,
    ageSeconds: Number.isFinite(safeNumber(context.ageSeconds ?? context.age_seconds ?? null, null)) ? safeNumber(context.ageSeconds ?? context.age_seconds ?? null, null) : null,
    currentPrice: Number.isFinite(Number(context.currentPrice)) ? Number(context.currentPrice) : null,
    previousClose: Number.isFinite(Number(context.previousClose)) ? Number(context.previousClose) : null,
    volume: Number.isFinite(Number(context.volume)) ? Number(context.volume) : null,
    averageVolume: Number.isFinite(Number(context.averageVolume)) ? Number(context.averageVolume) : null,
    bid: Number.isFinite(Number(context.bid)) ? Number(context.bid) : null,
    ask: Number.isFinite(Number(context.ask)) ? Number(context.ask) : null,
    sourceContributors: Array.isArray(context.sourceContributors) ? context.sourceContributors.slice() : [],
  };
}

module.exports = {
  scoreRegularWatchSymbol,
};
