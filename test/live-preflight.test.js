const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMinimalTradingServer, createTradingControlServer, evaluatePolicyHealth, runLivePreflight } = require('../src');
const { formatPreflightResult } = require('../scripts/live-preflight');

function liveEnv(overrides = {}) {
  return {
    TRADING_MODE: 'live',
    LIVE_TRADING_ENABLED: 'true',
    LIVE_TRADING_CONFIRMATION_PHRASE: 'confirmed',
    REQUIRE_HUMAN_APPROVAL: 'true',
    AUDIT_LOG_ENABLED: 'true',
    PAPER_ADAPTER_ENABLED: 'true',
    ALPACA_EXECUTION_ENABLED: 'true',
    ALPACA_API_KEY_ID: 'test-key',
    ALPACA_API_SECRET_KEY: 'test-secret',
    ALPACA_API_BASE_URL: 'https://api.alpaca.markets',
    MIN_CONFIDENCE_FOR_PAPER: '72',
    MIN_PROVIDER_CONFIRMATION_SCORE: '70',
    MIN_EDGE_SCORE: '60',
    MIN_VOLUME: '750',
    MAX_SPREAD_SLIPPAGE_PCT: '0.75',
    BUY_NOTIONAL_TARGET: '1000',
    MIN_BUY_NOTIONAL: '25',
    ...overrides,
  };
}

function healthyPolicy(capturedAt = '2026-06-24T13:00:00.000Z') {
  return {
    source: 'startup-config',
    scope: 'live-market',
    captured_at: capturedAt,
    policy: {
      minConfidenceForPaper: 72,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minVolume: 750,
      maxSpreadSlippagePct: 0.75,
      maxOpenPositions: 1,
      buyNotionalTarget: 1000,
      minBuyNotional: 25,
    },
  };
}

function adapter(overrides = {}) {
  return {
    requiresBrokerReconciliation: true,
    getAccount: async () => ({ status: 'ACTIVE', cash: '250', buying_power: '250', equity: '250' }),
    getPositions: async () => [],
    getOpenOrders: async () => [],
    ...overrides,
  };
}

function tempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-preflight-'));
  const dataDir = path.join(repoRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.env.local'), 'TRADING_MODE=live\n');
  const oldMtime = new Date('2026-06-24T12:00:00.000Z');
  fs.utimesSync(path.join(repoRoot, '.env.local'), oldMtime, oldMtime);
  fs.writeFileSync(path.join(dataDir, 'state', 'scanner-runtime.json'), JSON.stringify({
    updated_at: '2026-06-24T13:00:00.000Z',
    last_scan_time: '2026-06-24T13:00:00.000Z',
  }));
  fs.writeFileSync(path.join(dataDir, 'live-policy.json'), JSON.stringify(healthyPolicy()));
  return { repoRoot, dataDir };
}

async function preflight(options = {}) {
  const dirs = tempRepo();
  return runLivePreflight({
    repoRoot: dirs.repoRoot,
    dataDir: dirs.dataDir,
    runtimeEnv: liveEnv(),
    executionAdapter: adapter(),
    processDiscovery: { dashboards: [{ pid: 1 }], traders: [{ pid: 2 }], scanners: [{ pid: 3 }] },
    now: '2026-06-24T13:01:00.000Z',
    writeLatest: false,
    ...options,
  });
}

test('live preflight returns GO when mocked live state is healthy', async () => {
  const result = await preflight();

  assert.equal(result.status, 'GO');
  assert.equal(result.broker.account_available, true);
  assert.equal(result.broker.positions_available, true);
  assert.equal(result.broker.open_orders_available, true);
});

test('live preflight returns NO_GO when account is unavailable', async () => {
  const result = await preflight({
    executionAdapter: adapter({ getAccount: async () => { throw new Error('account down'); } }),
  });

  assert.equal(result.status, 'NO_GO');
  assert(result.critical_failures.includes('PREFLIGHT_BROKER_ACCOUNT_UNAVAILABLE'));
});

test('live preflight returns NO_GO when positions are unavailable', async () => {
  const result = await preflight({
    executionAdapter: adapter({ getPositions: async () => { throw new Error('positions down'); } }),
  });

  assert.equal(result.status, 'NO_GO');
  assert(result.critical_failures.includes('PREFLIGHT_BROKER_POSITIONS_UNAVAILABLE'));
});

test('live preflight returns NO_GO when open orders are unavailable', async () => {
  const result = await preflight({
    executionAdapter: adapter({ getOpenOrders: async () => { throw new Error('orders down'); } }),
  });

  assert.equal(result.status, 'NO_GO');
  assert(result.critical_failures.includes('PREFLIGHT_BROKER_OPEN_ORDERS_UNAVAILABLE'));
});

test('live preflight returns NO_GO when Alpaca credentials are missing', async () => {
  const result = await preflight({
    runtimeEnv: liveEnv({ ALPACA_API_KEY_ID: '', ALPACA_API_SECRET_KEY: '' }),
  });

  assert.equal(result.status, 'NO_GO');
  assert(result.critical_failures.includes('PREFLIGHT_ALPACA_CREDENTIALS_MISSING'));
});

test('live preflight returns NO_GO when live mode would fall back away from Alpaca execution', async () => {
  const result = await preflight({
    runtimeEnv: liveEnv({ ALPACA_EXECUTION_ENABLED: 'false' }),
  });

  assert.equal(result.status, 'NO_GO');
  assert(result.critical_failures.includes('LIVE_MODE_REQUIRES_ALPACA_EXECUTION_ENABLED'));
});

