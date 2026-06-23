const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const caseCheck = require('../scripts/check-case-sensitive-imports');
const { resolveRiskPolicyPath } = require('../src/replay-cli');

const {
  AlpacaTradeAdapter,
  buildPaperOrderRequestFromSignal,
  buildAlpacaOrderPayload,
  buildExecutionAdapter,
  confirmAlpacaTwelveData,
  buildProviderConfirmationFromContext,
  InMemoryAuditStore,
  computePaperOutcome,
  PaperTradeAdapter,
  buildReviewItem,
  createTradingControlServer,
  createMinimalTradingServer,
  PerformanceStore,
  buildThresholdProposal,
  comparePolicyPerformance,
  deriveMarketActivitySignal,
  scoreSummary,
  scorePolicyInterval,
  evaluateRiskGate,
  generateDailyLiveResultsReport,
  generateDailySummary,
  loadConfig,
  loadRuntimeEnv,
  normalizeMarketData,
  normalizeSymbol,
  runReplay,
  retryWithBackoff,
  scoreSignal,
  resolvePerformanceHistoryPath,
  resolveServerPort,
  refreshPolicySnapshot,
  resolvePolicyPath,
  resolvePolicyHistoryPath,
  processMarketInput,
  processTradingSignal,
  validatePaperOrderWebhookPayload,
  validateProviderTimestamp,
  validateNormalizedMarketData,
  detectContradictions,
  CircuitBreaker,
  startTradingControlServer,
  resolveBuyOrderSizing,
  recordPaperOutcome,
} = require('../src');

test('symbol normalization handles stock and crypto aliases', () => {
  assert.equal(normalizeSymbol('aapl', 'stock'), 'AAPL');
  assert.equal(normalizeSymbol('BTCUSDT', 'crypto'), 'BTC/USDT');
  assert.equal(normalizeSymbol('xbtusd', 'crypto'), 'BTC/USD');
});

test('stale data is rejected', () => {
  const normalized = normalizeMarketData({
    provider: 'alpaca',
    symbol: 'AAPL',
    asset_type: 'stock',
    timestamp: '2026-06-13T00:00:00.000Z',
    received_at: '2026-06-14T00:00:00.000Z',
    price: 200,
    volume: 1000,
  }, { maxStalenessSeconds: 60 });
  const validation = validateNormalizedMarketData(normalized);
  assert.equal(normalized.stale, true);
  assert.equal(validation.pass, false);
  assert(validation.reason_codes.includes('STALE_DATA'));
});

test('provider timestamps are validated', () => {
  const valid = validateProviderTimestamp('2026-06-14T12:00:00.000Z', '2026-06-14T12:00:05.000Z');
  assert.equal(valid.valid, true);

  const invalid = validateProviderTimestamp('not-a-date', '2026-06-14T12:00:05.000Z');
  assert.equal(invalid.valid, false);
  assert.equal(invalid.reason, 'INVALID_TIMESTAMP');
});

test('bad provider payload is rejected', () => {
  const normalized = normalizeMarketData({}, { maxStalenessSeconds: 60 });
  const validation = validateNormalizedMarketData(normalized);
  assert.equal(validation.pass, false);
  assert(validation.reason_codes.includes('MISSING_PROVIDER'));
  assert(validation.reason_codes.includes('MISSING_SYMBOL'));
  assert(validation.reason_codes.includes('MISSING_TIMESTAMP'));
});

test('signal scoring rewards fresh multi-source evidence', () => {
  const scored = scoreSignal({
    signal_id: 'sig-good',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    evidence: [
      { source: 'news', sentiment: 'positive' },
      { source: 'price', sentiment: 'bullish' },
      { source: 'filing', sentiment: 'positive' },
    ],
    unique_sources: 3,
    avg_provider_reliability: 90,
    freshness_score: 95,
    source_quality_score: 88,
    liquidity_score: 92,
    catalyst_score: 87,
    alignment_score: 90,
    risk_score: 20,
  }, { min_confidence_for_paper: 80 });

  assert(scored.confidence_score >= 80);
  assert.equal(scored.final_decision, 'approved_for_paper');
  assert.equal(typeof scored.freshness_score, 'number');
  assert.equal(typeof scored.source_quality_score, 'number');
  assert.equal(typeof scored.contradiction_score, 'number');
  assert.equal(typeof scored.risk_score, 'number');
  assert.equal(typeof scored.edge_score, 'number');
});

test('signal scoring rewards confirmed provider agreement', () => {
  const scored = scoreSignal({
    signal_id: 'sig-confirmed',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 85,
    freshness_score: 90,
    source_quality_score: 90,
    contradiction_score: 5,
    risk_score: 20,
    volume: 150000,
    market_context: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 200,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:03.000Z',
        received_at: '2026-06-14T13:00:04.000Z',
        price: 200.2,
        volume: 100100,
      },
    },
  }, { min_confidence_for_paper: 80 });

  assert.equal(scored.final_decision, 'approved_for_paper');
  assert(scored.provider_confirmation_score >= 90);
});

test('signal scoring blocks conflicted provider agreement', () => {
  const scored = scoreSignal({
    signal_id: 'sig-conflict',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 85,
    freshness_score: 90,
    source_quality_score: 90,
    contradiction_score: 5,
    risk_score: 20,
    volume: 150000,
    market_context: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 200,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:03.000Z',
        received_at: '2026-06-14T13:00:04.000Z',
        price: 208,
        volume: 100100,
      },
    },
  }, { min_confidence_for_paper: 80 });

  assert.equal(scored.final_decision, 'blocked');
  assert(scored.decision_reasons.includes('MULTI_SOURCE_CONFIRMATION_FAILED'));
  assert(scored.provider_confirmation_score < 50);
});

test('contradictory evidence increases contradiction score', () => {
  const contradictory = detectContradictions([
    { sentiment: 'positive' },
    { sentiment: 'bearish' },
    { retracts: true },
  ]);
  assert(contradictory.contradiction_score > 0);
  const clean = detectContradictions([{ sentiment: 'positive' }]);
  assert(contradictory.contradiction_score > clean.contradiction_score);
});

test('risk gate approves safe paper candidates', () => {
  const signal = scoreSignal({
    signal_id: 'sig-1',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 90,
    liquidity_score: 90,
    freshness_score: 95,
    provider_confirmation_score: 95,
    risk_score: 20,
    volume: 150000,
    market_context: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 200,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:03.000Z',
        received_at: '2026-06-14T13:00:04.000Z',
        price: 200.2,
        volume: 100100,
      },
    },
  });

  const decision = evaluateRiskGate(signal, {
    trade_count_today: 1,
    daily_loss: 0,
    position_notional: 0,
    available: true,
    position_notional_by_asset: {},
    exposure_by_sector: {},
  }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    minConfidenceForPaper: 72,
    minLiquidityScore: 40,
    minVolume: 50000,
  }, {
    market_closed: false,
    volatility_pct: 2,
    spread_slippage_pct: 0.1,
    volume: 150000,
  });

  assert.equal(decision.decision, 'APPROVED_FOR_PAPER');
  assert.equal(decision.pass, true);
});

test('risk gate blocks mismatched alpaca and twelve data confirmation', () => {
  const signal = scoreSignal({
    signal_id: 'sig-confirmation',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 90,
    liquidity_score: 90,
    freshness_score: 95,
    provider_confirmation_score: 95,
    risk_score: 20,
    volume: 150000,
    market_context: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 200,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:03.000Z',
        received_at: '2026-06-14T13:00:04.000Z',
        price: 200.2,
        volume: 100100,
      },
    },
  });

  const decision = evaluateRiskGate(signal, {
    trade_count_today: 0,
    daily_loss: 0,
    position_notional: 0,
    available: true,
    position_notional_by_asset: {},
    exposure_by_sector: {},
  }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    minConfidenceForPaper: 72,
    minLiquidityScore: 40,
    minVolume: 50000,
  }, {
    market_closed: false,
    volatility_pct: 2,
    spread_slippage_pct: 0.1,
    volume: 150000,
    alpaca_quote: {
      provider: 'alpaca',
      symbol: 'AAPL',
      asset_type: 'stock',
      timestamp: '2026-06-14T13:00:00.000Z',
      received_at: '2026-06-14T13:00:01.000Z',
      price: 200,
      volume: 100000,
    },
    twelve_data_quote: {
      provider: 'twelvedata',
      symbol: 'AAPL',
      asset_type: 'stock',
      timestamp: '2026-06-14T13:00:03.000Z',
      received_at: '2026-06-14T13:00:04.000Z',
      price: 204,
      volume: 100100,
    },
  });

  assert.equal(decision.decision, 'BLOCKED');
  assert.equal(decision.pass, false);
  assert(decision.reason_codes.includes('MULTI_SOURCE_CONFIRMATION_FAILED'));
  assert.equal(decision.multi_source_confirmation.confirmed, false);
});

test('sell-side provider confirmation is looser than buy-side confirmation', () => {
  const buySignal = scoreSignal({
    signal_id: 'sig-buy-confirmation',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 90,
    freshness_score: 90,
    source_quality_score: 90,
    contradiction_score: 5,
    risk_score: 20,
    volume: 150000,
    market_context: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 200,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:03.000Z',
        received_at: '2026-06-14T13:00:04.000Z',
        price: 201.5,
        volume: 100100,
      },
    },
  }, { min_confidence_for_paper: 80 });

  assert.equal(buySignal.final_decision, 'blocked');
  assert(buySignal.decision_reasons.includes('MULTI_SOURCE_CONFIRMATION_FAILED'));

  const sellSignal = scoreSignal({
    signal_id: 'sig-sell-confirmation',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bearish',
    stop_loss: 202,
    take_profit: 194,
    confidence_score: 90,
    freshness_score: 90,
    source_quality_score: 90,
    contradiction_score: 5,
    risk_score: 20,
    volume: 150000,
    market_context: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 200,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:03.000Z',
        received_at: '2026-06-14T13:00:04.000Z',
        price: 201.5,
        volume: 100100,
      },
    },
  }, { min_confidence_for_paper: 80 });

  assert.equal(sellSignal.final_decision, 'approved_for_paper');
  assert.equal(sellSignal.decision_reasons.includes('MULTI_SOURCE_CONFIRMATION_FAILED'), false);
});

test('risk gate allows reward-risk ratios that are effectively at the threshold', () => {
  const signal = scoreSignal({
    signal_id: 'sig-reward-risk',
    symbol: 'ETH/USD',
    asset_type: 'crypto',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bearish',
    stop_loss: 1790,
    take_profit: 1748.5,
    confidence_score: 90,
    liquidity_score: 90,
    freshness_score: 95,
    provider_confirmation_score: 95,
    risk_score: 20,
    volume: 150000,
    market_context: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'ETH/USD',
        asset_type: 'crypto',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 1778,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'ETH/USD',
        asset_type: 'crypto',
        timestamp: '2026-06-14T13:00:03.000Z',
        received_at: '2026-06-14T13:00:04.000Z',
        price: 1778.1,
        volume: 100100,
      },
    },
  });

  const decision = evaluateRiskGate(signal, {
    trade_count_today: 0,
    daily_loss: 0,
    position_notional: 0,
    available: true,
    position_notional_by_asset: {},
    exposure_by_sector: {},
  }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    minConfidenceForPaper: 72,
    minLiquidityScore: 40,
    minVolume: 50000,
  }, {
    market_closed: false,
    volatility_pct: 2,
    spread_slippage_pct: 0.1,
    volume: 150000,
    alpaca_quote: {
      provider: 'alpaca',
      symbol: 'ETH/USD',
      asset_type: 'crypto',
      timestamp: '2026-06-14T13:00:00.000Z',
      received_at: '2026-06-14T13:00:01.000Z',
      price: 1778,
      volume: 100000,
    },
    twelve_data_quote: {
      provider: 'twelvedata',
      symbol: 'ETH/USD',
      asset_type: 'crypto',
      timestamp: '2026-06-14T13:00:03.000Z',
      received_at: '2026-06-14T13:00:04.000Z',
      price: 1778.1,
      volume: 100100,
    },
  });

  assert.equal(decision.decision, 'APPROVED_FOR_PAPER');
  assert.equal(decision.pass, true);
});

test('risk gate applies the policy size multiplier to exposure limits', () => {
  const signal = scoreSignal({
    signal_id: 'sig-size',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 90,
    liquidity_score: 90,
    freshness_score: 95,
    risk_score: 20,
    volume: 150000,
    market_context: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 200,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:03.000Z',
        received_at: '2026-06-14T13:00:04.000Z',
        price: 200.2,
        volume: 100100,
      },
    },
  });

  const strictDecision = evaluateRiskGate(signal, {
    trade_count_today: 0,
    daily_loss: 0,
    position_notional: 600,
    available: true,
    position_notional_by_asset: {},
    exposure_by_sector: {},
  }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    minConfidenceForPaper: 72,
    minLiquidityScore: 40,
    minVolume: 50000,
    positionSizeMultiplier: 0.5,
  }, {
    market_closed: false,
    volatility_pct: 2,
    spread_slippage_pct: 0.1,
    volume: 150000,
  });

  const relaxedDecision = evaluateRiskGate(signal, {
    trade_count_today: 0,
    daily_loss: 0,
    position_notional: 600,
    available: true,
    position_notional_by_asset: {},
    exposure_by_sector: {},
  }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    minConfidenceForPaper: 72,
    minLiquidityScore: 40,
    minVolume: 50000,
    positionSizeMultiplier: 1.25,
  }, {
    market_closed: false,
    volatility_pct: 2,
    spread_slippage_pct: 0.1,
    volume: 150000,
  });

  assert.equal(strictDecision.decision, 'BLOCKED');
  assert.strictEqual(strictDecision.reason_codes.includes('MAX_POSITION_SIZE_EXCEEDED'), true);
  assert.equal(relaxedDecision.decision, 'APPROVED_FOR_PAPER');
});

test('risk gate blocks when the open position count reaches the cap', () => {
  const signal = scoreSignal({
    signal_id: 'sig-open-positions',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 90,
    liquidity_score: 90,
    freshness_score: 95,
    source_quality_score: 90,
    provider_confirmation_score: 95,
    risk_score: 20,
    volume: 150000,
    market_context: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 200,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:03.000Z',
        received_at: '2026-06-14T13:00:04.000Z',
        price: 200.2,
        volume: 100100,
      },
    },
  });

  const cappedDecision = evaluateRiskGate(signal, {
    trade_count_today: 0,
    daily_loss: 0,
    position_notional: 0,
    open_positions_count: 8,
    available: true,
    position_notional_by_asset: {},
    exposure_by_sector: {},
  }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    maxOpenPositions: 8,
    minConfidenceForPaper: 72,
    minLiquidityScore: 40,
    minVolume: 50000,
  }, {
    market_closed: false,
    volatility_pct: 2,
    spread_slippage_pct: 0.1,
    volume: 150000,
  });

  const expandedDecision = evaluateRiskGate(signal, {
    trade_count_today: 0,
    daily_loss: 0,
    position_notional: 0,
    open_positions_count: 8,
    available: true,
    position_notional_by_asset: {},
    exposure_by_sector: {},
  }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    maxOpenPositions: 9,
    minConfidenceForPaper: 72,
    minLiquidityScore: 40,
    minVolume: 50000,
  }, {
    market_closed: false,
    volatility_pct: 2,
    spread_slippage_pct: 0.1,
    volume: 150000,
  });

  assert.equal(cappedDecision.decision, 'BLOCKED');
  assert(cappedDecision.reason_codes.includes('MAX_OPEN_POSITIONS_EXCEEDED'));
  assert.equal(expandedDecision.decision, 'APPROVED_FOR_PAPER');
});

test('default policy snapshot allows wider open-position concurrency', () => {
  const store = new PerformanceStore();
  const snapshot = store.getPolicySnapshot();
  assert.equal(snapshot.policy.maxOpenPositions, 12);
});

test('risk gate blocks when fill quality degrades', () => {
  const signal = scoreSignal({
    signal_id: 'sig-fill-quality',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 90,
    liquidity_score: 90,
    freshness_score: 95,
    source_quality_score: 90,
    provider_confirmation_score: 95,
    risk_score: 20,
    volume: 150000,
    market_context: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 200,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:03.000Z',
        received_at: '2026-06-14T13:00:04.000Z',
        price: 200.2,
        volume: 100100,
      },
    },
  });

  const decision = evaluateRiskGate(signal, {
    trade_count_today: 0,
    daily_loss: 0,
    position_notional: 0,
    available: true,
    position_notional_by_asset: {},
    exposure_by_sector: {},
  }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    minConfidenceForPaper: 72,
    minLiquidityScore: 40,
    minVolume: 50000,
  }, {
    market_closed: false,
    volatility_pct: 2,
    spread_slippage_pct: 0.1,
    volume: 150000,
    fill_quality_summary: {
      count: 6,
      fill_rate: 0.45,
      partial_fill_rate: 0.25,
      rejection_rate: 0.1,
    },
  });

  assert.equal(decision.decision, 'BLOCKED');
  assert(decision.reason_codes.includes('LOW_FILL_RATE'));
  assert(decision.reason_codes.includes('HIGH_PARTIAL_FILL_RATE'));
});

test('risk gate blocks unsafe signals', () => {
  const signal = scoreSignal({
    signal_id: 'sig-2',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 50,
    liquidity_score: 20,
    freshness_score: 20,
    risk_score: 85,
    expires_at: '2026-06-13T00:00:00.000Z',
  });

  const decision = evaluateRiskGate(signal, { trade_count_today: 10, daily_loss: -500, available: true }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    minConfidenceForPaper: 72,
  }, {});

  assert.equal(decision.decision, 'BLOCKED');
  assert(decision.reason_codes.length > 0);
});

test('risk gate blocks low freshness and weak source quality', () => {
  const freshDecision = evaluateRiskGate({
    signal_id: 'sig-fresh',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 82,
    freshness_score: 20,
    source_quality_score: 75,
    contradiction_score: 10,
    risk_score: 20,
    liquidity_score: 90,
    volume: 100000,
  }, { available: true, trade_count_today: 0, daily_loss: 0, position_notional: 0, position_notional_by_asset: {}, exposure_by_sector: {} }, { killSwitch: false, paperAdapterEnabled: true, requireHumanApproval: true }, {});

  const weakSourceDecision = evaluateRiskGate({
    signal_id: 'sig-source',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 82,
    freshness_score: 90,
    source_quality_score: 20,
    contradiction_score: 10,
    risk_score: 20,
    liquidity_score: 90,
    volume: 100000,
  }, { available: true, trade_count_today: 0, daily_loss: 0, position_notional: 0, position_notional_by_asset: {}, exposure_by_sector: {} }, { killSwitch: false, paperAdapterEnabled: true, requireHumanApproval: true }, {});

  assert.equal(freshDecision.decision, 'BLOCKED');
  assert(freshDecision.reason_codes.includes('LOW_FRESHNESS'));
  assert.equal(weakSourceDecision.decision, 'BLOCKED');
  assert(weakSourceDecision.reason_codes.includes('LOW_SOURCE_QUALITY'));
});

