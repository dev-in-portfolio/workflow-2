const { clamp, hashObject, nowIso, safeNumber } = require('./util');
const { buildProviderConfirmationFromContext } = require('./market-data');
const { calibrationBucketForConfidence } = require('./paper-outcomes');

const RiskDecision = {
  APPROVED_FOR_PAPER: 'APPROVED_FOR_PAPER',
  NEEDS_HUMAN_REVIEW: 'NEEDS_HUMAN_REVIEW',
  ALERT_ONLY: 'ALERT_ONLY',
  BLOCKED: 'BLOCKED',
};

const RiskReason = {
  KILL_SWITCH_ENABLED: 'KILL_SWITCH_ENABLED',
  MAX_POSITION_SIZE_EXCEEDED: 'MAX_POSITION_SIZE_EXCEEDED',
  MAX_OPEN_POSITIONS_EXCEEDED: 'MAX_OPEN_POSITIONS_EXCEEDED',
  MAX_DAILY_LOSS_EXCEEDED: 'MAX_DAILY_LOSS_EXCEEDED',
  MAX_TRADES_PER_DAY_EXCEEDED: 'MAX_TRADES_PER_DAY_EXCEEDED',
  MAX_EXPOSURE_PER_ASSET_EXCEEDED: 'MAX_EXPOSURE_PER_ASSET_EXCEEDED',
  MAX_EXPOSURE_PER_SECTOR_EXCEEDED: 'MAX_EXPOSURE_PER_SECTOR_EXCEEDED',
  MAX_CRYPTO_EXPOSURE_EXCEEDED: 'MAX_CRYPTO_EXPOSURE_EXCEEDED',
  MIN_LIQUIDITY_NOT_MET: 'MIN_LIQUIDITY_NOT_MET',
  MIN_VOLUME_NOT_MET: 'MIN_VOLUME_NOT_MET',
  MAX_SPREAD_SLIPPAGE_EXCEEDED: 'MAX_SPREAD_SLIPPAGE_EXCEEDED',
  VOLATILITY_THRESHOLD_EXCEEDED: 'VOLATILITY_THRESHOLD_EXCEEDED',
  EVENT_BLACKOUT: 'EVENT_BLACKOUT',
  COOLDOWN_AFTER_LOSS: 'COOLDOWN_AFTER_LOSS',
  COOLDOWN_AFTER_SIGNAL_SPAM: 'COOLDOWN_AFTER_SIGNAL_SPAM',
  DUPLICATE_SIGNAL: 'DUPLICATE_SIGNAL',
  STALE_SIGNAL: 'STALE_SIGNAL',
  MISSING_STOP_LOSS: 'MISSING_STOP_LOSS',
  INVALID_STOP_DISTANCE: 'INVALID_STOP_DISTANCE',
  MISSING_TAKE_PROFIT: 'MISSING_TAKE_PROFIT',
  INVALID_REWARD_RISK: 'INVALID_REWARD_RISK',
  PAPER_BROKER_UNAVAILABLE: 'PAPER_BROKER_UNAVAILABLE',
  PORTFOLIO_STATE_UNAVAILABLE: 'PORTFOLIO_STATE_UNAVAILABLE',
  DATA_PROVIDER_DEGRADED: 'DATA_PROVIDER_DEGRADED',
  MARKET_CLOSED: 'MARKET_CLOSED',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  MISSING_PORTFOLIO_CONTEXT: 'MISSING_PORTFOLIO_CONTEXT',
  MISSING_RISK_PLAN: 'MISSING_RISK_PLAN',
  MULTI_SOURCE_CONFIRMATION_FAILED: 'MULTI_SOURCE_CONFIRMATION_FAILED',
  EXECUTION_QUALITY_DEGRADED: 'EXECUTION_QUALITY_DEGRADED',
  LOW_FILL_RATE: 'LOW_FILL_RATE',
  HIGH_PARTIAL_FILL_RATE: 'HIGH_PARTIAL_FILL_RATE',
};

