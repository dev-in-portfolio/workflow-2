const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMinimalTradingServer, loadConfig, PaperTradeAdapter, PerformanceStore, startMinimalTradingServer } = require('../src');
const { readOvernightStatus } = require('../scripts/overnight-status');

test('minimal v1 config defaults stay simple', () => {
  const config = loadConfig({});
  assert.equal(config.AUTO_POLICY_REFRESH, false);
  assert.equal(config.MIN_VOLUME, 1000);
});

test('minimal server accepts approved signals and records an outcome', async () => {
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      maxOpenPositions: 5,
      positionSizeMultiplier: 1,
    },
  });

  class MockExecutionAdapter {
    constructor() {
      this.orders = new Map();
    }

    async submitOrder(request) {
      const order = {
        order_id: 'minimal-v1-order',
        status: 'accepted',
        request,
      };
      this.orders.set(order.order_id, order);
      return order;
    }

    async getOrder(orderId) {
      const order = this.orders.get(orderId);
      if (!order) {
        throw new Error(`missing order ${orderId}`);
      }
      return {
        ...order,
        status: 'filled',
        filled_at: '2026-06-14T13:01:00.000Z',
        average_fill_price: 205,
        filled_quantity: 1,
        fill: {
          at: '2026-06-14T13:01:00.000Z',
          average_fill_price: 205,
          filled_quantity: 1,
          estimated_fees: 0,
        },
      };
    }
  }

  const executionAdapter = new MockExecutionAdapter();
  const server = createMinimalTradingServer({
    performance,
    executionAdapter,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        signal_id: 'minimal-v1-approve',
        symbol: 'AAPL',
        asset_type: 'stock',
        strategy_name: 'breakout',
        timeframe: '5m',
        action_candidate: 'paper_buy',
        direction: 'bullish',
        side: 'buy',
        quantity: 1,
        confidence_score: 95,
        freshness_score: 95,
        source_quality_score: 95,
        contradiction_score: 5,
        risk_score: 10,
        stop_loss: 198,
        take_profit: 220,
        volume: 100000,
        market_context: {
          alpaca_quote: {
            provider: 'alpaca',
            symbol: 'AAPL',
            asset_type: 'stock',
            timestamp: '2026-06-14T13:00:00.000Z',
            received_at: '2026-06-14T13:00:01.000Z',
            price: 150,
            volume: 100000,
          },
          twelve_data_quote: {
            provider: 'twelvedata',
            symbol: 'AAPL',
            asset_type: 'stock',
            timestamp: '2026-06-14T13:00:02.000Z',
            received_at: '2026-06-14T13:00:03.000Z',
            price: 150.1,
            volume: 100100,
          },
        },
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.stage, 'order_confirmed');
    assert.equal(payload.paper_order.status, 'accepted');
    assert.equal(payload.order_confirmation.confirmed, true);
    assert.equal(payload.order_confirmation.confirmation_status, 'filled');
    assert.equal(performance.paperOutcomes.length, 1);
    assert.equal(performance.paperOutcomes[0].original_signal.signal_id, 'minimal-v1-approve');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('minimal server returns invalid_json for malformed payloads', async () => {
  const server = createMinimalTradingServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.error, 'invalid_json');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('minimal server rejects stale data and legacy admin routes', async () => {
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      maxOpenPositions: 5,
      positionSizeMultiplier: 1,
    },
  });

  const executionAdapter = {
    submitOrder: async () => {
      throw new Error('should not be called for stale input');
    },
  };

  const server = createMinimalTradingServer({
    performance,
    executionAdapter,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const staleResponse = await fetch(`http://127.0.0.1:${port}/market-ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'alpaca',
        symbol: 'AAPL',
        asset_type: 'stock',
        kind: 'quote',
        timestamp: '2026-06-10T00:00:00.000Z',
        received_at: '2026-06-14T00:00:00.000Z',
        price: 205,
        previous_close: 200,
        volume: 150000,
      }),
    });
    const stalePayload = await staleResponse.json();
    assert.equal(staleResponse.status, 400);
    assert.equal(stalePayload.accepted, false);
    assert(stalePayload.reason_codes.includes('STALE_DATA'));

    const legacyResponse = await fetch(`http://127.0.0.1:${port}/policy-refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'test', report_date: '2026-06-14' }),
    });
    const legacyPayload = await legacyResponse.json();
    assert.equal(legacyResponse.status, 200);
    assert.equal(legacyPayload.accepted, true);
    assert(legacyPayload.policy_snapshot.policy);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('minimal server exposes live report and policy tuning views', async () => {
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      maxOpenPositions: 5,
      positionSizeMultiplier: 1,
    },
  });
  performance.recordSignal({
    signal_id: 'live-report-signal',
    symbol: 'AAPL',
    created_at: '2026-06-14T13:00:00.000Z',
    recorded_at: '2026-06-14T13:00:00.000Z',
    confidence_score: 90,
    freshness_score: 95,
    source_quality_score: 92,
    contradiction_score: 5,
    risk_score: 10,
    provider_confirmation_score: 93,
  });
  performance.recordRiskDecision({
    decision: 'APPROVED_FOR_PAPER',
    reason_codes: ['SIGNAL_QUALITY_OK'],
    timestamp: '2026-06-14T13:00:01.000Z',
    recorded_at: '2026-06-14T13:00:01.000Z',
  });
  performance.recordPaperExecution({
    original_signal: { signal_id: 'live-report-signal', confidence_score: 90, symbol: 'AAPL' },
    paper_result: { status: 'filled', filled_at: '2026-06-14T13:01:00.000Z', average_fill_price: 205, filled_quantity: 1 },
    entry_price: 205,
    exit_price: 208,
    high_price: 209,
    low_price: 204,
    quantity: 1,
    side: 'buy',
    false_positive: false,
  });

  const server = createMinimalTradingServer({ performance, executionAdapter: new PaperTradeAdapter({ dryRun: true }) });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const reportResponse = await fetch(`http://127.0.0.1:${port}/daily-live-results?date=2026-06-14`);
    const report = await reportResponse.json();
    assert.equal(reportResponse.status, 200);
    assert.equal(report.signal_count, 1);
    assert.equal(report.blocked_count, 0);
    assert.equal(report.approved_count, 1);
    assert.equal(report.paper_outcome_count, 1);
    assert.equal(report.paper_pnl, 3);
    assert(Array.isArray(report.top_block_reasons));
    assert(report.best_signal);
    assert(report.worst_signal);
    assert(report.calibration_buckets.length > 0);

    const policyResponse = await fetch(`http://127.0.0.1:${port}/risk-policy`);
    const policyPayload = await policyResponse.json();
    assert.equal(policyResponse.status, 200);
    assert.equal(policyPayload.accepted, true);
    assert(policyPayload.policy_snapshot.policy.maxOpenPositions >= 1);

    const tuningResponse = await fetch(`http://127.0.0.1:${port}/performance/tuning`);
    const tuningPayload = await tuningResponse.json();
    assert.equal(tuningResponse.status, 200);
    assert.equal(tuningPayload.accepted, true);
    assert(Array.isArray(tuningPayload.tuning.suggestions));
    assert(tuningPayload.tuning.report);
    assert(tuningPayload.tuning.policy_snapshot);

    const overnightResponse = await fetch(`http://127.0.0.1:${port}/overnight-status?date=2026-06-14`);
    const overnightPayload = await overnightResponse.json();
    assert.equal(overnightResponse.status, 200);
    assert.equal(overnightPayload.accepted, true);
    assert.equal(overnightPayload.report_date, '2026-06-14');
    assert.equal(overnightPayload.signal_count, 1);
    assert(Array.isArray(overnightPayload.tuning_suggestions));
    assert(overnightPayload.policy_snapshot.policy);

    const refreshResponse = await fetch(`http://127.0.0.1:${port}/policy-refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'test-refresh', report_date: '2026-06-14' }),
    });
    const refreshPayload = await refreshResponse.json();
    assert.equal(refreshResponse.status, 200);
    assert.equal(refreshPayload.accepted, true);
    assert(refreshPayload.policy_snapshot.policy);
    assert(refreshPayload.learning_report);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('minimal server writes a durable overnight status snapshot', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-status-snapshot-'));
  const statusSnapshotPath = path.join(tempDir, 'overnight-status.json');
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      maxOpenPositions: 5,
      positionSizeMultiplier: 1,
    },
  });

  const server = createMinimalTradingServer({
    performance,
    statusSnapshotPath,
    startedAt: '2026-06-14T12:00:00.000Z',
    executionAdapter: new PaperTradeAdapter({ dryRun: true }),
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/overnight-status?date=2026-06-14`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.accepted, true);
    assert(fs.existsSync(statusSnapshotPath));
    const filePayload = JSON.parse(fs.readFileSync(statusSnapshotPath, 'utf8'));
    assert.equal(filePayload.accepted, true);
    assert.equal(filePayload.mode, 'minimal-v1');
    assert.equal(filePayload.report_date, '2026-06-14');
    assert.equal(filePayload.started_at, '2026-06-14T12:00:00.000Z');
    assert(filePayload.uptime_minutes >= 0);
    assert(filePayload.request_count >= 1);
    assert.equal(filePayload.heartbeat_count, 0);
    assert(filePayload.last_request_at);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('minimal server writes a startup overnight snapshot immediately', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-status-startup-'));
  const statusSnapshotPath = path.join(tempDir, 'overnight-status.json');
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      maxOpenPositions: 5,
      positionSizeMultiplier: 1,
    },
  });

  const server = createMinimalTradingServer({
    performance,
    statusSnapshotPath,
    startedAt: '2026-06-14T12:00:00.000Z',
    executionAdapter: new PaperTradeAdapter({ dryRun: true }),
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    assert(fs.existsSync(statusSnapshotPath));
    const filePayload = JSON.parse(fs.readFileSync(statusSnapshotPath, 'utf8'));
    assert.equal(filePayload.snapshot_type, 'startup');
    assert.equal(filePayload.status, 'ok');
    assert.equal(filePayload.mode, 'minimal-v1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('minimal server refreshes the overnight snapshot while idle', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-status-heartbeat-'));
  const statusSnapshotPath = path.join(tempDir, 'overnight-status.json');
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'manual',
    captured_at: '2026-06-14T12:00:00.000Z',
    report_date: '2026-06-14',
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      maxOpenPositions: 5,
      positionSizeMultiplier: 1,
    },
  });

  const server = createMinimalTradingServer({
    performance,
    statusSnapshotPath,
    statusHeartbeatIntervalMs: 20,
    startedAt: '2026-06-14T12:00:00.000Z',
    executionAdapter: new PaperTradeAdapter({ dryRun: true }),
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert(fs.existsSync(statusSnapshotPath));
    const filePayload = JSON.parse(fs.readFileSync(statusSnapshotPath, 'utf8'));
    assert.equal(filePayload.snapshot_type, 'heartbeat');
    assert.equal(filePayload.mode, 'minimal-v1');
    assert.equal(filePayload.started_at, '2026-06-14T12:00:00.000Z');
    assert(filePayload.uptime_minutes >= 0);
    assert(filePayload.heartbeat_count >= 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('overnight status cli reads the durable snapshot file', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-status-cli-'));
  const statusSnapshotPath = path.join(tempDir, 'overnight-status.json');
  const snapshot = {
    accepted: true,
    mode: 'minimal-v1',
    report_date: '2026-06-14',
    signal_count: 1,
  };
  fs.writeFileSync(statusSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  const captured = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    const result = readOvernightStatus({ OVERNIGHT_STATUS_PATH: statusSnapshotPath });
    assert.equal(result.accepted, true);
    assert.equal(result.snapshot_fresh, true);
    assert.equal(result.stale, false);
    assert.deepEqual(result.payload, snapshot);
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = captured.join('');
  assert(output.includes('"accepted": true'));
  assert(output.includes('"report_date": "2026-06-14"'));
});

test('overnight status cli flags stale snapshots', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-status-stale-'));
  const statusSnapshotPath = path.join(tempDir, 'overnight-status.json');
  const snapshot = {
    accepted: true,
    mode: 'minimal-v1',
    report_date: '2026-06-14',
    signal_count: 1,
  };
  fs.writeFileSync(statusSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const oldTime = new Date(Date.now() - (60 * 60 * 1000));
  fs.utimesSync(statusSnapshotPath, oldTime, oldTime);

  const captured = [];
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    const result = readOvernightStatus({
      OVERNIGHT_STATUS_PATH: statusSnapshotPath,
      OVERNIGHT_STATUS_MAX_AGE_MINUTES: 15,
    });
    assert.equal(result.stale, true);
    assert.equal(result.snapshot_fresh, false);
    assert(result.age_minutes >= 15);
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
  }

  const output = captured.join('');
  assert(output.includes('"stale": true'));
  assert(output.includes('"snapshot_fresh": false'));
});

test('trader cli launches the minimal server', () => {
  const minimalCliPath = require.resolve('../src/minimal-cli');
  const traderCliPath = require.resolve('../src/trader-cli');
  const originalMinimalCliModule = require.cache[minimalCliPath];
  const originalTraderCliModule = require.cache[traderCliPath];
  let capturedEnv = null;

  require.cache[minimalCliPath] = {
    id: minimalCliPath,
    filename: minimalCliPath,
    loaded: true,
    exports: {
      startMinimalTradingServer: (env) => {
        capturedEnv = env;
      },
    },
  };
  delete require.cache[traderCliPath];

  const { main } = require('../src/trader-cli');
  main({ PORT: '0' });

  assert.deepEqual(capturedEnv, { PORT: '0' });

  if (originalMinimalCliModule) {
    require.cache[minimalCliPath] = originalMinimalCliModule;
  } else {
    delete require.cache[minimalCliPath];
  }
  if (originalTraderCliModule) {
    require.cache[traderCliPath] = originalTraderCliModule;
  } else {
    delete require.cache[traderCliPath];
  }
});
