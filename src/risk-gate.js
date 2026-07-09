const { clamp, hashObject, safeNumber } = require('./util');
const { buildProviderConfirmationFromContext } = require('./market-data');
const { calibrationBucketForConfidence } = require('./paper-outcomes');
const { RiskDecision, RiskReason, REASON_SEVERITY, WARNING_SEVERITY } = require('./risk/constants');
const { performScannerChecks } = require('./risk/scanner-checks');
const { performPortfolioChecks } = require('./risk/portfolio-checks');
const { performSignalChecks, calcRewardRiskRatio } = require('./risk/signal-checks');
const { performBrokerChecks } = require('./risk/broker-checks');

const DEFAULT_MAX_OPEN_POSITIONS = 2;

function evaluateRiskGate(signal, portfolio = {}, riskConfig = {}, marketContext = {}, now = new Date()) {
  const config = {
    killSwitch: true,
    maxDailyLoss: 250,
    maxPositionNotional: 1000,
    maxOpenPositions: DEFAULT_MAX_OPEN_POSITIONS,
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
  const effectiveMaxOpenPositions = Math.max(1, Math.round(safeNumber(config.maxOpenPositions, DEFAULT_MAX_OPEN_POSITIONS)));
  const effectiveMaxExposurePerAsset = safeNumber(config.maxExposurePerAsset, 1500) * sizeMultiplier;
  const effectiveMaxExposurePerSector = safeNumber(config.maxExposurePerSector, 3000) * sizeMultiplier;
  const effectiveMaxCryptoExposure = safeNumber(config.maxCryptoExposure, 2000) * sizeMultiplier;

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

  const approvedSymbols = Array.isArray(config.approvedSymbols)
    ? config.approvedSymbols.map(normalizePortfolioSymbol).filter(Boolean)
    : [];
  const normalizedSignalSymbol = normalizePortfolioSymbol(signal.symbol);

  const minProviderConfirmationScore = signalSide === 'sell'
    ? safeNumber(config.minSellProviderConfirmationScore, safeNumber(config.minProviderConfirmationScore, 70))
    : assetType === 'crypto'
      ? safeNumber(config.minCryptoProviderConfirmationScore, safeNumber(config.minProviderConfirmationScore, 35))
      : safeNumber(config.minProviderConfirmationScore, 70);

  const confidenceBucket = calibrationBucketForConfidence(signal.confidence_score);

  const fillQualitySummary = marketContext.fill_quality_summary || marketContext.execution_quality || null;
  const fillRate = safeNumber(fillQualitySummary?.fill_rate, null);
  const partialFillRate = safeNumber(fillQualitySummary?.partial_fill_rate, null);

  const scannerResult = performScannerChecks(signal, signalSide, marketContext, config, normalizedSignalSymbol, approvedSymbols, { isScannerExitSell });
  const portfolioResult = performPortfolioChecks(signalSide, signal, portfolio, config, effectiveMaxOpenPositions, effectiveMaxDailyLoss, effectiveMaxExposurePerAsset, effectiveMaxExposurePerSector, effectiveMaxCryptoExposure, effectiveMaxPositionNotional, normalizedSignalSymbol);
  const signalResult = performSignalChecks(signal, marketContext, config, now, signalSide, isScannerExitSell, stopLoss, takeProfit, entryPrice, rewardRiskRatio, confidenceBucket, minProviderConfirmationScore);
  const brokerResult = performBrokerChecks(marketContext, config, now, portfolio, signalSide, fillRate, partialFillRate, multiSourceConfirmation, signal.strategy_requires_open_market, isScannerExitSell);

  const reasonCodes = [...scannerResult.reasonCodes, ...portfolioResult.reasonCodes, ...signalResult.reasonCodes, ...brokerResult.reasonCodes];
  const warnings = [...scannerResult.warnings, ...portfolioResult.warnings, ...signalResult.warnings, ...brokerResult.warnings];

  let decision = RiskDecision.APPROVED_FOR_PAPER;
  for (const code of reasonCodes) {
    const sev = REASON_SEVERITY[code];
    if (sev === RiskDecision.BLOCKED) { decision = RiskDecision.BLOCKED; break; }
    if (sev === RiskDecision.NEEDS_HUMAN_REVIEW && decision !== RiskDecision.BLOCKED) {
      decision = RiskDecision.NEEDS_HUMAN_REVIEW;
    }
  }
  for (const warning of warnings) {
    const sev = WARNING_SEVERITY[warning];
    if (sev === RiskDecision.NEEDS_HUMAN_REVIEW && decision !== RiskDecision.BLOCKED) {
      decision = RiskDecision.NEEDS_HUMAN_REVIEW;
    }
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
