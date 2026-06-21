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
    volatilityThresholdPct: 999,
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
