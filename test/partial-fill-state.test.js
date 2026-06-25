const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadPartialFillState,
  reconcilePartialFills,
  savePartialFillState,
  summarizePartialFillState,
  updatePartialFillStateFromOrder,
} = require('../src');

test('partial buy creates partial-fill state and summary', () => {
  const state = updatePartialFillStateFromOrder({}, {
    id: 'ord-buy-1',
    client_order_id: 'client-buy-1',
    symbol: 'MU',
    side: 'buy',
    status: 'partially_filled',
    qty: '2',
    filled_qty: '1',
    filled_avg_price: '100',
  }, { now: '2026-06-25T13:00:00.000Z' });
  const summary = summarizePartialFillState(state);

  assert.equal(summary.count, 1);
  assert.equal(summary.partial_buys[0].symbol, 'MU');
  assert.equal(summary.partial_buys[0].remaining_qty, 1);
  assert(summary.warnings.includes('PARTIAL_FILL_PENDING'));
});

test('partial sell creates partial-fill state and remaining exposure reason', async () => {
  const state = updatePartialFillStateFromOrder({}, {
    id: 'ord-sell-1',
    symbol: 'MU',
    side: 'sell',
    status: 'partially_filled',
    qty: '2',
    filled_qty: '1',
  }, { now: '2026-06-25T13:00:00.000Z' });

  const reconciled = await reconcilePartialFills({
    previousState: state,
    openOrders: [{ id: 'ord-sell-1', symbol: 'MU', side: 'sell', status: 'partially_filled', qty: '2', filled_qty: '1' }],
    positions: [{ symbol: 'MU', qty: '1' }],
    now: '2026-06-25T13:01:00.000Z',
  });
  const summary = summarizePartialFillState(reconciled);

  assert.equal(summary.partial_sells[0].symbol, 'MU');
  assert(summary.partial_sells[0].reason_codes.includes('PARTIAL_SELL_REMAINING_EXPOSURE'));
});

test('filled after partial clears active pending summary', async () => {
  const state = updatePartialFillStateFromOrder({}, {
    id: 'ord-fill-1',
    symbol: 'NVDA',
    side: 'buy',
    status: 'partially_filled',
    qty: '2',
    filled_qty: '1',
  }, { now: '2026-06-25T13:00:00.000Z' });
  const adapter = {
    getOrder: async () => ({ id: 'ord-fill-1', symbol: 'NVDA', side: 'buy', status: 'filled', qty: '2', filled_qty: '2' }),
  };
  const reconciled = await reconcilePartialFills({
    executionAdapter: adapter,
    previousState: state,
    openOrders: [],
    positions: [{ symbol: 'NVDA', qty: '2' }],
    now: '2026-06-25T13:02:00.000Z',
  });

  assert.equal(summarizePartialFillState(reconciled).count, 0);
  assert(Object.values(reconciled.orders)[0].reason_codes.includes('PARTIAL_ORDER_FILLED'));
});

test('canceled and rejected partial orders record reason codes', () => {
  const canceled = updatePartialFillStateFromOrder({}, {
    id: 'ord-cancel',
    symbol: 'MU',
    side: 'buy',
    status: 'canceled',
    qty: '2',
    filled_qty: '1',
  });
  const rejected = updatePartialFillStateFromOrder({}, {
    id: 'ord-reject',
    symbol: 'MU',
    side: 'buy',
    status: 'rejected',
    qty: '2',
    filled_qty: '0',
  });

  assert(Object.values(canceled.orders)[0].reason_codes.includes('PARTIAL_ORDER_CANCELED'));
  assert(Object.values(rejected.orders)[0].reason_codes.includes('PARTIAL_ORDER_REJECTED'));
});

test('stale partial order warning appears', () => {
  const state = updatePartialFillStateFromOrder({}, {
    id: 'ord-stale',
    symbol: 'MU',
    side: 'buy',
    status: 'partially_filled',
    qty: '2',
    filled_qty: '1',
  }, {
    now: '2026-06-25T13:00:00.000Z',
    staleMinutes: 1,
  });
  const stale = updatePartialFillStateFromOrder(state, {
    id: 'ord-stale',
    symbol: 'MU',
    side: 'buy',
    status: 'partially_filled',
    qty: '2',
    filled_qty: '1',
  }, {
    now: '2026-06-25T13:02:00.000Z',
    staleMinutes: 1,
  });

  assert.equal(summarizePartialFillState(stale).stale_partials.length, 1);
});

test('partial state saves and loads from disk', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-fill-state-'));
  const filePath = path.join(tempDir, 'partial-fill-state.json');
  const state = updatePartialFillStateFromOrder({}, {
    id: 'ord-disk',
    symbol: 'MU',
    side: 'buy',
    status: 'partially_filled',
    qty: '2',
    filled_qty: '1',
  });

  savePartialFillState(state, filePath);
  assert.equal(summarizePartialFillState(loadPartialFillState(filePath)).count, 1);
});
