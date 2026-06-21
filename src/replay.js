const { normalizeMarketData, validateNormalizedMarketData } = require('./market-data');
const { scoreSignal } = require('./signals');
const { evaluateRiskGate } = require('./risk-gate');
const { generateDailySummary } = require('./metrics');

function runReplay(fixtures, options = {}) {
  const normalized = [];
  const scoredSignals = [];
  const riskDecisions = [];
  const orders = [];
  const paperOutcomes = [];

  for (const fixture of fixtures) {
    const marketData = normalizeMarketData(fixture.market_data, options.marketOptions || {});
    normalized.push(marketData);
    const validation = validateNormalizedMarketData(marketData);
    if (!validation.pass) {
      riskDecisions.push({
        decision: 'BLOCKED',
        reason_codes: validation.reason_codes,
        explanation: `Replay rejected due to ${validation.reason_codes.join(', ')}`,
      });
      continue;
    }
    const signal = scoreSignal(fixture.signal, {
      min_confidence_for_paper: options.minConfidenceForPaper ?? 72,
      portfolio_context_available: options.portfolio_context_available !== false,
      market_context: fixture.market_context || fixture.signal.market_context || {},
    });
    scoredSignals.push(signal);
    const riskDecision = evaluateRiskGate(signal, fixture.portfolio || {}, options.riskConfig || {}, fixture.market_context || {});
    riskDecisions.push(riskDecision);
    if (riskDecision.decision === 'APPROVED_FOR_PAPER' && options.paperAdapter && typeof options.paperAdapter.submitOrder === 'function') {
      const marketForFill = {
        ...(fixture.market_context || {}),
        price: marketData.price ?? fixture.market_context?.price ?? null,
      };
      const order = options.paperAdapter.submitOrder({
        request_id: `replay_${signal.signal_id}`,
        signal_id: signal.signal_id,
        asset_id: signal.asset_id,
        symbol: signal.symbol,
        side: signal.direction === 'bearish' ? 'sell' : 'buy',
        order_type: 'market',
        quantity: 1,
        stop_loss: fixture.signal.stop_loss,
        take_profit: fixture.signal.take_profit,
        strategy_name: signal.strategy_name,
        confidence_score: signal.confidence_score,
        risk_decision_id: riskDecision.input_snapshot_hash,
        created_by: 'system',
      }, { market: marketForFill });
      orders.push(order);
      if (fixture.paper_outcome && typeof options.paperAdapter.recordOutcome === 'function') {
        const outcome = options.paperAdapter.recordOutcome(order.order_id, fixture.paper_outcome);
        paperOutcomes.push(outcome);
      } else if (order.paper_outcome) {
        paperOutcomes.push(order.paper_outcome);
      }
    }
  }

  const summary = generateDailySummary({
    date: options.date,
    signals: scoredSignals,
    riskDecisions,
    orders: paperOutcomes.length ? paperOutcomes : orders,
    events: options.events || [],
    policySnapshot: options.policySnapshot || (options.riskConfig ? { policy: options.riskConfig } : null),
  });

  return {
    normalized,
    scoredSignals,
    riskDecisions,
    orders,
    paperOutcomes,
    summary,
  };
}

module.exports = {
  runReplay,
};