test('risk gate blocks low provider confirmation', () => {
  const decision = evaluateRiskGate({
    signal_id: 'sig-provider',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 82,
    freshness_score: 90,
    source_quality_score: 90,
    provider_confirmation_score: 20,
    contradiction_score: 10,
    risk_score: 20,
    liquidity_score: 90,
    volume: 100000,
  }, { available: true, trade_count_today: 0, daily_loss: 0, position_notional: 0, position_notional_by_asset: {}, exposure_by_sector: {} }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
  }, {});

  assert.equal(decision.decision, 'BLOCKED');
  assert(decision.reason_codes.includes('LOW_PROVIDER_CONFIRMATION'));
});

test('risk gate allows crypto at the lower crypto provider confirmation floor', () => {
  const decision = evaluateRiskGate({
    signal_id: 'sig-crypto-provider',
    symbol: 'XRP/USD',
    asset_type: 'crypto',
    strategy_name: 'overnight-crypto-momentum',
    timeframe: 'overnight',
    direction: 'bullish',
    stop_loss: 0.98,
    take_profit: 1.04,
    confidence_score: 81,
    freshness_score: 100,
    source_quality_score: 70,
    provider_confirmation_score: 35,
    contradiction_score: 10,
    risk_score: 20,
    liquidity_score: 90,
    volume: 100000,
  }, { available: true, trade_count_today: 0, daily_loss: 0, position_notional: 0, position_notional_by_asset: {}, exposure_by_sector: {} }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    minProviderConfirmationScore: 70,
    minCryptoProviderConfirmationScore: 35,
  }, {});

  assert.equal(decision.decision, 'APPROVED_FOR_PAPER');
  assert.equal(decision.reason_codes.includes('LOW_PROVIDER_CONFIRMATION'), false);
});

test('risk gate blocks low edge score', () => {
  const decision = evaluateRiskGate({
    signal_id: 'sig-edge',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 45,
    freshness_score: 35,
    source_quality_score: 30,
    provider_confirmation_score: 25,
    contradiction_score: 20,
    risk_score: 40,
    edge_score: 20,
    liquidity_score: 35,
    volume: 30000,
  }, { available: true, trade_count_today: 0, daily_loss: 0, position_notional: 0, position_notional_by_asset: {}, exposure_by_sector: {} }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
  }, {});

  assert.equal(decision.decision, 'BLOCKED');
  assert(decision.reason_codes.includes('LOW_EDGE_SCORE'));
});

test('risk gate blocks signals from blocked calibration buckets', () => {
  const decision = evaluateRiskGate({
    signal_id: 'sig-bucket',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 84,
    freshness_score: 90,
    source_quality_score: 90,
    provider_confirmation_score: 95,
    contradiction_score: 10,
    risk_score: 20,
    liquidity_score: 90,
    volume: 100000,
  }, { available: true, trade_count_today: 0, daily_loss: 0, position_notional: 0, position_notional_by_asset: {}, exposure_by_sector: {} }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    blockedCalibrationBuckets: ['80-89'],
  }, {});

  assert.equal(decision.decision, 'BLOCKED');
  assert.equal(decision.confidence_bucket, '80-89');
  assert(decision.reason_codes.includes('BLOCKED_CALIBRATION_BUCKET'));
});

test('risk gate blocks high-confidence buy buckets without touching sells', () => {
  const blockedBuyDecision = evaluateRiskGate({
    signal_id: 'sig-buy-bucket',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    action_candidate: 'paper_buy',
    side: 'buy',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 92,
    freshness_score: 90,
    source_quality_score: 90,
    provider_confirmation_score: 95,
    contradiction_score: 10,
    risk_score: 20,
    liquidity_score: 90,
    volume: 100000,
  }, { available: true, trade_count_today: 0, daily_loss: 0, position_notional: 0, position_notional_by_asset: {}, exposure_by_sector: {} }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    blockedBuyCalibrationBuckets: ['90-100'],
  }, {
    market_closed: false,
    volatility_pct: 2,
    spread_slippage_pct: 0.1,
    volume: 100000,
  });

  const allowedSellDecision = evaluateRiskGate({
    signal_id: 'sig-sell-bucket',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bearish',
    action_candidate: 'paper_sell',
    side: 'sell',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 92,
    freshness_score: 90,
    source_quality_score: 90,
    provider_confirmation_score: 95,
    contradiction_score: 10,
    risk_score: 20,
    liquidity_score: 90,
    volume: 100000,
  }, { available: true, trade_count_today: 0, daily_loss: 0, position_notional: 0, position_notional_by_asset: {}, exposure_by_sector: {} }, {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    blockedBuyCalibrationBuckets: ['90-100'],
  }, {
    market_closed: false,
    volatility_pct: 2,
    spread_slippage_pct: 0.1,
    volume: 100000,
  });

  assert.equal(blockedBuyDecision.decision, 'BLOCKED');
  assert(blockedBuyDecision.reason_codes.includes('BLOCKED_BUY_CALIBRATION_BUCKET'));
  assert.equal(allowedSellDecision.decision, 'APPROVED_FOR_PAPER');
});

test('alpaca and twelve data confirmation compares multi-source inputs', () => {
  const alpaca = normalizeMarketData({
    provider: 'alpaca',
    symbol: 'AAPL',
    asset_type: 'stock',
    timestamp: '2026-06-14T13:00:00.000Z',
    received_at: '2026-06-14T13:00:01.000Z',
    price: 200,
    volume: 100000,
  });
  const twelve = normalizeMarketData({
    provider: 'twelvedata',
    symbol: 'AAPL',
    asset_type: 'stock',
    timestamp: '2026-06-14T13:00:03.000Z',
    received_at: '2026-06-14T13:00:04.000Z',
    price: 200.4,
    volume: 100100,
  });
  const confirmation = confirmAlpacaTwelveData(alpaca, twelve);
  assert.equal(confirmation.confirmed, true);
  assert.equal(confirmation.reason_codes.length, 0);
});

test('market context provider confirmation is derived from alpaca and twelve data quotes', () => {
  const confirmation = buildProviderConfirmationFromContext({
    alpaca_quote: {
      provider: 'alpaca',
      symbol: 'AAPL',
      asset_type: 'stock',
      timestamp: '2026-06-14T13:00:00.000Z',
      received_at: '2026-06-14T13:00:01.000Z',
      price: 200,
      volume: 100000,
    },
    twelve_data_quote: {
      provider: 'twelvedata',
      symbol: 'AAPL',
      asset_type: 'stock',
      timestamp: '2026-06-14T13:00:03.000Z',
      received_at: '2026-06-14T13:00:04.000Z',
      price: 200.2,
      volume: 100100,
    },
  });

  assert.equal(confirmation.confirmed, true);
  assert.equal(confirmation.reason_codes.length, 0);
});

test('provider confirmation rejects raw quotes with invalid timestamps', () => {
  const confirmation = buildProviderConfirmationFromContext({
    alpaca_quote: {
      provider: 'alpaca',
      symbol: 'AAPL',
      asset_type: 'stock',
      timestamp: 'not-a-real-timestamp',
      received_at: '2026-06-14T13:00:01.000Z',
      price: 200,
      volume: 100000,
    },
    twelve_data_quote: {
      provider: 'twelvedata',
      symbol: 'AAPL',
      asset_type: 'stock',
      timestamp: '2026-06-14T13:00:03.000Z',
      received_at: '2026-06-14T13:00:04.000Z',
      price: 200.2,
      volume: 100100,
    },
  });

  assert.equal(confirmation.confirmed, false);
  assert(confirmation.reason_codes.includes('INVALID_TIMESTAMP') || confirmation.reason_codes.includes('STALE_DATA'));
});

test('crypto provider confirmation tolerates slightly wider disagreement than stock', () => {
  const cryptoConfirmation = buildProviderConfirmationFromContext({
    alpaca_quote: {
      provider: 'alpaca',
      symbol: 'DOT/USD',
      asset_type: 'crypto',
      timestamp: '2026-06-14T13:00:00.000Z',
      received_at: '2026-06-14T13:00:01.000Z',
      price: 1.00,
      volume: 100000,
    },
    twelve_data_quote: {
      provider: 'twelvedata',
      symbol: 'DOT/USD',
      asset_type: 'crypto',
      timestamp: '2026-06-14T13:01:10.000Z',
      received_at: '2026-06-14T13:01:11.000Z',
      price: 1.01,
      volume: 100100,
    },
  });
  assert.equal(cryptoConfirmation.confirmed, true);
  assert.equal(cryptoConfirmation.reason_codes.length, 0);

  const stockConfirmation = buildProviderConfirmationFromContext({
    alpaca_quote: {
      provider: 'alpaca',
      symbol: 'AAPL',
      asset_type: 'stock',
      timestamp: '2026-06-14T13:00:00.000Z',
      received_at: '2026-06-14T13:00:01.000Z',
      price: 200,
      volume: 100000,
    },
    twelve_data_quote: {
      provider: 'twelvedata',
      symbol: 'AAPL',
      asset_type: 'stock',
      timestamp: '2026-06-14T13:01:10.000Z',
      received_at: '2026-06-14T13:01:11.000Z',
      price: 202.5,
      volume: 100100,
    },
  });
  assert.equal(stockConfirmation.confirmed, false);
  assert(stockConfirmation.reason_codes.includes('PRICE_DISAGREEMENT') || stockConfirmation.reason_codes.includes('TIMESTAMP_SKEW'));
});

test('real market data can be turned into an actionable signal when alpaca and twelve data agree', () => {
  const activity = deriveMarketActivitySignal({
    provider: 'alpaca',
    symbol: 'AAPL',
    asset_type: 'stock',
    kind: 'quote',
    timestamp: '2026-06-14T13:00:00.000Z',
    received_at: '2026-06-14T13:00:01.000Z',
    price: 205,
    previous_close: 200,
    volume: 150000,
    confidence: 92,
    reliability: 90,
    market_context: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        kind: 'quote',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 205,
        previous_close: 200,
        volume: 150000,
        confidence: 92,
        reliability: 90,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        kind: 'quote',
        timestamp: '2026-06-14T13:00:02.000Z',
        received_at: '2026-06-14T13:00:03.000Z',
        price: 205.15,
        previous_close: 200,
        volume: 150100,
        confidence: 91,
        reliability: 89,
      },
    },
  }, {
    policy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minVolume: 50000,
    },
  });

  assert.equal(activity.accepted, true);
  assert.equal(activity.signal.final_decision, 'approved_for_paper');
  assert.equal(activity.signal.action_candidate, 'paper_buy');
  assert(activity.signal.provider_confirmation_score >= 70);
  assert(activity.signal.freshness_score >= 0);
  assert(activity.signal.source_quality_score >= 0);
});

test('real market data ingestion rejects stale provider timestamps', () => {
  const activity = deriveMarketActivitySignal({
    provider: 'alpaca',
    symbol: 'AAPL',
    asset_type: 'stock',
    kind: 'quote',
    timestamp: '2026-06-13T13:00:00.000Z',
    received_at: '2026-06-14T13:00:01.000Z',
    price: 205,
    previous_close: 200,
    volume: 150000,
    confidence: 92,
    reliability: 90,
  });

  assert.equal(activity.accepted, false);
  assert(activity.reason_codes.includes('STALE_DATA') || activity.reason_codes.includes('INVALID_TIMESTAMP'));
});

test('hold and no-signal decisions are not turned into buy-sell payloads', () => {
  assert.equal(buildPaperOrderRequestFromSignal({
    signal_id: 'sig-hold',
    action_candidate: 'hold',
    symbol: 'AAPL',
  }), null);

  const validation = validatePaperOrderWebhookPayload({ action_candidate: 'no_signal', side: 'buy' });
  assert.equal(validation.pass, false);
  assert(validation.reason_codes.includes('NON_TRADE_DECISION'));
});

test('paper order validation rejects trade decisions without a size', () => {
  const validation = validatePaperOrderWebhookPayload({
    action_candidate: 'paper_buy',
    side: 'buy',
  });

  assert.equal(validation.pass, false);
  assert(validation.reason_codes.includes('MISSING_ORDER_SIZE'));
});

test('processTradingSignal blocks conflicting open orders before broker submission', async () => {
  let submitCount = 0;
  const executionAdapter = {
    async getOpenOrders() {
      return [
        {
          symbol: 'F',
          side: 'sell',
          status: 'new',
          id: 'open-order-1',
        },
      ];
    },
    async submitOrder() {
      submitCount += 1;
      throw new Error('should not submit when open order conflicts');
    },
    async getOrder() {
      throw new Error('should not be called');
    },
  };
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'test',
    captured_at: '2026-06-16T00:00:00.000Z',
    report_date: '2026-06-16',
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      buyNotionalTarget: 200,
    },
  });

  const result = await processTradingSignal({
    signal: {
      signal_id: 'sig-open-conflict',
      symbol: 'F',
      asset_type: 'stock',
      strategy_name: 'breakout',
      timeframe: '5m',
      direction: 'bullish',
      action_candidate: 'paper_buy',
      side: 'buy',
      notional: 1,
      confidence_score: 95,
      freshness_score: 95,
      source_quality_score: 95,
      contradiction_score: 0,
      risk_score: 10,
      provider_confirmation_score: 95,
      edge_score: 90,
      volume: 100000,
      stop_loss: 13,
      take_profit: 15,
      entry_price: 13.75,
      price: 13.75,
      created_at: '2026-06-16T00:00:00.000Z',
    },
    portfolio: { available: true, trade_count_today: 0, daily_loss: 0, position_notional: 0, open_positions_count: 0 },
  }, {
    executionAdapter,
    performance,
    policySnapshot: performance.getPolicySnapshot(),
    buyNotionalTarget: 200,
    source: 'test',
  });

  assert.equal(result.accepted, false);
  assert.equal(result.stage, 'pre_submit');
  assert(result.reason_codes.includes('OPEN_ORDER_CONFLICT'));
  assert(result.reason_codes.includes('WASH_TRADE_RISK'));
  assert.equal(submitCount, 0);
});

test('buy sizing targets about $200 and stays within budget', () => {
  const fractionalSizing = resolveBuyOrderSizing({
    signal_id: 'sig-fractional',
    action_candidate: 'paper_buy',
    symbol: 'AVAX/USD',
    asset_type: 'crypto',
    price: 6.87,
  });

  assert.equal(fractionalSizing.pass, true);
  assert.equal(fractionalSizing.supports_fractional_shares, true);
  assert(fractionalSizing.quantity > 0);
  assert(fractionalSizing.quantity * fractionalSizing.price <= 200);
  assert.equal(fractionalSizing.notional <= 200, true);

  const wholeShareSizing = resolveBuyOrderSizing({
    signal_id: 'sig-whole',
    action_candidate: 'paper_buy',
    symbol: 'AAPL',
    asset_type: 'stock',
    price: 48.25,
  });

  assert.equal(wholeShareSizing.pass, true);
  assert.equal(wholeShareSizing.supports_fractional_shares, false);
  assert.equal(wholeShareSizing.quantity, 4);
  assert.equal(wholeShareSizing.notional, 193);

  const order = buildPaperOrderRequestFromSignal({
    signal_id: 'sig-size',
    action_candidate: 'paper_buy',
    symbol: 'ETH/USD',
    asset_type: 'crypto',
    price: 1792.15,
  });

  assert.equal(order.time_in_force, 'gtc');
  assert.equal(order.notional <= 200, true);
});

test('buy sizing blocks whole-share assets that cannot fit one share inside the budget', () => {
  const sizing = resolveBuyOrderSizing({
    signal_id: 'sig-too-expensive',
    action_candidate: 'paper_buy',
    symbol: 'AAPL',
    asset_type: 'stock',
    price: 250,
  });

  assert.equal(sizing.pass, false);
  assert(sizing.reason_codes.includes('BUY_BUDGET_TOO_SMALL_FOR_WHOLE_SHARES'));
  assert.equal(buildPaperOrderRequestFromSignal({
    signal_id: 'sig-too-expensive',
    action_candidate: 'paper_buy',
    symbol: 'AAPL',
    asset_type: 'stock',
    price: 250,
  }), null);
});

test('buy notional target is configurable with a sane default', () => {
  const defaultConfig = loadConfig({});
  assert.equal(defaultConfig.BUY_NOTIONAL_TARGET, 200);

  const customConfig = loadConfig({
    BUY_NOTIONAL_TARGET: '150',
  });
  assert.equal(customConfig.BUY_NOTIONAL_TARGET, 150);

  const customSizing = resolveBuyOrderSizing({
    signal_id: 'sig-custom-target',
    action_candidate: 'paper_buy',
    symbol: 'AAPL',
    asset_type: 'stock',
    price: 48.25,
  }, {
    buyNotionalTarget: customConfig.BUY_NOTIONAL_TARGET,
  });

  assert.equal(customSizing.quantity, 3);
  assert.equal(customSizing.notional, 144.75);
});

test('blocked buy calibration buckets are configurable', () => {
  const config = loadConfig({
    BLOCKED_BUY_CALIBRATION_BUCKETS: '90-100,80-89',
  });
  assert.deepEqual(config.BLOCKED_BUY_CALIBRATION_BUCKETS, ['90-100', '80-89']);
});

test('block buys is configurable', () => {
  const config = loadConfig({
    BLOCK_BUYS: 'true',
  });
  assert.equal(config.BLOCK_BUYS, true);
});

test('sell confirmation threshold is configurable with a sane default', () => {
  const config = loadConfig({});
  assert.equal(config.MIN_SELL_PROVIDER_CONFIRMATION_SCORE, 60);
  assert.equal(config.SELL_MAX_PROVIDER_PRICE_DIFF_PCT, 0.75);

  const custom = loadConfig({
    MIN_SELL_PROVIDER_CONFIRMATION_SCORE: '55',
    SELL_MAX_PROVIDER_PRICE_DIFF_PCT: '0.9',
  });
  assert.equal(custom.MIN_SELL_PROVIDER_CONFIRMATION_SCORE, 55);
  assert.equal(custom.SELL_MAX_PROVIDER_PRICE_DIFF_PCT, 0.9);
});

test('sell outcomes use the position cost basis to compute realized pnl', () => {
  const performance = new PerformanceStore({});
  const outcome = recordPaperOutcome(
    performance,
    {
      signal_id: 'sell-pnl-proof',
      symbol: 'LINK/USD',
      direction: 'bearish',
      side: 'sell',
      position_avg_entry_price: 10,
      position_qty_available: 2,
      quantity: 2,
      entry_price: 11,
      created_at: '2026-06-17T00:00:00.000Z',
    },
    {
      order_id: 'sell-pnl-proof',
      status: 'filled',
      filled_at: '2026-06-17T00:01:00.000Z',
      average_fill_price: 11,
      filled_quantity: 2,
      estimated_fees: 0,
    },
  );

  assert.equal(outcome.paper_result.entry_price, 10);
  assert.equal(outcome.paper_result.exit_price, 11);
  assert.equal(outcome.pnl, 2);
  assert.equal(outcome.status, 'filled');
});

