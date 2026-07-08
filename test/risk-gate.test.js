const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRiskGate } = require('../src');

function baseSignal(overrides = {}) {
  return {
    signal_id: 'risk-test',
    symbol: 'BTC/USD',
    asset_type: 'crypto',
    side: 'buy',
    direction: 'bullish',
    entry_price: 100,
    stop_loss: 99,
    take_profit: 104,
    confidence_score: 90,
    freshness_score: 100,
    source_quality_score: 90,
    provider_confirmation_score: 90,
    edge_score: 90,
    volume: 100000,
    ...overrides,
  };
}

function basePolicy(overrides = {}) {
  return {
    killSwitch: false,
    requireHumanApproval: false,
    paperAdapterEnabled: true,
    requireStopLoss: true,
    requireTakeProfit: true,
    minRewardRiskRatio: 1,
    minConfidenceForPaper: 72,
    minVolume: 750,
    maxOpenPositions: 4,
    maxSpreadSlippagePct: 2,
    volatilityThresholdPct: null,
    minCryptoProviderConfirmationScore: 35,
    minProviderConfirmationScore: 70,
    ...overrides,
  };
}

test('risk gate max-open-position cap blocks buys only', () => {
  const fullPortfolio = {
    available: true,
    open_positions_count: 4,
    positions: [{ symbol: 'BTCUSD', qty: '1' }],
  };
  const buyDecision = evaluateRiskGate(baseSignal({ side: 'buy' }), fullPortfolio, basePolicy());
  assert(buyDecision.reason_codes.includes('MAX_OPEN_POSITIONS_EXCEEDED'));

  const sellDecision = evaluateRiskGate(baseSignal({
    side: 'sell',
    direction: 'bearish',
    stop_loss: 101,
    take_profit: 96,
  }), fullPortfolio, basePolicy());
  assert.equal(sellDecision.reason_codes.includes('MAX_OPEN_POSITIONS_EXCEEDED'), false);
});

test('risk gate blocks duplicate symbol buys from live portfolio context', () => {
  const decision = evaluateRiskGate(baseSignal({ symbol: 'BTC/USD' }), {
    available: true,
    open_positions_count: 1,
    symbols_held: ['BTC/USD'],
    open_orders: [{ symbol: 'ETHUSD', side: 'buy', status: 'new' }],
  }, basePolicy());
  assert(decision.reason_codes.includes('EXISTING_POSITION_FOR_SYMBOL'));
});

test('risk gate blocks duplicate open buy orders from live portfolio context', () => {
  const decision = evaluateRiskGate(baseSignal({ symbol: 'ETH/USD' }), {
    available: true,
    open_positions_count: 0,
    open_orders: [{ symbol: 'ETHUSD', side: 'buy', status: 'new' }],
  }, basePolicy());
  assert(decision.reason_codes.includes('OPEN_BUY_ORDER_FOR_SYMBOL'));
});

test('risk gate allows scale-in buys to pass through same-symbol holdings and open orders', () => {
  const decision = evaluateRiskGate(baseSignal({
    symbol: 'NVDA',
    allow_scale_in: true,
  }), {
    available: true,
    open_positions_count: 1,
    symbols_held: ['NVDA'],
    open_orders: [{ symbol: 'NVDA', side: 'buy', status: 'new' }],
  }, basePolicy());

  assert.equal(decision.pass, true);
  assert.equal(decision.reason_codes.includes('EXISTING_POSITION_FOR_SYMBOL'), false);
  assert.equal(decision.reason_codes.includes('OPEN_BUY_ORDER_FOR_SYMBOL'), false);
});

