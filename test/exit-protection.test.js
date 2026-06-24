const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyExitProtection } = require('../src/exit-protection');

test('broker protective sell order classifies a position as broker_native', () => {
  const result = classifyExitProtection({
    positions: [{ symbol: 'NVDA', qty: '1' }],
    openOrders: [{ id: 'stop-1', symbol: 'NVDA', side: 'sell', type: 'stop', stop_price: '99' }],
    now: new Date('2026-06-24T15:00:00.000Z'),
  });

  assert.equal(result[0].classification, 'broker_native');
  assert.equal(result[0].protective_order_id, 'stop-1');
  assert.equal(result[0].warning, null);
});

test('fresh scanner runtime classifies a position as scanner_exit_manager', () => {
  const result = classifyExitProtection({
    positions: [{ symbol: 'MU', qty: '2' }],
    scannerRuntime: {
      last_scan_time: '2026-06-24T15:00:00.000Z',
      trailing_state: { positions: { MU: { peak_unrealized_pl: 0.8 } } },
    },
    now: new Date('2026-06-24T15:01:00.000Z'),
  });

  assert.equal(result[0].classification, 'scanner_exit_manager');
  assert.equal(result[0].scanner_exit_manager, true);
});

test('stale scanner and no protective order triggers an exit-manager warning', () => {
  const result = classifyExitProtection({
    positions: [{ symbol: 'FDX', qty: '1' }],
    openOrders: [],
    scannerRuntime: {
      last_scan_time: '2026-06-24T14:00:00.000Z',
      trailing_state: { positions: { FDX: { peak_unrealized_pl: 0.8 } } },
    },
    now: new Date('2026-06-24T15:00:00.000Z'),
  });

  assert.equal(result[0].classification, 'none');
  assert.equal(result[0].warning, 'EXIT_MANAGER_REQUIRED');
});