test('paper adapter prevents duplicate submissions', () => {
  const adapter = new PaperTradeAdapter();
  const orderRequest = {
    request_id: 'req-1',
    signal_id: 'sig-1',
    asset_id: 'asset-aapl',
    symbol: 'AAPL',
    side: 'buy',
    order_type: 'market',
    quantity: 1,
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 90,
  };

  const first = adapter.submitOrder(orderRequest, { market: { price: 200 } });
  const second = adapter.submitOrder(orderRequest, { market: { price: 200 } });
  assert.equal(first.order_id, second.order_id);
  assert.equal(adapter.listOrders().length, 1);
});

test('order lifecycle transitions are recorded', () => {
  const adapter = new PaperTradeAdapter();
  const order = adapter.proposeOrder({
    request_id: 'req-2',
    signal_id: 'sig-2',
    symbol: 'AAPL',
    side: 'buy',
    quantity: 1,
    order_type: 'market',
  });
  adapter.transitionOrder(order.order_id, 'risk_checked', {});
  adapter.transitionOrder(order.order_id, 'approval_required', {});
  adapter.transitionOrder(order.order_id, 'approved', {});
  adapter.transitionOrder(order.order_id, 'submitted_to_paper', {});
  adapter.transitionOrder(order.order_id, 'accepted', {});
  adapter.transitionOrder(order.order_id, 'filled', { filled_quantity: 1, average_fill_price: 200 });
  adapter.transitionOrder(order.order_id, 'reconciled', {});
  assert.equal(adapter.getOrder(order.order_id).status, 'reconciled');
  assert(adapter.getOrder(order.order_id).state_history.length >= 1);
});

test('audit log writes payload hashes', () => {
  const audit = new InMemoryAuditStore();
  const event = audit.writeEvent({
    event_type: 'signal_created',
    related_entity_id: 'sig-1',
    payload: { symbol: 'AAPL' },
  });
  assert.equal(audit.events.length, 1);
  assert.equal(event.related_entity_id, 'sig-1');
  assert.equal(typeof event.payload_hash, 'string');
});

test('paper outcome tracking computes MFE MAE PnL and calibration bucket', () => {
  const outcome = computePaperOutcome({
    original_signal: { confidence_score: 83 },
    paper_result: { status: 'closed', average_fill_price: 101, estimated_fees: 0.5 },
    entry_price: 100,
    exit_price: 112,
    high_price: 116,
    low_price: 96,
    quantity: 2,
    side: 'buy',
  });

  assert.equal(outcome.win_loss, 'win');
  assert.equal(outcome.calibration_bucket, '80-89');
  assert.equal(outcome.pnl, 24);
  assert.equal(outcome.execution_drag > 0, true);
  assert.equal(typeof outcome.execution_drag_ratio, 'number');
  assert.equal(outcome.adjusted_pnl < outcome.pnl, true);
  assert.equal(outcome.max_favorable_excursion, 32);
  assert.equal(outcome.max_adverse_excursion, 8);
  assert.equal(outcome.status, 'closed');
  assert.equal(outcome.paper_result.status, 'closed');
});

test('paper outcome inference marks filled executions when status is omitted', () => {
  const outcome = computePaperOutcome({
    original_signal: { confidence_score: 83 },
    paper_result: { average_fill_price: 101, estimated_fees: 0.5, filled_at: '2026-06-14T10:00:00.000Z' },
    entry_price: 100,
    exit_price: 112,
    high_price: 116,
    low_price: 96,
    quantity: 2,
    side: 'buy',
  });

  assert.equal(outcome.status, 'filled');
  assert.equal(outcome.paper_result.status, 'filled');
});

test('paper outcome leaves open fills as unknown until an exit exists', () => {
  const outcome = computePaperOutcome({
    original_signal: { confidence_score: 83 },
    paper_result: { status: 'filled', average_fill_price: 101, estimated_fees: 0.5, filled_at: '2026-06-14T10:00:00.000Z' },
    entry_price: 100,
    exit_price: null,
    high_price: null,
    low_price: null,
    quantity: 2,
    side: 'buy',
  });

  assert.equal(outcome.win_loss, 'unknown');
  assert.equal(outcome.pnl, null);
  assert.equal(outcome.adjusted_pnl, null);
});

test('paper adapter records outcome details on orders', () => {
  const adapter = new PaperTradeAdapter();
  const order = adapter.submitOrder({
    request_id: 'req-outcome',
    signal_id: 'sig-outcome',
    symbol: 'AAPL',
    side: 'buy',
    quantity: 1,
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 88,
    original_signal: { confidence_score: 88, symbol: 'AAPL' },
  }, { market: { price: 200 } });
  const outcome = adapter.recordOutcome(order.order_id, {
    entry_price: 200,
    exit_price: 210,
    high_price: 214,
    low_price: 197,
    quantity: 1,
  });
  assert.equal(outcome.pnl, 10);
  assert(outcome.execution_drag > 0);
  assert(outcome.adjusted_pnl < outcome.pnl);
  assert.equal(adapter.getOrder(order.order_id).paper_outcome.win_loss, 'win');
});

test('alpaca order payload maps bracket orders and auth headers', async () => {
  const payload = buildAlpacaOrderPayload({
    request_id: 'req-alpaca',
    signal_id: 'sig-alpaca',
    symbol: 'AAPL',
    side: 'buy',
    order_type: 'market',
    quantity: 2,
    limit_price: 190.12345,
    stop_loss: 190.98765,
    take_profit: 220.54321,
    time_in_force: 'day',
  });
  assert.equal(payload.client_order_id, 'req-alpaca');
  assert.equal(payload.qty, '2');
  assert.equal(payload.order_class, 'bracket');
  assert.equal(payload.limit_price, '190.12');
  assert.equal(payload.take_profit.limit_price, '220.54');
  assert.equal(payload.stop_loss.stop_price, '190.99');

  const requests = [];
  const adapter = new AlpacaTradeAdapter({
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    baseUrl: 'https://paper-api.alpaca.markets',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'alpaca-order-1', status: 'accepted' }),
      };
    },
  });
  const result = await adapter.submitOrder({
    request_id: 'req-alpaca',
    signal_id: 'sig-alpaca',
    symbol: 'AAPL',
    side: 'buy',
    order_type: 'market',
    quantity: 2,
    stop_loss: 190,
    take_profit: 220,
    time_in_force: 'day',
  });
  assert.equal(result.order_id, 'alpaca-order-1');
  assert.equal(requests[0].url, 'https://paper-api.alpaca.markets/v2/orders');
  assert.equal(requests[0].init.headers['APCA-API-KEY-ID'], 'key');
  assert.equal(requests[0].init.headers['APCA-API-SECRET-KEY'], 'secret');
});

test('alpaca crypto orders strip bracket exits before submission', async () => {
  const payload = buildAlpacaOrderPayload({
    request_id: 'req-crypto',
    signal_id: 'sig-crypto',
    symbol: 'ETH/USD',
    asset_type: 'crypto',
    side: 'buy',
    order_type: 'market',
    notional: 50,
    stop_loss: 1777,
    take_profit: 1825,
    time_in_force: 'gtc',
  });
  assert.equal(payload.order_class, undefined);
  assert.equal(payload.take_profit, undefined);
  assert.equal(payload.stop_loss, undefined);
  assert.equal(payload.notional, '50');

  const requests = [];
  const adapter = new AlpacaTradeAdapter({
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    baseUrl: 'https://api.alpaca.markets',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'alpaca-order-crypto', status: 'accepted' }),
      };
    },
  });
  const result = await adapter.submitOrder({
    request_id: 'req-crypto',
    signal_id: 'sig-crypto',
    symbol: 'ETH/USD',
    asset_type: 'crypto',
    side: 'buy',
    order_type: 'market',
    notional: 50,
    stop_loss: 1777,
    take_profit: 1825,
    time_in_force: 'gtc',
  });
  assert.equal(result.order_id, 'alpaca-order-crypto');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.order_class, undefined);
  assert.equal(body.take_profit, undefined);
  assert.equal(body.stop_loss, undefined);
  assert.equal(body.notional, '50');
});

test('alpaca execution adapter strips brackets for fractional stock orders', async () => {
  const requests = [];
  const adapter = new AlpacaTradeAdapter({
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    baseUrl: 'https://api.alpaca.markets',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'alpaca-order-fractional', status: 'accepted' }),
      };
    },
  });

  const result = await adapter.submitOrder({
    request_id: 'req-fractional',
    signal_id: 'sig-fractional',
    symbol: 'INTC',
    asset_type: 'stock',
    side: 'buy',
    order_type: 'market',
    quantity: 0.95,
    supports_fractional_shares: true,
    stop_loss: 127.08,
    take_profit: 156.95,
    time_in_force: 'day',
  });

  assert.equal(result.order_id, 'alpaca-order-fractional');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.order_class, undefined);
  assert.equal(body.take_profit, undefined);
  assert.equal(body.stop_loss, undefined);
  assert.equal(body.time_in_force, 'day');
  assert.equal(body.qty, '0.95');
});

test('alpaca execution adapter infers fractional stock sells from quantity', async () => {
  const requests = [];
  const adapter = new AlpacaTradeAdapter({
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    baseUrl: 'https://api.alpaca.markets',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'alpaca-order-fractional-sell', status: 'accepted' }),
      };
    },
  });

  const result = await adapter.submitOrder({
    request_id: 'req-fractional-sell',
    signal_id: 'sig-fractional-sell',
    symbol: 'NVDA',
    asset_type: 'stock',
    side: 'sell',
    order_type: 'market',
    quantity: 1.280305,
    stop_loss: 202.5,
    take_profit: 198.49,
    time_in_force: 'day',
  });

  assert.equal(result.order_id, 'alpaca-order-fractional-sell');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.order_class, undefined);
  assert.equal(body.take_profit, undefined);
  assert.equal(body.stop_loss, undefined);
  assert.equal(body.side, 'sell');
  assert.equal(body.qty, '1.280305');
});

test('alpaca paper trading adapter strips bracket exits unless explicitly requested', async () => {
  const requests = [];
  const adapter = new AlpacaTradeAdapter({
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    paperTrading: true,
    baseUrl: 'https://paper-api.alpaca.markets',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'alpaca-order-2', status: 'accepted' }),
      };
    },
  });
  await adapter.submitOrder({
    request_id: 'req-alpaca-paper',
    signal_id: 'sig-alpaca-paper',
    symbol: 'AAPL',
    side: 'buy',
    order_type: 'market',
    quantity: 2,
    stop_loss: 190,
    take_profit: 220,
    time_in_force: 'day',
  });
  const payload = JSON.parse(requests[0].init.body);
  assert.equal(payload.order_class, undefined);
  assert.equal(payload.take_profit, undefined);
  assert.equal(payload.stop_loss, undefined);
});

test('unsafe config is rejected', () => {
  assert.throws(() => loadConfig({
    TRADING_MODE: 'live',
    LIVE_TRADING_ENABLED: 'true',
    REQUIRE_HUMAN_APPROVAL: 'false',
  }));
  const config = loadConfig({
    MIN_PROVIDER_CONFIRMATION_SCORE: '75',
    MIN_EDGE_SCORE: '65',
  });
  assert.equal(config.MIN_PROVIDER_CONFIRMATION_SCORE, 75);
  assert.equal(config.MIN_EDGE_SCORE, 65);
  assert.equal(config.MIN_VOLUME, 1000);
  const relaxedConfig = loadConfig({
    MIN_VOLUME: '250',
  });
  assert.equal(relaxedConfig.MIN_VOLUME, 250);
  assert.equal(config.MAX_OPEN_POSITIONS, 12);
  assert.equal(config.AUTO_POLICY_REFRESH, false);
  assert.equal(config.AUTO_POLICY_REFRESH_MIN_BLOCKED_COUNT, 2);
  assert.equal(config.AUTO_POLICY_REFRESH_MIN_REJECTION_PRESSURE_SCORE, 50);
  assert.equal(config.AUTO_POLICY_REFRESH_MIN_PAPER_OUTCOMES, 1);
  const tunedConfig = loadConfig({
    AUTO_POLICY_REFRESH: 'false',
    AUTO_POLICY_REFRESH_MIN_BLOCKED_COUNT: '4',
    AUTO_POLICY_REFRESH_MIN_REJECTION_PRESSURE_SCORE: '65',
    AUTO_POLICY_REFRESH_MIN_PAPER_OUTCOMES: '2',
  });
  assert.equal(tunedConfig.AUTO_POLICY_REFRESH, false);
  assert.equal(tunedConfig.AUTO_POLICY_REFRESH_MIN_BLOCKED_COUNT, 4);
  assert.equal(tunedConfig.AUTO_POLICY_REFRESH_MIN_REJECTION_PRESSURE_SCORE, 65);
  assert.equal(tunedConfig.AUTO_POLICY_REFRESH_MIN_PAPER_OUTCOMES, 2);
  assert.throws(() => loadConfig({
    MIN_PROVIDER_CONFIRMATION_SCORE: '120',
  }), /MIN_PROVIDER_CONFIRMATION_OUT_OF_RANGE/);
  assert.throws(() => loadConfig({
    MIN_EDGE_SCORE: '-1',
  }), /MIN_EDGE_OUT_OF_RANGE/);
  assert.throws(() => loadConfig({
    ALPACA_EXECUTION_ENABLED: 'true',
  }), /ALPACA_API_KEY_ID_REQUIRED/);
});

test('runtime env loader reads .env.local before .env', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-env-'));
  fs.writeFileSync(path.join(tempDir, '.env.local'), [
    'MAX_OPEN_POSITIONS=12',
    'ALPACA_API_BASE_URL=https://paper-api.alpaca.markets',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(tempDir, '.env'), [
    'MAX_OPEN_POSITIONS=3',
    'TRADING_MODE=live',
  ].join('\n'), 'utf8');

  const runtimeEnv = loadRuntimeEnv({}, tempDir);
  assert.equal(runtimeEnv.MAX_OPEN_POSITIONS, '12');
  assert.equal(runtimeEnv.TRADING_MODE, 'live');
  assert.equal(runtimeEnv.ALPACA_API_BASE_URL, 'https://paper-api.alpaca.markets');
});

test('server cli selects paper or alpaca execution adapters from config', () => {
  const paperAdapter = buildExecutionAdapter({}, loadConfig({}), {});
  assert.equal(paperAdapter instanceof PaperTradeAdapter, true);
  const alpacaAdapter = buildExecutionAdapter({
    ALPACA_EXECUTION_ENABLED: 'true',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
    ALPACA_API_BASE_URL: 'https://paper-api.alpaca.markets',
  }, loadConfig({
    ALPACA_EXECUTION_ENABLED: 'true',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
    ALPACA_API_BASE_URL: 'https://paper-api.alpaca.markets',
  }), {});
  assert.equal(alpacaAdapter instanceof AlpacaTradeAdapter, true);
});

test('server cli propagates auto policy refresh settings into the server factory', () => {
  const serverModulePath = require.resolve('../src/server');
  const serverCliPath = require.resolve('../src/server-cli');
  const originalServerModule = require.cache[serverModulePath];
  const originalServerCliModule = require.cache[serverCliPath];
  let capturedOptions = null;

  require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: {
      createTradingControlServer: (options) => {
        capturedOptions = options;
        return {
          listen: () => {},
          on: () => {},
        };
      },
    },
  };
  delete require.cache[serverCliPath];

  const { startTradingControlServer } = require('../src/server-cli');
  startTradingControlServer({
    AUTO_POLICY_REFRESH: 'false',
    AUTO_POLICY_REFRESH_MIN_BLOCKED_COUNT: '7',
    AUTO_POLICY_REFRESH_MIN_REJECTION_PRESSURE_SCORE: '75',
    AUTO_POLICY_REFRESH_MIN_PAPER_OUTCOMES: '3',
    MAX_OPEN_POSITIONS: '14',
  });

  assert.equal(capturedOptions.autoPolicyRefresh, false);
  assert.equal(capturedOptions.autoPolicyRefreshMinBlockedCount, 7);
  assert.equal(capturedOptions.autoPolicyRefreshMinRejectionPressureScore, 75);
  assert.equal(capturedOptions.autoPolicyRefreshMinPaperOutcomes, 3);
  assert.equal(capturedOptions.startupPolicyPatch.policy.maxOpenPositions, 14);

  if (originalServerModule) {
    require.cache[serverModulePath] = originalServerModule;
  } else {
    delete require.cache[serverModulePath];
  }
  if (originalServerCliModule) {
    require.cache[serverCliPath] = originalServerCliModule;
  } else {
    delete require.cache[serverCliPath];
  }
});

test('trader cli starts the bare control server without the overnight scanner by default', () => {
  const minimalCliPath = require.resolve('../src/minimal-cli');
  const traderCliPath = require.resolve('../src/trader-cli');
  const originalMinimalCliModule = require.cache[minimalCliPath];
  const originalTraderCliModule = require.cache[traderCliPath];
  let capturedEnv = null;

  require.cache[minimalCliPath] = {
    id: minimalCliPath,
    filename: minimalCliPath,
    loaded: true,
    exports: {
      startMinimalTradingServer: (env) => {
        capturedEnv = env;
      },
    },
  };
  delete require.cache[traderCliPath];

  const { main } = require('../src/trader-cli');
  main({ PORT: '0' });

  assert.deepEqual(capturedEnv, { PORT: '0' });

  if (originalMinimalCliModule) {
    require.cache[minimalCliPath] = originalMinimalCliModule;
  } else {
    delete require.cache[minimalCliPath];
  }
  if (originalTraderCliModule) {
    require.cache[traderCliPath] = originalTraderCliModule;
  } else {
    delete require.cache[traderCliPath];
  }
});

test('retry and circuit breaker helpers work', async () => {
  let attempts = 0;
  const value = await retryWithBackoff(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error('temporary');
    }
    return 'ok';
  }, { retries: 3, baseDelayMs: 1, maxDelayMs: 2 });

  assert.equal(value, 'ok');
  assert.equal(attempts, 3);

  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10 });
  breaker.recordFailure(Date.now());
  breaker.recordFailure(Date.now());
  assert.equal(breaker.canExecute(Date.now()), false);
});

test('case-sensitive import checker catches mismatched casing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-check-'));
  const aFile = path.join(tempDir, 'consumer.js');
  const bFile = path.join(tempDir, 'TradingviewAlert.schema.js');
  fs.writeFileSync(aFile, "require('./" + "tradingviewAlert.schema');\n", 'utf8');
  fs.writeFileSync(bFile, 'module.exports = {};\n', 'utf8');
  const resolved = caseCheck.resolveRelativeImport(aFile, './tradingviewAlert.schema');
  assert.equal(resolved.ok, true);
  assert.notEqual(caseCheck.assertExactPathCase(resolved.path), null);
  const candidate = path.join(tempDir, 'tradingviewAlert.schema.js');
  assert.notEqual(caseCheck.assertExactPathCase(candidate), null);
});

