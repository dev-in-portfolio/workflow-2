const { reconcileBrokerPortfolio } = require('./broker-reconciliation');
const { deriveMarketActivitySignal } = require('./market-activity');
const { computePaperOutcome } = require('./paper-outcomes');
const { evaluateRiskGate } = require('./risk-gate');
const { assertRiskDecision } = require('./module-contracts');
const { nowIso, safeNumber, resolveRepoRoot } = require('./util');
const {
  buildPaperResultFromOrder,
  buildPartialFillMetadata,
  confirmBrokerOrder,
  detectOpenOrderConflict,
  executeOrder,
} = require('./trading/execution-orchestrator');
const { buildPaperOrder, findPendingPartialConflict, resolveLiveBuyNotionalTarget } = require('./trading/order-builder');
const { processSignal } = require('./trading/signal-processor');

async function processTradingSignal(signalOrRequest = {}, options = {}) {
  const signalResult = processSignal(signalOrRequest, options);
  if (!signalResult.ok) {
    return {
      accepted: false,
      stage: signalResult.error.stage || 'validation',
      reason_codes: signalResult.reasonCodes,
      signal: signalResult.error.data?.signal || (signalOrRequest.signal || signalOrRequest),
      market_context: signalResult.error.data?.marketContext || signalOrRequest.market_context || signalOrRequest.marketContext || {},
    };
  }

  const { signal, marketContext, performance, audit, policySnapshot, policy, requestedPortfolio, partialFillState, partialFillSummary } = signalResult.value;

  const brokerReconciliation = await reconcileBrokerPortfolio({
    executionAdapter: options.executionAdapter,
    requestPortfolio: requestedPortfolio,
    policy,
    signal,
  });
  const portfolio = brokerReconciliation.broker_reconciled_portfolio || requestedPortfolio;
  const reconciledMarketContext = {
    ...marketContext,
    broker_reconciliation: brokerReconciliation,
    partial_fill_state: partialFillSummary,
  };

  const riskDecision = evaluateRiskGate(signal, portfolio, policy, reconciledMarketContext);
  assertRiskDecision(riskDecision);
  if (performance?.recordSignal) {
    performance.recordSignal(signal);
  }
  if (performance?.recordRiskDecision) {
    performance.recordRiskDecision({
      ...riskDecision,
      signal_id: signal.signal_id || null,
      timestamp: signal.created_at || riskDecision.timestamp || nowIso(),
      policy_snapshot: policySnapshot,
      broker_reconciliation: brokerReconciliation,
    });
  }

  if (!['APPROVED_FOR_PAPER', 'APPROVED_FOR_EXECUTION'].includes(riskDecision.decision)) {
    return {
      accepted: false,
      stage: 'decision',
      reason_codes: riskDecision.reason_codes || [],
      signal,
      riskDecision,
      broker_reconciliation: brokerReconciliation,
      market_context: reconciledMarketContext,
    };
  }

  const orderResult = buildPaperOrder(signal, riskDecision, {
    ...options,
    policy,
    portfolio,
  });
  if (!orderResult.accepted) {
    return {
      accepted: false,
      stage: 'decision',
      reason_codes: orderResult.reason_codes,
      signal,
      riskDecision,
      broker_reconciliation: brokerReconciliation,
      market_context: reconciledMarketContext,
      ...(orderResult.sizing ? { sizing: orderResult.sizing } : {}),
    };
  }

  const { paperOrderRequest } = orderResult;

  const partialConflict = findPendingPartialConflict(partialFillSummary, paperOrderRequest);
  if (partialConflict) {
    return {
      accepted: false,
      stage: 'pre_submit',
      reason_codes: ['PARTIAL_FILL_PENDING'],
      signal,
      riskDecision,
      paperOrderRequest,
      broker_reconciliation: brokerReconciliation,
      market_context: reconciledMarketContext,
      partial_fill_state: partialFillSummary,
      partial_fill_conflict: partialConflict,
    };
  }

  const openOrderCheck = await detectOpenOrderConflict(options.executionAdapter, paperOrderRequest);
  if (!openOrderCheck.pass) {
    return {
      accepted: false,
      stage: 'pre_submit',
      reason_codes: openOrderCheck.reason_codes,
      signal,
      riskDecision,
      paperOrderRequest,
      broker_reconciliation: brokerReconciliation,
      market_context: reconciledMarketContext,
      open_orders: openOrderCheck.open_orders || [],
    };
  }

  const executionResult = await executeOrder(paperOrderRequest, signal, {
    ...options,
    policy,
    reconciledMarketContext,
    partialFillState,
  });

  const paperOutcome = recordPaperOutcome(performance, signal, executionResult.paperResult, options.outcomeSnapshot || null);

  if (audit?.writeEvent) {
    audit.writeEvent({
      event_type: 'trading_signal_processed',
      related_entity_id: executionResult.paperOrder.order_id || signal.signal_id || null,
      payload: {
        signal,
        riskDecision,
        brokerReconciliation,
        paperOrderRequest,
        paperOrder: executionResult.paperOrder,
        confirmation: executionResult.confirmation,
        paperResult: executionResult.paperResult,
        paperOutcome,
        partialFillState: executionResult.updatedPartialFillSummary,
      },
      source: options.source || 'server',
      severity: 'info',
    });
  }

  return {
    accepted: true,
    stage: 'order_confirmed',
    signal,
    riskDecision,
    paperOrderRequest,
    paperOrder: executionResult.paperOrder,
    confirmation: executionResult.confirmation,
    paperResult: executionResult.paperResult,
    paperOutcome,
    market_context: reconciledMarketContext,
    broker_reconciliation: brokerReconciliation,
    partial_fill_state: executionResult.updatedPartialFillSummary,
  };
}

