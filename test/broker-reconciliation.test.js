const assert = require('node:assert/strict');
const test = require('node:test');
const { processTradingSignal, recordPaperOutcome } = require('../src/trading-loop');

function buySignal(overrides = {}) {
  return {
    signal_id: 'sig-buy-nvda',
    request_id: 'req-buy-nvda',
    symbol: 'NVDA',
    asset_type: 'stock',
    side: 'buy',
    direction: 'bullish',
    action_candidate: 'paper_buy',
    order_type: 'market',
    notional: 150,
    supports_fractional_shares: true,
    entry_price: 100,
    price: 100,
    stop_loss: 99,
    take_profit: 103,
    confidence_score: 90,
    liquidity_score: 90,
    provider_confirmation_score: 90,
    edge_score: 90,
    source_quality_score: 90,
    volume: 100000,
    ...overrides,
  };
}

function permissivePolicy(overrides = {}) {
  return {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: false,
    requireTakeProfit: true,
    minConfidenceForPaper: 0,
    minLiquidityScore: 0,
    minProviderConfirmationScore: 0,
    minEdgeScore: 0,
    minVolume: 0,
    maxSpreadSlippagePct: 100,
    minRewardRiskRatio: 0,
    maxOpenPositions: 2,
    buyNotionalTarget: 150,
    minBuyNotional: 25,
    approvedSymbols: ['NVDA', 'AAPL'],
    ...overrides,
  };
}

function strictAdapter(overrides = {}) {
  return {
    requiresBrokerReconciliation: true,
    getAccount: async () => ({ cash: '500', buying_power: '500' }),
    getPositions: async () => [],
    getOpenOrders: async () => [],
    submitOrder: async (request) => ({ order_id: request.request_id, status: 'filled', request }),
    getOrder: async () => ({ id: 'order-1', status: 'filled', filled_avg_price: '100', qty: '1' }),
    ...overrides,
  };
}

