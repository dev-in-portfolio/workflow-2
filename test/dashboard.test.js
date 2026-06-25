const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createDashboardServer, buildDashboardSnapshot, resolveDashboardPort } = require('../src/dashboard-server');
const { shouldAutoOpenBrowser } = require('../scripts/dashboard-cli');

test('dashboard snapshot aggregates read-only endpoints and local files', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', 'overnight-status.json'), JSON.stringify({
    status: 'ok',
    mode: 'minimal-v1',
    report_date: '2026-06-19',
    timestamp: '2026-06-19T15:00:00.000Z',
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'live-policy.json'), JSON.stringify({
    source: 'startup-config',
    policy: {
      minConfidenceForPaper: 72,
      maxOpenPositions: 9,
      positionSizeMultiplier: 1,
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'performance-history.jsonl'), [
    JSON.stringify({ entry_type: 'paper_outcome', record: { symbol: 'AAPL', side: 'buy', quantity: 2, paper_result: { filled_quantity: 2, average_fill_price: 101.12, filled_at: '2026-06-19T15:00:01.000Z', order_id: 'ord-1', status: 'filled' }, pnl: 1.25, adjusted_pnl: 1.1, execution_drag: 0.15, win_loss: 'win', calibration_bucket: '80-89', recorded_at: '2026-06-19T15:00:01.000Z' } }),
    JSON.stringify({ entry_type: 'paper_outcome', record: { symbol: 'AAPL', side: 'sell', quantity: 1, paper_result: { filled_quantity: 1, average_fill_price: 102.5, filled_at: '2026-06-19T15:04:01.000Z', order_id: 'ord-2', status: 'filled' }, pnl: 0.25, adjusted_pnl: 0.2, execution_drag: 0.05, win_loss: 'win', calibration_bucket: '80-89', recorded_at: '2026-06-19T15:04:01.000Z' } }),
    JSON.stringify({ entry_type: 'risk_decision', record: { decision: 'BLOCKED', reason_codes: ['LOW_CONFIDENCE'], recorded_at: '2026-06-19T15:00:02.000Z' } }),
  ].join('\n'));
  fs.writeFileSync(path.join(dataDir, 'policy-history.jsonl'), JSON.stringify({
    source: 'startup-config',
    captured_at: '2026-06-19T14:46:40.126Z',
    policy: {
      maxOpenPositions: 9,
      positionSizeMultiplier: 1,
      minConfidenceForPaper: 72,
    },
  }) + '\n');
  fs.writeFileSync(path.join(dataDir, 'runtime', 'live-preflight-latest.json'), JSON.stringify({
    status: 'WARN',
    checked_at: '2026-06-19T14:59:00.000Z',
    critical_failures: [],
    warnings: ['ENV_CHANGED_AFTER_START_RESTART_REQUIRED'],
    policy: {
      health: {
        status: 'WARN',
        warnings: ['POLICY_STALE'],
        critical_failures: [],
        deprecated_fields: [],
        suspicious_fields: [],
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'broker-local-reconciliation-latest.json'), JSON.stringify({
    status: 'WARN',
    checked_at: '2026-06-19T15:00:30.000Z',
    warnings: ['STALE_TRAILING_STATE'],
    critical_failures: [],
    mismatches: [{ type: 'STALE_TRAILING_STATE', symbol: 'AAPL', severity: 'warning' }],
    local_phantom_positions: [],
    broker_positions_missing_locally: [],
    quantity_mismatches: [],
    open_order_mismatches: [],
    trailing_state_mismatches: [{ type: 'STALE_TRAILING_STATE', symbol: 'AAPL' }],
    pnl_mismatches: [],
    recommended_actions: ['Refresh scanner/trailing runtime state so exits remain explainable.'],
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'partial-fill-state.json'), JSON.stringify({
    version: '2026-06-25.partial-fill-state.1',
    updated_at: '2026-06-19T15:01:00.000Z',
    last_reconciled_at: '2026-06-19T15:01:00.000Z',
    orders: {
      'ord-partial-aapl': {
        order_id: 'ord-partial-aapl',
        client_order_id: 'client-partial-aapl',
        symbol: 'AAPL',
        side: 'buy',
        submitted_qty: 2,
        filled_qty: 1,
        remaining_qty: 1,
        submitted_notional: 202,
        filled_notional: 101,
        average_fill_price: 101,
        status: 'partially_filled',
        first_seen_at: '2026-06-19T15:00:00.000Z',
        last_seen_at: '2026-06-19T15:01:00.000Z',
        last_reconciled_at: '2026-06-19T15:01:00.000Z',
        warnings: [],
        reason_codes: ['PARTIAL_FILL_PENDING'],
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'logs', 'scanner-runtime.json'), JSON.stringify({
    scanner: 'stock-scanner',
    mode: 'live-market',
    last_scan_time: '2026-06-19T15:01:00.000Z',
    risk_budget_sizing: {
      enabled: true,
      max_risk_per_trade_dollars: 1,
      latest_candidates: [{
        symbol: 'MU',
        sizing_method: 'risk_budget',
        risk_budget_sizing: { accepted: true, notional: 120, quantity: 1.5 },
        structure_stop: { accepted: true, method: 'swing_low', stop_distance: 0.5 },
      }],
    },
  }, null, 2));

  const trader = http.createServer((req, res) => {
    const payloads = {
      '/status': { status: 'ok', mode: 'minimal-v1', uptime_minutes: 12, heartbeat_count: 3, last_request_at: '2026-06-19T15:00:00.000Z', timestamp: '2026-06-19T15:00:01.000Z' },
      '/daily-live-results': { date: '2026-06-19', signal_count: 4, blocked_count: 1, approved_count: 3, paper_pnl: 2.5, execution_drag: 0, drawdown: 0.1, top_block_reasons: [] },
      '/risk-policy': { accepted: true, policy_snapshot: { source: 'startup-config', policy: { minConfidenceForPaper: 72, maxOpenPositions: 9, positionSizeMultiplier: 1 } } },
      '/performance/tuning': { accepted: true, tuning: { recommended_tuning_notes: ['Keep the floor tight.'] } },
      '/policy-effectiveness': { accepted: true, policy_effectiveness: { intervals: [] } },
      '/overnight-status': { accepted: true, status: 'ok', mode: 'minimal-v1' },
    };
    const payload = payloads[req.url];
    res.setHeader('content-type', 'application/json');
    if (!payload) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => trader.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${trader.address().port}`;

  const snapshot = await buildDashboardSnapshot({
    traderBaseUrl: baseUrl,
    port: 1111,
    dataDir,
    nowProvider: () => new Date('2026-06-17T12:00:00Z'),
    env: {
      ALPACA_API_KEY_ID: '',
      ALPACA_API_SECRET_KEY: '',
      ALPACA_API_BASE_URL: '',
      MAX_OPEN_POSITIONS: '1',
      BUY_NOTIONAL_TARGET: '150',
      MIN_BUY_NOTIONAL: '25',
      STOCK_SCANNER_SYMBOLS: 'SPCX,SMCI,FDX,MU,APGE,NVDA,IBM,INTC,MRVL,MARA,IREN,GOOGL,FCEL,CBRS,VIX,AMO,SNDK,VTAK',
      POSITION_STOP_LOSS_DOLLARS: '1',
      POSITION_STOP_LOSS_NOTIONAL_PCT: '0.75',
      POSITION_STOP_LOSS_MAX_DOLLARS: '2.50',
      TRAILING_PROFIT_START_DOLLARS: '0.50',
      TRAILING_PROFIT_GIVEBACK_DOLLARS: '0.30',
      RISK_BUDGET_SIZING_ENABLED: 'true',
      MAX_RISK_PER_TRADE_DOLLARS: '1',
      MAX_RISK_PER_TRADE_PCT_EQUITY: '0.5',
      MAX_TRADE_NOTIONAL: '150',
      MIN_STOP_DISTANCE_DOLLARS: '0.25',
      MAX_STOP_DISTANCE_DOLLARS: '2',
      ALLOW_RISK_BUDGET_FRACTIONAL_SHARES: 'true',
      RISK_BUDGET_REQUIRE_BROKER_EQUITY: 'true',
    },
    fetchImpl: global.fetch,
  }, {
    dataDir,
  }, {});

  await new Promise((resolve) => trader.close(resolve));

  assert.equal(snapshot.dashboard.port, 1111);
  assert.equal(snapshot.dashboard.trader_base_url, baseUrl);
  assert(snapshot.dashboard.runtime_version);
  assert.equal(snapshot.live.exit_management.state, 'unmanaged');
  assert.equal(snapshot.live.preflight.status, 'WARN');
  assert.equal(snapshot.live.policy_health.status, 'WARN');
  assert.equal(snapshot.summary.preflight_status, 'WARN');
  assert.equal(snapshot.live.broker_local_reconciliation.status, 'WARN');
  assert.equal(snapshot.live.reconciliation_summary.mismatch_count, 1);
  assert.equal(snapshot.live.partial_fill_summary.count, 1);
  assert.deepEqual(snapshot.live.partial_fill_summary.blocked_symbols, ['AAPL']);
  assert.equal(snapshot.live.risk_budget_sizing.config.enabled, true);
  assert.equal(snapshot.live.risk_budget_sizing.config.max_risk_per_trade_dollars, 1);
  assert.equal(snapshot.live.risk_budget_sizing.runtime.enabled, true);
  assert.equal(snapshot.live.risk_budget_sizing.latest_candidates[0].symbol, 'MU');
  assert.equal(snapshot.summary.reconciliation_status, 'WARN');
  assert.equal(snapshot.summary.reconciliation_mismatch_count, 1);
  assert.equal(snapshot.summary.partial_fill_count, 1);
  assert.equal(snapshot.summary.risk_budget_sizing_enabled, true);
  assert.equal(snapshot.summary.risk_budget_latest_candidate_count, 1);
  assert.equal(snapshot.file_snapshots.live_preflight.exists, true);
  assert.equal(snapshot.file_snapshots.broker_local_reconciliation.exists, true);
  assert.equal(snapshot.file_snapshots.partial_fill_state.exists, true);
  assert.equal(typeof snapshot.live.config_drift.has_drift, 'boolean');
  assert.equal(snapshot.summary.trader_status, 'ok');
  assert.equal(snapshot.summary.paper_pnl, 2.5);
  assert.equal(snapshot.live.report.execution_drag, 0);
  assert.equal(snapshot.summary.blocked_count, 1);
  assert.equal(snapshot.summary.approved_count, 3);
  assert.equal(snapshot.regime.workflow, 'Live Market');
  assert.deepEqual(snapshot.regime.approved_symbols, ['SPCX', 'SMCI', 'FDX', 'MU', 'APGE', 'NVDA', 'IBM', 'INTC', 'MRVL', 'MARA', 'IREN', 'GOOGL', 'FCEL', 'CBRS', 'VIX', 'AMO', 'SNDK', 'VTAK']);
  assert.equal(snapshot.regime.stop_loss_dollars, 1);
  assert.equal(snapshot.regime.stop_loss_notional_pct, 0.75);
  assert.equal(snapshot.regime.stop_loss_max_dollars, 2.5);
  assert.equal(snapshot.regime.trailing_profit_start_dollars, 0.5);
  assert.equal(snapshot.regime.trailing_profit_giveback_dollars, 0.3);
  assert.equal(snapshot.automation.live_market.current.market_day, true);
  assert.equal(snapshot.automation.live_market.start.today, true);
  assert.equal(snapshot.automation.live_market.stop.today, true);
  assert(snapshot.automation.live_market.start.label.includes('8:30 AM ET'));
  assert.equal(snapshot.live.policy.policy.maxOpenPositions, 9);
  assert.equal(snapshot.recent_activity.paperOutcomes.length, 2);
  assert.equal(snapshot.recent_activity.orders.length, 2);
  assert.equal(snapshot.recent_activity.derived_open_positions.length, 1);
  assert.equal(snapshot.summary.open_positions_count, 1);
  assert.equal(snapshot.summary.open_positions_count_source, 'derived');
  assert.equal(snapshot.summary.last_trade_at, '2026-06-19T15:04:01.000Z');
  assert.equal(snapshot.recent_activity.riskDecisions.length, 1);
  assert(snapshot.source_health.length >= 5);
});

test('dashboard snapshot prefers live alpaca positions when available', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-live-positions-test-'));
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', 'overnight-status.json'), JSON.stringify({
    status: 'ok',
    mode: 'minimal-v1',
    report_date: '2026-06-19',
    timestamp: '2026-06-19T15:00:00.000Z',
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'live-policy.json'), JSON.stringify({
    source: 'startup-config',
    policy: {
      minConfidenceForPaper: 72,
      maxOpenPositions: 9,
      positionSizeMultiplier: 1,
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'performance-history.jsonl'), '');
  fs.writeFileSync(path.join(dataDir, 'policy-history.jsonl'), '');

  const positionsServer = http.createServer((req, res) => {
    if (req.url === '/v2/positions') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([
        { symbol: 'AAPL', qty: '2' },
        { symbol: 'MSFT', qty: '1' },
      ]));
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve) => positionsServer.listen(0, '127.0.0.1', resolve));
  const positionsBaseUrl = `http://127.0.0.1:${positionsServer.address().port}`;

  const trader = http.createServer((req, res) => {
    const payloads = {
      '/status': { status: 'ok', mode: 'minimal-v1', uptime_minutes: 12, heartbeat_count: 3, last_request_at: '2026-06-19T15:00:00.000Z', timestamp: '2026-06-19T15:00:01.000Z' },
      '/daily-live-results': { date: '2026-06-19', signal_count: 4, blocked_count: 1, approved_count: 3, paper_pnl: 2.5, drawdown: 0.1, top_block_reasons: [] },
      '/risk-policy': { accepted: true, policy_snapshot: { source: 'startup-config', policy: { minConfidenceForPaper: 72, maxOpenPositions: 9, positionSizeMultiplier: 1 } } },
      '/performance/tuning': { accepted: true, tuning: { recommended_tuning_notes: ['Keep the floor tight.'] } },
      '/policy-effectiveness': { accepted: true, policy_effectiveness: { intervals: [] } },
      '/overnight-status': { accepted: true, status: 'ok', mode: 'minimal-v1' },
    };
    const payload = payloads[req.url];
    res.setHeader('content-type', 'application/json');
    if (!payload) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => trader.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${trader.address().port}`;

  const snapshot = await buildDashboardSnapshot({
    traderBaseUrl: baseUrl,
    port: 1111,
    dataDir,
    env: {
      ALPACA_API_KEY_ID: 'key',
      ALPACA_API_SECRET_KEY: 'secret',
      ALPACA_API_BASE_URL: positionsBaseUrl,
    },
    fetchImpl: global.fetch,
  }, {
    dataDir,
  }, {});

  await new Promise((resolve) => trader.close(resolve));
  await new Promise((resolve) => positionsServer.close(resolve));

  assert.equal(snapshot.summary.open_positions_count, 2);
  assert.equal(snapshot.summary.live_open_positions_count, 2);
  assert.equal(snapshot.summary.open_positions_count_source, 'alpaca');
});

test('dashboard snapshot prefers Alpaca daily account change when available', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-account-test-'));
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', 'overnight-status.json'), JSON.stringify({
    status: 'ok',
    mode: 'minimal-v1',
    report_date: '2026-06-19',
    timestamp: '2026-06-19T15:00:00.000Z',
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'live-policy.json'), JSON.stringify({
    source: 'startup-config',
    policy: {
      minConfidenceForPaper: 72,
      maxOpenPositions: 9,
      positionSizeMultiplier: 1,
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'performance-history.jsonl'), '');
  fs.writeFileSync(path.join(dataDir, 'policy-history.jsonl'), '');

  const brokerServer = http.createServer((req, res) => {
    if (req.url === '/v2/account') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        equity: '283.70',
        last_equity: '300.61',
        cash: '272.79',
        portfolio_value: '283.70',
      }));
      return;
    }
    if (req.url === '/v2/positions') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([]));
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve) => brokerServer.listen(0, '127.0.0.1', resolve));
  const brokerBaseUrl = `http://127.0.0.1:${brokerServer.address().port}`;

  const trader = http.createServer((req, res) => {
    const payloads = {
      '/status': { status: 'ok', mode: 'minimal-v1', uptime_minutes: 12, heartbeat_count: 3, last_request_at: '2026-06-19T15:00:00.000Z', timestamp: '2026-06-19T15:00:01.000Z' },
      '/daily-live-results': { date: '2026-06-19', signal_count: 4, blocked_count: 1, approved_count: 3, paper_pnl: 2.5, execution_drag: 0, drawdown: 0.1, top_block_reasons: [] },
      '/risk-policy': { accepted: true, policy_snapshot: { source: 'startup-config', policy: { minConfidenceForPaper: 72, maxOpenPositions: 9, positionSizeMultiplier: 1 } } },
      '/performance/tuning': { accepted: true, tuning: { recommended_tuning_notes: ['Keep the floor tight.'] } },
      '/policy-effectiveness': { accepted: true, policy_effectiveness: { intervals: [] } },
      '/overnight-status': { accepted: true, status: 'ok', mode: 'minimal-v1' },
    };
    const payload = payloads[req.url];
    res.setHeader('content-type', 'application/json');
    if (!payload) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => trader.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${trader.address().port}`;

  const snapshot = await buildDashboardSnapshot({
    traderBaseUrl: baseUrl,
    port: 1111,
    dataDir,
    env: {
      ALPACA_API_KEY_ID: 'key',
      ALPACA_API_SECRET_KEY: 'secret',
      ALPACA_API_BASE_URL: brokerBaseUrl,
    },
    fetchImpl: global.fetch,
  }, {
    dataDir,
  }, {});

  await new Promise((resolve) => trader.close(resolve));
  await new Promise((resolve) => brokerServer.close(resolve));

  assert.equal(snapshot.summary.daily_change, -16.91);
  assert.equal(snapshot.summary.daily_change_source, 'alpaca');
  assert.equal(snapshot.summary.account_cash, 272.79);
});

test('dashboard server serves local assets and api health', async () => {
  const server = createDashboardServer({
    port: 0,
    dashboardDir: path.resolve(process.cwd(), 'dashboard'),
    dataDir: path.resolve(process.cwd(), 'data'),
    fetchImpl: global.fetch,
    traderBaseUrl: 'http://127.0.0.1:65535',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
  const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());

  await new Promise((resolve) => server.close(resolve));

  assert.equal(health.status, 'ok');
  assert(health.runtime_version);
  assert(Number.isFinite(health.pid));
  assert(html.includes('Live Market'));
});

test('dashboard server serves the new Home, Status, and Policy tabs', async () => {
  const server = createDashboardServer({
    port: 0,
    dashboardDir: path.resolve(process.cwd(), 'dashboard'),
    dataDir: path.resolve(process.cwd(), 'data'),
    fetchImpl: global.fetch,
    traderBaseUrl: 'http://127.0.0.1:65535',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const home = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
  const status = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.text());
  const policy = await fetch(`http://127.0.0.1:${port}/policy`).then((response) => response.text());
  const exitRules = await fetch(`http://127.0.0.1:${port}/exit-rules`).then((response) => response.text());
  const alerts = await fetch(`http://127.0.0.1:${port}/alerts`).then((response) => response.text());
  const control = await fetch(`http://127.0.0.1:${port}/control`).then((response) => response.text());

  await new Promise((resolve) => server.close(resolve));

  assert(home.includes('Home'));
  assert(home.includes('Daily Change'));
  assert(home.includes('Last 5 trades'));
  assert(status.includes('Status'));
  assert(policy.includes('Policy'));
  assert(exitRules.includes('Exit Rules'));
  assert(alerts.includes('Alerts'));
  assert(control.includes('Home'));
  assert(control.includes('Status'));
  assert(control.includes('Policy'));
  assert(control.includes('Exit Rules'));
  assert(control.includes('Alerts'));
});

test('dashboard launcher auto-open can be disabled explicitly', () => {
  assert.equal(shouldAutoOpenBrowser({ DASHBOARD_OPEN_BROWSER: 'false' }), false);
  assert.equal(shouldAutoOpenBrowser({ DASHBOARD_OPEN_BROWSER: '0' }), false);
  assert.equal(shouldAutoOpenBrowser({ DASHBOARD_OPEN_BROWSER: 'true' }), true);
});

test('dashboard port prefers TRADER_DASHBOARD_PORT over DASHBOARD_PORT', () => {
  assert.equal(resolveDashboardPort({ TRADER_DASHBOARD_PORT: '2222', DASHBOARD_PORT: '3333' }), 2222);
  assert.equal(resolveDashboardPort({ DASHBOARD_PORT: '3333' }), 3333);
  assert.equal(resolveDashboardPort({ TRADER_DASHBOARD_PORT: 'not-a-port' }), 1111);
});

test('dashboard server serves mobile shell assets and manifest', async () => {
  const server = createDashboardServer({ dashboardDir: path.join(process.cwd(), 'dashboard') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const manifest = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    const mobile = await fetch(`http://127.0.0.1:${port}/mobile.js`);
    assert.equal(manifest.ok, true);
    assert.equal(mobile.ok, true);
    assert.match(manifest.headers.get('content-type') || '', /manifest\+json/);
    assert.match(mobile.headers.get('content-type') || '', /javascript/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
