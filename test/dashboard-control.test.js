const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboardServer } = require('../src/dashboard-server');
const { createLocalProcessController, normalizeOperatorScannerProfile } = require('../src/local-process-controller');
const { updateMemeMonitorFeatureState } = require('../src/meme-monitor-state');

test('dashboard server auto-starts regular watch loop only when requested', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-regular-watch-loop-'));
  const dataDir = path.join(repoRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  let startCount = 0;
  let stopCount = 0;
  const regularWatchLoop = {
    start: async () => {
      startCount += 1;
      return { status: 'active' };
    },
    stop: async () => {
      stopCount += 1;
      return { status: 'stopped' };
    },
    isRunning: () => startCount > stopCount,
  };
  const server = createDashboardServer({
    repoRoot,
    dataDir,
    env: {},
    regularWatchAutoStart: true,
    regularWatchLoop,
    controlManager: { getState: () => null },
    memeMonitor: { getStatus: () => null },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(startCount, 1);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(stopCount, 1);
});

test('dashboard control routes serve the operator tab and route actions locally', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-control-'));
  const dataDir = path.join(repoRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
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
    repoRoot,
    dataDir,
    env: {
      ...process.env,
      MEME_MONITOR_ENABLED: 'false',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'false',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      MEME_AUTO_ACTION_ENABLED: 'false',
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'false',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'false',
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'false',
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: 'false',
    },
    fetchImpl: global.fetch,
    controlManager,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const operatorHtml = await fetch(`http://127.0.0.1:${port}/control`).then((response) => response.text());
    const operatorJs = await fetch(`http://127.0.0.1:${port}/control.js`).then((response) => response.text());
    assert(operatorHtml.includes('Process Controls'));
    assert(operatorHtml.includes('Live Market Scanner'));
    assert(operatorHtml.includes('Meme Monitor'));
    assert(operatorHtml.includes('Enable Meme Monitor'));
    assert(operatorHtml.includes('Start Meme Monitor Shadow Scan'));
    assert(operatorHtml.includes('Refresh Hot Scores Now'));
    assert(operatorHtml.includes('Clear Expired Hot Symbols'));
    assert(operatorHtml.includes('Reset Meme Scores'));
    assert(operatorHtml.includes('Hot Slot Rotation may sell a weak break-even/profitable position to free a slot for a Hot Hot candidate.'));
    assert(operatorHtml.includes('Enable Hot Slot Rotation'));
    assert(operatorHtml.includes('Disable Hot Slot Rotation'));
    assert(operatorHtml.includes('memeSourceState'));
    assert(operatorHtml.includes('Enable Reddit API'));
    assert(operatorHtml.includes('Enable Alpaca Market Data'));
    assert(operatorHtml.includes('Enable SEC EDGAR'));
    assert(operatorHtml.includes('Phase A data sources can be enabled independently.'));
    assert(operatorHtml.includes('Enable Stocktwits Source'));
    assert(operatorHtml.includes('Enable Polygon Source'));
    assert(operatorHtml.includes('Enable Alpha Vantage Source'));
    assert(operatorHtml.includes('Refresh All Phase B Sources Now'));
    assert(operatorHtml.includes('Regular Watch Intelligence'));
    assert(operatorHtml.includes('Enable Regular Watch Intelligence'));
    assert(operatorHtml.includes('Enable Regular Priority Scoring'));
    assert(operatorHtml.includes('Enable Regular Scanner Ranking'));
    assert(operatorHtml.includes('regularWatchSourceState'));
    assert(operatorHtml.includes('Refresh Regular Watch Status'));
    assert.equal(operatorHtml.includes('data-regular-watch-action="buy"'), false);
    assert.equal(operatorHtml.includes('data-regular-watch-action="sell"'), false);
    assert(operatorJs.includes('Reddit sources'));
    assert(operatorHtml.includes('Auto Action is locked'));
    assert(operatorHtml.includes('Upcoming schedule'));
    assert.equal(operatorHtml.includes('Switch to crypto only'), false);
    assert.equal(operatorHtml.includes('Buy now'), false);
    assert.equal(operatorHtml.includes('Sell now'), false);
    assert.equal(operatorHtml.includes('Liquidate'), false);
    assert.equal(operatorHtml.includes('Cancel order'), false);

    const controlState = await fetch(`http://127.0.0.1:${port}/api/control/state`).then((response) => response.json());
    assert.equal(controlState.status, 'ok');
    assert.equal(controlState.control.trader.port, 3001);
    assert.deepEqual(calls.shift(), ['refresh']);

    const memeState = await fetch(`http://127.0.0.1:${port}/api/meme/features`).then((response) => response.json());
    assert.equal(memeState.ok, true);
    assert.equal(memeState.status, 'ok');
    assert.ok(memeState.features);
    assert.ok(Array.isArray(memeState.blocked_features));
    assert.ok(Array.isArray(memeState.warnings));
    assert.equal(memeState.summary.master_enabled, false);
    assert.equal(memeState.features.MEME_MONITOR_ENABLED.status, 'off');
    assert.equal(memeState.features.MEME_REDDIT_SCANNER_ENABLED.status, 'blocked');

    const regularWatchState = await fetch(`http://127.0.0.1:${port}/api/regular-watch/features`).then((response) => response.json());
    assert.equal(regularWatchState.ok, true);
    assert.equal(regularWatchState.status, 'ok');
    assert.ok(regularWatchState.features);
    assert.ok(Array.isArray(regularWatchState.blocked_features));
    assert.ok(Array.isArray(regularWatchState.warnings));

    const memeStatus = await fetch(`http://127.0.0.1:${port}/api/meme/status`).then((response) => response.json());
    assert.equal(memeStatus.ok, true);
    assert(['off', 'shadow', 'active', 'reused_records', 'inactive', 'missing_credentials', 'timeout'].includes(memeStatus.memeMonitor.redditScanner.status));
    assert.equal(memeStatus.memeMonitor.hotList.status, 'off');
    assert.equal(memeStatus.memeMonitor.dynamicWatchlist.status, 'blocked');
    assert.equal(memeStatus.memeMonitor.priorityOverride.status, 'blocked');
    assert.equal(memeStatus.memeMonitor.hotSlotRotation.status, 'off');
    assert.equal(memeStatus.memeMonitor.phaseA.status, 'off');
    assert.equal(memeStatus.memeMonitor.phaseB.status, 'off');
    assert.equal(Array.isArray(Object.values(memeStatus.memeMonitor.phaseA.sources)), true);

    const regularWatchStatus = await fetch(`http://127.0.0.1:${port}/api/regular-watch/status`).then((response) => response.json());
    assert.equal(regularWatchStatus.ok, true);
    assert(['off', 'warn', 'active'].includes(regularWatchStatus.regularWatchIntelligence.status), true);
    assert.equal(regularWatchStatus.scannerRanking.status, 'off');
    assert.equal(regularWatchStatus.positionAwareness.status, 'off');

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

    const memeAction = await fetch(`http://127.0.0.1:${port}/api/meme/features`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ featureKey: 'MEME_REDDIT_SCANNER_ENABLED', enabled: true }),
    }).then((response) => response.json());
    assert.equal(memeAction.ok, false);
    assert.equal(memeAction.error, 'dependency_blocked');

    const sourceAction = await fetch(`http://127.0.0.1:${port}/api/meme/features`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ featureKey: 'MEME_SOURCE_STOCKTWITS_ENABLED', enabled: true }),
    }).then((response) => response.json());
    assert.equal(sourceAction.ok, true);
    assert.equal(sourceAction.state.features.MEME_SOURCE_STOCKTWITS_ENABLED.status, 'missing_credentials');

    const regularWatchMaster = await fetch(`http://127.0.0.1:${port}/api/regular-watch/features`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ featureKey: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', enabled: true }),
    }).then((response) => response.json());
    assert.equal(regularWatchMaster.ok, true);

    const regularWatchChild = await fetch(`http://127.0.0.1:${port}/api/regular-watch/features`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ featureKey: 'REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED', enabled: true }),
    }).then((response) => response.json());
    assert.equal(regularWatchChild.ok, true);
    assert.equal(regularWatchChild.state.features.REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED.status, 'active');

    const regularWatchRanking = await fetch(`http://127.0.0.1:${port}/api/regular-watch/features`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ featureKey: 'REGULAR_WATCH_SCANNER_RANKING_ENABLED', enabled: true }),
    }).then((response) => response.json());
    assert.equal(regularWatchRanking.ok, false);
    assert.equal(regularWatchRanking.error, 'feature_disabled_in_config');

    const runtimeAction = await fetch(`http://127.0.0.1:${port}/api/meme/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'refresh-hot-scores-now' }),
    }).then((response) => response.json());
    assert.equal(runtimeAction.ok, false);
    assert.equal(runtimeAction.status, 'blocked');

    const regularWatchAction = await fetch(`http://127.0.0.1:${port}/api/regular-watch/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'refresh-regular-watch-status' }),
    }).then((response) => response.json());
    assert.equal(regularWatchAction.ok, true);
    assert.equal(regularWatchAction.regularWatchIntelligence.status, 'warn');

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

