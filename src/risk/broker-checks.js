const { safeNumber } = require('../util');
const { RiskReason, RiskDecision } = require('./constants');
const { minutesSince } = require('./signal-checks');

function performBrokerChecks(
  marketContext, config, now, portfolio, signalSide,
  fillRate, partialFillRate, multiSourceConfirmation,
  strategyRequiresOpenMarket,
  isScannerExitSell = false,
) {
  const reasonCodes = [];
  const warnings = [];

  if (config.killSwitch) reasonCodes.push(RiskReason.KILL_SWITCH_ENABLED);

  for (const brokerReason of [
    ...(Array.isArray(portfolio?.broker_reconciliation_reason_codes) ? portfolio.broker_reconciliation_reason_codes : []),
    ...(Array.isArray(portfolio?.reason_codes) ? portfolio.reason_codes : []),
  ]) {
    if (brokerReason && !reasonCodes.includes(brokerReason)) reasonCodes.push(brokerReason);
  }

  const liveExecution = String(config.executionMode || config.tradingMode || '').trim().toLowerCase() === 'live'
    && config.liveTradingEnabled === true;
  if (!liveExecution && !config.paperAdapterEnabled) reasonCodes.push(RiskReason.PAPER_BROKER_UNAVAILABLE);

  if (signalSide === 'buy' && config.blockBuys) {
    reasonCodes.push('BUY_SIDE_BLOCKED');
  }

  if (marketContext.provider_degraded) reasonCodes.push(RiskReason.DATA_PROVIDER_DEGRADED);
  if (marketContext.market_closed && strategyRequiresOpenMarket) reasonCodes.push(RiskReason.MARKET_CLOSED);

  if (marketContext.last_loss_at && minutesSince(now, marketContext.last_loss_at) < config.cooldownAfterLossMinutes) {
    reasonCodes.push(RiskReason.COOLDOWN_AFTER_LOSS);
  }

  if (Number.isFinite(fillRate) && fillRate < safeNumber(config.minFillRateForPaper, 0.8)) {
    reasonCodes.push(RiskReason.LOW_FILL_RATE);
  }
  if (Number.isFinite(partialFillRate) && partialFillRate > safeNumber(config.maxPartialFillRate, 0.1)) {
    reasonCodes.push(RiskReason.HIGH_PARTIAL_FILL_RATE);
  }

  if (!isScannerExitSell && multiSourceConfirmation && !multiSourceConfirmation.confirmed && !marketContext.single_source_momentum_override) {
    reasonCodes.push(RiskReason.MULTI_SOURCE_CONFIRMATION_FAILED);
  }

  return { reasonCodes, warnings };
}

module.exports = { performBrokerChecks };
