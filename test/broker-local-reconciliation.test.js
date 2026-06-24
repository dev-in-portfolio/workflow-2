const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reconcileBrokerLocalState } = require('../src');
const { formatReconciliationResult } = require('../scripts/reconcile-broker-local');

function adapter({ positions = [], openOrders = [], account = { cash: '250', buying_power: '250' } } = {}) {
  return {
    getAccount: async () => account,
    getPositions: async () => positions,
    getOpenOrders: async () => openOrders,
  };
}

function repo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-local-recon-'));
  const dataDir = path.join(repoRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'performance-history.jsonl'), '');
  return { repoRoot, dataDir };
}

function outcome(symbol, side, quantity, price, pnl = null) {
  return {
    entry_type: 'paper_outcome',
    record: {
      symbol,
      side,
      quantity,
      pnl,
      paper_result: {
        symbol,
        side,
        status: 'filled',
        filled_quantity: quantity,
        average_fill_price: price,
      },
    },
  };
}

async function reconcile(options = {}) {
  const dirs = repo();
  return reconcileBrokerLocalState({
    repoRoot: dirs.repoRoot,
    dataDir: dirs.dataDir,
    writeLatest: false,
    now: '2026-06-24T13:00:00.000Z',
    ...options,
  });
}

test('broker/local reconciliation reports OK when Alpaca and local agree', async () => {
  const result = await reconcile({
    executionAdapter: adapter({
      positions: [{ symbol: 'MU', qty: '1', avg_entry_price: '100', unrealized_pl: '0.2' }],
      openOrders: [],
    }),
    localPerformanceHistory: [outcome('MU', 'buy', 1, 100, 0.2)],
    trailingState: { positions: { MU: { peak_unrealized_pl: 0.4 } } },
  });

  assert.equal(result.status, 'OK');
  assert.equal(result.mismatches.length, 0);
});

test('broker/local reconciliation detects local phantom positions', async () => {
  const result = await reconcile({
    executionAdapter: adapter({ positions: [] }),
    localPerformanceHistory: [outcome('MU', 'buy', 1, 100)],
  });

  assert.equal(result.status, 'CRITICAL');
  assert.equal(result.local_phantom_positions[0].symbol, 'MU');
});

test('broker/local reconciliation detects Alpaca position missing locally', async () => {
  const result = await reconcile({
    executionAdapter: adapter({ positions: [{ symbol: 'NVDA', qty: '1', avg_entry_price: '120' }] }),
    localPerformanceHistory: [],
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 0.2 } } },
  });

  assert.equal(result.status, 'CRITICAL');
  assert.equal(result.broker_positions_missing_locally[0].symbol, 'NVDA');
});

test('broker/local reconciliation detects quantity and cost-basis mismatches', async () => {
  const result = await reconcile({
    executionAdapter: adapter({ positions: [{ symbol: 'MU', qty: '2', avg_entry_price: '101' }] }),
    localPerformanceHistory: [outcome('MU', 'buy', 1, 100)],
    trailingState: { positions: { MU: { peak_unrealized_pl: 0.4 } } },
  });

  assert(result.quantity_mismatches.some((item) => item.symbol === 'MU'));
  assert(result.cost_basis_mismatches.some((item) => item.symbol === 'MU'));
});

test('broker/local reconciliation detects open buy and sell order mismatches', async () => {
  const buyResult = await reconcile({
    executionAdapter: adapter({ openOrders: [{ id: 'buy-1', symbol: 'MU', side: 'buy', status: 'accepted' }] }),
  });
  const sellResult = await reconcile({
    executionAdapter: adapter({ openOrders: [{ id: 'sell-1', symbol: 'MU', side: 'sell', status: 'accepted' }] }),
  });

  assert(buyResult.open_order_mismatches.some((item) => item.type === 'ALPACA_OPEN_BUY_ORDER_UNKNOWN_LOCALLY'));
  assert(sellResult.open_order_mismatches.some((item) => item.type === 'ALPACA_OPEN_SELL_ORDER_UNKNOWN_LOCALLY'));
});

test('broker/local reconciliation detects stale trailing and missing trailing state', async () => {
  const result = await reconcile({
    executionAdapter: adapter({ positions: [{ symbol: 'MU', qty: '1', avg_entry_price: '100' }] }),
    localPerformanceHistory: [outcome('MU', 'buy', 1, 100)],
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 0.7 } } },
  });

  assert(result.trailing_state_mismatches.some((item) => item.type === 'STALE_TRAILING_STATE'));
  assert(result.trailing_state_mismatches.some((item) => item.type === 'BROKER_POSITION_MISSING_TRAILING_STATE'));
});

test('broker/local reconciliation detects pnl mismatches beyond tolerance', async () => {
  const result = await reconcile({
    executionAdapter: adapter({ positions: [{ symbol: 'MU', qty: '1', avg_entry_price: '100', unrealized_pl: '-1.50' }] }),
    localPerformanceHistory: [outcome('MU', 'buy', 1, 100, 0.25)],
    trailingState: { positions: { MU: { peak_unrealized_pl: 0.4 } } },
    pnlTolerance: 0.1,
  });

  assert(result.pnl_mismatches.some((item) => item.symbol === 'MU'));
});

test('broker/local reconciliation writes latest result to runtime file', async () => {
  const dirs = repo();
  const outputPath = path.join(dirs.dataDir, 'runtime', 'broker-local-reconciliation-latest.json');
  const result = await reconcileBrokerLocalState({
    repoRoot: dirs.repoRoot,
    dataDir: dirs.dataDir,
    outputPath,
    executionAdapter: adapter(),
  });

  assert.equal(result.status, 'OK');
  assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).status, 'OK');
});

test('broker/local reconciliation CLI formatter redacts secrets', () => {
  const output = formatReconciliationResult({
    status: 'CRITICAL',
    checked_at: '2026-06-24T13:00:00.000Z',
    account_available: false,
    positions_available: false,
    open_orders_available: false,
    alpaca_positions: [],
    alpaca_open_orders: [],
    mismatches: [],
    critical_failures: ['bad secret=super-secret-value AKAABIPI6ZUGH4KUGREJOV5XAP'],
    warnings: ['token: my-token-value'],
    recommended_actions: [],
  });

  assert(!output.includes('AKAABIPI6ZUGH4KUGREJOV5XAP'));
  assert(!output.includes('super-secret-value'));
  assert(!output.includes('my-token-value'));
});
