const { clamp, nowIso, safeNumber } = require('../util');

function scoreMarketConfirmation(symbol, marketContext = null, options = {}) {
  const context = marketContext && typeof marketContext === 'object' ? marketContext : null;
  if (!context || Object.keys(context).length === 0) {
    return {
      symbol,
      available: false,
      marketConfirmationScore: null,
      reasonCodes: ['market_confirmation_unavailable'],
      riskWarnings: ['market_data_unavailable'],
      details: {
        receivedAt: nowIso(),
      },
    };
  }

  const currentPrice = safeNumber(context.currentPrice ?? context.price ?? context.last ?? context.close, null);
  const previousClose = safeNumber(context.previousClose ?? context.previous_close ?? context.prevClose ?? context.open, null);
  const openPrice = safeNumber(context.openPrice ?? context.open ?? null, null);
  const volume = safeNumber(context.volume ?? context.dayVolume ?? context.v, null);
  const averageVolume = safeNumber(context.averageVolume ?? context.avgVolume ?? context.average_volume ?? context.average_daily_volume, null);
  const bid = safeNumber(context.bid ?? null, null);
  const ask = safeNumber(context.ask ?? null, null);
  const spreadPct = Number.isFinite(bid) && Number.isFinite(ask) && ask > 0
    ? ((ask - bid) / ((ask + bid) / 2)) * 100
    : safeNumber(context.spreadPct ?? context.spread_pct, null);
  const tradable = context.tradable ?? context.isTradable ?? context.is_tradable ?? null;
  const haltStatusText = String(context.halt_status || context.haltStatus || '').trim().toLowerCase();
  const halted = context.halted ?? context.isHalted ?? (haltStatusText === 'halted' ? true : (haltStatusText === 'not_halted' || haltStatusText === 'open' || haltStatusText === 'false' ? false : null));
  const excluded = Boolean(context.excluded ?? context.isExcluded ?? context.banned ?? false);
  const stale = Boolean(context.stale ?? context.marketDataStale ?? false);
  const ageSeconds = safeNumber(context.ageSeconds ?? context.age_seconds ?? null, null);
  const liquidity = safeNumber(context.liquidity ?? (Number.isFinite(volume) && Number.isFinite(currentPrice) ? volume * currentPrice : null), null);
  const enoughData = Number.isFinite(currentPrice) || Number.isFinite(volume) || Number.isFinite(spreadPct);

  if (!enoughData) {
    return {
      symbol,
      available: false,
      marketConfirmationScore: null,
      reasonCodes: ['market_confirmation_unavailable'],
      riskWarnings: ['market_data_unavailable'],
      details: {
        receivedAt: nowIso(),
      },
    };
  }

  const reasonCodes = [];
  const riskWarnings = [];
  let score = 25;

  if (tradable === false) {
    reasonCodes.push('not_tradable');
    score -= 35;
  } else if (tradable === true) {
    reasonCodes.push('tradable_confirmed');
    score += 15;
  }

  if (excluded) {
    reasonCodes.push('excluded_symbol');
    score -= 40;
    riskWarnings.push('excluded_symbol');
  }

  if (halted === true) {
    reasonCodes.push('possible_halt_risk');
    score -= 40;
    riskWarnings.push('possible_halt_risk');
  } else if (halted === false) {
    reasonCodes.push('not_halted');
  } else {
    reasonCodes.push('halt_status_unknown');
  }

  if (stale) {
    reasonCodes.push('stale_market_data');
    score -= 25;
    riskWarnings.push('stale_market_data');
  }

  if (Number.isFinite(currentPrice) && Number.isFinite(previousClose) && previousClose > 0) {
    const movePct = ((currentPrice - previousClose) / previousClose) * 100;
    const accelerationPct = Number.isFinite(openPrice) && openPrice > 0
      ? ((currentPrice - openPrice) / openPrice) * 100
      : movePct;
    if (Math.abs(accelerationPct) >= 2.5 || Math.abs(movePct) >= 3) {
      reasonCodes.push('price_acceleration_confirmed');
      score += 20;
    } else {
      reasonCodes.push('price_acceleration_not_confirmed');
      score += 5;
    }
  }

  if (Number.isFinite(volume) && Number.isFinite(averageVolume) && averageVolume > 0) {
    const volumeRatio = volume / averageVolume;
    if (volumeRatio >= 1.5) {
      reasonCodes.push('volume_confirmed');
      score += 20;
    } else {
      reasonCodes.push('volume_not_confirmed');
      score += 4;
    }
  } else if (Number.isFinite(volume)) {
    if (volume >= 100000) {
      reasonCodes.push('volume_confirmed');
      score += 15;
    } else {
      reasonCodes.push('volume_not_confirmed');
    }
  } else {
    reasonCodes.push('volume_not_confirmed');
  }

  if (Number.isFinite(spreadPct)) {
    if (spreadPct <= (options.maxSpreadPct ?? 1.0)) {
      reasonCodes.push('spread_acceptable');
      score += 10;
    } else {
      reasonCodes.push('spread_too_wide');
      score -= 15;
      riskWarnings.push('spread_too_wide');
    }
  }

  if (Number.isFinite(liquidity)) {
    if (liquidity >= (options.minLiquidity ?? 250000)) {
      score += 10;
    } else {
      score -= 5;
    }
  }

  if (Number.isFinite(ageSeconds)) {
    if (ageSeconds <= (options.maxStalenessSeconds ?? 60)) {
      score += 5;
    } else {
      score -= 15;
      reasonCodes.push('stale_market_data');
    }
  }

  score = clamp(score, 0, 100);
  const available = true;
  if (score >= (options.marketConfirmationMinScore ?? 70)) {
    reasonCodes.push('market_confirmation_passed');
  } else {
    reasonCodes.push('market_confirmation_failed');
  }

  return {
    symbol,
    available,
    marketConfirmationScore: score,
    reasonCodes: [...new Set(reasonCodes)],
    riskWarnings: [...new Set(riskWarnings)],
    details: {
      currentPrice,
      previousClose,
      openPrice,
      volume,
      averageVolume,
      bid,
      ask,
      spreadPct,
      liquidity,
      ageSeconds,
      stale,
      tradable,
      halted,
      excluded,
    },
  };
}

module.exports = {
  scoreMarketConfirmation,
};