test('minimal trading loop submits, confirms, and records a paper order', async () => {
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      maxOpenPositions: 5,
      positionSizeMultiplier: 1,
    },
  });

  class MockExecutionAdapter {
    constructor() {
      this.orders = new Map();
      this.submitCalls = [];
      this.getOrderCalls = 0;
    }

    async submitOrder(request) {
      this.submitCalls.push(request);
      const order = {
        order_id: 'ord-1',
        status: 'accepted',
        fill: null,
        request,
      };
      this.orders.set(order.order_id, { ...order });
      return order;
    }

    async getOrder(orderId) {
      this.getOrderCalls += 1;
      const order = this.orders.get(orderId);
      if (!order) {
        throw new Error(`missing order ${orderId}`);
      }
      if (this.getOrderCalls === 1) {
        return { ...order, status: 'accepted' };
      }
      return {
        ...order,
        status: 'filled',
        filled_at: '2026-06-14T13:00:05.000Z',
        average_fill_price: 205.12,
        filled_quantity: 1,
        fill: {
          at: '2026-06-14T13:00:05.000Z',
          average_fill_price: 205.12,
          filled_quantity: 1,
          estimated_fees: 0,
        },
      };
    }
  }

  const executionAdapter = new MockExecutionAdapter();
  const result = await processTradingSignal({
    signal: {
      signal_id: 'sig-live-1',
      symbol: 'AAPL',
      asset_type: 'stock',
      strategy_name: 'breakout',
      timeframe: '5m',
      direction: 'bullish',
      action_candidate: 'paper_buy',
      side: 'buy',
      quantity: 1,
      confidence_score: 95,
      freshness_score: 95,
      source_quality_score: 95,
      contradiction_score: 5,
      risk_score: 10,
      provider_confirmation_score: 95,
      edge_score: 90,
      stop_loss: 198,
      take_profit: 220,
      entry_price: 205,
      price: 205,
      volume: 150000,
      created_at: '2026-06-14T13:00:00.000Z',
      market_context: {
        alpaca_quote: {
          provider: 'alpaca',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T13:00:00.000Z',
          received_at: '2026-06-14T13:00:01.000Z',
          price: 205,
          volume: 150000,
        },
        twelve_data_quote: {
          provider: 'twelvedata',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T13:00:02.000Z',
          received_at: '2026-06-14T13:00:03.000Z',
          price: 205.1,
          volume: 150100,
        },
      },
    },
    portfolio: {
      trade_count_today: 0,
      daily_loss: 0,
      position_notional: 0,
      available: true,
      open_positions_count: 0,
    },
  }, {
    executionAdapter,
    performance,
    policySnapshot: performance.getPolicySnapshot(),
    marketContext: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 205,
        volume: 150000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:02.000Z',
        received_at: '2026-06-14T13:00:03.000Z',
        price: 205.1,
        volume: 150100,
      },
    },
    confirmationAttempts: 3,
    confirmationDelayMs: 1,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.stage, 'order_confirmed');
  assert.equal(executionAdapter.submitCalls.length, 1);
  assert.equal(executionAdapter.getOrderCalls >= 2, true);
  assert.equal(performance.paperOutcomes.length, 1);
  assert.equal(performance.paperOutcomes[0].original_signal.signal_id, 'sig-live-1');
  assert.equal(performance.paperOutcomes[0].paper_result.status, 'filled');
});

test('minimal trading loop rejects stale market input before submitting orders', async () => {
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      maxOpenPositions: 5,
      positionSizeMultiplier: 1,
    },
  });

  const executionAdapter = {
    submitOrder: async () => {
      throw new Error('should not submit for stale data');
    },
  };

  const result = await processMarketInput({
    provider: 'alpaca',
    symbol: 'AAPL',
    asset_type: 'stock',
    kind: 'quote',
    timestamp: '2026-06-10T00:00:00.000Z',
    received_at: '2026-06-14T00:00:00.000Z',
    price: 205,
    previous_close: 200,
    volume: 150000,
  }, {
    executionAdapter,
    performance,
    policySnapshot: performance.getPolicySnapshot(),
  });

  assert.equal(result.accepted, false);
  assert(result.reason_codes.includes('STALE_DATA'));
  assert.equal(performance.paperOutcomes.length, 0);
});

test('minimal server keeps the core loop and rejects legacy admin routes', async () => {
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      maxOpenPositions: 5,
      positionSizeMultiplier: 1,
    },
  });
  const paperAdapter = new PaperTradeAdapter({ dryRun: true });
  const server = createMinimalTradingServer({
    performance,
    paperAdapter,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const signalResponse = await fetch(`http://127.0.0.1:${port}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        signal_id: 'minimal-signal-order',
        symbol: 'AAPL',
        asset_type: 'stock',
        strategy_name: 'breakout',
        timeframe: '5m',
        action_candidate: 'paper_buy',
        direction: 'bullish',
        side: 'buy',
        quantity: 1,
        confidence_score: 95,
        freshness_score: 95,
        source_quality_score: 95,
        contradiction_score: 5,
        risk_score: 10,
        stop_loss: 198,
        take_profit: 220,
        volume: 100000,
        market_context: {
          alpaca_quote: {
            provider: 'alpaca',
            symbol: 'AAPL',
            asset_type: 'stock',
            timestamp: '2026-06-14T13:00:00.000Z',
            received_at: '2026-06-14T13:00:01.000Z',
            price: 205,
            volume: 100000,
          },
          twelve_data_quote: {
            provider: 'twelvedata',
            symbol: 'AAPL',
            asset_type: 'stock',
            timestamp: '2026-06-14T13:00:02.000Z',
            received_at: '2026-06-14T13:00:03.000Z',
            price: 205.1,
            volume: 100100,
          },
        },
      }),
    });
    const signalPayload = await signalResponse.json();
    assert.equal(signalResponse.status, 200);
    assert.equal(signalPayload.stage, 'order_confirmed');
    assert.equal(signalPayload.paper_order.status, 'accepted');
    assert.equal(paperAdapter.listOrders().length, 1);

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    const healthPayload = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(healthPayload.mode, 'minimal-v1');

    const legacyRouteResponse = await fetch(`http://127.0.0.1:${port}/policy-refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'test' }),
    });
    assert.equal(legacyRouteResponse.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('replay mode produces a summary', () => {
  const adapter = new PaperTradeAdapter({ dryRun: true });
  const replay = runReplay([
    {
      market_data: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 200,
        volume: 200000,
      },
      signal: {
        signal_id: 'sig-replay',
        symbol: 'AAPL',
        asset_type: 'stock',
        strategy_name: 'breakout',
        timeframe: '5m',
        direction: 'bullish',
        stop_loss: 190,
        take_profit: 220,
        confidence_score: 90,
        liquidity_score: 90,
        freshness_score: 95,
        risk_score: 10,
        evidence: [{ sentiment: 'positive' }],
      },
      portfolio: {
        trade_count_today: 0,
        daily_loss: 0,
        position_notional: 0,
        available: true,
      },
      market_context: {
        market_closed: false,
        volatility_pct: 2,
        spread_slippage_pct: 0.1,
        volume: 200000,
        alpaca_quote: {
          provider: 'alpaca',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T13:00:00.000Z',
          received_at: '2026-06-14T13:00:01.000Z',
          price: 200,
          volume: 200000,
        },
        twelve_data_quote: {
          provider: 'twelvedata',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T13:00:03.000Z',
          received_at: '2026-06-14T13:00:04.000Z',
          price: 200.2,
          volume: 200100,
        },
      },
    },
  ], {
    paperAdapter: adapter,
    riskConfig: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: false,
      minConfidenceForPaper: 70,
      minLiquidityScore: 40,
      minVolume: 50000,
    },
  });

  assert.equal(replay.summary.total_signals, 1);
  assert(replay.summary.paper_orders >= 0);
  assert.equal(typeof replay.scoredSignals[0].edge_score, 'number');
  assert(replay.scoredSignals[0].edge_score > 0);
});

test('metrics summary generation counts signals and block reasons', () => {
  const summary = generateDailySummary({
    date: '2026-06-14',
    signals: [
      { signal_id: 'sig-1', confidence_score: 90, edge_score: 88, provider_confirmation_score: 95, strategy_name: 'breakout', symbol: 'AAPL', provider_name: 'alpaca', timeframe: '5m' },
      { signal_id: 'sig-2', confidence_score: 40, edge_score: 24, provider_confirmation_score: 28, strategy_name: 'mean-reversion', symbol: 'MSFT', provider_name: 'finnhub', timeframe: '15m' },
    ],
    riskDecisions: [
      { decision: 'BLOCKED', reason_codes: ['STALE_SIGNAL', 'LOW_CONFIDENCE'] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
    ],
    orders: [
      { status: 'filled', realized_pnl: 10 },
    ],
    events: [
      { event_type: 'raw_market_data_received' },
    ],
  });

  assert.equal(summary.total_signals, 2);
  assert.equal(summary.blocked_by_risk, 1);
  assert(summary.top_block_reasons.length > 0);
  assert(summary.recommended_tuning_notes.some((note) => note.toLowerCase().includes('edge')));
  assert(summary.recommended_tuning_notes.some((note) => note.toLowerCase().includes('provider agreement')));
});

test('daily live results report includes the requested rollup fields', () => {
  const report = generateDailyLiveResultsReport({
    date: '2026-06-14',
    signals: [
      { signal_id: 'sig-1', confidence_score: 90, edge_score: 88, provider_confirmation_score: 95, strategy_name: 'breakout', symbol: 'AAPL', provider_name: 'alpaca', timeframe: '5m' },
      { signal_id: 'sig-2', confidence_score: 40, edge_score: 20, provider_confirmation_score: 25, strategy_name: 'mean-reversion', symbol: 'MSFT', provider_name: 'finnhub', timeframe: '15m' },
    ],
    riskDecisions: [
      { decision: 'BLOCKED', reason_codes: ['STALE_DATA', 'LOW_CONFIDENCE'] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
    ],
    paperOutcomes: [
      { pnl: 25, false_positive: false, win_loss: 'win', calibration_bucket: '80-89', execution_drag: 0.75, execution_drag_ratio: 0.04, status: 'filled' },
      { pnl: -10, false_positive: true, win_loss: 'loss', calibration_bucket: '90-100', execution_drag: 0.5, execution_drag_ratio: 0.06, status: 'partially_filled' },
      { pnl: 0, false_positive: false, win_loss: 'loss', calibration_bucket: '70-79', execution_drag: 0.2, execution_drag_ratio: 0.02, status: 'rejected' },
    ],
    events: [{ event_type: 'raw_market_data_received' }],
  });

  assert.equal(report.signal_count, 2);
  assert.equal(report.blocked_count, 1);
  assert.equal(report.approved_count, 1);
  assert.equal(report.paper_pnl, 15);
  assert.equal(report.false_positives, 1);
  assert(report.top_block_reasons.length > 0);
  assert.equal(report.blocked_reason_counts.STALE_DATA, 1);
  assert.equal(report.dominant_block_reason.reason, 'STALE_DATA');
  assert.equal(typeof report.rejection_rate, 'number');
  assert(report.rejection_pressure_score >= 0);
  assert(report.best_signal);
  assert(report.worst_signal);
  assert(Array.isArray(report.calibration_buckets));
  assert(report.calibration_buckets.length > 0);
  assert(report.best_calibration_bucket);
  assert(report.worst_calibration_bucket);
  assert(report.signal_quality_summary);
  assert.equal(typeof report.signal_quality_summary.average_confidence, 'number');
  assert(Array.isArray(report.signal_quality_outliers));
  assert.equal(report.signal_quality_outliers.length, 2);
  assert.equal(report.signal_quality_outliers[0].signal_id, 'sig-2');
  assert(Array.isArray(report.false_positive_buckets));
  assert.equal(report.false_positive_buckets.length, 1);
  assert.equal(report.false_positive_buckets[0].bucket, '90-100');
  assert.equal(report.false_positive_buckets[0].false_positives, 1);
  assert.equal(report.execution_drag, 1.45);
  assert.equal(typeof report.execution_drag_ratio, 'number');
  assert(report.fill_quality_summary);
  assert.equal(report.fill_quality_summary.count, 3);
  assert.equal(report.fill_quality_summary.filled_count, 1);
  assert.equal(report.fill_quality_summary.partially_filled_count, 1);
  assert.equal(report.fill_quality_summary.rejected_count, 1);
  assert(report.recommended_tuning_notes.some((note) => note.toLowerCase().includes('edge')));
  assert(report.recommended_tuning_notes.some((note) => note.toLowerCase().includes('provider agreement')));
  assert(report.recommended_tuning_notes.some((note) => note.toLowerCase().includes('source quality')));
  assert(report.recommended_tuning_notes.some((note) => note.toLowerCase().includes('false positives')));
  assert(report.recommended_tuning_notes.some((note) => note.toLowerCase().includes('weakest signal today')));
  assert(report.recommended_tuning_notes.some((note) => note.toLowerCase().includes('execution drag')));
  assert(report.recommended_tuning_notes.some((note) => note.toLowerCase().includes('absorbing')));
  assert(report.recommended_tuning_notes.some((note) => note.toLowerCase().includes('partial fills')));
  assert(report.recommended_tuning_notes.some((note) => note.toLowerCase().includes('rejected fills')));
  assert.equal(typeof report.recommended_max_open_positions, 'number');
  assert(report.recommended_max_open_positions >= 1);
});

test('daily live results report uses the current policy snapshot for capacity recommendations', () => {
  const report = generateDailyLiveResultsReport({
    date: '2026-06-14',
    policySnapshot: {
      policy: {
        maxOpenPositions: 14,
      },
    },
    signals: [
      { signal_id: 'sig-1', confidence_score: 95, edge_score: 92, provider_confirmation_score: 96, strategy_name: 'breakout', symbol: 'AAPL', provider_name: 'alpaca', timeframe: '5m' },
      { signal_id: 'sig-2', confidence_score: 94, edge_score: 91, provider_confirmation_score: 95, strategy_name: 'breakout', symbol: 'MSFT', provider_name: 'alpaca', timeframe: '5m' },
      { signal_id: 'sig-3', confidence_score: 96, edge_score: 93, provider_confirmation_score: 97, strategy_name: 'breakout', symbol: 'NVDA', provider_name: 'alpaca', timeframe: '5m' },
    ],
    riskDecisions: [
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
    ],
    paperOutcomes: [
      { pnl: 14, false_positive: false, win_loss: 'win', calibration_bucket: '90-100', execution_drag: 0.2, execution_drag_ratio: 0.01, status: 'filled' },
      { pnl: 12, false_positive: false, win_loss: 'win', calibration_bucket: '90-100', execution_drag: 0.1, execution_drag_ratio: 0.01, status: 'filled' },
      { pnl: 11, false_positive: false, win_loss: 'win', calibration_bucket: '90-100', execution_drag: 0.1, execution_drag_ratio: 0.01, status: 'filled' },
    ],
    events: [],
  });

  assert.equal(report.recommended_max_open_positions, 15);
});

test('performance store records outcomes and suggests tuning', () => {
  const store = new PerformanceStore();
  store.recordSignal({ signal_id: 'sig-1', symbol: 'AAPL', confidence_score: 92, edge_score: 35, provider_confirmation_score: 30, freshness_score: 88, source_quality_score: 90, contradiction_score: 5, risk_score: 20, created_at: '2026-06-14T10:00:00.000Z' });
  store.recordRiskDecision({ decision: 'APPROVED_FOR_PAPER', reason_codes: [], timestamp: '2026-06-14T10:00:00.000Z' });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-1', confidence_score: 92, symbol: 'AAPL' },
    paper_result: { signal_id: 'sig-1' },
    entry_price: 100,
    exit_price: 95,
    high_price: 101,
    low_price: 94,
    quantity: 1,
    side: 'buy',
    false_positive: true,
  });
  const report = store.getDailyReport('2026-06-14');
  const tuning = store.suggestTuning();
  assert.equal(report.signal_count, 1);
  assert.equal(report.paper_outcome_count, 1);
  assert.equal(report.false_positives, 1);
  assert.equal(tuning.report.date, report.date);
  assert(Array.isArray(tuning.calibration_buckets));
  assert(Array.isArray(tuning.suggestions));
  assert(tuning.threshold_proposal.proposed_policy.minConfidenceForPaper >= 72);
  assert.equal(typeof tuning.threshold_proposal.proposed_policy.minEdgeScore, 'number');
  assert.equal(typeof tuning.report.rejection_rate, 'number');
  assert(tuning.policy_snapshot);
  assert(report.policy_snapshot);
  assert(tuning.report.recommended_tuning_notes.some((note) => note.toLowerCase().includes('edge')));
});

test('performance store tuning reacts to dominant block reasons', () => {
  const store = new PerformanceStore();
  store.recordSignal({
    signal_id: 'sig-block-stale',
    symbol: 'AAPL',
    confidence_score: 80,
    edge_score: 70,
    provider_confirmation_score: 40,
    freshness_score: 10,
    source_quality_score: 50,
    contradiction_score: 10,
    risk_score: 20,
    created_at: '2026-06-14T10:00:00.000Z',
  });
  store.recordRiskDecision({
    decision: 'BLOCKED',
    reason_codes: ['STALE_DATA', 'INVALID_TIMESTAMP'],
    timestamp: '2026-06-14T10:00:00.000Z',
  });
  store.recordRiskDecision({
    decision: 'BLOCKED',
    reason_codes: ['MULTI_SOURCE_CONFIRMATION_FAILED'],
    timestamp: '2026-06-14T10:05:00.000Z',
  });

  const tuning = store.suggestTuning();
  assert.equal(tuning.report.dominant_block_reason.reason, 'STALE_DATA');
  assert(tuning.suggestions.some((note) => note.toLowerCase().includes('stale or invalid provider timestamps')));
});

test('policy effectiveness ranks durable intervals above fragile ones', () => {
  const store = new PerformanceStore();
  store.setPolicySnapshot({
    source: 'policy-a',
    captured_at: '2026-06-14T10:00:00.000Z',
    report_date: '2026-06-14',
    reason_codes: ['A'],
    policy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      minVolume: 50000,
    },
  });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-a', confidence_score: 88, symbol: 'AAPL' },
    paper_result: { signal_id: 'sig-a', entry_price: 100, filled_at: '2026-06-14T10:05:00.000Z' },
    entry_price: 100,
    exit_price: 110,
    high_price: 112,
    low_price: 99,
    quantity: 1,
    side: 'buy',
  });
  store.setPolicySnapshot({
    source: 'policy-b',
    captured_at: '2026-06-14T11:00:00.000Z',
    report_date: '2026-06-14',
    reason_codes: ['B'],
    policy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      minVolume: 50000,
    },
  });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-b', confidence_score: 88, symbol: 'MSFT' },
    paper_result: { signal_id: 'sig-b', entry_price: 100, filled_at: '2026-06-14T11:05:00.000Z' },
    entry_price: 100,
    exit_price: 102,
    high_price: 118,
    low_price: 84,
    quantity: 1,
    side: 'buy',
    false_positive: true,
  });

  const effectiveness = store.getPolicyEffectiveness({ dateFrom: '2026-06-14T00:00:00.000Z', dateTo: '2026-06-14T23:59:59.999Z' });
  assert.equal(effectiveness.intervals.length, 2);
  assert.equal(typeof effectiveness.intervals[0].durability_score, 'number');
  assert.equal(effectiveness.best_policy.report_date, '2026-06-14');
  assert(effectiveness.best_policy.durability_score >= effectiveness.worst_policy.durability_score);
  assert(scorePolicyInterval(effectiveness.best_policy) >= scorePolicyInterval(effectiveness.worst_policy));
});

