const { safeNumber } = require('../util');
const { RiskReason, RiskDecision } = require('./constants');
const { calibrationBucketForConfidence } = require('../paper-outcomes');

function calcRewardRiskRatio(entryPrice, stopLoss, takeProfit, direction) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit) || entryPrice <= 0) return null;
  const risk = direction === 'bearish' ? Math.abs(stopLoss - entryPrice) : Math.abs(entryPrice - stopLoss);
  const reward = direction === 'bearish' ? Math.abs(entryPrice - takeProfit) : Math.abs(takeProfit - entryPrice);
  if (risk <= 0) return null;
  return reward / risk;
}

function minutesSince(now, past) {
  return (new Date(now).getTime() - new Date(past).getTime()) / 60000;
}

function performSignalChecks(
  signal, marketContext, config, now,
  signalSide, isScannerExitSell,
  stopLoss, takeProfit, entryPrice, rewardRiskRatio,
  confidenceBucket, minProviderConfirmationScore,
) {
  const reasonCodes = [];
  const warnings = [];

  if (marketContext.duplicate_signal) reasonCodes.push(RiskReason.DUPLICATE_SIGNAL);
  if (marketContext.signal_spam_detected) reasonCodes.push(RiskReason.COOLDOWN_AFTER_SIGNAL_SPAM);

  if (signal.expires_at && new Date(signal.expires_at).getTime() < now.getTime()) {
    reasonCodes.push(RiskReason.STALE_SIGNAL);
  }

  if (signal.confidence_score !== undefined && signal.confidence_score < config.minConfidenceForPaper) {
    reasonCodes.push(RiskReason.LOW_CONFIDENCE);
  }

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

  const singleSourceMomentumOverride = Boolean(signal.single_source_momentum_override || marketContext.single_source_momentum_override);
  if (!isScannerExitSell && !singleSourceMomentumOverride && signal.provider_confirmation_score !== undefined && signal.provider_confirmation_score < minProviderConfirmationScore) {
    reasonCodes.push('LOW_PROVIDER_CONFIRMATION');
  }

  if (signal.contradiction_score !== undefined && signal.contradiction_score > config.maxContradictionScore) {
    reasonCodes.push('HIGH_CONTRADICTION');
  }

  if (signal.risk_score !== undefined && signal.risk_score > config.maxRiskScore) {
    reasonCodes.push('SIGNAL_RISK_TOO_HIGH');
  }

  if (!isScannerExitSell && (signal.stop_loss === undefined || signal.stop_loss === null)) reasonCodes.push(RiskReason.MISSING_STOP_LOSS);
  if (!isScannerExitSell && config.requireTakeProfit && (signal.take_profit === undefined || signal.take_profit === null)) reasonCodes.push(RiskReason.MISSING_TAKE_PROFIT);

  if (Number.isFinite(entryPrice) && Number.isFinite(stopLoss) && entryPrice > 0) {
    const stopDistancePct = Math.abs((entryPrice - stopLoss) / entryPrice) * 100;
    if (stopDistancePct <= 0 || stopDistancePct > 20) reasonCodes.push(RiskReason.INVALID_STOP_DISTANCE);
  }

  if (!isScannerExitSell && Number.isFinite(rewardRiskRatio) && rewardRiskRatio + 1e-9 < config.minRewardRiskRatio) {
    reasonCodes.push(RiskReason.INVALID_REWARD_RISK);
  }

  if (!isScannerExitSell && !signal.stop_loss && config.requireStopLoss) reasonCodes.push(RiskReason.MISSING_RISK_PLAN);

  return { reasonCodes, warnings };
}

module.exports = { performSignalChecks, calcRewardRiskRatio, minutesSince };
