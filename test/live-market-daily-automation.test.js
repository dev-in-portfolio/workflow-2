const test = require('node:test');
const assert = require('node:assert/strict');
const { isUsMarketHoliday } = require('../src/us-market-holidays');
const {
  dashboardCandidates,
  formatAutomationSummary,
  isUsMarketWeekday,
  runLiveMarketDailyAutomation,
} = require('../src/live-market-daily-automation');

test('live-market automation treats market holidays as blocked start days', () => {
  assert.equal(isUsMarketHoliday(new Date('2026-06-19T13:30:00Z')), true);
  assert.equal(isUsMarketWeekday(new Date('2026-06-19T13:30:00Z')), true);
});

test('dashboard candidates start at the preferred dashboard port', () => {
  const candidates = dashboardCandidates({ DASHBOARD_PORT: '1113' });
  assert.equal(candidates[0], 'http://127.0.0.1:1113');
});

test('start automation skips US market holidays without touching the dashboard', async () => {
  const result = await runLiveMarketDailyAutomation({
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

test('automation report formatter includes the key operator fields', () => {
  const text = formatAutomationSummary({
    dashboard_url: 'http://127.0.0.1:1111',
    workflow_state: 'running',
    trader: { status: 'running', pid: 1234 },
    scanner: { status: 'running', pid: 4321, profile: 'live-market' },
    config: { approved_symbols: ['NVDA', 'TSLA'] },
    open_positions: [{ symbol: 'NVDA', quantity: 4 }],
    account: { buying_power: 1234.56, daily_change: 25.2 },
    warnings: [],
  });

  assert(text.includes('Dashboard: http://127.0.0.1:1111'));
  assert(text.includes('Workflow: running'));
  assert(text.includes('Approved symbols: NVDA, TSLA'));
  assert(text.includes('Open positions: NVDA x4'));
});