test('performance store exports replay fixtures from stored paper history', () => {
  const store = new PerformanceStore();
  store.recordSignal({
    signal_id: 'sig-history',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 89,
    freshness_score: 88,
    source_quality_score: 87,
    contradiction_score: 10,
    risk_score: 22,
    liquidity_score: 91,
    volume: 200000,
    provider_name: 'alpaca',
    created_at: '2026-06-14T10:00:00.000Z',
  });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-history', symbol: 'AAPL' },
    paper_result: { signal_id: 'sig-history', entry_price: 200, filled_at: '2026-06-14T10:01:00.000Z' },
    entry_price: 200,
    exit_price: 210,
    high_price: 212,
    low_price: 198,
    quantity: 1,
    side: 'buy',
  });

  const fixtures = store.exportReplayFixtures({ dateFrom: '2026-06-14T00:00:00.000Z', dateTo: '2026-06-14T23:59:59.999Z' });
  assert.equal(fixtures.length, 1);
  assert.equal(fixtures[0].signal.signal_id, 'sig-history');
  assert.equal(fixtures[0].market_data.symbol, 'AAPL');
  assert.equal(fixtures[0].paper_outcome.win_loss, 'win');
});

test('performance store persists and reloads JSONL history', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-history-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');

  const firstStore = new PerformanceStore({ historyPath });
  firstStore.recordSignal({
    signal_id: 'sig-persist',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    confidence_score: 91,
    freshness_score: 89,
    source_quality_score: 88,
    contradiction_score: 8,
    risk_score: 20,
    created_at: '2026-06-14T10:00:00.000Z',
  });
  firstStore.recordRiskDecision({
    signal_id: 'sig-persist',
    decision: 'APPROVED_FOR_PAPER',
    reason_codes: [],
    timestamp: '2026-06-14T10:00:01.000Z',
  });
  firstStore.recordPaperExecution({
    original_signal: { signal_id: 'sig-persist', confidence_score: 91, symbol: 'AAPL' },
    paper_result: { signal_id: 'sig-persist', entry_price: 100, filled_at: '2026-06-14T10:01:00.000Z' },
    entry_price: 100,
    exit_price: 110,
    high_price: 112,
    low_price: 98,
    quantity: 1,
    side: 'buy',
  });
  firstStore.recordEvent({
    event_type: 'raw_market_data_received',
    created_at: '2026-06-14T10:00:02.000Z',
  });

  const secondStore = new PerformanceStore({ historyPath });
  const report = secondStore.getDailyReport('2026-06-14');
  const fixtures = secondStore.exportReplayFixtures({
    dateFrom: '2026-06-14T00:00:00.000Z',
    dateTo: '2026-06-14T23:59:59.999Z',
  });

  assert.equal(secondStore.signals.length, 1);
  assert.equal(secondStore.riskDecisions.length, 1);
  assert.equal(secondStore.paperOutcomes.length, 1);
  assert.equal(secondStore.events.length, 1);
  assert.equal(report.signal_count, 1);
  assert.equal(report.paper_outcome_count, 1);
  assert.equal(fixtures.length, 1);
  assert.equal(fixtures[0].signal.signal_id, 'sig-persist');
});

test('performance store persists and reloads policy snapshot', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-history-'));
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const store = new PerformanceStore({ policyPath, policyHistoryPath });
  const snapshot = store.setPolicySnapshot({
    source: 'tuning',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    reason_codes: ['LOW_OVERALL_WIN_RATE'],
    policy: {
      minConfidenceForPaper: 80,
      minFreshnessScore: 60,
      minSourceQualityScore: 55,
      maxContradictionScore: 35,
      maxRiskScore: 50,
      minLiquidityScore: 45,
      minVolume: 75000,
    },
  });
  assert.equal(snapshot.policy.minConfidenceForPaper, 80);
  assert.equal(fs.existsSync(policyPath), true);
  assert.equal(fs.existsSync(policyHistoryPath), true);
  assert.equal(fs.readFileSync(policyHistoryPath, 'utf8').trim().split(/\r?\n/).length, 1);
  const tuning = store.suggestTuning();
  assert.equal(tuning.threshold_proposal.current_policy.minConfidenceForPaper, 80);
  const reloaded = new PerformanceStore({ policyPath, policyHistoryPath });
  assert.equal(reloaded.getPolicySnapshot().policy.minConfidenceForPaper, 80);
  assert.deepEqual(reloaded.getPolicySnapshot().reason_codes, ['LOW_OVERALL_WIN_RATE']);
});

test('performance store startup policy patch overrides persisted concurrency cap', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-policy-patch-'));
  const policyPath = path.join(tempDir, 'live-policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    source: 'persisted',
    captured_at: '2026-06-14T09:00:00.000Z',
    report_date: '2026-06-14',
    reason_codes: ['PERSISTED'],
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      blockedCalibrationBuckets: [],
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      minVolume: 50000,
      maxOpenPositions: 8,
      positionSizeMultiplier: 1,
    },
  }), 'utf8');

  const store = new PerformanceStore({
    policyPath,
    startupPolicyPatch: {
      source: 'startup-config',
      captured_at: '2026-06-14T12:00:00.000Z',
      report_date: '2026-06-14',
      reason_codes: ['STARTUP_CONFIG'],
      policy: {
        maxOpenPositions: 14,
      },
    },
  });

  const snapshot = store.getPolicySnapshot();
  assert.equal(snapshot.source, 'startup-config');
  assert.equal(snapshot.policy.maxOpenPositions, 14);
  assert.equal(snapshot.policy.minConfidenceForPaper, 72);
});

test('performance store refreshes policy from rejection-aware learning signals', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-learning-refresh-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const store = new PerformanceStore({ historyPath, policyPath, policyHistoryPath });

  store.recordSignal({
    signal_id: 'sig-refresh',
    symbol: 'AAPL',
    confidence_score: 88,
    edge_score: 84,
    provider_confirmation_score: 78,
    freshness_score: 92,
    source_quality_score: 88,
    contradiction_score: 8,
    risk_score: 22,
    created_at: '2026-06-14T10:00:00.000Z',
  });
  store.recordRiskDecision({
    decision: 'BLOCKED',
    reason_codes: ['MAX_OPEN_POSITIONS_EXCEEDED', 'MULTI_SOURCE_CONFIRMATION_FAILED'],
    timestamp: '2026-06-14T10:00:00.000Z',
  });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-refresh', confidence_score: 88, symbol: 'AAPL' },
    paper_result: { signal_id: 'sig-refresh', entry_price: 100, filled_at: '2026-06-14T10:05:00.000Z' },
    entry_price: 100,
    exit_price: 108,
    high_price: 109,
    low_price: 99,
    quantity: 1,
    side: 'buy',
  });

  const snapshot = store.refreshPolicyFromLearning({ source: 'learning-refresh' });
  assert.equal(snapshot.source, 'learning-refresh');
  assert(snapshot.reason_codes.some((reason) => reason.startsWith('DOMINANT_BLOCK_')));
  assert.equal(typeof snapshot.policy.maxOpenPositions, 'number');
  assert.equal(fs.existsSync(policyPath), true);
  assert.equal(fs.existsSync(policyHistoryPath), true);
  assert.equal(store.getPolicySnapshot().source, 'learning-refresh');
});

test('performance store summarizes policy effectiveness by snapshot interval', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-effectiveness-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const store = new PerformanceStore({ historyPath, policyPath, policyHistoryPath });

  store.setPolicySnapshot({
    source: 'policy-a',
    captured_at: '2026-06-14T10:00:00.000Z',
    report_date: '2026-06-14',
    reason_codes: ['A'],
    policy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      minVolume: 50000,
    },
  });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-a', confidence_score: 80, symbol: 'AAPL' },
    paper_result: { signal_id: 'sig-a', entry_price: 100, filled_at: '2026-06-14T10:15:00.000Z' },
    entry_price: 100,
    exit_price: 110,
    high_price: 112,
    low_price: 99,
    quantity: 1,
    side: 'buy',
  });
  store.setPolicySnapshot({
    source: 'policy-b',
    captured_at: '2026-06-14T11:00:00.000Z',
    report_date: '2026-06-14',
    reason_codes: ['B'],
    policy: {
      minConfidenceForPaper: 80,
      minFreshnessScore: 60,
      minSourceQualityScore: 45,
      maxContradictionScore: 45,
      maxRiskScore: 65,
      minLiquidityScore: 45,
      minVolume: 60000,
    },
  });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-b', confidence_score: 85, symbol: 'MSFT' },
    paper_result: { signal_id: 'sig-b', entry_price: 100, filled_at: '2026-06-14T11:15:00.000Z' },
    entry_price: 100,
    exit_price: 95,
    high_price: 101,
    low_price: 94,
    quantity: 1,
    side: 'buy',
    false_positive: true,
  });

  const effectiveness = store.getPolicyEffectiveness({ dateFrom: '2026-06-14T00:00:00.000Z', dateTo: '2026-06-14T23:59:59.999Z' });
  assert.equal(effectiveness.interval_count, 2);
  assert(effectiveness.best_policy);
  assert(effectiveness.worst_policy);
  assert.equal(effectiveness.intervals[0].paper_pnl, 10);
  assert.equal(effectiveness.intervals[1].paper_pnl, -5);
  assert.equal(typeof effectiveness.recommended_position_size_multiplier, 'number');
});

test('performance store recommends a higher open-position cap on healthy runs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-effectiveness-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const store = new PerformanceStore({ historyPath, policyPath, policyHistoryPath });

  store.setPolicySnapshot({
    source: 'policy-a',
    captured_at: '2026-06-14T10:00:00.000Z',
    report_date: '2026-06-14',
    reason_codes: ['A'],
    policy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      minVolume: 50000,
      maxOpenPositions: 12,
    },
  });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-cap-1', confidence_score: 92, symbol: 'AAPL' },
    paper_result: { signal_id: 'sig-cap-1', entry_price: 100, filled_at: '2026-06-14T10:15:00.000Z' },
    entry_price: 100,
    exit_price: 114,
    high_price: 116,
    low_price: 99,
    quantity: 1,
    side: 'buy',
  });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-cap-2', confidence_score: 93, symbol: 'MSFT' },
    paper_result: { signal_id: 'sig-cap-2', entry_price: 100, filled_at: '2026-06-14T10:25:00.000Z' },
    entry_price: 100,
    exit_price: 112,
    high_price: 114,
    low_price: 99,
    quantity: 1,
    side: 'buy',
  });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-cap-3', confidence_score: 94, symbol: 'NVDA' },
    paper_result: { signal_id: 'sig-cap-3', entry_price: 100, filled_at: '2026-06-14T10:35:00.000Z' },
    entry_price: 100,
    exit_price: 118,
    high_price: 120,
    low_price: 99,
    quantity: 1,
    side: 'buy',
  });

  const effectiveness = store.getPolicyEffectiveness({ dateFrom: '2026-06-14T00:00:00.000Z', dateTo: '2026-06-14T23:59:59.999Z' });
  assert.equal(effectiveness.recommended_max_open_positions, 14);
  assert(effectiveness.best_policy);
  assert.equal(effectiveness.best_policy.recommended_max_open_positions, 14);
});

test('server cli resolves default and overridden paths and port', () => {
  const historyPath = resolvePerformanceHistoryPath({});
  const policyPath = resolvePolicyHistoryPath({});
  assert(path.isAbsolute(historyPath));
  assert(historyPath.endsWith(path.join('data', 'performance-history.jsonl')));
  assert.equal(resolvePerformanceHistoryPath({ PERFORMANCE_HISTORY_PATH: 'tmp/history.jsonl' }).endsWith(path.join('tmp', 'history.jsonl')), true);
  assert(path.isAbsolute(resolvePolicyPath({})));
  assert(resolvePolicyPath({ LIVE_POLICY_PATH: 'tmp/live-policy.json' }).endsWith(path.join('tmp', 'live-policy.json')));
  assert(path.isAbsolute(policyPath));
  assert(policyPath.endsWith(path.join('data', 'policy-history.jsonl')));
  assert.equal(resolvePolicyHistoryPath({ POLICY_HISTORY_PATH: 'tmp/policy-history.jsonl' }).endsWith(path.join('tmp', 'policy-history.jsonl')), true);
  assert.equal(resolveServerPort({}), 3000);
  assert.equal(resolveServerPort({ PORT: '4200' }), 4200);
  assert.equal(resolveServerPort({ SERVER_PORT: '4300' }), 4300);
});

test('replay cli resolves the shared live policy path', () => {
  assert(path.isAbsolute(resolveRiskPolicyPath({})));
  assert(resolveRiskPolicyPath({ LIVE_POLICY_PATH: 'tmp/live-policy.json' }).endsWith(path.join('tmp', 'live-policy.json')));
});

test('replay summary uses the supplied policy snapshot for capacity recommendations', () => {
  const replay = runReplay([
    {
      market_data: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 200,
        volume: 200000,
      },
      signal: {
        signal_id: 'sig-replay-cap',
        symbol: 'AAPL',
        asset_type: 'stock',
        strategy_name: 'breakout',
        timeframe: '5m',
        direction: 'bullish',
        stop_loss: 190,
        take_profit: 220,
        confidence_score: 95,
        freshness_score: 95,
        source_quality_score: 95,
        provider_confirmation_score: 95,
        contradiction_score: 5,
        risk_score: 10,
        volume: 200000,
      },
      market_context: {
        alpaca_quote: {
          provider: 'alpaca',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T13:00:00.000Z',
          received_at: '2026-06-14T13:00:01.000Z',
          price: 200,
          volume: 200000,
        },
        twelve_data_quote: {
          provider: 'twelvedata',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T13:00:03.000Z',
          received_at: '2026-06-14T13:00:04.000Z',
          price: 200.1,
          volume: 200050,
        },
      },
      portfolio: {
        trade_count_today: 0,
        daily_loss: 0,
        position_notional: 0,
        available: true,
        position_notional_by_asset: {},
        exposure_by_sector: {},
      },
      paper_outcome: {
        original_signal: { signal_id: 'sig-replay-cap', confidence_score: 95, symbol: 'AAPL' },
        paper_result: { signal_id: 'sig-replay-cap', filled_at: '2026-06-14T13:05:00.000Z', average_fill_price: 200 },
        entry_price: 200,
        exit_price: 216,
        high_price: 218,
        low_price: 199,
        quantity: 1,
        side: 'buy',
      },
    },
  ], {
    paperAdapter: new PaperTradeAdapter({ dryRun: true }),
    riskConfig: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: false,
      minConfidenceForPaper: 70,
      minLiquidityScore: 40,
      minVolume: 50000,
      maxOpenPositions: 14,
    },
    policySnapshot: {
      policy: {
        maxOpenPositions: 14,
      },
    },
  });

  assert.equal(replay.summary.recommended_max_open_positions, 15);
});

test('policy cli refreshes a policy snapshot from stored history', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-cli-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const store = new PerformanceStore({ historyPath, policyPath, policyHistoryPath });
  store.recordSignal({
    signal_id: 'sig-policy',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    confidence_score: 94,
    freshness_score: 92,
    source_quality_score: 90,
    contradiction_score: 5,
    risk_score: 18,
    liquidity_score: 92,
    created_at: '2026-06-14T10:00:00.000Z',
  });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-policy', confidence_score: 94, symbol: 'AAPL' },
    paper_result: { signal_id: 'sig-policy', entry_price: 100, filled_at: '2026-06-14T10:01:00.000Z' },
    entry_price: 100,
    exit_price: 114,
    high_price: 115,
    low_price: 99,
    quantity: 1,
    side: 'buy',
  });

  const snapshot = refreshPolicySnapshot({}, { historyPath, policyPath, policyHistoryPath });
  assert.equal(snapshot.source, 'tuning');
  assert.equal(fs.existsSync(policyPath), true);
  assert.equal(fs.existsSync(policyHistoryPath), true);
  const diskSnapshot = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  assert.equal(diskSnapshot.policy.minConfidenceForPaper >= 72, true);
  assert.equal(typeof diskSnapshot.policy.positionSizeMultiplier, 'number');
  assert.equal(diskSnapshot.policy.positionSizeMultiplier <= 1.35, true);
});

test('threshold proposal reacts to poor outcomes', () => {
  const proposal = buildThresholdProposal({
    currentPolicy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
    },
    signals: [
      { confidence_score: 60, freshness_score: 40, source_quality_score: 35, contradiction_score: 55, risk_score: 65 },
      { confidence_score: 85, freshness_score: 90, source_quality_score: 82, contradiction_score: 10, risk_score: 25 },
    ],
    paperOutcomes: [
      { calibration_bucket: '80-89', pnl: -10, win_loss: 'loss', max_favorable_excursion: 5, max_adverse_excursion: 12 },
      { calibration_bucket: '80-89', pnl: -5, win_loss: 'loss', max_favorable_excursion: 3, max_adverse_excursion: 8 },
      { calibration_bucket: '80-89', pnl: -7, win_loss: 'loss', max_favorable_excursion: 4, max_adverse_excursion: 9 },
    ],
    riskDecisions: [
      { decision: 'BLOCKED', reason_codes: ['LOW_FRESHNESS'] },
      { decision: 'BLOCKED', reason_codes: ['LOW_SOURCE_QUALITY'] },
    ],
  });

  assert.equal(proposal.proposed_policy.minConfidenceForPaper >= 75, true);
  assert(proposal.reason_codes.length > 0);
  assert(proposal.expected_focus.includes('confidence bucket'));
  assert.equal(typeof proposal.proposed_policy.positionSizeMultiplier, 'number');
  assert(proposal.proposed_policy.positionSizeMultiplier <= 1);
});

test('threshold proposal blocks losing calibration buckets', () => {
  const proposal = buildThresholdProposal({
    currentPolicy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      blockedCalibrationBuckets: [],
    },
    paperOutcomes: [
      { calibration_bucket: '80-89', pnl: -10, win_loss: 'loss', max_favorable_excursion: 5, max_adverse_excursion: 12 },
      { calibration_bucket: '80-89', pnl: -8, win_loss: 'loss', max_favorable_excursion: 3, max_adverse_excursion: 11 },
      { calibration_bucket: '80-89', pnl: -6, win_loss: 'loss', max_favorable_excursion: 2, max_adverse_excursion: 9 },
    ],
  });

  assert(proposal.reason_codes.includes('BLOCKED_CALIBRATION_BUCKETS'));
  assert.deepEqual(proposal.proposed_policy.blockedCalibrationBuckets, ['80-89']);
});

