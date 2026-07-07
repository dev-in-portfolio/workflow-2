const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createDashboardServer } = require('../src/dashboard-server');
const { saveTrailingState } = require('../src/position-trailing-state');

test('dashboard broker sync endpoint repairs stale broker state without process control action', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-broker-sync-'));
  const dataDir = path.join(repoRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  saveTrailingState({ positions: { VRM: { symbol: 'VRM', quantity: 25 } } }, { env: {}, repoRoot });
  const calls = [];
  const controlManager = {
    getState: () => ({
      scanner: { status: 'running', pid: 111 },
      trader: { status: 'running', pid: 222 },
    }),
    refresh: async () => { calls.push(['refresh']); },
    startWorkflow: async () => { calls.push(['startWorkflow']); return { ok: true }; },
  };
  const server = createDashboardServer({
    port: 0,
    dashboardDir: path.resolve(process.cwd(), 'dashboard'),
    repoRoot,
    dataDir,
    env: {
      TRADING_MODE: 'paper',
      ALPACA_EXECUTION_ENABLED: 'true',
      ALPACA_API_KEY_ID: 'key',
      ALPACA_API_SECRET_KEY: 'secret',
      ALPACA_API_BASE_URL: 'https://paper-api.alpaca.markets',
    },
    runtimeEnv: {
      TRADING_MODE: 'paper',
      ALPACA_EXECUTION_ENABLED: 'true',
      ALPACA_API_KEY_ID: 'key',
      ALPACA_API_SECRET_KEY: 'secret',
      ALPACA_API_BASE_URL: 'https://paper-api.alpaca.markets',
      MAX_OPEN_POSITIONS: '1',
    },
    controlManager,
    brokerSyncAdapter: {
      getAccount: async () => ({ buying_power: '500', cash: '500' }),
      getPositions: async () => [],
      getOpenOrders: async () => [],
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const result = await fetch(`http://127.0.0.1:${port}/api/broker/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'test' }),
    }).then((response) => response.json());

    assert.equal(result.ok, true);
    assert.equal(result.positions_after, 0);
    assert.equal(result.available_position_slots_after, 1);
    assert.equal(result.scanner_pid_before, 111);
    assert.equal(result.scanner_pid_after, 111);
    assert.equal(result.trader_pid_before, 222);
    assert.equal(result.trader_pid_after, 222);
    assert.equal(calls.some((call) => call[0] === 'startWorkflow'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
