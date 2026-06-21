const { clamp, hashObject, nowIso, safeNumber } = require('./util');
const { buildProviderConfirmationFromContext, normalizeMarketData, validateNormalizedMarketData } = require('./market-data');
const { scoreSignal } = require('./signals');

function deriveMarketActivitySignal(rawInput = {}, options = {}) {
  const policy = options.policy || {};
  const rawMarketData = rawInput.market_data || rawInput.marketData || rawInput;
  const marketContext = rawInput.market_context || rawInput.marketContext || {};
  const normalizedMarketData = normalizeMarketData(rawMarketData, {
    maxStalenessSeconds: policy.maxStalenessSeconds ?? 60,
    receivedAt: rawInput.received_at || rawInput.receivedAt || nowIso(),
    priceJumpConfirmationPct: policy.priceJumpConfirmationPct ?? 15,
  });
  const validation = validateNormalizedMarketData(normalizedMarketData);

  if (!validation.pass) {
    return {
      accepted: false,
      action_candidate: 'ignore',
      reason_codes: validation.reason_codes,
      normalized_market_data: normalizedMarketData,
      signal: null,
    };
  }

  const entryPrice = safeNumber(normalizedMarketData.price);
  const previousClose = safeNumber(normalizedMarketData.previous_close);
  const movePct = Number.isFinite(entryPrice) && Number.isFinite(previousClose) && previousClose > 0
    ? ((entryPrice - previousClose) / previousClose) * 100
    : null;
  const minMovePct = safeNumber(options.min_move_pct ?? policy.minMovePct ?? 0.4, 0.4);

  if (movePct === null || Math.abs(movePct) < minMovePct) {
    return {
      accepted: true,
      action_candidate: 'watch',
      reason_codes: ['MOVE_TOO_SMALL'],
      normalized_market_data: normalizedMarketData,
      signal: null,
    };
  }

  const bullish = movePct > 0;
  const volatilityPct = clamp(Math.abs(movePct), 0.35, 8);
  const stopDistancePct = clamp(Math.max(0.35, volatilityPct * 0.6), 0.35, 4);
  const targetDistancePct = clamp(stopDistancePct * 1.8, stopDistancePct * 1.2, 7);
  const stopLoss = bullish
    ? entryPrice * (1 - stopDistancePct / 100)
    : entryPrice * (1 + stopDistancePct / 100);
  const takeProfit = bullish
    ? entryPrice * (1 + targetDistancePct / 100)
    : entryPrice * (1 - targetDistancePct / 100);
  const providerConfirmation = buildProviderConfirmationFromContext(marketContext, {
    confirmation_options: {
      maxPriceDiffPct: policy.maxProviderPriceDiffPct ?? 0.5,
      maxTimeSkewSeconds: policy.maxProviderTimeSkewSeconds ?? 60,
    },
    trade_side: bullish ? 'buy' : 'sell',
    sellMaxPriceDiffPct: policy.sellMaxProviderPriceDiffPct ?? 0.75,
    alpaca_options: {
      maxStalenessSeconds: policy.maxStalenessSeconds ?? 60,
    },
    twelve_options: {
      maxStalenessSeconds: policy.maxStalenessSeconds ?? 60,
    },
  });
  const freshnessScore = normalizedMarketData.stale
    ? 10
    : clamp(100 - safeNumber(normalizedMarketData.latency_ms, 0) / 1000, 0, 100);
  const sourceQualityScore = clamp(
    safeNumber(normalizedMarketData.reliability_score, 50)
      + (normalizedMarketData.provider_timestamp_valid ? 10 : -20)
      + (providerConfirmation?.confirmed ? 15 : 0),
    0,
    100,
  );
  const contradictionScore = clamp(
    (providerConfirmation && !providerConfirmation.confirmed ? providerConfirmation.discrepancy_score : 0)
      + (normalizedMarketData.requires_confirmation ? 15 : 0)
      + (normalizedMarketData.provider_timestamp_valid ? 0 : 20),
    0,
    100,
  );
  const riskScore = clamp(
    (normalizedMarketData.stale ? 60 : 20)
      + Math.min(20, Math.abs(movePct) * 4)
      + Math.min(20, safeNumber(rawInput.spread_slippage_pct ?? marketContext.spread_slippage_pct ?? 0, 0) * 10)
      + (safeNumber(normalizedMarketData.volume, 0) <= 0 ? 15 : 0),
    0,
    100,
  );
  const confidenceScore = clamp(
    safeNumber(normalizedMarketData.confidence_score, 50)
      + (providerConfirmation?.confirmed ? 12 : -8)
      + Math.min(15, Math.abs(movePct) * 2),
    0,
    100,
  );
  const liquidityScore = clamp(
    safeNumber(normalizedMarketData.volume, 0) > 0
      ? Math.min(100, (safeNumber(normalizedMarketData.volume, 0) / Math.max(1, safeNumber(policy.minVolume ?? 50000, 50000))) * 40)
      : 0,
    0,
    100,
  );
  const notional = safeNumber(options.notional ?? policy.defaultNotional ?? 25, 25);
  const signal = scoreSignal({
    signal_id: rawInput.signal_id || `sig_${hashObject({
      provider: normalizedMarketData.provider_name,
      symbol: normalizedMarketData.symbol,
      timestamp: normalizedMarketData.timestamp,
      price: normalizedMarketData.price,
      movePct: Number.isFinite(movePct) ? movePct.toFixed(4) : 'na',
    }).slice(0, 16)}`,
    asset_id: normalizedMarketData.provider_asset_id || null,
    symbol: normalizedMarketData.symbol,
    asset_type: normalizedMarketData.asset_type,
    strategy_name: rawInput.strategy_name || `real-${normalizedMarketData.kind}-momentum`,
    timeframe: rawInput.timeframe || (normalizedMarketData.kind === 'quote' ? '1m' : normalizedMarketData.kind),
    direction: bullish ? 'bullish' : 'bearish',
    action_candidate: bullish ? 'paper_buy' : 'paper_sell',
    confidence_score: confidenceScore,
    freshness_score: freshnessScore,
    source_quality_score: sourceQualityScore,
    contradiction_score: contradictionScore,
    risk_score: riskScore,
    provider_confirmation_score: providerConfirmation
      ? providerConfirmation.confirmed
        ? clamp(100 - safeNumber(providerConfirmation.discrepancy_score, 0), 0, 100)
        : clamp(35 - safeNumber(providerConfirmation.discrepancy_score, 0), 0, 100)
      : 50,
    edge_score: undefined,
    entry_price: entryPrice,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    volume: normalizedMarketData.volume,
    liquidity_score: liquidityScore,
    notional,
    market_context: {
      ...marketContext,
      primary_quote: marketContext.primary_quote || normalizedMarketData,
      provider_confirmation: providerConfirmation || null,
    },
    provider_confirmation: providerConfirmation || null,
    created_at: rawInput.created_at || normalizedMarketData.received_at || nowIso(),
  }, {
    min_confidence_for_paper: policy.minConfidenceForPaper ?? 72,
    min_edge_score: policy.minEdgeScore ?? 60,
    min_freshness_score: policy.minFreshnessScore ?? 55,
    min_provider_confirmation_score: policy.minProviderConfirmationScore ?? 70,
    market_context: {
      ...marketContext,
      primary_quote: marketContext.primary_quote || normalizedMarketData,
      secondary_quote: marketContext.secondary_quote || marketContext.twelve_data_quote || null,
      alpaca_quote: marketContext.alpaca_quote || normalizedMarketData,
      twelve_data_quote: marketContext.twelve_data_quote || null,
      provider_confirmation: providerConfirmation || null,
    },
    provider_confirmation: providerConfirmation || null,
    provider_confirmation_options: {
      maxPriceDiffPct: policy.maxProviderPriceDiffPct ?? 0.5,
      maxTimeSkewSeconds: policy.maxProviderTimeSkewSeconds ?? 60,
    },
    min_freshness_score: policy.minFreshnessScore ?? 55,
    min_edge_score: policy.minEdgeScore ?? 60,
  });

  return {
    accepted: signal.final_decision === 'approved_for_paper',
    action_candidate: signal.action_candidate,
    reason_codes: signal.decision_reasons || [],
    normalized_market_data: normalizedMarketData,
    provider_confirmation: providerConfirmation || null,
    signal,
  };
}

module.exports = {
  deriveMarketActivitySignal,
};