async function processMarketInput(rawInput = {}, options = {}) {
  const policySnapshot = options.policySnapshot || options.performance?.getPolicySnapshot?.() || { policy: {} };
  const policy = policySnapshot.policy || {};
  const derived = deriveMarketActivitySignal(rawInput, { policy });
  if (!derived.accepted || !derived.signal) {
    return {
      accepted: false,
      stage: 'validation',
      reason_codes: derived.reason_codes || ['NON_TRADE_DECISION'],
      normalized_market_data: derived.normalized_market_data || null,
      signal: derived.signal || null,
      market_context: rawInput.market_context || rawInput.marketContext || {},
    };
  }

  const normalizedSignal = {
    ...derived.signal,
    side: derived.signal.side
      || (derived.signal.action_candidate === 'paper_sell' || derived.signal.direction === 'bearish'
        ? 'sell'
        : 'buy'),
  };

  return processTradingSignal({
    ...rawInput,
    signal: normalizedSignal,
    market_context: {
      ...(rawInput.market_context || rawInput.marketContext || {}),
      primary_quote: derived.normalized_market_data,
      provider_confirmation: derived.provider_confirmation || null,
    },
  }, {
    ...options,
    policySnapshot,
  });
}

function recordPaperOutcome(performance, signal, paperResult, exitSnapshot = null) {
  if (!performance) return null;

  const exit = exitSnapshot || {};
  const signalExitState = signal.market_context?.exit_state
    || signal.marketContext?.exit_state
    || signal.exit_state
    || {};
  const recordedAt = paperResult.filled_at || nowIso();
  const entryAt = signalExitState.opened_at
    || signal.position_opened_at
    || signal.entry_at
    || signal.created_at
    || null;
  const entryAtMs = entryAt ? new Date(entryAt).getTime() : Number.NaN;
  const recordedAtMs = new Date(recordedAt).getTime();
  const holdingPeriodSeconds = Number.isFinite(entryAtMs) && Number.isFinite(recordedAtMs) && recordedAtMs >= entryAtMs
    ? Math.round((recordedAtMs - entryAtMs) / 1000)
    : null;
  const sellSide = String(signal.side || signal.direction || '').trim().toLowerCase() === 'sell'
    || String(signal.direction || '').trim().toLowerCase() === 'bearish';
  const costBasis = safeNumber(
    signal.position_avg_entry_price
      ?? signal.position_entry_price
      ?? signal.avg_entry_price
      ?? signalExitState.entry_price
      ?? null,
    null,
  );
  const entryPriceSource = Number.isFinite(safeNumber(signal.position_avg_entry_price, null))
    ? 'broker_position_avg_entry_price'
    : Number.isFinite(safeNumber(signal.position_entry_price ?? signal.avg_entry_price, null))
      ? 'broker_position_entry_price'
      : Number.isFinite(safeNumber(signalExitState.entry_price, null)) ? 'scanner_exit_state' : null;
  const liveExecution = String(paperResult.execution_mode || '').toLowerCase() === 'live';
  const accountingReasonCodes = [];
  if (sellSide && liveExecution && paperResult.broker_fill_price_confirmed !== true) accountingReasonCodes.push('BROKER_FILL_PRICE_UNCONFIRMED');
  if (sellSide && !Number.isFinite(costBasis)) accountingReasonCodes.push('BROKER_COST_BASIS_UNAVAILABLE');
  const accountingValid = !sellSide || accountingReasonCodes.length === 0;
  const entryPrice = sellSide && Number.isFinite(costBasis)
    ? costBasis
    : safeNumber(paperResult.average_fill_price ?? signal.entry_price ?? signal.price, null);
  const exitPrice = sellSide
    ? safeNumber(paperResult.average_fill_price ?? signalExitState.sell_price ?? signal.entry_price ?? signal.price, null)
    : exit.exit_price ?? null;
  const outcomeQuantity = sellSide
    ? safeNumber(signalExitState.quantity ?? exit.quantity ?? paperResult.filled_quantity ?? signal.quantity, 0)
    : safeNumber(exit.quantity ?? paperResult.filled_quantity ?? signal.quantity, 0);
  const outcome = computePaperOutcome({
    original_signal: signal,
    paper_result: paperResult,
    entry_price: entryPrice,
    exit_price: exitPrice,
    high_price: exit.high_price ?? null,
    low_price: exit.low_price ?? null,
    quantity: outcomeQuantity,
    side: sellSide ? 'sell' : 'buy',
    position_exit: sellSide,
    false_positive: exit.false_positive,
    estimated_entry_price: signalExitState.entry_price ?? null,
    estimated_exit_price: signalExitState.sell_price ?? null,
    estimated_fees: signalExitState.fees ?? paperResult.estimated_fees ?? null,
    entry_at: entryAt,
    exit_at: recordedAt,
    holding_period_seconds: holdingPeriodSeconds,
    trade_duration_seconds: holdingPeriodSeconds,
    exit_reason: signalExitState.exit_reason ?? null,
    exit_state: Object.keys(signalExitState).length ? signalExitState : null,
    accounting_valid: accountingValid,
    accounting_reason_codes: accountingReasonCodes,
    entry_price_source: entryPriceSource,
  });

  if (typeof performance.recordPaperOutcome === 'function') {
    return performance.recordPaperOutcome({
      ...outcome,
      signal_id: signal.signal_id || null,
      symbol: signal.symbol || null,
      recorded_at: recordedAt,
      partial_fill: buildPartialFillMetadata(paperResult),
    });
  }

  if (typeof performance.recordEvent === 'function') {
    return performance.recordEvent({
      event_type: 'paper_outcome_recorded',
      payload: outcome,
      source: 'server',
    });
  }

  return outcome;
}

module.exports = {
  buildPaperResultFromOrder,
  confirmBrokerOrder,
  detectOpenOrderConflict,
  processMarketInput,
  processTradingSignal,
  recordPaperOutcome,
  resolveLiveBuyNotionalTarget,
};
