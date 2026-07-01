const { safeNumber } = require('../util');
const { RiskReason, RiskDecision } = require('./constants');
const { normalizePortfolioSymbol } = require('./scanner-checks');

function performPortfolioChecks(
  signalSide, signal, portfolio, config,
  effectiveMaxOpenPositions, effectiveMaxDailyLoss,
  effectiveMaxExposurePerAsset, effectiveMaxExposurePerSector,
  effectiveMaxCryptoExposure, effectiveMaxPositionNotional,
  normalizedSignalSymbol,
) {
  const reasonCodes = [];
  const warnings = [];

  if (!portfolio) reasonCodes.push(RiskReason.PORTFOLIO_STATE_UNAVAILABLE);
  if (!portfolio.available && portfolio.available !== undefined) reasonCodes.push(RiskReason.PORTFOLIO_STATE_UNAVAILABLE);

  if (portfolio.trade_count_today !== undefined && portfolio.trade_count_today >= config.maxTradesPerDay) {
    reasonCodes.push(RiskReason.MAX_TRADES_PER_DAY_EXCEEDED);
  }

  const openPositionsCount = safeNumber(
    portfolio.open_positions_count
      ?? portfolio.open_position_count
      ?? portfolio.positions_open_count
      ?? (Array.isArray(portfolio.open_positions) ? portfolio.open_positions.length : null)
      ?? (Array.isArray(portfolio.positions) ? portfolio.positions.filter((position) => safeNumber(position.qty ?? position.quantity ?? position.qty_available, 0) !== 0).length : null),
    null,
  );
  if (signalSide === 'buy' && Number.isFinite(openPositionsCount) && openPositionsCount >= effectiveMaxOpenPositions) {
    reasonCodes.push(RiskReason.MAX_OPEN_POSITIONS_EXCEEDED);
  }

  const heldSymbols = new Set([
    ...(Array.isArray(portfolio.symbols_held) ? portfolio.symbols_held : []),
    ...(Array.isArray(portfolio.positions) ? portfolio.positions.map((position) => position.symbol) : []),
    ...(Array.isArray(portfolio.open_positions) ? portfolio.open_positions.map((position) => position.symbol) : []),
  ].map(normalizePortfolioSymbol).filter(Boolean));
  const openBuySymbols = new Set([
    ...(Array.isArray(portfolio.symbols_with_open_buy_orders) ? portfolio.symbols_with_open_buy_orders : []),
    ...(Array.isArray(portfolio.open_orders) ? portfolio.open_orders.filter((order) => String(order.side || '').toLowerCase() === 'buy').map((order) => order.symbol) : []),
  ].map(normalizePortfolioSymbol).filter(Boolean));

  const allowScaleIn = Boolean(signal?.allow_scale_in || signal?.allowScaleIn);

  if (signalSide === 'buy' && normalizedSignalSymbol && !allowScaleIn && heldSymbols.has(normalizedSignalSymbol)) {
    reasonCodes.push('EXISTING_POSITION_FOR_SYMBOL');
  }
  if (signalSide === 'buy' && normalizedSignalSymbol && !allowScaleIn && openBuySymbols.has(normalizedSignalSymbol)) {
    reasonCodes.push('OPEN_BUY_ORDER_FOR_SYMBOL');
  }

  if (safeNumber(portfolio.daily_loss, 0) <= -effectiveMaxDailyLoss) reasonCodes.push(RiskReason.MAX_DAILY_LOSS_EXCEEDED);
  const signalSymbol = signal.symbol;
  if (safeNumber(portfolio.position_notional_by_asset?.[signalSymbol], 0) >= effectiveMaxExposurePerAsset) {
    reasonCodes.push(RiskReason.MAX_EXPOSURE_PER_ASSET_EXCEEDED);
  }
  if (safeNumber(portfolio.position_notional, 0) >= effectiveMaxPositionNotional) reasonCodes.push(RiskReason.MAX_POSITION_SIZE_EXCEEDED);
  if (signal.asset_type === 'crypto' && safeNumber(portfolio.crypto_exposure, 0) >= effectiveMaxCryptoExposure) {
    reasonCodes.push(RiskReason.MAX_CRYPTO_EXPOSURE_EXCEEDED);
  }
  if (signal.sector && safeNumber(portfolio.exposure_by_sector?.[signal.sector], 0) >= effectiveMaxExposurePerSector) {
    reasonCodes.push(RiskReason.MAX_EXPOSURE_PER_SECTOR_EXCEEDED);
  }

  return { reasonCodes, warnings };
}

module.exports = { performPortfolioChecks };