test('live-intended server factories refuse implicit paper adapter fallback', () => {
  const env = liveEnv();

  assert.throws(
    () => createTradingControlServer({ env }),
    (error) => error.code === 'LIVE_EXECUTION_ADAPTER_REQUIRED'
      && error.reason_codes.includes('LIVE_MODE_REQUIRES_BROKER_EXECUTION_ADAPTER'),
  );
  assert.throws(
    () => createMinimalTradingServer({ env }),
    (error) => error.code === 'LIVE_EXECUTION_ADAPTER_REQUIRED'
      && error.reason_codes.includes('LIVE_MODE_REQUIRES_BROKER_EXECUTION_ADAPTER'),
  );
});

test('live-intended server factories accept explicit broker-backed adapters', () => {
  const env = liveEnv();
  const executionAdapter = adapter();
  const controlServer = createTradingControlServer({ env, executionAdapter });
  const minimalServer = createMinimalTradingServer({ env, executionAdapter });

  assert.equal(typeof controlServer.listen, 'function');
  assert.equal(typeof minimalServer.listen, 'function');
});

test('live preflight warns when env local changed after runtime start', async () => {
  const dirs = tempRepo();
  const envPath = path.join(dirs.repoRoot, '.env.local');
  const future = new Date('2026-06-24T13:10:00.000Z');
  fs.utimesSync(envPath, future, future);
  const result = await runLivePreflight({
    repoRoot: dirs.repoRoot,
    dataDir: dirs.dataDir,
    runtimeEnv: liveEnv(),
    executionAdapter: adapter(),
    processDiscovery: { dashboards: [{ pid: 1 }], traders: [{ pid: 2 }], scanners: [{ pid: 3 }] },
    runtimeStartedAt: '2026-06-24T13:00:00.000Z',
    now: '2026-06-24T13:11:00.000Z',
    writeLatest: false,
  });

  assert.equal(result.status, 'WARN');
  assert(result.warnings.includes('ENV_CHANGED_AFTER_START_RESTART_REQUIRED'));
});

test('policy health detects metadata, deprecated fields, zero thresholds, permissive spread, and stale blocklists', () => {
  const health = evaluatePolicyHealth({
    policySnapshot: {
      source: '',
      policy: {
        minConfidenceForPaper: 0,
        minProviderConfirmationScore: 0,
        minEdgeScore: 0,
        minVolume: 0,
        maxSpreadSlippagePct: 100,
        blockedBuyCalibrationBuckets: ['80-89'],
        cooldownAfterLossMinutes: 60,
      },
    },
    runtimeEnv: {},
    now: '2026-06-24T13:00:00.000Z',
  });

  assert.equal(health.stale, true);
  assert(health.warnings.includes('POLICY_SOURCE_MISSING'));
  assert(health.warnings.includes('POLICY_SCOPE_MISSING'));
  assert(health.warnings.includes('POLICY_DEPRECATED_FIELDS_PRESENT'));
  assert(health.warnings.includes('POLICY_STALE_BLOCKLIST_ACTIVE'));
  assert(health.critical_failures.includes('POLICY_MAX_SPREAD_TOO_PERMISSIVE'));
  assert(health.deprecated_fields.includes('cooldownAfterLossMinutes'));
  assert(health.suspicious_fields.some((item) => item.field === 'maxSpreadSlippagePct'));
});

test('live preflight writes latest result to runtime file', async () => {
  const dirs = tempRepo();
  const outputPath = path.join(dirs.dataDir, 'runtime', 'live-preflight-latest.json');
  const result = await runLivePreflight({
    repoRoot: dirs.repoRoot,
    dataDir: dirs.dataDir,
    runtimeEnv: liveEnv(),
    executionAdapter: adapter(),
    processDiscovery: { dashboards: [{ pid: 1 }], traders: [{ pid: 2 }], scanners: [{ pid: 3 }] },
    now: '2026-06-24T13:01:00.000Z',
    outputPath,
  });

  assert.equal(result.status, 'GO');
  assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).status, 'GO');
});

test('live preflight CLI formatter redacts secrets', () => {
  const output = formatPreflightResult({
    status: 'NO_GO',
    checked_at: '2026-06-24T13:00:00.000Z',
    broker: { account_available: false, positions_available: false, open_orders_available: false, account_summary: {}, position_count: 0, open_order_count: 0 },
    config: { loaded: false, env_local_exists: true, env_local_changed_after_start: false },
    policy: { available: false, stale: true, deprecated_fields: [], suspicious_fields: [] },
    processes: { trader: { count: 0 }, scanner: { count: 0 }, dashboard: { count: 1 }, duplicate_warnings: [] },
    critical_failures: ['bad secret=super-secret-value AKAABIPI6ZUGH4KUGREJOV5XAP'],
    warnings: ['token: my-token-value'],
    recommended_actions: [],
  });

  assert(!output.includes('AKAABIPI6ZUGH4KUGREJOV5XAP'));
  assert(!output.includes('super-secret-value'));
  assert(!output.includes('my-token-value'));
});

test('live preflight formatter shows the active approved symbol list', () => {
  const output = formatPreflightResult({
    status: 'GO',
    checked_at: '2026-06-24T13:00:00.000Z',
    broker: { account_available: true, positions_available: true, open_orders_available: true, account_summary: {}, position_count: 0, open_order_count: 0 },
    config: { loaded: true, env_local_exists: true, env_local_changed_after_start: false },
    policy: {
      available: true,
      stale: false,
      source: 'startup-config',
      scope: 'live-market',
      approved_symbols: ['SPCX', 'SMCI', 'NVDA'],
      deprecated_fields: [],
      suspicious_fields: [],
    },
    processes: { trader: { count: 1 }, scanner: { count: 1 }, dashboard: { count: 1 }, duplicate_warnings: [] },
    critical_failures: [],
    warnings: [],
    recommended_actions: [],
  });

  assert(output.includes('Approved symbols (3): SPCX, SMCI, NVDA'));
});
