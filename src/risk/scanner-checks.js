const { clamp, safeNumber } = require('../util');
const { RiskReason } = require('./constants');

function normalizePortfolioSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes('/')) return raw;
  if (raw.endsWith('USDT')) return `${raw.slice(0, -4)}/USDT`;
  if (raw.endsWith('USD') && raw.length > 3) return `${raw.slice(0, -3)}/USD`;
  return raw;
}

function performScannerChecks(signal, signalSide, marketContext, config, normalizedSignalSymbol, approvedSymbols, options = {}) {
  const reasonCodes = [];
  const warnings = [];
  const isScannerExitSell = Boolean(options.isScannerExitSell);

  if (signalSide === 'buy' && approvedSymbols.length && normalizedSignalSymbol && !approvedSymbols.includes(normalizedSignalSymbol)) {
    reasonCodes.push('SYMBOL_NOT_APPROVED_FOR_LIVE_MARKET');
  }

  if (!isScannerExitSell && safeNumber(signal.liquidity_score, 100) < config.minLiquidityScore) reasonCodes.push(RiskReason.MIN_LIQUIDITY_NOT_MET);
  if (!isScannerExitSell && safeNumber(signal.volume, marketContext.volume ?? 0) < config.minVolume) reasonCodes.push(RiskReason.MIN_VOLUME_NOT_MET);
  if (!isScannerExitSell && safeNumber(marketContext.spread_slippage_pct, 0) > config.maxSpreadSlippagePct) warnings.push(RiskReason.MAX_SPREAD_SLIPPAGE_EXCEEDED);

  const volatilityThresholdPct = safeNumber(config.volatilityThresholdPct, null);
  if (Number.isFinite(volatilityThresholdPct) && safeNumber(marketContext.volatility_pct, 0) > volatilityThresholdPct) {
    warnings.push(RiskReason.VOLATILITY_THRESHOLD_EXCEEDED);
  }

  if (marketContext.events && marketContext.events.some((event) => event.type === 'earnings_blackout' || event.type === 'macro_blackout')) {
    reasonCodes.push(RiskReason.EVENT_BLACKOUT);
  }

  return { reasonCodes, warnings };
}

module.exports = { performScannerChecks, normalizePortfolioSymbol };