test('threshold proposal blocks calibration buckets with high false positive rates', () => {
  const proposal = buildThresholdProposal({
    currentPolicy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      blockedCalibrationBuckets: [],
    },
    paperOutcomes: [
      { calibration_bucket: '80-89', pnl: 6, win_loss: 'win', false_positive: true, max_favorable_excursion: 8, max_adverse_excursion: 1 },
      { calibration_bucket: '80-89', pnl: 5, win_loss: 'win', false_positive: true, max_favorable_excursion: 7, max_adverse_excursion: 1 },
      { calibration_bucket: '80-89', pnl: 4, win_loss: 'win', false_positive: false, max_favorable_excursion: 6, max_adverse_excursion: 1 },
    ],
  });
  const cleanProposal = buildThresholdProposal({
    currentPolicy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      blockedCalibrationBuckets: [],
    },
    paperOutcomes: [
      { calibration_bucket: '80-89', pnl: 6, win_loss: 'win', false_positive: false, max_favorable_excursion: 8, max_adverse_excursion: 1 },
      { calibration_bucket: '80-89', pnl: 5, win_loss: 'win', false_positive: false, max_favorable_excursion: 7, max_adverse_excursion: 1 },
      { calibration_bucket: '80-89', pnl: 4, win_loss: 'win', false_positive: false, max_favorable_excursion: 6, max_adverse_excursion: 1 },
    ],
  });

  assert(proposal.reason_codes.includes('HIGH_FALSE_POSITIVE_BUCKETS'));
  assert.deepEqual(proposal.proposed_policy.blockedCalibrationBuckets, ['80-89']);
  assert.equal(proposal.proposed_policy.minConfidenceForPaper >= 75, true);
  assert(proposal.proposed_policy.positionSizeMultiplier < cleanProposal.proposed_policy.positionSizeMultiplier);
  assert(proposal.notes.some((note) => note.toLowerCase().includes('false positives')));
});

test('threshold proposal blocks buckets with high execution drag', () => {
  const proposal = buildThresholdProposal({
    currentPolicy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      blockedCalibrationBuckets: [],
      positionSizeMultiplier: 1,
    },
    paperOutcomes: [
      { calibration_bucket: '70-79', pnl: 4, win_loss: 'win', execution_drag: 2.5, max_favorable_excursion: 6, max_adverse_excursion: 1 },
      { calibration_bucket: '70-79', pnl: 5, win_loss: 'win', execution_drag: 3.0, max_favorable_excursion: 7, max_adverse_excursion: 1 },
      { calibration_bucket: '70-79', pnl: 3, win_loss: 'win', execution_drag: 2.8, max_favorable_excursion: 5, max_adverse_excursion: 1 },
    ],
  });

  assert(proposal.reason_codes.includes('HIGH_EXECUTION_DRAG_BUCKETS'));
  assert.deepEqual(proposal.proposed_policy.blockedCalibrationBuckets, ['70-79']);
  assert(proposal.proposed_policy.positionSizeMultiplier < 1);
  assert(proposal.notes.some((note) => note.toLowerCase().includes('execution drag')));
  assert(proposal.notes.some((note) => note.toLowerCase().includes('relative drag')));
});

test('threshold proposal reduces size more when drawdown is worse', () => {
  const cleanProposal = buildThresholdProposal({
    currentPolicy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      positionSizeMultiplier: 1,
    },
    signals: [
      { confidence_score: 88, freshness_score: 88, source_quality_score: 86, contradiction_score: 10, risk_score: 20 },
    ],
    paperOutcomes: [
      { calibration_bucket: '80-89', pnl: 5, win_loss: 'win', max_favorable_excursion: 7, max_adverse_excursion: 1 },
      { calibration_bucket: '80-89', pnl: 5, win_loss: 'win', max_favorable_excursion: 8, max_adverse_excursion: 1 },
      { calibration_bucket: '80-89', pnl: 5, win_loss: 'win', max_favorable_excursion: 8, max_adverse_excursion: 1 },
    ],
    riskDecisions: [
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
    ],
  });

  const drawdownProposal = buildThresholdProposal({
    currentPolicy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      positionSizeMultiplier: 1,
    },
    signals: [
      { confidence_score: 88, freshness_score: 88, source_quality_score: 86, contradiction_score: 10, risk_score: 20 },
    ],
    paperOutcomes: [
      { calibration_bucket: '80-89', pnl: 20, win_loss: 'win', max_favorable_excursion: 22, max_adverse_excursion: 1 },
      { calibration_bucket: '80-89', pnl: -15, win_loss: 'loss', max_favorable_excursion: 2, max_adverse_excursion: 18 },
      { calibration_bucket: '80-89', pnl: 10, win_loss: 'win', max_favorable_excursion: 12, max_adverse_excursion: 2 },
    ],
    riskDecisions: [
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
    ],
  });

  assert(cleanProposal.proposed_policy.positionSizeMultiplier >= drawdownProposal.proposed_policy.positionSizeMultiplier);
});

test('threshold proposal sizes up more aggressively when signals and outcomes are strong', () => {
  const proposal = buildThresholdProposal({
    currentPolicy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      maxOpenPositions: 8,
      positionSizeMultiplier: 1,
    },
    signals: [
      { confidence_score: 95, freshness_score: 96, source_quality_score: 94, provider_confirmation_score: 96, contradiction_score: 2, risk_score: 10 },
      { confidence_score: 94, freshness_score: 95, source_quality_score: 95, provider_confirmation_score: 95, contradiction_score: 3, risk_score: 12 },
      { confidence_score: 96, freshness_score: 97, source_quality_score: 93, provider_confirmation_score: 94, contradiction_score: 1, risk_score: 11 },
    ],
    paperOutcomes: [
      { calibration_bucket: '90-100', pnl: 18, win_loss: 'win', max_favorable_excursion: 20, max_adverse_excursion: 2 },
      { calibration_bucket: '90-100', pnl: 16, win_loss: 'win', max_favorable_excursion: 19, max_adverse_excursion: 1 },
      { calibration_bucket: '90-100', pnl: 17, win_loss: 'win', max_favorable_excursion: 21, max_adverse_excursion: 2 },
    ],
    riskDecisions: [
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
    ],
  });

  assert(proposal.proposed_policy.positionSizeMultiplier > 1.25);
  assert(proposal.reason_codes.includes('SIZE_UP_FOR_CONFIRMED_EDGE'));
});

test('threshold proposal raises the open-position cap when capacity is the bottleneck and results are healthy', () => {
  const proposal = buildThresholdProposal({
    currentPolicy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      maxOpenPositions: 8,
      positionSizeMultiplier: 1,
    },
    signals: [
      { confidence_score: 88, freshness_score: 90, source_quality_score: 88, contradiction_score: 10, risk_score: 20 },
      { confidence_score: 86, freshness_score: 89, source_quality_score: 87, contradiction_score: 12, risk_score: 22 },
    ],
    paperOutcomes: [
      { calibration_bucket: '80-89', pnl: 8, win_loss: 'win', max_favorable_excursion: 10, max_adverse_excursion: 2 },
      { calibration_bucket: '80-89', pnl: 6, win_loss: 'win', max_favorable_excursion: 9, max_adverse_excursion: 1 },
      { calibration_bucket: '80-89', pnl: 7, win_loss: 'win', max_favorable_excursion: 11, max_adverse_excursion: 2 },
    ],
    riskDecisions: [
      { decision: 'BLOCKED', reason_codes: ['MAX_OPEN_POSITIONS_EXCEEDED'] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
    ],
  });

  assert.equal(proposal.proposed_policy.maxOpenPositions, 9);
  assert(proposal.reason_codes.includes('OPEN_POSITION_CAP_TOO_TIGHT'));
  assert(proposal.notes.some((note) => note.toLowerCase().includes('concurrency cap')));
});

test('threshold proposal expands open-position capacity on healthy high-quality activity', () => {
  const proposal = buildThresholdProposal({
    currentPolicy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      maxOpenPositions: 12,
      positionSizeMultiplier: 1,
    },
    signals: [
      { confidence_score: 93, freshness_score: 95, source_quality_score: 94, provider_confirmation_score: 96, contradiction_score: 4, risk_score: 10 },
      { confidence_score: 92, freshness_score: 94, source_quality_score: 93, provider_confirmation_score: 95, contradiction_score: 3, risk_score: 11 },
      { confidence_score: 94, freshness_score: 96, source_quality_score: 95, provider_confirmation_score: 97, contradiction_score: 2, risk_score: 9 },
    ],
    paperOutcomes: [
      { calibration_bucket: '90-100', pnl: 14, win_loss: 'win', status: 'filled', max_favorable_excursion: 16, max_adverse_excursion: 1 },
      { calibration_bucket: '90-100', pnl: 11, win_loss: 'win', status: 'filled', max_favorable_excursion: 13, max_adverse_excursion: 1 },
      { calibration_bucket: '90-100', pnl: 9, win_loss: 'win', status: 'filled', max_favorable_excursion: 12, max_adverse_excursion: 1 },
    ],
    riskDecisions: [
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
      { decision: 'APPROVED_FOR_PAPER', reason_codes: [] },
    ],
  });

  assert.equal(proposal.proposed_policy.maxOpenPositions, 14);
  assert(proposal.reason_codes.includes('HEALTHY_ACTIVITY_EXPANDS_OPEN_POSITIONS'));
  assert(proposal.notes.some((note) => note.toLowerCase().includes('widen open-position capacity')));
});

test('threshold proposal raises provider confirmation floor when signals are weak on provider agreement', () => {
  const proposal = buildThresholdProposal({
    currentPolicy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      positionSizeMultiplier: 1,
    },
    signals: [
      { confidence_score: 80, freshness_score: 80, source_quality_score: 80, provider_confirmation_score: 20, contradiction_score: 10, risk_score: 20 },
      { confidence_score: 82, freshness_score: 82, source_quality_score: 78, provider_confirmation_score: 30, contradiction_score: 15, risk_score: 25 },
    ],
    paperOutcomes: [
      { calibration_bucket: '70-79', pnl: -4, win_loss: 'loss', max_favorable_excursion: 2, max_adverse_excursion: 6 },
      { calibration_bucket: '70-79', pnl: -3, win_loss: 'loss', max_favorable_excursion: 1, max_adverse_excursion: 4 },
      { calibration_bucket: '70-79', pnl: -2, win_loss: 'loss', max_favorable_excursion: 1, max_adverse_excursion: 3 },
    ],
    riskDecisions: [
      { decision: 'BLOCKED', reason_codes: ['LOW_PROVIDER_CONFIRMATION'] },
      { decision: 'BLOCKED', reason_codes: ['LOW_PROVIDER_CONFIRMATION'] },
    ],
  });

  assert.equal(proposal.proposed_policy.minProviderConfirmationScore >= 70, true);
  assert(proposal.reason_codes.includes('LOW_AVERAGE_PROVIDER_CONFIRMATION'));
  assert.equal(typeof proposal.proposed_policy.minEdgeScore, 'number');
});

test('walk-forward comparison returns baseline tuned and delta outputs', () => {
  const fixtures = [
    {
      market_data: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 200,
        volume: 200000,
      },
      signal: {
        signal_id: 'sig-1',
        symbol: 'AAPL',
        asset_type: 'stock',
        strategy_name: 'breakout',
        timeframe: '5m',
        direction: 'bullish',
        stop_loss: 190,
        take_profit: 220,
        confidence_score: 90,
        liquidity_score: 90,
        freshness_score: 95,
        source_quality_score: 92,
        contradiction_score: 5,
        risk_score: 15,
        evidence: [{ sentiment: 'positive' }],
      },
      portfolio: { trade_count_today: 0, daily_loss: 0, position_notional: 0, available: true },
      market_context: { market_closed: false, volatility_pct: 2, spread_slippage_pct: 0.1, volume: 200000 },
    },
    {
      market_data: {
        provider: 'alpaca',
        symbol: 'MSFT',
        asset_type: 'stock',
        timestamp: '2026-06-14T13:05:00.000Z',
        received_at: '2026-06-14T13:05:01.000Z',
        price: 300,
        volume: 120000,
      },
      signal: {
        signal_id: 'sig-2',
        symbol: 'MSFT',
        asset_type: 'stock',
        strategy_name: 'mean-reversion',
        timeframe: '15m',
        direction: 'bullish',
        stop_loss: 290,
        take_profit: 312,
        confidence_score: 62,
        liquidity_score: 55,
        freshness_score: 58,
        source_quality_score: 48,
        contradiction_score: 28,
        risk_score: 55,
        evidence: [{ sentiment: 'mixed' }],
      },
      portfolio: { trade_count_today: 1, daily_loss: 0, position_notional: 0, available: true },
      market_context: { market_closed: false, volatility_pct: 3, spread_slippage_pct: 0.2, volume: 120000 },
    },
  ];

  const comparison = comparePolicyPerformance(fixtures, {
    baselinePolicy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: false,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      minVolume: 50000,
    },
  });

  assert(comparison.baseline);
  assert(comparison.tuned);
  assert('paper_pnl' in comparison.delta);
  assert(['baseline', 'tuned', 'tie'].includes(comparison.winner));
  assert(comparison.recommendation.length > 0);
  assert.equal(comparison.tuned_policy.minProviderConfirmationScore >= 70, true);
  assert.equal(comparison.tuned_policy.minEdgeScore >= 60, true);
  assert(comparison.tuning_proposal.signal_stats.average_edge > 0);
  assert(comparison.tuning_proposal.signal_stats.average_provider_confirmation > 0);
});

test('walk-forward comparison can use stored history when fixtures are omitted', () => {
  const store = new PerformanceStore();
  store.recordSignal({
    signal_id: 'sig-history',
    symbol: 'AAPL',
    asset_type: 'stock',
    strategy_name: 'breakout',
    timeframe: '5m',
    direction: 'bullish',
    stop_loss: 190,
    take_profit: 220,
    confidence_score: 89,
    freshness_score: 88,
    source_quality_score: 87,
    contradiction_score: 10,
    risk_score: 22,
    liquidity_score: 91,
    volume: 200000,
    provider_name: 'alpaca',
    created_at: '2026-06-14T10:00:00.000Z',
  });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-history', symbol: 'AAPL' },
    paper_result: { signal_id: 'sig-history', entry_price: 200, filled_at: '2026-06-14T10:01:00.000Z' },
    entry_price: 200,
    exit_price: 210,
    high_price: 212,
    low_price: 198,
    quantity: 1,
    side: 'buy',
  });

  const comparison = comparePolicyPerformance([], {
    performanceStore: store,
    baselinePolicy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: false,
    },
    dateFrom: '2026-06-14T00:00:00.000Z',
    dateTo: '2026-06-14T23:59:59.999Z',
  });

  assert(comparison.baseline);
  assert(comparison.tuned);
  assert.equal(comparison.baseline.total_signals >= 1, true);
});

test('walk-forward scoring prefers cleaner equity curves', () => {
  const cleaner = {
    paper_pnl: 20,
    drawdown: 1,
    false_positives: 0,
    blocked_count: 0,
  };
  const rougher = {
    paper_pnl: 20,
    drawdown: 8,
    false_positives: 1,
    blocked_count: 0,
  };

  assert(scoreSummary(cleaner) > scoreSummary(rougher));
});

test('review items contain operator-friendly fields', () => {
  const reviewItem = buildReviewItem({
    signal: {
      signal_id: 'sig-1',
      symbol: 'AAPL',
      asset_type: 'stock',
      action_candidate: 'paper_buy',
      confidence_score: 92,
      edge_score: 88,
      provider_confirmation_score: 94,
      risk_score: 22,
      explanation: 'test',
      evidence_refs: ['ref-1'],
      stop_loss: 198,
      take_profit: 220,
      decision_reasons: ['LOW_CONFIDENCE'],
    },
    riskDecision: { decision: 'APPROVED_FOR_PAPER' },
  });

  assert.equal(reviewItem.symbol, 'AAPL');
  assert(reviewItem.actions.includes('approve_for_paper'));
  assert(reviewItem.position_sizing_rationale.includes('Edge score'));
  assert(reviewItem.position_sizing_rationale.includes('provider confirmation'));
});

test('server exposes daily live results and paper outcome ingestion', async () => {
  const server = createTradingControlServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  await fetch(`http://127.0.0.1:${port}/webhooks/signal-created`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      signal_id: 'sig-server-history',
      symbol: 'AAPL',
      asset_type: 'stock',
      strategy_name: 'breakout',
      direction: 'bullish',
      confidence_score: 90,
      freshness_score: 90,
      source_quality_score: 90,
      contradiction_score: 5,
      risk_score: 15,
      stop_loss: 190,
      take_profit: 220,
      created_at: '2026-06-14T10:00:00.000Z',
      signal: {
        signal_id: 'sig-server-history',
        symbol: 'AAPL',
        asset_type: 'stock',
        strategy_name: 'breakout',
        timeframe: '5m',
        direction: 'bullish',
        confidence_score: 90,
        freshness_score: 90,
        source_quality_score: 90,
        contradiction_score: 5,
        risk_score: 15,
        stop_loss: 190,
        take_profit: 220,
        created_at: '2026-06-14T10:00:00.000Z',
      },
    }),
  });

  await fetch(`http://127.0.0.1:${port}/paper-outcomes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      original_signal: { signal_id: 'sig-server-history', confidence_score: 90, symbol: 'AAPL' },
      paper_result: { signal_id: 'sig-server-history', entry_price: 200, filled_at: '2026-06-14T10:01:00.000Z' },
      entry_price: 200,
      exit_price: 210,
      high_price: 212,
      low_price: 198,
      quantity: 1,
      side: 'buy',
    }),
  });

  const outcomeResponse = await fetch(`http://127.0.0.1:${port}/paper-outcomes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      original_signal: { signal_id: 'sig-1', confidence_score: 90, symbol: 'AAPL' },
      paper_result: { signal_id: 'sig-1' },
      entry_price: 100,
      exit_price: 105,
      high_price: 107,
      low_price: 98,
      quantity: 1,
      side: 'buy',
    }),
  });
  const outcomePayload = await outcomeResponse.json();
  assert.equal(outcomeResponse.status, 200);
  assert.equal(outcomePayload.accepted, true);

  const reportResponse = await fetch(`http://127.0.0.1:${port}/daily-live-results`);
  const reportPayload = await reportResponse.json();
  assert.equal(reportResponse.status, 200);
  assert.equal(reportPayload.date.length, 10);
  assert('signal_count' in reportPayload);

  const tuningResponse = await fetch(`http://127.0.0.1:${port}/performance/tuning`);
  const tuningPayload = await tuningResponse.json();
  assert.equal(tuningResponse.status, 200);
  assert('suggestions' in tuningPayload);

  const walkForwardResponse = await fetch(`http://127.0.0.1:${port}/walk-forward-comparison`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fixtures: [],
      baseline_policy: {
        killSwitch: false,
        paperAdapterEnabled: true,
        requireHumanApproval: false,
      },
      dateFrom: '2026-06-14T00:00:00.000Z',
      dateTo: '2026-06-14T23:59:59.999Z',
    }),
  });
  const walkForwardPayload = await walkForwardResponse.json();
  assert.equal(walkForwardResponse.status, 200);
  assert.equal(walkForwardPayload.accepted, true);
  assert('comparison' in walkForwardPayload);

  await new Promise((resolve) => server.close(resolve));
});