test('risk gate respects a widened live-market spread ceiling', () => {
  const tightPolicy = basePolicy({ maxSpreadSlippagePct: 0.75 });
  const loosePolicy = basePolicy({ maxSpreadSlippagePct: 7 });
  const signal = baseSignal({ symbol: 'NVDA', asset_type: 'stock' });
  const marketContext = { spread_slippage_pct: 3.2 };

  const tightDecision = evaluateRiskGate(signal, { available: true, open_positions_count: 0 }, tightPolicy, marketContext);
  assert(tightDecision.warnings.includes('MAX_SPREAD_SLIPPAGE_EXCEEDED'));

  const looseDecision = evaluateRiskGate(signal, { available: true, open_positions_count: 0 }, loosePolicy, marketContext);
  assert.equal(looseDecision.warnings.includes('MAX_SPREAD_SLIPPAGE_EXCEEDED'), false);
});

test('risk gate allows explicit single-source momentum override for stock buys', () => {
  const signal = baseSignal({
    symbol: 'VRM',
    asset_type: 'stock',
    provider_confirmation_score: 20,
    single_source_momentum_override: true,
  });
  const decision = evaluateRiskGate(signal, {
    available: true,
    open_positions_count: 0,
  }, basePolicy(), {
    single_source_momentum_override: {
      enabled: true,
      reason_code: 'SINGLE_SOURCE_MOMENTUM_OVERRIDE',
      rank_score: 1135.536,
      min_rank_score: 500,
    },
    provider_confirmation: { confirmed: false, discrepancy_score: 15 },
  });

  assert.equal(decision.pass, true);
  assert.equal(decision.reason_codes.includes('LOW_PROVIDER_CONFIRMATION'), false);
  assert.equal(decision.reason_codes.includes('MULTI_SOURCE_CONFIRMATION_FAILED'), false);
});

test('risk gate does not emit volatility warnings when the threshold is removed', () => {
  const decision = evaluateRiskGate(
    baseSignal({ symbol: 'MARA', asset_type: 'stock' }),
    { available: true, open_positions_count: 0 },
    basePolicy({ volatilityThresholdPct: null }),
    { volatility_pct: 50 },
  );

  assert.equal(decision.warnings.includes('VOLATILITY_THRESHOLD_EXCEEDED'), false);
});

test('risk gate allows scanner exit sells to bypass entry-only confirmation and reward-risk math', () => {
  const signal = baseSignal({
    symbol: 'NVDA',
    asset_type: 'stock',
    side: 'sell',
    direction: 'bearish',
    entry_price: 144,
    stop_loss: 145,
    take_profit: 143,
    provider_confirmation_score: 35,
    volume: 1000000,
  });
  const portfolio = {
    available: true,
    open_positions_count: 1,
    positions: [{ symbol: 'NVDA', qty: '0.5' }],
  };
  const policy = basePolicy({
    minRewardRiskRatio: 1.5,
    minSellProviderConfirmationScore: 60,
  });
  const marketContext = {
    price: 144,
    exit_state: {
      exit_reason: 'STOP_LOSS_DOLLARS',
      unrealized_pl: -1.25,
      gross_pnl: -1.25,
      execution_drag: 0,
      net_pnl: -1.25,
      real_gain: false,
    },
    provider_confirmation: {
      confirmed: false,
      discrepancy_score: 50,
    },
  };

  const exitDecision = evaluateRiskGate(signal, portfolio, policy, marketContext);
  assert.equal(exitDecision.pass, true);
  assert.equal(exitDecision.reason_codes.includes('INVALID_REWARD_RISK'), false);
  assert.equal(exitDecision.reason_codes.includes('LOW_PROVIDER_CONFIRMATION'), false);
  assert.equal(exitDecision.reason_codes.includes('MULTI_SOURCE_CONFIRMATION_FAILED'), false);

  const nonExitDecision = evaluateRiskGate(signal, portfolio, policy, {});
  assert.equal(nonExitDecision.pass, false);
  assert(nonExitDecision.reason_codes.includes('INVALID_REWARD_RISK'));
  assert(nonExitDecision.reason_codes.includes('LOW_PROVIDER_CONFIRMATION'));
});
