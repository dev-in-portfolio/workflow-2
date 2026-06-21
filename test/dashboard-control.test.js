const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboardServer } = require('../src/dashboard-server');
const { createLocalProcessController, normalizeOperatorScannerProfile } = require('../src/local-process-controller');

test('dashboard control routes serve the operator tab and route actions locally', async () => {
  const calls = [];
  const controlManager = {
    refresh: async () => {
      calls.push(['refresh']);
    },
    getState: () => ({
      trader: {
        status: 'running',
        pid: 1234,
        port: 3001,
        managed: true,
        started_at: '2026-06-19T15:00:00.000Z',
        last_action_at: '2026-06-19T15:05:00.000Z',
      },
      scanner: {
        status: 'running',
        profile: 'live-market',
        pid: 4321,
        script: 'scripts/start-stock-scanner.js',
        managed: true,
        started_at: '2026-06-19T15:00:00.000Z',
        last_action_at: '2026-06-19T15:05:00.000Z',
      },
      last_action: null,
      updated_at: '2026-06-19T15:05:00.000Z',
    }),
    startTrader: async () => { calls.push(['startTrader']); return { ok: true, message: 'Trader started' }; },
    stopTrader: async () => { calls.push(['stopTrader']); return { ok: true, message: 'Trader stopped' }; },
    restartTrader: async () => { calls.push(['restartTrader']); return { ok: true, message: 'Trader restarted' }; },
    startWorkflow: async () => { calls.push(['startWorkflow']); return { ok: true, message: 'Workflow started' }; },
    startScanner: async (profile) => { calls.push(['startScanner', profile]); return { ok: true, message: 'Scanner started' }; },
    stopScanner: async () => { calls.push(['stopScanner']); return { ok: true, message: 'Scanner stopped' }; },
    restartScanner: async (profile) => { calls.push(['restartScanner', profile]); return { ok: true, message: 'Scanner restarted' }; },
    switchScannerProfile: async (profile) => { calls.push(['switchScannerProfile', profile]); return { ok: true, message: 'Scanner switched' }; },
  };

  const server = createDashboardServer({
    port: 0,
    dashboardDir: path.resolve(process.cwd(), 'dashboard'),
    dataDir: path.resolve(process.cwd(), 'data'),
    fetchImpl: global.fetch,
    controlManager,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const operatorHtml = await fetch(`http://127.0.0.1:${port}/control`).then((response) => response.text());
    assert(operatorHtml.includes('Process Controls'));
    assert(operatorHtml.includes('Live Market Scanner'));
    assert.equal(operatorHtml.includes('Switch to crypto only'), false);

    const controlState = await fetch(`http://127.0.0.1:${port}/api/control/state`).then((response) => response.json());
    assert.equal(controlState.status, 'ok');
    assert.equal(controlState.control.trader.port, 3001);
    assert.deepEqual(calls.shift(), ['refresh']);

    const actionResponse = await fetch(`http://127.0.0.1:${port}/api/control/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start-workflow' }),
    }).then((response) => response.json());
    assert.equal(actionResponse.ok, true);
    assert.equal(actionResponse.verified, true);
    assert.deepEqual(calls.shift(), ['startWorkflow']);

    const refreshAction = await fetch(`http://127.0.0.1:${port}/api/control/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'refresh' }),
    }).then((response) => response.json());
    assert.equal(refreshAction.ok, true);
    assert.deepEqual(calls.shift(), ['refresh']);

    const cryptoAction = await fetch(`http://127.0.0.1:${port}/api/control/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start-crypto-only' }),
    }).then((response) => response.json());
    assert.equal(cryptoAction.ok, false);
    assert.equal(cryptoAction.error, 'legacy_scanner_profile_hidden');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('operator workflow normalizes stale scanner profiles back to live market', async () => {
  assert.equal(normalizeOperatorScannerProfile('crypto-only'), 'live-market');
  assert.equal(normalizeOperatorScannerProfile('market-aware-auto'), 'live-market');
  assert.equal(normalizeOperatorScannerProfile('crypto-only', true), 'crypto-only');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-state-test-'));
  const workflowStatePath = path.join(tempDir, 'workflow-state.json');
  fs.writeFileSync(workflowStatePath, JSON.stringify({ desired_scanner_profile: 'crypto-only' }));

  const controller = createLocalProcessController({
    repoRoot: process.cwd(),
    workflowStatePath,
    runtimeEnv: {},
    fetchImpl: async () => { throw new Error('not running'); },
    execFileAsync: async () => ({ stdout: '', stderr: '' }),
  });

  const state = controller.getState();
  assert.equal(state.workflow.desired_scanner_profile, 'live-market');
  assert.equal(state.scanner.desired_profile, 'live-market');
});
