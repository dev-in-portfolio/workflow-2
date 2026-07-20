const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { buildDashboardSnapshot } = require('../src/dashboard-server');

test('dashboard source health includes runtime reddit and regular watch sources', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-source-health-'));
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'logs', 'overnight-status.json'), JSON.stringify({
    status: 'ok',
    mode: 'minimal-v1',
    report_date: '2026-06-30',
    timestamp: '2026-06-30T14:00:00.000Z',
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'performance-history.jsonl'), '');
  fs.writeFileSync(path.join(dataDir, 'policy-history.jsonl'), '');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state', 'scanner-runtime.json'), JSON.stringify({
    updated_at: '2026-06-30T14:05:00.000Z',
    last_scan_time: '2026-06-30T14:05:00.000Z',
    sources: [{
      source: 'twelve_data', enabled: true, configured: true, healthy: true, status: 'healthy',
      last_successful_request: '2026-06-30T14:04:59.000Z', requests_used_this_minute: 1,
      estimated_daily_credits_used: 12, estimated_daily_credits_remaining: 788,
      authentication_state: 'authenticated',
    }],
  }, null, 2));

  fs.writeFileSync(path.join(dataDir, 'runtime', 'meme-monitor-status.json'), JSON.stringify({
    version: '2026-06-30.meme-monitor-status.1',
    updated_at: '2026-06-30T14:05:00.000Z',
    enabled: true,
      redditScanner: {
        enabled: true,
        status: 'shadow',
        lastRunAt: '2026-06-30T14:05:00.000Z',
        lastError: null,
      sources: [
        {
          source: 'wallstreetbets2',
          tier: 'tier_1',
          status: 'active',
          lastScanAt: '2026-06-30T14:05:00.000Z',
          lastError: null,
          symbolsDetected: 4,
          blockedReason: null,
        },
        {
          source: 'CryptoCurrency',
          tier: 'optional_high_noise',
          status: 'off',
          lastScanAt: null,
          lastError: null,
          symbolsDetected: 0,
          blockedReason: 'source_disabled',
        },
        {
          source: 'wallstreetbetsnew',
          tier: 'tier_1',
          status: 'reused_records',
          lastScanAt: '2026-06-30T14:05:00.000Z',
          lastError: null,
          symbolsDetected: 2,
          blockedReason: null,
        },
        {
          source: 'shortsqueeze',
          tier: 'tier_1',
          status: 'source_disabled',
          lastScanAt: null,
          lastError: null,
          symbolsDetected: 0,
          blockedReason: 'source_disabled',
        },
        {
          source: 'wallstreetbetselite',
          tier: 'tier_1',
          status: 'missing_credentials',
          lastScanAt: null,
          lastError: 'missing_credentials',
          symbolsDetected: 0,
          blockedReason: 'missing_credentials',
        },
        {
          source: 'wallstreetbetsnew',
          tier: 'tier_1',
          status: 'source_not_found_or_inaccessible',
          lastScanAt: null,
          lastError: 'source_not_found_or_inaccessible',
          symbolsDetected: 0,
          blockedReason: 'source_not_found_or_inaccessible',
        },
        {
          source: 'amcstock',
          tier: 'ticker_specific',
          status: 'quarantined_or_restricted',
          lastScanAt: null,
          lastError: 'quarantined_or_restricted',
          symbolsDetected: 0,
          blockedReason: 'quarantined_or_restricted',
        },
        {
          source: 'daytrading',
          tier: 'tier_2',
          status: 'error',
          lastScanAt: null,
          lastError: 'unexpected_error',
          symbolsDetected: 0,
          blockedReason: 'unexpected_error',
        },
      ],
      symbolsDetected: 4,
      rejectedTokens: 0,
      mode: 'reddit-oauth',
    },
    phaseA: {
      enabled: true,
      status: 'active',
      lastRunAt: '2026-06-30T14:05:00.000Z',
      lastError: null,
      sources: {
        alpacaMarket: {
          source: 'alpacaMarket',
          status: 'active',
          lastRunAt: '2026-06-30T14:05:00.000Z',
          lastError: null,
        },
      },
      symbols: [],
    },
    phaseB: {
      enabled: true,
      status: 'active',
      lastRunAt: '2026-06-30T14:05:00.000Z',
      lastError: null,
      sources: {
        stocktwits: {
          source: 'stocktwits',
          status: 'rate_limited',
          lastRunAt: null,
          lastError: 'rate_limited',
          blockedReason: 'rate_limited',
        },
      },
      symbols: [],
    },
  }, null, 2));

  fs.writeFileSync(path.join(dataDir, 'runtime', 'regular-watch-status.json'), JSON.stringify({
    version: '2026-06-30.regular-watch-status.2',
    updated_at: '2026-06-30T14:05:00.000Z',
    enabled: true,
    regularWatchIntelligence: {
      enabled: true,
      status: 'active',
      lastRunAt: '2026-06-30T14:05:00.000Z',
      lastError: null,
      symbolsChecked: 1,
      moversFound: 1,
      blockedSymbols: 0,
      features: {},
      sources: [
        {
          source: 'stocks',
          tier: 'tier_2',
          status: 'active',
          lastScanAt: '2026-06-30T14:05:00.000Z',
          lastError: null,
          symbolsDetected: 2,
          blockedReason: null,
        },
      ],
    },
    sources: [
      {
        source: 'stocks',
        tier: 'tier_2',
        status: 'active',
        lastScanAt: '2026-06-30T14:05:00.000Z',
        lastError: null,
        symbolsDetected: 2,
        blockedReason: null,
      },
    ],
    regularWatchList: [],
    regularWatchMovers: [],
    stale: false,
    status: 'active',
    lastRunAt: '2026-06-30T14:05:00.000Z',
    lastError: null,
  }, null, 2));

  const trader = http.createServer((req, res) => {
    const payloads = {
      '/status': { status: 'ok', mode: 'minimal-v1', uptime_minutes: 12, heartbeat_count: 3, timestamp: '2026-06-30T14:05:00.000Z' },
      '/daily-live-results': { date: '2026-06-30', signal_count: 0, blocked_count: 0, approved_count: 0, paper_pnl: 0, execution_drag: 0, drawdown: 0, top_block_reasons: [] },
      '/risk-policy': { accepted: true, policy_snapshot: { source: 'startup-config', policy: { minConfidenceForPaper: 72, maxOpenPositions: 9, positionSizeMultiplier: 1 } } },
      '/performance/tuning': { accepted: true, tuning: { recommended_tuning_notes: [] } },
      '/policy-effectiveness': { accepted: true, policy_effectiveness: { intervals: [] } },
      '/overnight-status': { status: 'ok', mode: 'minimal-v1' },
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
  const traderBaseUrl = `http://127.0.0.1:${trader.address().port}`;

  try {
    const snapshot = await buildDashboardSnapshot({
      traderBaseUrl,
      dataDir,
      repoRoot: tempDir,
      fetchImpl: global.fetch,
      env: {
        ALPACA_API_KEY_ID: '',
        ALPACA_API_SECRET_KEY: '',
        MEME_MONITOR_ENABLED: 'true',
        MEME_REDDIT_SCANNER_ENABLED: 'true',
        MEME_HOT_LIST_ENABLED: 'false',
        MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
        MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
        MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
        REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
        REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
        REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'true',
        REGULAR_WATCH_POSITION_AWARENESS_ENABLED: 'true',
      },
    }, {
      dataDir,
    }, {});

    const sourceHealth = snapshot.source_health.filter((entry) => entry.kind === 'source');
    const reddit = sourceHealth.find((entry) => entry.source === 'wallstreetbets2');
    const disabledOptional = sourceHealth.find((entry) => entry.source === 'CryptoCurrency');
    const phaseB = sourceHealth.find((entry) => entry.source === 'stocktwits');
    const regular = sourceHealth.find((entry) => entry.source === 'stocks');
    const reusedRecords = sourceHealth.find((entry) => entry.source === 'wallstreetbetsnew');
    const sourceDisabled = sourceHealth.find((entry) => entry.source === 'shortsqueeze');
    const missingCredentials = sourceHealth.find((entry) => entry.source === 'wallstreetbetselite');
    const inaccessible = sourceHealth.find((entry) => entry.source === 'wallstreetbetsnew' && entry.status === 'source_not_found_or_inaccessible');
    const quarantined = sourceHealth.find((entry) => entry.source === 'amcstock');
    const errored = sourceHealth.find((entry) => entry.source === 'daytrading');
    const twelveData = sourceHealth.find((entry) => entry.source === 'twelve_data');

    assert.equal(reddit.status, 'active');
    assert.equal(reddit.group, 'meme_monitor');
    assert.equal(disabledOptional.status, 'off');
    assert.equal(disabledOptional.ok, true);
    assert.equal(reusedRecords.status, 'reused_records');
    assert.equal(reusedRecords.ok, true);
    assert.equal(sourceDisabled.status, 'source_disabled');
    assert.equal(sourceDisabled.ok, true);
    assert.equal(missingCredentials.status, 'missing_credentials');
    assert.equal(missingCredentials.ok, false);
    assert.equal(inaccessible.status, 'source_not_found_or_inaccessible');
    assert.equal(inaccessible.ok, false);
    assert.equal(quarantined.status, 'quarantined_or_restricted');
    assert.equal(quarantined.ok, false);
    assert.equal(errored.status, 'error');
    assert.equal(errored.ok, false);
    assert.equal(phaseB.status, 'rate_limited');
    assert.equal(phaseB.ok, false);
    assert.equal(regular.status, 'active');
    assert.equal(regular.group, 'regular_watch');
    assert.equal(twelveData.status, 'healthy');
    assert.equal(twelveData.ok, true);
    assert.equal(twelveData.authentication_state, 'authenticated');
  } finally {
    await new Promise((resolve) => trader.close(resolve));
  }
});