function evaluateRiskGate(signal, portfolio = {}, riskConfig = {}, marketContext = {}, now = new Date()) {
  const config = {
    killSwitch: true,
  maxDailyLoss: 250,
  maxPositionNotional: 1000,
    maxOpenPositions: 12,
    maxTradesPerDay: 8,
    maxExposurePerAsset: 1500,
    maxExposurePerSector: 3000,
    maxCryptoExposure: 2000,
    minLiquidityScore: 40,
    minEdgeScore: 60,
    minFreshnessScore: 55,
    minSourceQualityScore: 40,
    maxContradictionScore: 50,
    maxRiskScore: 70,
    minVolume: 50000,
    positionSizeMultiplier: 1,
    maxSpreadSlippagePct: 0.75,
    volatilityThresholdPct: null,
    cooldownAfterLossMinutes: 60,
    cooldownAfterSignalSpamMinutes: 15,
    duplicateSignalWindowMinutes: 30,
    signalTtlMinutes: 120,
    minConfidenceForPaper: 72,
    minProviderConfirmationScore: 70,
    minCryptoProviderConfirmationScore: 35,
    minFillRateForPaper: 0.8,
    maxPartialFillRate: 0.1,
    requireStopLoss: true,
    requireTakeProfit: true,
    minRewardRiskRatio: 1.5,
    requireHumanApproval: true,
    tradingMode: 'paper',
    liveTradingEnabled: false,
    requireRiskGate: true,
    auditLogEnabled: true,
    paperAdapterEnabled: true,
    ...riskConfig,
  };
  const sizeMultiplier = clamp(safeNumber(config.positionSizeMultiplier, 1), 0.5, 1.35);
  const effectiveMaxDailyLoss = Math.abs(safeNumber(config.maxDailyLoss, 250)) * sizeMultiplier;
  const effectiveMaxPositionNotional = safeNumber(config.maxPositionNotional, 1000) * sizeMultiplier;
  const effectiveMaxOpenPositions = Math.max(1, Math.round(safeNumber(config.maxOpenPositions, 12)));
  const effectiveMaxExposurePerAsset = safeNumber(config.maxExposurePerAsset, 1500) * sizeMultiplier;
  const effectiveMaxExposurePerSector = safeNumber(config.maxExposurePerSector, 3000) * sizeMultiplier;
  const effectiveMaxCryptoExposure = safeNumber(config.maxCryptoExposure, 2000) * sizeMultiplier;

  const reasonCodes = [];
  const warnings = [];
  const assetType = String(signal.asset_type || signal.assetType || '').trim().toLowerCase();
  const stopLoss = safeNumber(signal.stop_loss);
  const takeProfit = safeNumber(signal.take_profit);
  const entryPrice = safeNumber(signal.entry_price ?? marketContext.price ?? signal.price);
  const rewardRiskRatio = calcRewardRiskRatio(entryPrice, stopLoss, takeProfit, signal.direction);
  const riskSnapshot = {
    signal_id: signal.signal_id,
    asset_id: signal.asset_id,
    symbol: signal.symbol,
    side: signal.direction,
    entryPrice,
    stopLoss,
    takeProfit,
    portfolio,
    marketContext,
    riskConfig: config,
  };
  const snapshotHash = hashObject(riskSnapshot);
  const signalSide = normalizeTradeSideHint(signal.side || signal.direction || '');
  const isScannerExitSell = signalSide === 'sell' && Boolean(
    marketContext.exit_state?.exit_reason
      || signal.market_context?.exit_state?.exit_reason
      || signal.marketContext?.exit_state?.exit_reason,
  );
  const multiSourceConfirmation = buildProviderConfirmationFromContext(marketContext, {
    confirmation_options: {
      maxPriceDiffPct: config.maxProviderPriceDiffPct ?? 0.5,
      maxTimeSkewSeconds: config.maxProviderTimeSkewSeconds ?? 60,
    },
    trade_side: signalSide,
    sellMaxPriceDiffPct: config.sellMaxProviderPriceDiffPct ?? 0.75,
  });

  if (config.killSwitch) reasonCodes.push(RiskReason.KILL_SWITCH_ENABLED);
  if (config.liveTradingEnabled) warnings.push('LIVE_TRADING_MODE_ENABLED_BUT_NOT_IMPLEMENTED');
  if (!config.paperAdapterEnabled) reasonCodes.push(RiskReason.PAPER_BROKER_UNAVAILABLE);
  if (signalSide === 'buy' && config.blockBuys) {
    reasonCodes.push('BUY_SIDE_BLOCKED');
  }
  const approvedSymbols = Array.isArray(config.approvedSymbols)
    ? config.approvedSymbols.map(normalizePortfolioSymbol).filter(Boolean)
    : [];
  const normalizedSignalSymbol = normalizePortfolioSymbol(signal.symbol);
  if (signalSide === 'buy' && approvedSymbols.length && normalizedSignalSymbol && !approvedSymbols.includes(normalizedSignalSymbol)) {
    reasonCodes.push('SYMBOL_NOT_APPROVED_FOR_LIVE_MARKET');
  }
  if (!portfolio) reasonCodes.push(RiskReason.PORTFOLIO_STATE_UNAVAILABLE);
  if (marketContext.provider_degraded) reasonCodes.push(RiskReason.DATA_PROVIDER_DEGRADED);
  if (marketContext.market_closed && signal.strategy_requires_open_market) reasonCodes.push(RiskReason.MARKET_CLOSED);
  if (marketContext.duplicate_signal) reasonCodes.push(RiskReason.DUPLICATE_SIGNAL);
  if (marketContext.signal_spam_detected) reasonCodes.push(RiskReason.COOLDOWN_AFTER_SIGNAL_SPAM);
  if (marketContext.last_loss_at && minutesSince(now, marketContext.last_loss_at) < config.cooldownAfterLossMinutes) {
    reasonCodes.push(RiskReason.COOLDOWN_AFTER_LOSS);
  }
  if (signal.expires_at && new Date(signal.expires_at).getTime() < now.getTime()) {
    reasonCodes.push(RiskReason.STALE_SIGNAL);
  }
  if (signal.confidence_score !== undefined && signal.confidence_score < config.minConfidenceForPaper) {
    reasonCodes.push(RiskReason.LOW_CONFIDENCE);
  }
  const confidenceBucket = calibrationBucketForConfidence(signal.confidence_score);
  if (Array.isArray(config.blockedCalibrationBuckets) && config.blockedCalibrationBuckets.includes(confidenceBucket)) {
    reasonCodes.push('BLOCKED_CALIBRATION_BUCKET');
  }
  if (signalSide === 'buy'
    && Array.isArray(config.blockedBuyCalibrationBuckets)
    && config.blockedBuyCalibrationBuckets.includes(confidenceBucket)) {
    reasonCodes.push('BLOCKED_BUY_CALIBRATION_BUCKET');
  }
  if (signal.freshness_score !== undefined && signal.freshness_score < config.minFreshnessScore) {
    warnings.push('LOW_FRESHNESS');
  }
  if (signal.edge_score !== undefined && signal.edge_score < config.minEdgeScore) {
    reasonCodes.push('LOW_EDGE_SCORE');
  }
  if (signal.source_quality_score !== undefined && signal.source_quality_score < config.minSourceQualityScore) {
    reasonCodes.push('LOW_SOURCE_QUALITY');
  }
  const minProviderConfirmationScore = signalSide === 'sell'
    ? safeNumber(config.minSellProviderConfirmationScore, safeNumber(config.minProviderConfirmationScore, 70))
    : assetType === 'crypto'
      ? safeNumber(config.minCryptoProviderConfirmationScore, safeNumber(config.minProviderConfirmationScore, 35))
      : safeNumber(config.minProviderConfirmationScore, 70);
  if (signal.provider_confirmation_score !== undefined && signal.provider_confirmation_score < minProviderConfirmationScore) {
    reasonCodes.push('LOW_PROVIDER_CONFIRMATION');
  }
  const fillQualitySummary = marketContext.fill_quality_summary || marketContext.execution_quality || null;
  const fillRate = safeNumber(fillQualitySummary?.fill_rate, null);
  const partialFillRate = safeNumber(fillQualitySummary?.partial_fill_rate, null);
  if (Number.isFinite(fillRate) && fillRate < safeNumber(config.minFillRateForPaper, 0.8)) {
    reasonCodes.push(RiskReason.LOW_FILL_RATE);
  }
  if (Number.isFinite(partialFillRate) && partialFillRate > safeNumber(config.maxPartialFillRate, 0.1)) {
    reasonCodes.push(RiskReason.HIGH_PARTIAL_FILL_RATE);
  }
  if (signal.contradiction_score !== undefined && signal.contradiction_score > config.maxContradictionScore) {
    reasonCodes.push('HIGH_CONTRADICTION');
  }
  if (signal.risk_score !== undefined && signal.risk_score > config.maxRiskScore) {
    reasonCodes.push('SIGNAL_RISK_TOO_HIGH');
  }
  if (signal.stop_loss === undefined || signal.stop_loss === null) reasonCodes.push(RiskReason.MISSING_STOP_LOSS);
  if (config.requireTakeProfit && (signal.take_profit === undefined || signal.take_profit === null)) reasonCodes.push(RiskReason.MISSING_TAKE_PROFIT);

  if (Number.isFinite(entryPrice) && Number.isFinite(stopLoss) && entryPrice > 0) {
    const stopDistancePct = Math.abs((entryPrice - stopLoss) / entryPrice) * 100;
    if (stopDistancePct <= 0 || stopDistancePct > 20) reasonCodes.push(RiskReason.INVALID_STOP_DISTANCE);
  }

  if (!isScannerExitSell && Number.isFinite(rewardRiskRatio) && rewardRiskRatio + 1e-9 < config.minRewardRiskRatio) {
    reasonCodes.push(RiskReason.INVALID_REWARD_RISK);
  }
  if (safeNumber(signal.liquidity_score, 100) < config.minLiquidityScore) reasonCodes.push(RiskReason.MIN_LIQUIDITY_NOT_MET);
  if (safeNumber(signal.volume, marketContext.volume ?? 0) < config.minVolume) reasonCodes.push(RiskReason.MIN_VOLUME_NOT_MET);
  if (safeNumber(marketContext.spread_slippage_pct, 0) > config.maxSpreadSlippagePct) warnings.push(RiskReason.MAX_SPREAD_SLIPPAGE_EXCEEDED);
  const volatilityThresholdPct = safeNumber(config.volatilityThresholdPct, null);
  if (Number.isFinite(volatilityThresholdPct) && safeNumber(marketContext.volatility_pct, 0) > volatilityThresholdPct) {
    warnings.push(RiskReason.VOLATILITY_THRESHOLD_EXCEEDED);
  }
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
  if (signalSide === 'buy' && normalizedSignalSymbol && heldSymbols.has(normalizedSignalSymbol)) {
    reasonCodes.push('EXISTING_POSITION_FOR_SYMBOL');
  }
  if (signalSide === 'buy' && normalizedSignalSymbol && openBuySymbols.has(normalizedSignalSymbol)) {
    reasonCodes.push('OPEN_BUY_ORDER_FOR_SYMBOL');
  }
  if (safeNumber(portfolio.daily_loss, 0) <= -effectiveMaxDailyLoss) reasonCodes.push(RiskReason.MAX_DAILY_LOSS_EXCEEDED);
  if (safeNumber(portfolio.position_notional_by_asset?.[signal.symbol], 0) >= effectiveMaxExposurePerAsset) {
    reasonCodes.push(RiskReason.MAX_EXPOSURE_PER_ASSET_EXCEEDED);
  }
  if (safeNumber(portfolio.position_notional, 0) >= effectiveMaxPositionNotional) reasonCodes.push(RiskReason.MAX_POSITION_SIZE_EXCEEDED);
  if (signal.asset_type === 'crypto' && safeNumber(portfolio.crypto_exposure, 0) >= effectiveMaxCryptoExposure) {
    reasonCodes.push(RiskReason.MAX_CRYPTO_EXPOSURE_EXCEEDED);
  }
  if (signal.sector && safeNumber(portfolio.exposure_by_sector?.[signal.sector], 0) >= effectiveMaxExposurePerSector) {
    reasonCodes.push(RiskReason.MAX_EXPOSURE_PER_SECTOR_EXCEEDED);
  }
  if (marketContext.events && marketContext.events.some((event) => event.type === 'earnings_blackout' || event.type === 'macro_blackout')) {
    reasonCodes.push(RiskReason.EVENT_BLACKOUT);
  }
  if (multiSourceConfirmation && !multiSourceConfirmation.confirmed) {
    reasonCodes.push(RiskReason.MULTI_SOURCE_CONFIRMATION_FAILED);
  }
  if (!signal.stop_loss && config.requireStopLoss) reasonCodes.push(RiskReason.MISSING_RISK_PLAN);
  if (!portfolio.available && portfolio.available !== undefined) reasonCodes.push(RiskReason.PORTFOLIO_STATE_UNAVAILABLE);

  let decision = RiskDecision.APPROVED_FOR_PAPER;
  if (reasonCodes.includes(RiskReason.KILL_SWITCH_ENABLED)
    || reasonCodes.includes('BUY_SIDE_BLOCKED')
    || reasonCodes.includes('SYMBOL_NOT_APPROVED_FOR_LIVE_MARKET')
    || reasonCodes.includes(RiskReason.MAX_POSITION_SIZE_EXCEEDED)
    || reasonCodes.includes(RiskReason.MAX_DAILY_LOSS_EXCEEDED)
    || reasonCodes.includes(RiskReason.MAX_OPEN_POSITIONS_EXCEEDED)
    || reasonCodes.includes('EXISTING_POSITION_FOR_SYMBOL')
    || reasonCodes.includes('OPEN_BUY_ORDER_FOR_SYMBOL')
    || reasonCodes.includes(RiskReason.MAX_TRADES_PER_DAY_EXCEEDED)
    || reasonCodes.includes(RiskReason.MAX_EXPOSURE_PER_ASSET_EXCEEDED)
    || reasonCodes.includes(RiskReason.MAX_EXPOSURE_PER_SECTOR_EXCEEDED)
    || reasonCodes.includes(RiskReason.MAX_CRYPTO_EXPOSURE_EXCEEDED)
    || reasonCodes.includes(RiskReason.MIN_LIQUIDITY_NOT_MET)
    || reasonCodes.includes(RiskReason.MIN_VOLUME_NOT_MET)
    || reasonCodes.includes(RiskReason.EVENT_BLACKOUT)
    || reasonCodes.includes(RiskReason.COOLDOWN_AFTER_LOSS)
    || reasonCodes.includes(RiskReason.COOLDOWN_AFTER_SIGNAL_SPAM)
    || reasonCodes.includes(RiskReason.DUPLICATE_SIGNAL)
    || reasonCodes.includes(RiskReason.STALE_SIGNAL)
    || reasonCodes.includes(RiskReason.MISSING_STOP_LOSS)
    || reasonCodes.includes(RiskReason.INVALID_STOP_DISTANCE)
    || reasonCodes.includes(RiskReason.MISSING_TAKE_PROFIT)
    || reasonCodes.includes(RiskReason.INVALID_REWARD_RISK)
    || reasonCodes.includes('BLOCKED_CALIBRATION_BUCKET')
    || reasonCodes.includes('BLOCKED_BUY_CALIBRATION_BUCKET')
    || reasonCodes.includes('LOW_EDGE_SCORE')
    || reasonCodes.includes('LOW_SOURCE_QUALITY')
    || reasonCodes.includes('LOW_PROVIDER_CONFIRMATION')
    || reasonCodes.includes(RiskReason.LOW_FILL_RATE)
    || reasonCodes.includes(RiskReason.HIGH_PARTIAL_FILL_RATE)
    || reasonCodes.includes('HIGH_CONTRADICTION')
    || reasonCodes.includes('SIGNAL_RISK_TOO_HIGH')
    || reasonCodes.includes(RiskReason.MULTI_SOURCE_CONFIRMATION_FAILED)
    || reasonCodes.includes(RiskReason.PAPER_BROKER_UNAVAILABLE)
    || reasonCodes.includes(RiskReason.PORTFOLIO_STATE_UNAVAILABLE)
    || reasonCodes.includes(RiskReason.MISSING_PORTFOLIO_CONTEXT)
    || reasonCodes.includes(RiskReason.MISSING_RISK_PLAN)) {
    decision = RiskDecision.BLOCKED;
  } else if (reasonCodes.includes(RiskReason.LOW_CONFIDENCE)
    || warnings.includes(RiskReason.VOLATILITY_THRESHOLD_EXCEEDED)
    || reasonCodes.includes(RiskReason.DATA_PROVIDER_DEGRADED)) {
    decision = RiskDecision.NEEDS_HUMAN_REVIEW;
  } else if (warnings.includes(RiskReason.VOLATILITY_THRESHOLD_EXCEEDED)) {
    decision = RiskDecision.ALERT_ONLY;
  }

  const humanReadable = buildRiskExplanation(decision, reasonCodes, warnings, config, signal, portfolio, marketContext);

  return {
    decision,
    pass: decision === RiskDecision.APPROVED_FOR_PAPER,
    reason_codes: reasonCodes,
    warnings,
    explanation: humanReadable,
    input_snapshot_hash: snapshotHash,
    risk_config_version: config.version || '2026-06-14.paper-first.1',
    timestamp: now.toISOString(),
    required_human_approval: config.requireHumanApproval,
    config_snapshot: config,
    effective_size_multiplier: sizeMultiplier,
    multi_source_confirmation: multiSourceConfirmation,
    fill_quality_summary: fillQualitySummary,
    confidence_bucket: confidenceBucket,
    reward_risk_ratio: Number.isFinite(rewardRiskRatio) ? rewardRiskRatio : null,
  };
}