test('meme monitor status reports missing credentials without crashing the server', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-monitor-server-test-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  const featurePath = path.join(dataDir, 'state', 'meme-monitor-state.json');
  updateMemeMonitorFeatureState({
    featureKey: 'MEME_MONITOR_ENABLED',
    enabled: true,
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      MEME_AUTO_ACTION_ENABLED: 'false',
    },
    filePath: featurePath,
    changedBy: 'test',
    source: 'unit-test',
  });
  updateMemeMonitorFeatureState({
    featureKey: 'MEME_REDDIT_SCANNER_ENABLED',
    enabled: true,
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      MEME_AUTO_ACTION_ENABLED: 'false',
    },
    filePath: featurePath,
    changedBy: 'test',
    source: 'unit-test',
  });
  updateMemeMonitorFeatureState({
    featureKey: 'MEME_HOT_LIST_ENABLED',
    enabled: true,
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      MEME_AUTO_ACTION_ENABLED: 'false',
    },
    filePath: featurePath,
    changedBy: 'test',
    source: 'unit-test',
  });
  const server = createDashboardServer({
    port: 0,
    dashboardDir: path.resolve(process.cwd(), 'dashboard'),
    dataDir,
    repoRoot: tempRoot,
    env: {
      ...process.env,
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      MEME_AUTO_ACTION_ENABLED: 'false',
      REDDIT_CLIENT_ID: '',
      REDDIT_CLIENT_SECRET: '',
    },
    fetchImpl: global.fetch,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const status = await fetch(`http://127.0.0.1:${port}/api/meme/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start-shadow-scan' }),
    }).then((response) => response.json());

    assert.equal(status.ok, false);
    assert.equal(status.memeMonitor.redditScanner.status, 'missing_credentials');
    assert.match(status.memeMonitor.redditScanner.lastError || '', /missing/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
