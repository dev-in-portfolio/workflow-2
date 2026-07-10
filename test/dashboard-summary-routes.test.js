const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  buildDynamicTopSymbols,
  buildHomeSummary,
  buildSourceHealthSummary,
  createDashboardServer,
} = require('../src/dashboard-server');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function createTraderServer() {
  const trader = http.createServer((req, res) => {
    const payloads = {
      '/status': { status: 'ok', mode: 'minimal-v1', uptime_minutes: 32, heartbeat_count: 7, timestamp: '2026-07-03T13:05:00.000Z' },
      '/daily-live-results': { date: '2026-07-03', signal_count: 0, blocked_count: 1, approved_count: 0, paper_pnl: 0.12, execution_drag: 0, drawdown: 0, top_block_reasons: [] },
      '/risk-policy': { accepted: true, policy_snapshot: { source: 'manual', captured_at: '2026-07-03T13:00:00.000Z', policy: { minConfidenceForPaper: 72, maxOpenPositions: 9, positionSizeMultiplier: 1 } } },
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
  return trader;
}

function createFixture(tempRoot) {
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });

  writeJson(path.join(dataDir, 'logs', 'overnight-status.json'), {
    status: 'ok',
    mode: 'minimal-v1',
    report_date: '2026-07-03',
    timestamp: '2026-07-03T13:00:00.000Z',
  });
  fs.writeFileSync(path.join(dataDir, 'performance-history.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'policy-history.jsonl'), '', 'utf8');
  writeJson(path.join(dataDir, 'live-policy.json'), {
    source: 'manual',
    captured_at: '2026-07-03T13:00:00.000Z',
    policy: {
      minConfidenceForPaper: 72,
      maxOpenPositions: 9,
      positionSizeMultiplier: 1,
    },
  });
  writeJson(path.join(dataDir, 'state', 'scanner-runtime.json'), {
    scanner: 'stock-scanner',
    mode: 'live-market',
    updated_at: '2026-07-03T13:04:00.000Z',
    last_scan_time: '2026-07-03T13:03:30.000Z',
    scanner_symbol_source: 'dynamic',
    active_source_count: 7,
    approved_source_count: 7,
    source_counts: {
      approved_source_count: 7,
      regular_watch_source_count: 2,
      regular_watch_movers_source_count: 2,
      dynamic_hot_source_count: 2,
      hot_hot_source_count: 2,
      dynamic_source_count: 7,
      active_source_count: 7,
    },
    source_lists_by_symbol: {
      H1: { source_lists: ['Hot Hot List', 'Dynamic Hot List'] },
      H2: { source_lists: ['Hot Hot List', 'Scanner Preview'] },
      DUP: { source_lists: ['Dynamic Hot List', 'Regular Watch Movers List'] },
      D2: { source_lists: ['Dynamic Hot List'] },
      P1: { source_lists: ['Scanner Preview', 'Regular Watch List'] },
      M1: { source_lists: ['Regular Watch Movers List'] },
      R1: { source_lists: ['Regular Watch List'] },
    },
    preview_candidate_count: 2,
    preview_reason_codes: ['MARKET_CLOSED_FOR_STOCKS'],
    preview_candidates: [
      { symbol: 'P1', source: 'scanner', status: 'preview_only', execution_blocked: true, reason_codes: ['MARKET_CLOSED_FOR_STOCKS'] },
      { symbol: 'H2', source: 'scanner', status: 'preview_only', execution_blocked: true, reason_codes: ['MARKET_CLOSED_FOR_STOCKS'] },
    ],
    top_preview_candidates: [
      { symbol: 'P1', source: 'scanner', status: 'preview_only', execution_blocked: true, reason_codes: ['MARKET_CLOSED_FOR_STOCKS'] },
      { symbol: 'H2', source: 'scanner', status: 'preview_only', execution_blocked: true, reason_codes: ['MARKET_CLOSED_FOR_STOCKS'] },
    ],
    market_closed_execution_block: true,
    candidate_rank_details: [],
  });
  writeJson(path.join(dataDir, 'runtime', 'dynamic-hot-list.json'), {
    generatedAt: '2026-07-03T13:00:00.000Z',
    lastScoredAt: '2026-07-03T13:00:00.000Z',
    mode: 'active',
    source: 'fixture',
    enabled: true,
    status: 'active',
    stale: false,
    dynamicHotList: [
      { symbol: 'H1', memeHeatScore: 96, marketConfirmationScore: 91, status: 'hot_hot', priorityOverrideEligible: true, reasonCodes: ['market_confirmation_passed'], expiresAt: '2026-07-03T15:00:00.000Z' },
      { symbol: 'DUP', memeHeatScore: 83, marketConfirmationScore: 79, status: 'hot_hot', priorityOverrideEligible: true, reasonCodes: ['market_confirmation_passed'], expiresAt: '2026-07-03T15:00:00.000Z' },
      { symbol: 'D2', memeHeatScore: 71, marketConfirmationScore: 68, status: 'dynamic_watch', reasonCodes: ['dynamic_watch'], expiresAt: '2026-07-03T15:00:00.000Z' },
    ],
    hotHotList: [
      { symbol: 'H1', memeHeatScore: 96, marketConfirmationScore: 91, status: 'hot_hot', priorityOverrideEligible: true, reasonCodes: ['market_confirmation_passed'], expiresAt: '2026-07-03T15:00:00.000Z' },
      { symbol: 'H2', memeHeatScore: 93, marketConfirmationScore: 90, status: 'hot_hot', priorityOverrideEligible: true, reasonCodes: ['market_confirmation_passed'], expiresAt: '2026-07-03T15:00:00.000Z' },
    ],
    expired: [],
    rejected: [],
  });
  writeJson(path.join(dataDir, 'runtime', 'meme-monitor-status.json'), {
    version: '2026-07-03.meme-monitor-status.1',
    updated_at: '2026-07-03T13:00:00.000Z',
    enabled: true,
    redditScanner: {
      enabled: true,
      status: 'shadow',
      lastRunAt: '2026-07-03T13:00:00.000Z',
      lastError: null,
      sources: [
        { source: 'wallstreetbets', tier: 'tier_1', status: 'active', lastScanAt: '2026-07-03T13:00:00.000Z', lastError: null, symbolsDetected: 4, blockedReason: null },
        { source: 'wallstreetbetselite', tier: 'tier_1', status: 'missing_credentials', lastScanAt: null, lastError: 'missing_credentials', symbolsDetected: 0, blockedReason: 'missing_credentials' },
        { source: 'CryptoCurrency', tier: 'optional_high_noise', status: 'off', lastScanAt: null, lastError: null, symbolsDetected: 0, blockedReason: 'source_disabled' },
      ],
      symbolsDetected: 4,
      rejectedTokens: 0,
      mode: 'reddit-oauth',
    },
    phaseA: {
      enabled: true,
      status: 'active',
      lastRunAt: '2026-07-03T13:00:00.000Z',
      lastError: null,
      sources: {
        alpacaMarket: { source: 'alpacaMarket', status: 'active', lastRunAt: '2026-07-03T13:00:00.000Z', lastError: null },
      },
      symbols: [],
    },
    phaseB: {
      enabled: true,
      status: 'active',
      lastRunAt: '2026-07-03T13:00:00.000Z',
      lastError: null,
      sources: {
        stocktwits: { source: 'stocktwits', status: 'error', lastRunAt: null, lastError: 'unexpected_error', blockedReason: 'unexpected_error' },
      },
      symbols: [],
    },
    hotList: {
      enabled: true,
      status: 'active',
      dynamicCount: 3,
      hotHotCount: 2,
      lastScoredAt: '2026-07-03T13:00:00.000Z',
      stale: false,
      lastError: null,
    },
    hotHotScoring: {
      enabled: true,
      status: 'active',
      lastScoredAt: '2026-07-03T13:00:00.000Z',
      stale: false,
      lastError: null,
    },
  });
  writeJson(path.join(dataDir, 'runtime', 'regular-watch-status.json'), {
    version: '2026-07-03.regular-watch-status.1',
    updated_at: '2026-07-03T13:00:00.000Z',
    enabled: true,
    regularWatchIntelligence: {
      enabled: true,
      status: 'active',
      lastRunAt: '2026-07-03T13:00:00.000Z',
      lastError: null,
      symbolsChecked: 3,
      moversFound: 2,
      blockedSymbols: 0,
      features: {},
      sources: [
        { source: 'stocks', tier: 'tier_2', status: 'active', lastScanAt: '2026-07-03T13:00:00.000Z', lastError: null, symbolsDetected: 2, blockedReason: null },
        { source: 'options', tier: 'tier_2', status: 'inactive', lastScanAt: null, lastError: null, symbolsDetected: 0, blockedReason: 'source_disabled' },
      ],
    },
    sources: [
      { source: 'stocks', tier: 'tier_2', status: 'active', lastScanAt: '2026-07-03T13:00:00.000Z', lastError: null, symbolsDetected: 2, blockedReason: null },
      { source: 'options', tier: 'tier_2', status: 'inactive', lastScanAt: null, lastError: null, symbolsDetected: 0, blockedReason: 'source_disabled' },
    ],
    regularWatchList: [
      { symbol: 'R1', score: 62, sourceStatus: [{ source: 'stocks', status: 'active' }] },
      { symbol: 'M1', score: 74, sourceStatus: [{ source: 'stocks', status: 'active' }] },
      { symbol: 'DUP', score: 57, sourceStatus: [{ source: 'stocks', status: 'active' }] },
      { symbol: 'P1', score: 53, sourceStatus: [{ source: 'stocks', status: 'active' }] },
    ],
    regularWatchMovers: [
      { symbol: 'M1', score: 74, sourceStatus: [{ source: 'stocks', status: 'active' }] },
      { symbol: 'DUP', score: 57, sourceStatus: [{ source: 'stocks', status: 'active' }] },
    ],
    stale: false,
    status: 'active',
    lastRunAt: '2026-07-03T13:00:00.000Z',
    lastError: null,
  });

  return { dataDir };
}

test('buildDynamicTopSymbols keeps source precedence and dedupes by symbol', () => {
  const top = buildDynamicTopSymbols({
    watch: {
      hotHotList: { symbols: [{ symbol: 'H1' }, { symbol: 'H2' }] },
      dynamicHotList: { symbols: [{ symbol: 'DUP' }, { symbol: 'D2' }] },
      scannerPreview: { topPreviewCandidates: [{ symbol: 'P1' }, { symbol: 'H2' }] },
      regularWatchMovers: [{ symbol: 'M1' }, { symbol: 'DUP' }],
      regularWatchList: [{ symbol: 'R1' }, { symbol: 'P1' }],
      scannerSource: {
        sourceListsBySymbol: {
          H1: { source_lists: ['Hot Hot List'] },
          H2: { source_lists: ['Hot Hot List', 'Scanner Preview'] },
          DUP: { source_lists: ['Dynamic Hot List', 'Regular Watch Movers'] },
          D2: { source_lists: ['Dynamic Hot List'] },
          P1: { source_lists: ['Scanner Preview', 'Regular Watch List'] },
          M1: { source_lists: ['Regular Watch Movers'] },
          R1: { source_lists: ['Regular Watch List'] },
        },
      },
    },
  });

  assert.deepEqual(top.map((item) => item.symbol), ['H1', 'H2', 'DUP', 'D2', 'P1', 'M1', 'R1']);
  assert.equal(top[0].source, 'Hot Hot List');
  assert.equal(top[2].source, 'Dynamic Hot List');
  assert.equal(top[4].source, 'Scanner Preview');
  assert.equal(top[5].source, 'Regular Watch Movers');
  assert.equal(top[6].source, 'Regular Watch');
  assert.equal(top[4].source_lists.includes('Scanner Preview'), true);
  assert.equal(top[2].source_lists.includes('Regular Watch Movers'), true);
});

test('home summary reports dynamic top freshness from source data, not dashboard generation time', () => {
  const homeSummary = buildHomeSummary({
    generated_at: '2026-07-03T14:00:00.000Z',
    timestamp: '2026-07-03T14:00:00.000Z',
    live: {
      scanner_runtime: {
        last_scan_time: '2026-07-03T13:03:30.000Z',
        updated_at: '2026-07-03T13:04:00.000Z',
      },
      regular_watch_intelligence: {
        enabled: true,
        status: 'active',
        symbolsChecked: 2,
        moversFound: 1,
        lastRunAt: '2026-07-03T13:02:00.000Z',
      },
      regular_watch_runtime: {
        stale: false,
        generatedAt: '2026-07-03T13:02:05.000Z',
      },
    },
    watch: {
      scannerPreview: {
        topPreviewCandidates: [
          { symbol: 'P1', adjusted_rank_score: 88 },
        ],
      },
      regularWatchMovers: [
        { symbol: 'M1', regularWatchScore: 74 },
      ],
    },
  });

  assert.equal(homeSummary.dynamicTopSymbols[0].symbol, 'P1');
  assert.equal(homeSummary.dynamicTopFreshness.source, 'Scanner Preview');
  assert.equal(homeSummary.dynamicTopFreshness.source_timestamp, '2026-07-03T13:03:30.000Z');
  assert.notEqual(homeSummary.dynamicTopFreshness.source_timestamp, homeSummary.generated_at);
  assert.equal(homeSummary.hotListStatus.status, 'active');
  assert.equal(homeSummary.hotListStatus.primaryCount, 2);
  assert.equal(homeSummary.hotListStatus.secondaryCount, 1);
  assert.equal(homeSummary.hotListStatus.sourceLabel, 'Regular stock process');
});

test('home summary surfaces useful regular watch warnings', () => {
  const homeSummary = buildHomeSummary({
    generated_at: '2026-07-03T14:00:00.000Z',
    timestamp: '2026-07-03T14:00:00.000Z',
    live: {
      regular_watch_intelligence: {
        enabled: true,
        status: 'warn',
        lastError: 'Regular Watch ignored 1 unsupported symbol (SMCI) in Alpaca snapshot requests. 2 symbols confirmed.',
        symbolsChecked: 2,
        moversFound: 1,
        lastRunAt: '2026-07-03T13:02:00.000Z',
      },
      regular_watch_runtime: {
        stale: false,
        regularWatchIntelligence: {
          enabled: true,
          status: 'warn',
          lastError: 'Regular Watch ignored 1 unsupported symbol (SMCI) in Alpaca snapshot requests. 2 symbols confirmed.',
          lastRunAt: '2026-07-03T13:02:00.000Z',
        },
      },
    },
  });

  assert.equal(homeSummary.hotListStatus.status, 'warn');
  assert.equal(homeSummary.hotListStatus.stale, false);
  assert.match(homeSummary.hotListStatus.lastError, /SMCI|unsupported symbol/i);
  assert.doesNotMatch(homeSummary.hotListStatus.lastError, /HTTP 400/i);
});

test('home summary displays the score used for regular watch ranking', () => {
  const homeSummary = buildHomeSummary({
    generated_at: '2026-07-06T15:05:00.000Z',
    timestamp: '2026-07-06T15:05:00.000Z',
    live: {
      scanner_runtime: {
        last_scan_time: '2026-07-06T15:04:35.000Z',
        updated_at: '2026-07-06T15:04:37.000Z',
      },
    },
    watch: {
      regularWatchMovers: [
        { symbol: 'VRM', regularWatchScore: 0, scannerScore: 1135.536 },
        { symbol: 'RGNX', regularWatchScore: 44 },
      ],
    },
  });

  assert.equal(homeSummary.dynamicTopSymbols[0].symbol, 'VRM');
  assert.equal(homeSummary.dynamicTopSymbols[0].score, 1135.536);
  assert.equal(homeSummary.dynamicTopSymbols[1].symbol, 'RGNX');
  assert.equal(homeSummary.dynamicTopSymbols[1].score, 44);
});

test('source health summary treats explicit disabled sources as inactive even with legacy ok flag', () => {
  const summary = buildSourceHealthSummary({
    generated_at: '2026-07-03T14:00:00.000Z',
    source_health: [
      { source: 'polygon', kind: 'source', status: 'inactive', ok: true, blockedReason: 'source_disabled' },
      { source: 'socialContext', kind: 'source', status: 'off', ok: true, blockedReason: 'source_disabled' },
      { source: 'alpacaMarket', kind: 'source', status: 'active', ok: true },
    ],
  });

  const polygon = summary.sources.find((entry) => entry.source === 'polygon');
  const social = summary.sources.find((entry) => entry.source === 'socialContext');
  const alpaca = summary.sources.find((entry) => entry.source === 'alpacaMarket');
  assert.equal(polygon.health_status, 'inactive');
  assert.equal(polygon.ok, false);
  assert.equal(social.health_status, 'inactive');
  assert.equal(social.ok, false);
  assert.equal(alpaca.health_status, 'active');
  assert.equal(summary.counts.inactive, 2);
  assert.equal(summary.counts.active, 1);
});

test('dashboard summary endpoints and page shells expose the lightweight views', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-summary-'));
  const { dataDir } = createFixture(tempRoot);
  const trader = createTraderServer();
  const controlManager = {
    refresh: async () => controlManager.getState(),
    getState: () => ({
      trader: {
        status: 'running',
        pid: 2468,
        port: 3005,
        base_url: 'http://127.0.0.1:3005',
        managed: true,
        started_at: '2026-07-03T12:55:00.000Z',
        last_action_at: '2026-07-03T12:58:00.000Z',
      },
      scanner: {
        status: 'running',
        profile: 'live-market',
        pid: 9753,
        script: 'scripts/start-stock-scanner.js',
        managed: true,
        started_at: '2026-07-03T12:55:00.000Z',
        last_action_at: '2026-07-03T12:58:00.000Z',
      },
      workflow: {
        status: 'running',
        issues: [],
        desired_scanner_profile: 'live-market',
      },
      updated_at: '2026-07-03T13:00:00.000Z',
    }),
  };

  await new Promise((resolve) => trader.listen(0, '127.0.0.1', resolve));
  const traderBaseUrl = `http://127.0.0.1:${trader.address().port}`;
  const dashboard = createDashboardServer({
    port: 0,
    dashboardDir: path.resolve(process.cwd(), 'dashboard'),
    repoRoot: tempRoot,
    dataDir,
    env: {
      ...process.env,
      STOCK_SCANNER_SYMBOLS: 'R1,M1,H1,H2,DUP,D2,P1',
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'true',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
    },
    fetchImpl: global.fetch,
    controlManager,
    traderBaseUrl,
  });
  await new Promise((resolve) => dashboard.listen(0, '127.0.0.1', resolve));
  const dashboardPort = dashboard.address().port;

  try {
    const homeSummary = await fetch(`http://127.0.0.1:${dashboardPort}/api/home-summary`).then((response) => response.json());
    assert.equal(homeSummary.status, 'ok');
    assert.equal(Array.isArray(homeSummary.dynamicTopSymbols), true);
    assert.equal(homeSummary.dynamicTopSymbols.length > 0, true);
    assert.equal(homeSummary.dynamicTopSymbols.length <= 10, true);
    assert.equal(homeSummary.dynamicTopSymbols.some((item) => item.symbol === 'P1'), true);
    assert.equal(homeSummary.dynamicTopFreshness.source_timestamp, '2026-07-03T13:03:30.000Z');
    assert.equal(typeof homeSummary.hotListStatus.status, 'string');
    assert.equal(homeSummary.source_health_summary.counts.total > 0, true);

    const watchSnapshot = await fetch(`http://127.0.0.1:${dashboardPort}/api/watch-snapshot`).then((response) => response.json());
    assert.equal(watchSnapshot.status, 'ok');
    assert.equal(Array.isArray(watchSnapshot.watch.regularWatchList), true);
    assert.equal(Array.isArray(watchSnapshot.watch.regularWatchMovers), true);
    assert.equal(Array.isArray(watchSnapshot.watch.dynamicHotList.symbols), true);
    assert.equal(Array.isArray(watchSnapshot.watch.hotHotList.symbols), true);
    assert.equal(watchSnapshot.watch.scannerPreview.previewCandidateCount, 2);
    assert.equal(watchSnapshot.watch.scannerPreview.marketClosedExecutionBlock, true);

    const controlSummary = await fetch(`http://127.0.0.1:${dashboardPort}/api/control-summary`).then((response) => response.json());
    assert.equal(['ok', 'warn', 'degraded'].includes(controlSummary.status), true);
    assert.equal(controlSummary.control.trader.port, 3005);
    assert.equal(controlSummary.control.scanner.profile, 'live-market');
    assert.equal(controlSummary.source_health_summary.counts.error > 0, true);

    const sourceHealthSummary = await fetch(`http://127.0.0.1:${dashboardPort}/api/source-health-summary`).then((response) => response.json());
    assert.equal(['ok', 'warn', 'degraded'].includes(sourceHealthSummary.status), true);
    assert.equal(Array.isArray(sourceHealthSummary.sources), true);
    assert.equal(sourceHealthSummary.sources.every((entry) => ['active', 'inactive', 'error'].includes(entry.health_status)), true);
    const disabledOptions = sourceHealthSummary.sources.find((entry) => entry.source === 'options');
    assert.equal(disabledOptions.health_status, 'inactive');

    const homeHtml = await fetch(`http://127.0.0.1:${dashboardPort}/`).then((response) => response.text());
    const watchHtml = await fetch(`http://127.0.0.1:${dashboardPort}/watch`).then((response) => response.text());
    assert.equal(homeHtml.includes('Dynamic Top 10'), true);
    assert.equal(homeHtml.includes('dynamicTopList'), true);
    assert.equal(homeHtml.includes('Hot List'), true);
    assert.equal((homeHtml.match(/top-symbol-card/g) || []).length, 0);
    assert.equal(watchHtml.includes('Regular Watch List'), true);
    assert.equal(watchHtml.includes('Regular Watch Movers List'), true);
    assert.equal(watchHtml.includes('Dynamic Hot List From Alerts'), true);
    assert.equal(watchHtml.includes('Hot Hot List'), true);
  } finally {
    await new Promise((resolve) => dashboard.close(resolve));
    await new Promise((resolve) => trader.close(resolve));
  }
});