test('server reloads persisted paper history across restarts', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-history-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');

  const firstServer = createTradingControlServer({ performanceHistoryPath: historyPath });
  await new Promise((resolve) => firstServer.listen(0, resolve));
  const { port: firstPort } = firstServer.address();
  await fetch(`http://127.0.0.1:${firstPort}/webhooks/signal-created`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      signal_id: 'sig-restart',
      symbol: 'AAPL',
      asset_type: 'stock',
      strategy_name: 'breakout',
      direction: 'bullish',
      confidence_score: 90,
      freshness_score: 90,
      source_quality_score: 90,
      contradiction_score: 5,
      risk_score: 15,
      stop_loss: 190,
      take_profit: 220,
      created_at: '2026-06-14T10:00:00.000Z',
      signal: {
        signal_id: 'sig-restart',
        symbol: 'AAPL',
        asset_type: 'stock',
        strategy_name: 'breakout',
        timeframe: '5m',
        direction: 'bullish',
        confidence_score: 90,
        freshness_score: 90,
        source_quality_score: 90,
        contradiction_score: 5,
        risk_score: 15,
        stop_loss: 190,
        take_profit: 220,
        created_at: '2026-06-14T10:00:00.000Z',
      },
    }),
  });
  await fetch(`http://127.0.0.1:${firstPort}/paper-outcomes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      original_signal: { signal_id: 'sig-restart', confidence_score: 90, symbol: 'AAPL' },
      paper_result: { signal_id: 'sig-restart' },
      entry_price: 100,
      exit_price: 108,
      high_price: 109,
      low_price: 99,
      quantity: 1,
      side: 'buy',
    }),
  });
  await new Promise((resolve) => firstServer.close(resolve));

  const secondServer = createTradingControlServer({ performanceHistoryPath: historyPath });
  await new Promise((resolve) => secondServer.listen(0, resolve));
  const { port: secondPort } = secondServer.address();
  const reportResponse = await fetch(`http://127.0.0.1:${secondPort}/daily-live-results?date=2026-06-14`);
  const reportPayload = await reportResponse.json();
  assert.equal(reportResponse.status, 200);
  assert.equal(reportPayload.paper_outcome_count, 1);
  assert.equal(reportPayload.signal_count, 1);
  await new Promise((resolve) => secondServer.close(resolve));
});

test('server exposes and accepts a persisted risk policy snapshot', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-policy-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const server = createTradingControlServer({ performanceHistoryPath: historyPath, policyPath, policyHistoryPath });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const defaultResponse = await fetch(`http://127.0.0.1:${port}/risk-policy`);
  const defaultPayload = await defaultResponse.json();
  assert.equal(defaultResponse.status, 200);
  assert.equal(defaultPayload.accepted, true);
  assert(defaultPayload.policy_snapshot);

  const updateResponse = await fetch(`http://127.0.0.1:${port}/risk-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'tuning',
      captured_at: '2026-06-14T12:00:00.000Z',
      report_date: '2026-06-14',
      reason_codes: ['HIGH_CONFIDENCE_BUCKET_OUTPERFORMS'],
      policy: {
        minConfidenceForPaper: 88,
        minFreshnessScore: 65,
        minSourceQualityScore: 60,
        maxContradictionScore: 35,
        maxRiskScore: 45,
        minLiquidityScore: 50,
        minVolume: 100000,
      },
    }),
  });
  const updatePayload = await updateResponse.json();
  assert.equal(updateResponse.status, 200);
  assert.equal(updatePayload.accepted, true);
  assert.equal(updatePayload.policy_snapshot.policy.minConfidenceForPaper, 88);
  assert.equal(fs.existsSync(policyPath), true);
  assert.equal(fs.existsSync(policyHistoryPath), true);
  const diskSnapshot = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  assert.equal(diskSnapshot.policy.minConfidenceForPaper, 88);
  await new Promise((resolve) => server.close(resolve));
});

test('server exposes policy effectiveness summaries', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-policy-effectiveness-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const server = createTradingControlServer({ performanceHistoryPath: historyPath, policyPath, policyHistoryPath });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const laterPolicyResponse = await fetch(`http://127.0.0.1:${port}/risk-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'policy-a',
      captured_at: '2026-06-14T10:00:00.000Z',
      report_date: '2026-06-14',
      policy: {
        minConfidenceForPaper: 72,
        minFreshnessScore: 55,
        minSourceQualityScore: 40,
        maxContradictionScore: 50,
        maxRiskScore: 70,
        minLiquidityScore: 40,
        minVolume: 50000,
      },
    }),
  });
  await laterPolicyResponse.text();

  const outcomeResponse = await fetch(`http://127.0.0.1:${port}/paper-outcomes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      original_signal: { signal_id: 'sig-eff-a', confidence_score: 80, symbol: 'AAPL' },
      paper_result: { signal_id: 'sig-eff-a' },
      entry_price: 100,
      exit_price: 110,
      high_price: 112,
      low_price: 99,
      quantity: 1,
      side: 'buy',
    }),
  });
  const policyResponse = await fetch(`http://127.0.0.1:${port}/risk-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'policy-b',
      captured_at: '2026-06-14T11:00:00.000Z',
      report_date: '2026-06-14',
      policy: {
        minConfidenceForPaper: 80,
        minFreshnessScore: 60,
        minSourceQualityScore: 45,
        maxContradictionScore: 45,
        maxRiskScore: 65,
        minLiquidityScore: 45,
        minVolume: 60000,
      },
    }),
  });

  const response = await fetch(`http://127.0.0.1:${port}/policy-effectiveness?dateFrom=2026-06-14T00:00:00.000Z&dateTo=2026-06-14T23:59:59.999Z`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.accepted, true);
  assert.equal(payload.policy_effectiveness.interval_count >= 1, true);
  assert(payload.policy_effectiveness.best_policy);
  await new Promise((resolve) => server.close(resolve));
});

test('server can roll back to the best historical policy', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-policy-rollback-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const server = createTradingControlServer({ performanceHistoryPath: historyPath, policyPath, policyHistoryPath });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const policyResponse = await fetch(`http://127.0.0.1:${port}/risk-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'policy-a',
      captured_at: '2026-06-14T10:00:00.000Z',
      report_date: '2026-06-14',
      policy: {
        minConfidenceForPaper: 72,
        minFreshnessScore: 55,
        minSourceQualityScore: 40,
        maxContradictionScore: 50,
        maxRiskScore: 70,
        minLiquidityScore: 40,
        minVolume: 50000,
      },
    }),
  });
  await policyResponse.text();

  const outcomeResponse = await fetch(`http://127.0.0.1:${port}/paper-outcomes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      original_signal: { signal_id: 'sig-rollback-a', confidence_score: 80, symbol: 'AAPL' },
      paper_result: { signal_id: 'sig-rollback-a' },
      entry_price: 100,
      exit_price: 110,
      high_price: 112,
      low_price: 99,
      quantity: 1,
      side: 'buy',
    }),
  });
  await fetch(`http://127.0.0.1:${port}/risk-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'policy-b',
      captured_at: '2026-06-14T11:00:00.000Z',
      report_date: '2026-06-14',
      policy: {
        killSwitch: true,
        minConfidenceForPaper: 95,
        minFreshnessScore: 60,
        minSourceQualityScore: 45,
        maxContradictionScore: 45,
        maxRiskScore: 65,
        minLiquidityScore: 45,
        minVolume: 60000,
      },
    }),
  });

  const rollbackResponse = await fetch(`http://127.0.0.1:${port}/policy-rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dateFrom: '2026-06-14T00:00:00.000Z',
      dateTo: '2026-06-14T23:59:59.999Z',
    }),
  });
  const rollbackPayload = await rollbackResponse.json();
  assert.equal(rollbackResponse.status, 200);
  assert.equal(rollbackPayload.accepted, true);
  assert.equal(rollbackPayload.policy_snapshot.policy.minConfidenceForPaper, 72);
  assert.equal(rollbackPayload.policy_snapshot.source, 'rollback');
  const dailyResponse = await fetch(`http://127.0.0.1:${port}/risk-policy`);
  const dailyPayload = await dailyResponse.json();
  assert.equal(dailyPayload.policy_snapshot.policy.minConfidenceForPaper, 72);
  await new Promise((resolve) => server.close(resolve));
});

test('performance store can rebalance policy size from effectiveness history', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-size-rebalance-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const store = new PerformanceStore({ historyPath, policyPath, policyHistoryPath });

  store.setPolicySnapshot({
    source: 'policy-a',
    captured_at: '2026-06-14T10:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      minVolume: 50000,
      positionSizeMultiplier: 1,
    },
  });
  store.recordPaperExecution({
    original_signal: { signal_id: 'sig-size-up', confidence_score: 80, symbol: 'AAPL' },
    paper_result: { signal_id: 'sig-size-up', entry_price: 100, filled_at: '2026-06-14T10:15:00.000Z' },
    entry_price: 100,
    exit_price: 110,
    high_price: 112,
    low_price: 99,
    quantity: 1,
    side: 'buy',
  });
  const rebalance = store.rebalancePolicySize({ dateFrom: '2026-06-14T00:00:00.000Z', dateTo: '2026-06-14T23:59:59.999Z' });
  assert.equal(rebalance.accepted, true);
  assert.equal(rebalance.policy_snapshot.policy.positionSizeMultiplier > 1, true);
});

test('server exposes policy size rebalancing', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-size-rebalance-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const server = createTradingControlServer({ performanceHistoryPath: historyPath, policyPath, policyHistoryPath });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const policyResponse = await fetch(`http://127.0.0.1:${port}/risk-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'policy-a',
      captured_at: '2026-06-14T10:00:00.000Z',
      report_date: '2026-06-14',
      policy: {
        minConfidenceForPaper: 72,
        minFreshnessScore: 55,
        minSourceQualityScore: 40,
        maxContradictionScore: 50,
        maxRiskScore: 70,
        minLiquidityScore: 40,
        minVolume: 50000,
        positionSizeMultiplier: 1,
      },
    }),
  });
  await policyResponse.text();

  const outcomeResponse = await fetch(`http://127.0.0.1:${port}/paper-outcomes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      original_signal: { signal_id: 'sig-size-rebalance', confidence_score: 80, symbol: 'AAPL' },
      paper_result: { signal_id: 'sig-size-rebalance', filled_at: '2026-06-14T10:01:00.000Z' },
      entry_price: 100,
      exit_price: 110,
      high_price: 112,
      low_price: 99,
      quantity: 1,
      side: 'buy',
    }),
  });
  await outcomeResponse.text();

  const response = await fetch(`http://127.0.0.1:${port}/policy-size-rebalance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dateFrom: '2026-06-14T00:00:00.000Z',
      dateTo: '2026-06-14T23:59:59.999Z',
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.accepted, true);
  assert.equal(payload.policy_snapshot.policy.positionSizeMultiplier > 1, true);
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  server.close();
});

test('server exposes policy capacity rebalancing', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-capacity-rebalance-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const server = createTradingControlServer({ performanceHistoryPath: historyPath, policyPath, policyHistoryPath });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  await fetch(`http://127.0.0.1:${port}/risk-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'policy-a',
      captured_at: '2026-06-14T10:00:00.000Z',
      report_date: '2026-06-14',
      policy: {
        minConfidenceForPaper: 72,
        minFreshnessScore: 55,
        minSourceQualityScore: 40,
        maxContradictionScore: 50,
        maxRiskScore: 70,
        minLiquidityScore: 40,
        minVolume: 50000,
        maxOpenPositions: 12,
        positionSizeMultiplier: 1,
      },
    }),
  });

  await fetch(`http://127.0.0.1:${port}/paper-outcomes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      original_signal: { signal_id: 'sig-capacity', confidence_score: 93, symbol: 'AAPL' },
      paper_result: { signal_id: 'sig-capacity', filled_at: '2026-06-14T10:01:00.000Z' },
      entry_price: 100,
      exit_price: 115,
      high_price: 117,
      low_price: 99,
      quantity: 1,
      side: 'buy',
    }),
  });
  await fetch(`http://127.0.0.1:${port}/paper-outcomes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      original_signal: { signal_id: 'sig-capacity-2', confidence_score: 92, symbol: 'MSFT' },
      paper_result: { signal_id: 'sig-capacity-2', filled_at: '2026-06-14T10:11:00.000Z' },
      entry_price: 100,
      exit_price: 113,
      high_price: 114,
      low_price: 99,
      quantity: 1,
      side: 'buy',
    }),
  });
  await fetch(`http://127.0.0.1:${port}/paper-outcomes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      original_signal: { signal_id: 'sig-capacity-3', confidence_score: 94, symbol: 'NVDA' },
      paper_result: { signal_id: 'sig-capacity-3', filled_at: '2026-06-14T10:21:00.000Z' },
      entry_price: 100,
      exit_price: 118,
      high_price: 120,
      low_price: 99,
      quantity: 1,
      side: 'buy',
    }),
  });

  const response = await fetch(`http://127.0.0.1:${port}/policy-capacity-rebalance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dateFrom: '2026-06-14T00:00:00.000Z',
      dateTo: '2026-06-14T23:59:59.999Z',
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.accepted, true);
  assert.equal(payload.policy_snapshot.policy.maxOpenPositions, 14);
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  server.close();
});

test('server refreshes policy from learned rejection pressure', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-policy-refresh-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const server = createTradingControlServer({ performanceHistoryPath: historyPath, policyPath, policyHistoryPath });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  await fetch(`http://127.0.0.1:${port}/risk-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({
      source: 'manual',
      captured_at: '2026-06-14T10:00:00.000Z',
      report_date: '2026-06-14',
      policy: {
        minConfidenceForPaper: 72,
        minFreshnessScore: 55,
        minSourceQualityScore: 40,
        maxContradictionScore: 50,
        maxRiskScore: 70,
        minLiquidityScore: 40,
        minVolume: 50000,
        maxOpenPositions: 8,
      },
    }),
  });

  await fetch(`http://127.0.0.1:${port}/webhooks/signal-created`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      signal_id: 'sig-policy-refresh',
      symbol: 'AAPL',
      asset_type: 'stock',
      strategy_name: 'breakout',
      action_candidate: 'paper_buy',
      direction: 'bullish',
      side: 'buy',
      quantity: 1,
      confidence_score: 90,
      freshness_score: 90,
      source_quality_score: 90,
      contradiction_score: 5,
      risk_score: 10,
      stop_loss: 190,
      take_profit: 220,
      volume: 100000,
      signal: {
        signal_id: 'sig-policy-refresh',
        symbol: 'AAPL',
        asset_type: 'stock',
        strategy_name: 'breakout',
        timeframe: '5m',
        action_candidate: 'paper_buy',
        direction: 'bullish',
        side: 'buy',
        quantity: 1,
        confidence_score: 90,
        freshness_score: 90,
        source_quality_score: 90,
        contradiction_score: 5,
        risk_score: 10,
        stop_loss: 190,
        take_profit: 220,
        volume: 100000,
        created_at: '2026-06-14T10:01:00.000Z',
      },
    }),
  });

  const refreshResponse = await fetch(`http://127.0.0.1:${port}/policy-refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'learning-refresh',
      report_date: '2026-06-14',
    }),
  });
  const refreshPayload = await refreshResponse.json();
  assert.equal(refreshResponse.status, 200);
  assert.equal(refreshPayload.accepted, true);
  assert.equal(refreshPayload.policy_snapshot.source, 'learning-refresh');
  assert.equal(typeof refreshPayload.policy_snapshot.policy.maxOpenPositions, 'number');
  assert(refreshPayload.learning_report.dominant_block_reason);

  const policyResponse = await fetch(`http://127.0.0.1:${port}/risk-policy`);
  const policyPayload = await policyResponse.json();
  assert.equal(policyPayload.policy_snapshot.source, 'learning-refresh');

  await new Promise((resolve) => server.close(resolve));
});

test('server auto-refreshes the live policy after enough learning signals accumulate', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-auto-policy-refresh-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const server = createTradingControlServer({ performanceHistoryPath: historyPath, policyPath, policyHistoryPath });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  await fetch(`http://127.0.0.1:${port}/risk-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'manual',
      captured_at: '2026-06-14T10:00:00.000Z',
      report_date: '2026-06-14',
      policy: {
        minConfidenceForPaper: 72,
        minFreshnessScore: 55,
        minSourceQualityScore: 40,
        maxContradictionScore: 50,
        maxRiskScore: 70,
        minLiquidityScore: 40,
        minVolume: 50000,
        maxOpenPositions: 8,
      },
    }),
  });

  await fetch(`http://127.0.0.1:${port}/webhooks/risk-decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      riskDecision: {
        decision: 'BLOCKED',
        reason_codes: ['MAX_OPEN_POSITIONS_EXCEEDED', 'STALE_DATA'],
        timestamp: '2026-06-14T10:01:00.000Z',
      },
    }),
  });

  await fetch(`http://127.0.0.1:${port}/webhooks/risk-decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      riskDecision: {
        decision: 'BLOCKED',
        reason_codes: ['MULTI_SOURCE_CONFIRMATION_FAILED'],
        timestamp: '2026-06-14T10:02:00.000Z',
      },
    }),
  });

  const outcomeResponse = await fetch(`http://127.0.0.1:${port}/paper-outcomes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      original_signal: { signal_id: 'sig-auto-refresh', confidence_score: 88, symbol: 'AAPL' },
      paper_result: { signal_id: 'sig-auto-refresh', filled_at: '2026-06-14T10:03:00.000Z' },
      entry_price: 100,
      exit_price: 108,
      high_price: 109,
      low_price: 99,
      quantity: 1,
      side: 'buy',
    }),
  });
  const outcomePayload = await outcomeResponse.json();
  assert.equal(outcomeResponse.status, 200);
  assert.equal(outcomePayload.accepted, true);

  const policyResponse = await fetch(`http://127.0.0.1:${port}/risk-policy`);
  const policyPayload = await policyResponse.json();
  assert.equal(policyPayload.policy_snapshot.source.startsWith('auto-'), true);
  assert.equal(typeof policyPayload.policy_snapshot.policy.maxOpenPositions, 'number');
  assert(policyPayload.policy_snapshot.reason_codes.some((reason) => reason.includes('DOMINANT_BLOCK_')));

  await new Promise((resolve) => server.close(resolve));
});

