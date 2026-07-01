const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  createStockScanner,
  processTradingSignal,
  reconcilePartialFills,
  summarizePartialFillState,
  updatePartialFillStateFromOrder,
} = require('../src');

function buySignal(overrides = {}) {
  return {
    signal_id: 'sig-buy-mu',
    request_id: 'req-buy-mu',
    symbol: 'MU',
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

function policy(overrides = {}) {
  return {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: false,
    minConfidenceForPaper: 0,
    minLiquidityScore: 0,
    minProviderConfirmationScore: 0,
    minEdgeScore: 0,
    minVolume: 0,
    maxSpreadSlippagePct: 100,
    minRewardRiskRatio: 0,
    requireStopLoss: false,
    requireTakeProfit: false,
    maxOpenPositions: 2,
    buyNotionalTarget: 150,
    minBuyNotional: 25,
    approvedSymbols: ['MU', 'NVDA'],
    ...overrides,
  };
}

function adapter(overrides = {}) {
  return {
    requiresBrokerReconciliation: true,
    getAccount: async () => ({ cash: '500', buying_power: '500' }),
    getPositions: async () => [],
    getOpenOrders: async () => [],
    submitOrder: async (request) => ({ order_id: 'ord-partial', status: 'accepted', request }),
    getOrder: async () => ({
      id: 'ord-partial',
      client_order_id: 'req-buy-mu',
      symbol: 'MU',
      side: 'buy',
      status: 'partially_filled',
      qty: '2',
      filled_qty: '1',
      filled_avg_price: '100',
    }),
    ...overrides,
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

test('trading loop records actual partial-fill quantity and metadata', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-fill-loop-'));
  const records = [];
  const performance = {
    recordSignal() {},
    recordRiskDecision() {},
    recordPaperOutcome(record) {
      records.push(record);
      return record;
    },
  };
  const result = await processTradingSignal({
    signal: buySignal({ quantity: 2 }),
    portfolio: { available: true },
  }, {
    repoRoot: tempDir,
    executionAdapter: adapter(),
    performance,
    policySnapshot: { policy: policy() },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.paperResult.status, 'partially_filled');
  assert.equal(result.paperResult.filled_quantity, 1);
  assert.equal(result.paperResult.remaining_quantity, 1);
  assert.equal(result.partial_fill_state.count, 1);
  assert.equal(records[0].partial_fill.filled_quantity, 1);
});

test('trading loop blocks duplicate same-side order while partial is pending', async () => {
  const partialFillState = updatePartialFillStateFromOrder({}, {
    id: 'ord-existing',
    symbol: 'MU',
    side: 'buy',
    status: 'partially_filled',
    qty: '2',
    filled_qty: '1',
  });
  const result = await processTradingSignal({
    signal: buySignal({ quantity: 2 }),
    portfolio: { available: true },
  }, {
    partialFillState,
    savePartialFillState: false,
    executionAdapter: adapter({ submitOrder: async () => { throw new Error('should not submit'); } }),
    policySnapshot: { policy: policy() },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.stage, 'pre_submit');
  assert(result.reason_codes.includes('PARTIAL_FILL_PENDING'));
});

test('stock scanner blocks duplicate buy, occupies slot, reserves buying power, and writes runtime summary', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-fill-scanner-'));
  const requests = [];
  const partialFillState = updatePartialFillStateFromOrder({}, {
    id: 'ord-existing',
    symbol: 'MU',
    side: 'buy',
    status: 'partially_filled',
    qty: '2',
    filled_qty: '1',
    filled_avg_price: '100',
  });
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const localServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ accepted: true, final_decision: 'APPROVED_FOR_PAPER' }));
    });
  });
  await new Promise((resolve) => localServer.listen(0, resolve));
  const scanner = createStockScanner({
    enabled: true,
    localBaseUrl: `http://127.0.0.1:${localServer.address().port}`,
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['MU', 'NVDA'],
    maxOpenPositions: 2,
    runtimeStateEnabled: true,
    marketOpen: true,
    partialFillState,
    env: { SCANNER_RUNTIME_STATE_PATH: path.join(tempDir, 'scanner-runtime.json') },
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) return response([]);
      if (url.includes('/v2/orders?status=open')) return response([]);
      if (url.includes('/v2/account')) return response({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return response({
          snapshots: {
            MU: snapshot(120, alpacaTimestamp),
            NVDA: snapshot(110, alpacaTimestamp),
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: global.fetch,
  });

  const result = await scanner.runOnce({ runId: 'partial-fill-scanner' });
  scanner.stop();
  await new Promise((resolve) => localServer.close(resolve));
  const runtime = JSON.parse(fs.readFileSync(path.join(tempDir, 'scanner-runtime.json'), 'utf8'));

  assert.equal(result.portfolio.partial_buy_order_count, 1);
  assert.equal(result.portfolio.remaining_position_slots, 1);
  assert.equal(result.allocation.reserved_notional, 100);
  assert.equal(result.skip_summary.PARTIAL_FILL_PENDING, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].symbol, 'NVDA');
  assert.equal(runtime.partial_fill_state.count, 1);
});

test('authoritative broker open orders clear stale partial buy slot reservations', async () => {
  let partialFillState = updatePartialFillStateFromOrder({}, {
    id: 'stale-accepted',
    client_order_id: 'stale-accepted',
    symbol: 'AAPL',
    side: 'buy',
    status: 'accepted',
    notional: 150,
  });
  partialFillState = updatePartialFillStateFromOrder(partialFillState, {
    id: 'old-filled',
    client_order_id: 'old-filled',
    symbol: 'ETH/USD',
    side: 'buy',
    status: 'filled',
    qty: '0.027939',
    filled_qty: '0.025',
    filled_avg_price: '1789.61',
    notional: 50,
  });

  const reconciled = await reconcilePartialFills({
    previousState: partialFillState,
    openOrders: [],
    positions: [],
    now: '2026-06-30T14:10:00.000Z',
    options: { authoritativeOpenOrders: true },
  });
  const summary = summarizePartialFillState(reconciled);

  assert.equal(summary.count, 0);
  assert.equal(summary.partial_buys.length, 0);
  assert.equal(summary.reserved_buy_notional, 0);
});

function snapshot(price, timestamp) {
  return {
    latestQuote: { bp: price - 0.1, ap: price + 0.1, t: timestamp },
    latestTrade: { p: price, t: timestamp },
    minuteBar: { v: 50, h: price + 0.5, l: price - 0.5, t: timestamp },
    prevDailyBar: { c: 100, v: 100000 },
  };
}