test('live execution refuses a paper-only risk decision', async () => {
  let submitted = false;
  const result = await processTradingSignal({ signal: buySignal() }, {
    executionMode: 'live',
    executionAdapter: strictAdapter({
      submitOrder: async () => {
        submitted = true;
        return { status: 'filled' };
      },
    }),
    policySnapshot: { policy: permissivePolicy({ tradingMode: 'paper', liveTradingEnabled: false }) },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.stage, 'decision');
  assert.deepEqual(result.reason_codes, ['EXECUTION_MODE_DECISION_MISMATCH']);
  assert.equal(submitted, false);
});

test('broker-held symbol blocks stale direct portfolio buys', async () => {
  const result = await processTradingSignal({
    signal: buySignal(),
    portfolio: { available: true, positions: [], symbols_held: [] },
  }, {
    executionAdapter: strictAdapter({
      getPositions: async () => [{ symbol: 'NVDA', qty: '1', avg_entry_price: '99' }],
    }),
    policySnapshot: { policy: permissivePolicy() },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.stage, 'decision');
  assert(result.reason_codes.includes('EXISTING_POSITION_FOR_SYMBOL'));
  assert.equal(result.broker_reconciliation.available, true);
});

test('broker open buy order blocks stale direct portfolio buys', async () => {
  const result = await processTradingSignal({
    signal: buySignal(),
    portfolio: { available: true, positions: [], symbols_with_open_buy_orders: [] },
  }, {
    executionAdapter: strictAdapter({
      getOpenOrders: async () => [{ symbol: 'NVDA', side: 'buy', status: 'new' }],
    }),
    policySnapshot: { policy: permissivePolicy() },
  });

  assert.equal(result.accepted, false);
  assert(result.reason_codes.includes('OPEN_BUY_ORDER_FOR_SYMBOL'));
});

test('fresh broker truth clears stale local held-position gate after manual sell', async () => {
  const submitted = [];
  const result = await processTradingSignal({
    signal: buySignal({
      signal_id: 'sig-buy-aapl-after-vrm-sell',
      request_id: 'req-buy-aapl-after-vrm-sell',
      symbol: 'AAPL',
    }),
    portfolio: {
      available: true,
      open_positions_count: 1,
      remaining_position_slots: 0,
      symbols_held: ['VRM'],
      positions: [{ symbol: 'VRM', qty: '25' }],
    },
  }, {
    executionAdapter: strictAdapter({
      getAccount: async () => ({ cash: '500', buying_power: '500', equity: '500' }),
      getPositions: async () => [],
      getOpenOrders: async () => [],
      submitOrder: async (request) => {
        submitted.push(request);
        return { order_id: request.request_id, status: 'filled', request };
      },
    }),
    policySnapshot: { policy: permissivePolicy({ maxOpenPositions: 1, approvedSymbols: ['AAPL'] }) },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.broker_reconciliation.available, true);
  assert.equal(result.broker_reconciliation.broker_reconciled_portfolio.remaining_position_slots, 1);
  assert.deepEqual(result.broker_reconciliation.broker_reconciled_portfolio.symbols_held, []);
  assert.equal(submitted.length, 1);
});

test('missing broker account fails closed for Alpaca-capable buy paths', async () => {
  const result = await processTradingSignal({
    signal: buySignal(),
    portfolio: { available: true, cash: 1000, buying_power: 1000 },
  }, {
    executionAdapter: strictAdapter({
      getAccount: async () => { throw new Error('account unavailable'); },
    }),
    policySnapshot: { policy: permissivePolicy() },
  });

  assert.equal(result.accepted, false);
  assert(result.reason_codes.includes('BROKER_ACCOUNT_UNAVAILABLE'));
  assert(result.reason_codes.includes('BROKER_STATE_REQUIRED_FOR_BUY'));
});

test('broker buying power overrides request cash sizing', async () => {
  const submitted = [];
  const result = await processTradingSignal({
    signal: buySignal(),
    portfolio: { available: true, cash: 5000, buying_power: 5000 },
  }, {
    executionAdapter: strictAdapter({
      getAccount: async () => ({ cash: '132', buying_power: '132' }),
      submitOrder: async (request) => {
        submitted.push(request);
        return { order_id: request.request_id, status: 'filled', request };
      },
    }),
    policySnapshot: { policy: permissivePolicy({ maxOpenPositions: 1, buyNotionalTarget: 150 }) },
  });

  assert.equal(result.accepted, true);
  assert.equal(submitted[0].notional, 130.68);
  assert.equal(submitted[0].require_idempotency, true);
});

test('sell exits remain allowed through broker reconciliation when explainable', async () => {
  const result = await processTradingSignal({
    signal: buySignal({
      signal_id: 'sig-sell-nvda',
      request_id: 'req-sell-nvda',
      side: 'sell',
      direction: 'bearish',
      action_candidate: 'paper_sell',
      quantity: 1,
      position_avg_entry_price: 101,
      market_context: { exit_state: { exit_reason: 'STOP_LOSS_DOLLARS' } },
    }),
    market_context: { exit_state: { exit_reason: 'STOP_LOSS_DOLLARS' } },
  }, {
    executionAdapter: strictAdapter({
      getPositions: async () => [{ symbol: 'NVDA', qty: '1', avg_entry_price: '101' }],
    }),
    policySnapshot: { policy: permissivePolicy({ requireTakeProfit: false }) },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.paperOrderRequest.quantity, 1);
});

test('sell paper outcomes use scanner exit-state entry price instead of recording zero pnl', () => {
  let recorded = null;
  const performance = {
    recordPaperOutcome(outcome) {
      recorded = outcome;
      return outcome;
    },
  };

  const outcome = recordPaperOutcome(performance, {
    signal_id: 'sig-sell-dftx',
    symbol: 'DFTX',
    side: 'sell',
    direction: 'bearish',
    market_context: {
      exit_state: {
        entry_price: 44.105,
        sell_price: 43.16,
        quantity: 5.771227,
        exit_reason: 'STOP_LOSS_DOLLARS',
        fees: 0,
      },
    },
  }, {
    order_id: 'sell-order',
    status: 'filled',
    filled_at: '2026-06-24T17:17:13.870Z',
    average_fill_price: 43.16,
    filled_quantity: 5.771227,
    estimated_fees: 0,
  });

  assert.equal(outcome.pnl < 0, true);
  assert.equal(Number(outcome.pnl.toFixed(4)), -5.4538);
  assert.equal(recorded.win_loss, 'loss');
});