test('server factory seeds startup max open positions from initial policy snapshot', async () => {
  const server = createTradingControlServer({
    initialPolicySnapshot: {
      source: 'startup-config',
      captured_at: '2026-06-14T12:00:00.000Z',
      report_date: '2026-06-14',
      reason_codes: ['STARTUP_CONFIG'],
      policy: {
        killSwitch: false,
        paperAdapterEnabled: true,
        requireHumanApproval: true,
        minConfidenceForPaper: 72,
        minFreshnessScore: 55,
        minSourceQualityScore: 40,
        minProviderConfirmationScore: 70,
        minEdgeScore: 60,
        blockedCalibrationBuckets: [],
        maxContradictionScore: 50,
        maxRiskScore: 70,
        minLiquidityScore: 40,
        minVolume: 50000,
        maxOpenPositions: 14,
        positionSizeMultiplier: 1,
      },
    },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/risk-policy`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.policy_snapshot.policy.maxOpenPositions, 14);
  assert.equal(payload.policy_snapshot.source, 'startup-config');
  await new Promise((resolve) => server.close(resolve));
});

test('server evaluates signal-created webhooks against the persisted policy snapshot', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-signal-policy-'));
  const historyPath = path.join(tempDir, 'paper-history.jsonl');
  const policyPath = path.join(tempDir, 'live-policy.json');
  const policyHistoryPath = path.join(tempDir, 'policy-history.jsonl');
  const server = createTradingControlServer({ performanceHistoryPath: historyPath, policyPath, policyHistoryPath });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const policyResponse = await fetch(`http://127.0.0.1:${port}/risk-policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'manual',
      captured_at: '2026-06-14T12:00:00.000Z',
      report_date: '2026-06-14',
      reason_codes: ['KILL_SWITCH'],
      policy: {
        killSwitch: true,
        minConfidenceForPaper: 95,
        minFreshnessScore: 55,
        minSourceQualityScore: 40,
        maxContradictionScore: 50,
        maxRiskScore: 70,
        minLiquidityScore: 40,
        minVolume: 50000,
      },
    }),
  });
  await policyResponse.text();

  const signalResponse = await fetch(`http://127.0.0.1:${port}/webhooks/signal-created`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      signal_id: 'sig-policy-block',
      symbol: 'AAPL',
      asset_type: 'stock',
      strategy_name: 'breakout',
      direction: 'bullish',
      confidence_score: 90,
      freshness_score: 90,
      source_quality_score: 90,
      contradiction_score: 5,
      risk_score: 10,
      stop_loss: 190,
      take_profit: 220,
      volume: 100000,
      signal: {
        signal_id: 'sig-policy-block',
        symbol: 'AAPL',
        asset_type: 'stock',
        strategy_name: 'breakout',
        timeframe: '5m',
        direction: 'bullish',
        confidence_score: 90,
        freshness_score: 90,
        source_quality_score: 90,
        contradiction_score: 5,
        risk_score: 10,
        stop_loss: 190,
        take_profit: 220,
        volume: 100000,
        created_at: '2026-06-14T12:01:00.000Z',
      },
    }),
  });
  assert.equal(signalResponse.status, 200);

  const reviewResponse = await fetch(`http://127.0.0.1:${port}/review-items`);
  const reviewPayload = await reviewResponse.json();
  assert.equal(reviewResponse.status, 200);
  assert.equal(reviewPayload.items.length, 1);
  assert.equal(reviewPayload.items[0].risk_gate_result, 'BLOCKED');

  const reportResponse = await fetch(`http://127.0.0.1:${port}/daily-live-results?date=2026-06-14`);
  const reportPayload = await reportResponse.json();
  assert.equal(reportPayload.blocked_count, 1);
  assert.equal(reportPayload.policy_snapshot.policy.killSwitch, true);

  await new Promise((resolve) => server.close(resolve));
});

test('server creates a paper order for approved signal-created webhooks', async () => {
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      positionSizeMultiplier: 1,
    },
  });
  const paperAdapter = new PaperTradeAdapter({ dryRun: true });
  const result = await processTradingSignal({
    signal: {
      signal_id: 'sig-order',
      symbol: 'AAPL',
      asset_type: 'stock',
      strategy_name: 'breakout',
      timeframe: '5m',
      action_candidate: 'paper_buy',
      direction: 'bullish',
      side: 'buy',
      quantity: 1,
      confidence_score: 95,
      freshness_score: 95,
      source_quality_score: 95,
      contradiction_score: 5,
      risk_score: 10,
      stop_loss: 198,
      take_profit: 220,
      volume: 100000,
      created_at: '2026-06-14T12:01:00.000Z',
      market_context: {
        alpaca_quote: {
          provider: 'alpaca',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T12:01:00.000Z',
          received_at: '2026-06-14T12:01:01.000Z',
          price: 205,
          volume: 100000,
        },
        twelve_data_quote: {
          provider: 'twelvedata',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T12:01:02.000Z',
          received_at: '2026-06-14T12:01:03.000Z',
          price: 205.1,
          volume: 100100,
        },
      },
    },
    portfolio: {
      trade_count_today: 0,
      daily_loss: 0,
      position_notional: 0,
      available: true,
      open_positions_count: 0,
    },
  }, {
    executionAdapter: paperAdapter,
    performance,
    policySnapshot: performance.getPolicySnapshot(),
    source: 'webhook',
    confirmationAttempts: 3,
    confirmationDelayMs: 1,
    marketContext: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T12:01:00.000Z',
        received_at: '2026-06-14T12:01:01.000Z',
        price: 205,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T12:01:02.000Z',
        received_at: '2026-06-14T12:01:03.000Z',
        price: 205.1,
        volume: 100100,
      },
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.stage, 'order_confirmed');
  assert.equal(paperAdapter.listOrders().length, 1);
  assert.equal(paperAdapter.listOrders()[0].status, 'accepted');
  assert.equal(paperAdapter.listOrders()[0].state_history.some((step) => step.to === 'approval_required'), true);
  assert.equal(performance.getDailyReport('2026-06-14').approved_count >= 1, true);
});

test('server blocks new signal-created webhooks when recent fills are poor', async () => {
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      positionSizeMultiplier: 1,
      minFillRateForPaper: 0.8,
      maxPartialFillRate: 0.1,
    },
  });

  performance.recordPaperOutcome({
    signal_id: 'sig-fill-1',
    symbol: 'AAPL',
    original_signal: { signal_id: 'sig-fill-1', confidence_score: 90, symbol: 'AAPL' },
    paper_result: { signal_id: 'sig-fill-1', filled_at: '2026-06-14T09:30:00.000Z', average_fill_price: 200, status: 'partially_filled' },
    entry_price: 200,
    exit_price: 199,
    high_price: 201,
    low_price: 198,
    quantity: 1,
    side: 'buy',
  });
  performance.recordPaperOutcome({
    signal_id: 'sig-fill-2',
    symbol: 'AAPL',
    original_signal: { signal_id: 'sig-fill-2', confidence_score: 90, symbol: 'AAPL' },
    paper_result: { signal_id: 'sig-fill-2', filled_at: '2026-06-14T10:00:00.000Z', average_fill_price: 200, status: 'rejected' },
    entry_price: 200,
    exit_price: 200,
    high_price: 200.5,
    low_price: 199.5,
    quantity: 1,
    side: 'buy',
    false_positive: true,
  });

  const paperAdapter = new PaperTradeAdapter({ dryRun: true });
  const result = await processTradingSignal({
    signal: {
      signal_id: 'sig-fill-blocked',
      symbol: 'AAPL',
      asset_type: 'stock',
      strategy_name: 'breakout',
      timeframe: '5m',
      action_candidate: 'paper_buy',
      direction: 'bullish',
      side: 'buy',
      quantity: 1,
      confidence_score: 92,
      freshness_score: 92,
      source_quality_score: 92,
      provider_confirmation_score: 92,
      contradiction_score: 5,
      risk_score: 10,
      stop_loss: 198,
      take_profit: 220,
      volume: 100000,
      created_at: '2026-06-14T10:05:00.000Z',
      market_context: {
        alpaca_quote: {
          provider: 'alpaca',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T10:05:00.000Z',
          received_at: '2026-06-14T10:05:01.000Z',
          price: 200,
          volume: 100000,
        },
        twelve_data_quote: {
          provider: 'twelvedata',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T10:05:02.000Z',
          received_at: '2026-06-14T10:05:03.000Z',
          price: 200.1,
          volume: 100050,
        },
        fill_quality_summary: performance.getDailyReport('2026-06-14').fill_quality_summary,
      },
    },
    portfolio: {
      trade_count_today: 0,
      daily_loss: 0,
      position_notional: 0,
      available: true,
      open_positions_count: 0,
    },
  }, {
    executionAdapter: paperAdapter,
    performance,
    policySnapshot: performance.getPolicySnapshot(),
    source: 'webhook',
    marketContext: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T10:05:00.000Z',
        received_at: '2026-06-14T10:05:01.000Z',
        price: 200,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T10:05:02.000Z',
        received_at: '2026-06-14T10:05:03.000Z',
        price: 200.1,
        volume: 100050,
      },
      fill_quality_summary: performance.getDailyReport('2026-06-14').fill_quality_summary,
    },
  });

  assert.equal(result.accepted, false);
  assert(result.reason_codes.includes('LOW_FILL_RATE') || result.reason_codes.includes('HIGH_PARTIAL_FILL_RATE'));
  assert.equal(paperAdapter.listOrders().length, 0);
});

test('live buy sizing respects current buying power before submission', async () => {
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      positionSizeMultiplier: 1,
      maxOpenPositions: 9,
      buyNotionalTarget: 50,
    },
  });

  let submittedRequest = null;
  const executionAdapter = {
    async getAccount() {
      return {
        buying_power: '47.75',
        cash: '47.75',
        available_buying_power: '47.75',
      };
    },
    async submitOrder(request) {
      submittedRequest = request;
      return {
        order_id: 'alpaca-live-order',
        status: 'accepted',
        submitted_to: 'https://api.alpaca.markets',
        external_order: { id: 'alpaca-live-order', status: 'accepted' },
      };
    },
    async getOrder() {
      return {
        order_id: 'alpaca-live-order',
        status: 'filled',
        fill: { average_fill_price: 1789.61, filled_quantity: 0.025 },
      };
    },
    async getOpenOrders() {
      return [];
    },
  };

  const result = await processTradingSignal({
    signal: {
      signal_id: 'sig-live-buy-cap',
      symbol: 'ETH/USD',
      asset_type: 'crypto',
      strategy_name: 'overnight-crypto-momentum',
      timeframe: 'overnight',
      action_candidate: 'paper_buy',
      direction: 'bullish',
      side: 'buy',
      confidence_score: 90,
      freshness_score: 95,
      source_quality_score: 95,
      provider_confirmation_score: 95,
      contradiction_score: 5,
      risk_score: 10,
      entry_price: 1789.61,
      price: 1789.61,
      notional: 50,
      stop_loss: 1777,
      take_profit: 1825,
      volume: 100000,
      created_at: '2026-06-14T12:00:00.000Z',
      market_context: {
        alpaca_quote: {
          provider: 'alpaca',
          symbol: 'ETH/USD',
          asset_type: 'crypto',
          timestamp: '2026-06-14T12:00:00.000Z',
          received_at: '2026-06-14T12:00:01.000Z',
          price: 1789.61,
          volume: 100000,
        },
        secondary_quote: {
          provider: 'alpaca-secondary',
          symbol: 'ETH/USD',
          asset_type: 'crypto',
          timestamp: '2026-06-14T12:00:00.000Z',
          received_at: '2026-06-14T12:00:01.000Z',
          price: 1789.61,
          volume: 100000,
        },
      },
    },
    portfolio: {
      trade_count_today: 0,
      daily_loss: 0,
      position_notional: 0,
      available: true,
      open_positions_count: 0,
    },
  }, {
    executionAdapter,
    performance,
    policySnapshot: performance.getPolicySnapshot(),
    source: 'live',
    confirmationAttempts: 1,
    confirmationDelayMs: 0,
    confirmationMaxDelayMs: 0,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.stage, 'order_confirmed');
  assert.equal(submittedRequest.symbol, 'ETH/USD');
  assert.equal(submittedRequest.asset_type, 'crypto');
  assert.equal(result.paperOrderRequest.notional <= 47.75, true);
  assert(submittedRequest.notional <= 47.75);
});

test('policy buy target drives larger sizing when no runtime override is supplied', async () => {
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      positionSizeMultiplier: 1,
      maxOpenPositions: 2,
      buyNotionalTarget: 1000,
    },
  });

  let submittedRequest = null;
  const executionAdapter = {
    async getAccount() {
      return {
        buying_power: '5000',
        cash: '5000',
        available_buying_power: '5000',
      };
    },
    async submitOrder(request) {
      submittedRequest = request;
      return {
        order_id: 'alpaca-live-order',
        status: 'accepted',
        submitted_to: 'https://api.alpaca.markets',
        external_order: { id: 'alpaca-live-order', status: 'accepted' },
      };
    },
    async getOrder() {
      return {
        order_id: 'alpaca-live-order',
        status: 'filled',
        fill: { average_fill_price: 48.25, filled_quantity: 20 },
      };
    },
    async getOpenOrders() {
      return [];
    },
  };

  const result = await processTradingSignal({
    signal: {
      signal_id: 'sig-live-buy-policy-target',
      symbol: 'AAPL',
      asset_type: 'stock',
      strategy_name: 'breakout',
      timeframe: '5m',
      action_candidate: 'paper_buy',
      direction: 'bullish',
      side: 'buy',
      confidence_score: 90,
      freshness_score: 95,
      source_quality_score: 95,
      provider_confirmation_score: 95,
      contradiction_score: 5,
      risk_score: 10,
      entry_price: 48.25,
      price: 48.25,
      stop_loss: 45,
      take_profit: 60,
      volume: 100000,
      created_at: '2026-06-14T12:00:00.000Z',
      market_context: {
        alpaca_quote: {
          provider: 'alpaca',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T12:00:00.000Z',
          received_at: '2026-06-14T12:00:01.000Z',
          price: 48.25,
          volume: 100000,
        },
        secondary_quote: {
          provider: 'alpaca-secondary',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T12:00:00.000Z',
          received_at: '2026-06-14T12:00:01.000Z',
          price: 48.25,
          volume: 100000,
        },
      },
    },
    portfolio: {
      trade_count_today: 0,
      daily_loss: 0,
      position_notional: 0,
      available: true,
      open_positions_count: 0,
    },
  }, {
    executionAdapter,
    performance,
    policySnapshot: performance.getPolicySnapshot(),
    source: 'live',
    confirmationAttempts: 1,
    confirmationDelayMs: 0,
    confirmationMaxDelayMs: 0,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.stage, 'order_confirmed');
  assert.equal(submittedRequest.quantity, 20);
  assert.equal(submittedRequest.notional, 965);
});

test('paper order request webhook rejects invalid hold decisions', async () => {
  const server = createTradingControlServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/paper-order-request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      request_id: 'req-invalid',
      signal_id: 'sig-invalid',
      symbol: 'AAPL',
      side: 'hold',
      action_candidate: 'hold',
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.accepted, false);
  await new Promise((resolve) => server.close(resolve));
});

test('direct signal endpoint can submit an approved paper order', async () => {
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      positionSizeMultiplier: 1,
    },
  });
  const paperAdapter = new PaperTradeAdapter({ dryRun: true });
  const result = await processTradingSignal({
    signal: {
      signal_id: 'direct-signal-order',
      symbol: 'AAPL',
      asset_type: 'stock',
      strategy_name: 'breakout',
      timeframe: '5m',
      action_candidate: 'paper_buy',
      direction: 'bullish',
      side: 'buy',
      quantity: 1,
      confidence_score: 95,
      freshness_score: 95,
      source_quality_score: 95,
      contradiction_score: 5,
      risk_score: 10,
      stop_loss: 198,
      take_profit: 220,
      volume: 100000,
      created_at: '2026-06-14T12:01:00.000Z',
      market_context: {
        alpaca_quote: {
          provider: 'alpaca',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T12:01:00.000Z',
          received_at: '2026-06-14T12:01:01.000Z',
          price: 205,
          volume: 100000,
        },
        twelve_data_quote: {
          provider: 'twelvedata',
          symbol: 'AAPL',
          asset_type: 'stock',
          timestamp: '2026-06-14T12:01:02.000Z',
          received_at: '2026-06-14T12:01:03.000Z',
          price: 205.1,
          volume: 100100,
        },
      },
    },
    portfolio: {
      trade_count_today: 0,
      daily_loss: 0,
      position_notional: 0,
      available: true,
      open_positions_count: 0,
    },
  }, {
    executionAdapter: paperAdapter,
    performance,
    policySnapshot: performance.getPolicySnapshot(),
    source: 'direct',
    confirmationAttempts: 3,
    confirmationDelayMs: 1,
    marketContext: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T12:01:00.000Z',
        received_at: '2026-06-14T12:01:01.000Z',
        price: 205,
        volume: 100000,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        timestamp: '2026-06-14T12:01:02.000Z',
        received_at: '2026-06-14T12:01:03.000Z',
        price: 205.1,
        volume: 100100,
      },
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.stage, 'order_confirmed');
  assert.equal(paperAdapter.listOrders().length, 1);
  assert.equal(paperAdapter.listOrders()[0].status, 'accepted');
  assert.equal(performance.getDailyReport('2026-06-14').approved_count >= 1, true);
});

test('market ingest can create a paper order from real confirmed market data', async () => {
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minLiquidityScore: 40,
      minVolume: 1000,
      positionSizeMultiplier: 1,
      defaultNotional: 25,
    },
  });
  const paperAdapter = new PaperTradeAdapter({ dryRun: true });
  const result = await processMarketInput({
    provider: 'alpaca',
    symbol: 'AAPL',
    asset_type: 'stock',
    kind: 'quote',
    timestamp: '2026-06-14T13:00:00.000Z',
    received_at: '2026-06-14T13:00:01.000Z',
    price: 205,
    previous_close: 200,
    volume: 150000,
    confidence: 92,
    reliability: 90,
    market_context: {
      alpaca_quote: {
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        kind: 'quote',
        timestamp: '2026-06-14T13:00:00.000Z',
        received_at: '2026-06-14T13:00:01.000Z',
        price: 205,
        previous_close: 200,
        volume: 150000,
        confidence: 92,
        reliability: 90,
      },
      twelve_data_quote: {
        provider: 'twelvedata',
        symbol: 'AAPL',
        asset_type: 'stock',
        kind: 'quote',
        timestamp: '2026-06-14T13:00:02.000Z',
        received_at: '2026-06-14T13:00:03.000Z',
        price: 205.12,
        previous_close: 200,
        volume: 150100,
        confidence: 91,
        reliability: 89,
      },
    },
  }, {
    executionAdapter: paperAdapter,
    performance,
    policySnapshot: performance.getPolicySnapshot(),
    source: 'webhook',
    confirmationAttempts: 3,
    confirmationDelayMs: 1,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.stage, 'order_confirmed');
  assert.equal(result.signal.final_decision, 'approved_for_paper');
  assert.equal(paperAdapter.listOrders().length, 1);
  assert.equal(paperAdapter.listOrders()[0].status, 'filled');
});

test('direct paper order endpoint rejects invalid hold decisions', async () => {
  const server = createTradingControlServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/paper-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      request_id: 'req-invalid',
      signal_id: 'sig-invalid',
      symbol: 'AAPL',
      side: 'hold',
      action_candidate: 'hold',
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.accepted, false);
  await new Promise((resolve) => server.close(resolve));
});

test('direct paper order endpoint submits approved trade requests', async () => {
  const paperAdapter = new PaperTradeAdapter({ dryRun: true });
  const server = createTradingControlServer({
    paperAdapter,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/paper-order`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      request_id: 'req-valid',
      signal_id: 'sig-valid',
      symbol: 'ETH/USD',
      side: 'sell',
      action_candidate: 'paper_sell',
      quantity: 0.001,
      order_type: 'market',
      time_in_force: 'gtc',
      market_context: {
        alpaca_quote: {
          provider: 'alpaca',
          symbol: 'ETH/USD',
          asset_type: 'crypto',
          kind: 'quote',
          timestamp: '2026-06-15T04:00:00.000Z',
          received_at: '2026-06-15T04:00:01.000Z',
          price: 1770,
          previous_close: 1785,
          volume: 100000,
        },
      },
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.accepted, true);
  assert.equal(paperAdapter.listOrders().length, 1);
  assert.equal(paperAdapter.listOrders()[0].status, 'accepted');
  await new Promise((resolve) => server.close(resolve));
});
