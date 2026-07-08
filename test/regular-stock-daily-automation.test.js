const test = require('node:test');
const assert = require('node:assert/strict');
const { formatAutomationSummary, runRegularStockDailyAutomation } = require('../src/regular-stock-daily-automation');

test('start automation skips US market holidays without touching the dashboard', async () => {
  const result = await runRegularStockDailyAutomation({
    action: 'start',
    now: new Date('2026-06-19T13:30:00Z'),
    fetchImpl: async () => {
      throw new Error('fetch should not be called for a holiday skip');
    },
    spawnImpl: () => {
      throw new Error('spawn should not be called for a holiday skip');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'us_market_holiday');
});

test('start automation calls start-workflow when the dashboard is reachable', async () => {
  const calls = [];
  const dashboardBaseUrl = 'http://127.0.0.1:1111';
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options.method || 'GET', options.body || null]);
    const text = String(url);
    if (text.endsWith('/api/health')) {
      return responseJson(true, {});
    }
    if (text.endsWith('/api/control/state')) {
      return responseJson(true, {
        control: {
          workflow: { status: 'stopped' },
          trader: { status: 'stopped' },
          scanner: { status: 'stopped' },
        },
      });
    }
    if (text.endsWith('/api/snapshot')) {
      return responseJson(true, {
        regime: { approved_symbols: ['NVDA'] },
        summary: { account_buying_power: 1234.56, daily_change: 7.89 },
        live: { open_positions: [] },
      });
    }
    if (text.endsWith('/api/control/action')) {
      const body = JSON.parse(options.body || '{}');
      assert.equal(body.action, 'start-workflow');
      assert.equal(body.profile, 'live-market');
      return responseJson(true, {
        ok: true,
        action: 'start-workflow',
        verified: true,
        message: 'Workflow started',
      });
    }
    throw new Error(`Unexpected fetch url: ${url}`);
  };

  const result = await runRegularStockDailyAutomation({
    action: 'start',
    now: new Date('2026-06-17T12:00:00Z'),
    env: { DASHBOARD_BASE_URL: dashboardBaseUrl },
    fetchImpl,
    spawnImpl: () => {
      throw new Error('spawn should not be called when dashboard is reachable');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.workflow_state, 'stopped');
  assert.equal(result.action_result.ok, true);
  assert.equal(result.action_result.message, 'Workflow started');
  assert(calls.some(([url]) => String(url).endsWith('/api/control/action')));
});

test('stop automation calls stop-workflow on a weekday', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options.method || 'GET', options.body || null]);
    const text = String(url);
    if (text.endsWith('/api/health')) {
      return responseJson(true, {});
    }
    if (text.endsWith('/api/control/state')) {
      return responseJson(true, {
        control: {
          workflow: { status: 'running' },
          trader: { status: 'running' },
          scanner: { status: 'running' },
        },
      });
    }
    if (text.endsWith('/api/snapshot')) {
      return responseJson(true, {
        regime: { approved_symbols: ['NVDA'] },
        summary: { account_buying_power: 1234.56, daily_change: 7.89 },
        live: { open_positions: [] },
      });
    }
    if (text.endsWith('/api/control/action')) {
      const body = JSON.parse(options.body || '{}');
      assert.equal(body.action, 'stop-workflow');
      return responseJson(true, {
        ok: true,
        action: 'stop-workflow',
        verified: true,
        message: 'Workflow stopped',
      });
    }
    throw new Error(`Unexpected fetch url: ${url}`);
  };

  const result = await runRegularStockDailyAutomation({
    action: 'stop',
    now: new Date('2026-06-17T21:00:00Z'),
    env: { DASHBOARD_BASE_URL: 'http://127.0.0.1:1111' },
    fetchImpl,
    spawnImpl: () => {
      throw new Error('spawn should not be called when dashboard is reachable');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action_result.ok, true);
  assert.equal(result.action_result.message, 'Workflow stopped');
  assert(calls.some(([url]) => String(url).endsWith('/api/control/action')));
});

test('automation reports dashboard unreachable when it cannot connect', async () => {
  const result = await runRegularStockDailyAutomation({
    action: 'start',
    now: new Date('2026-06-17T12:00:00Z'),
    fetchImpl: async () => {
      throw new Error('dashboard not reachable');
    },
    spawnImpl: () => ({ pid: 0, unref() {} }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dashboard_unreachable');
});

test('automation report formatter includes the key operator fields', () => {
  const text = formatAutomationSummary({
    dashboard_url: 'http://127.0.0.1:1111',
    workflow_state: 'running',
    market_state: {
      schedule: {
        start: { label: 'Wed, Jun 17, 5:00 AM ET' },
        stop: { label: 'Wed, Jun 17, 5:00 PM ET' },
      },
    },
    trader: { status: 'running', pid: 1234 },
    scanner: { status: 'running', pid: 4321, profile: 'live-market' },
    config: { approved_symbols: ['NVDA', 'TSLA'] },
    open_positions: [{ symbol: 'NVDA', quantity: 4 }],
    account: { buying_power: 1234.56, daily_change: 25.2 },
    warnings: [],
  });

  assert(text.includes('Dashboard: http://127.0.0.1:1111'));
  assert(text.includes('Workflow: running'));
  assert(text.includes('Schedule: Wed, Jun 17, 5:00 AM ET -> Wed, Jun 17, 5:00 PM ET'));
  assert(text.includes('Approved symbols: NVDA, TSLA'));
  assert(text.includes('Open positions: NVDA x4'));
});

function responseJson(ok, payload) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  };
}