function calcRewardRiskRatio(entryPrice, stopLoss, takeProfit, direction) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit) || entryPrice <= 0) return null;
  const risk = direction === 'bearish' ? Math.abs(stopLoss - entryPrice) : Math.abs(entryPrice - stopLoss);
  const reward = direction === 'bearish' ? Math.abs(entryPrice - takeProfit) : Math.abs(takeProfit - entryPrice);
  if (risk <= 0) return null;
  return reward / risk;
}

function buildRiskExplanation(decision, reasonCodes, warnings, config, signal, portfolio, marketContext) {
  const parts = [`Risk gate decision ${decision} for ${signal.symbol || 'unknown'}.`];
  if (reasonCodes.length) parts.push(`Blocked reasons: ${reasonCodes.join(', ')}.`);
  if (warnings.length) parts.push(`Warnings: ${warnings.join(', ')}.`);
  parts.push(`Confidence threshold ${config.minConfidenceForPaper}, portfolio trades today ${portfolio.trade_count_today ?? 'unknown'}.`);
  if (marketContext.fill_quality_summary?.count) {
    parts.push(`Execution fill rate ${Math.round((safeNumber(marketContext.fill_quality_summary.fill_rate, 0) * 100))}%, partial fills ${Math.round((safeNumber(marketContext.fill_quality_summary.partial_fill_rate, 0) * 100))}%.`);
  }
  if (marketContext.provider_degraded) parts.push('Provider degraded mode active.');
  return parts.join(' ');
}

function minutesSince(now, past) {
  return (new Date(now).getTime() - new Date(past).getTime()) / 60000;
}

function normalizeTradeSideHint(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['buy', 'paper_buy', 'bullish', 'long'].includes(normalized)) return 'buy';
  if (['sell', 'paper_sell', 'bearish', 'short'].includes(normalized)) return 'sell';
  return normalized;
}

function normalizePortfolioSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes('/')) return raw;
  if (raw.endsWith('USDT')) return `${raw.slice(0, -4)}/USDT`;
  if (raw.endsWith('USD') && raw.length > 3) return `${raw.slice(0, -3)}/USD`;
  return raw;
}

module.exports = {
  RiskDecision,
  RiskReason,
  calcRewardRiskRatio,
  evaluateRiskGate,
};
