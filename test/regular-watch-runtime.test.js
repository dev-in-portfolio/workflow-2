const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { buildScannerConfig } = require('../src/scanner-config');
const {
  loadRegularWatchState,
  resolveRegularWatchStatePath,
  updateRegularWatchFeatureState,
} = require('../src/regular-watch/regular-watch-feature-state');
const {
  loadRegularWatchStatus,
  resolveRegularWatchStatusPath,
} = require('../src/regular-watch/regular-watch-status');
const { runRegularWatchSources } = require('../src/regular-watch/regular-watch-source-runner');
const { createRegularWatchLoop } = require('../src/regular-watch/regular-watch-loop');

function tempWorkspace() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'regular-watch-runtime-'));
  const dataDir = path.join(repoRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  return { repoRoot, dataDir };
}

function writeEnabledState({ dataDir, env, include = [] } = {}) {
  const filePath = resolveRegularWatchStatePath({ dataDir });
  const baseEnv = {
    REGULAR_WATCH_MARKET_DATA_BATCH_DELAY_MS: '0',
    REGULAR_WATCH_MARKET_DATA_BATCH_JITTER_MS: '0',
    REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
    REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
    REGULAR_WATCH_ASSET_VALIDATION_ENABLED: 'true',
    REGULAR_WATCH_HALT_CHECK_ENABLED: 'true',
    REGULAR_WATCH_SEC_RISK_CHECK_ENABLED: 'false',
    REGULAR_WATCH_NEWS_CATALYST_ENABLED: 'false',
    REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'true',
    REGULAR_WATCH_SCANNER_RANKING_ENABLED: 'false',
    REGULAR_WATCH_POSITION_AWARENESS_ENABLED: 'false',
    REGULAR_WATCH_POLYGON_CONFIRMATION_ENABLED: 'false',
    REGULAR_WATCH_ALPHA_VANTAGE_CONFIRMATION_ENABLED: 'false',
    REGULAR_WATCH_SOCIAL_CONTEXT_ENABLED: 'false',
    REGULAR_WATCH_OPTIONS_CONTEXT_ENABLED: 'false',
    ...env,
  };
  for (const featureKey of ['REGULAR_WATCH_INTELLIGENCE_ENABLED', 'REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED', 'REGULAR_WATCH_ASSET_VALIDATION_ENABLED', 'REGULAR_WATCH_HALT_CHECK_ENABLED', 'REGULAR_WATCH_PRIORITY_SCORING_ENABLED']) {
    updateRegularWatchFeatureState({
      featureKey,
      enabled: true,
      env: baseEnv,
      filePath,
      changedBy: 'test',
      source: 'unit-test',
    });
  }
  for (const featureKey of include) {
    updateRegularWatchFeatureState({
      featureKey,
      enabled: true,
      env: baseEnv,
      filePath,
      changedBy: 'test',
      source: 'unit-test',
    });
  }
  return loadRegularWatchState({ env: baseEnv, filePath });
}

function makeResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function parseRequestedSymbols(url) {
  const parsed = new URL(url);
  return String(parsed.searchParams.get('symbols') || '')
    .split(',')
    .map((entry) => decodeURIComponent(entry).trim().toUpperCase())
    .filter(Boolean);
}

function createFetchStub({ snapshots = {}, assets = [], haltedSymbols = [], rejectSymbols = [], rejectStatus = 400, rejectBody = null } = {}) {
  const requested = [];
  const stub = async (url) => {
    requested.push(url);
    if (String(url).includes('/v2/stocks/snapshots')) {
      const symbols = parseRequestedSymbols(url);
      const rejectedSymbol = symbols.find((symbol) => rejectSymbols.map((entry) => String(entry).trim().toUpperCase()).includes(symbol));
      if (rejectedSymbol) {
        return makeResponse(rejectStatus, rejectBody || { message: `unsupported symbol ${rejectedSymbol}` });
      }
      const response = {};
      for (const symbol of symbols) {
        response[symbol] = snapshots[symbol] || {
          latestTrade: { p: 10, t: new Date().toISOString() },
          latestQuote: { bp: 9.95, ap: 10.05, t: new Date().toISOString() },
          dailyBar: { c: 10, o: 9.9, v: 500000 },
          previousDailyBar: { c: 9.7, v: 350000 },
        };
      }
      return makeResponse(200, { snapshots: response });
    }
    if (String(url).includes('/v2/assets')) {
      return makeResponse(200, assets);
    }
    if (String(url).includes('TradeHaltRSS')) {
      const xml = `<rss><channel>${haltedSymbols.map((symbol) => `<item><symbol>${symbol}</symbol></item>`).join('')}</channel></rss>`;
      return {
        ok: true,
        status: 200,
        async text() {
          return xml;
        },
      };
    }
    return makeResponse(200, {});
  };
  stub.requested = requested;
  return stub;
}

test('regular watch runner scans configured symbols and keeps scanner config unchanged', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    ...process.env,
    STOCK_SCANNER_SYMBOLS: 'SPCX,SMCI,AAPL,MSFT',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
  };
  const before = buildScannerConfig(env);
  writeEnabledState({ dataDir, env });
  const fetchImpl = createFetchStub();

  const status = await runRegularWatchSources({
    env,
    fetchImpl,
    repoRoot,
    dataDir,
  });

  const after = buildScannerConfig(env);
  const requestedSymbols = [...new Set(fetchImpl.requested.flatMap((url) => parseRequestedSymbols(url)))];
  assert.deepEqual(after.symbols, before.symbols);
  assert.deepEqual(status.regularWatchList.map((entry) => entry.symbol), ['AAPL', 'MSFT', 'SMCI', 'SPCX']);
  assert.equal(requestedSymbols.includes('AAPL'), true);
  assert.equal(requestedSymbols.includes('MSFT'), true);
  assert.ok(fs.existsSync(resolveRegularWatchStatusPath({ dataDir })));
});

test('regular watch strips malformed symbols before Alpaca requests', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    ...process.env,
    STOCK_SCANNER_SYMBOLS: 'SPCX,/USD,SMCI,C/USD',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
  };
  writeEnabledState({ dataDir, env });
  const fetchImpl = createFetchStub({
    assets: [
      { symbol: 'SPCX', tradable: true, status: 'active', asset_class: 'us_equity' },
      { symbol: 'SMCI', tradable: true, status: 'active', asset_class: 'us_equity' },
    ],
  });

  const status = await runRegularWatchSources({
    env,
    fetchImpl,
    repoRoot,
    dataDir,
  });

  const snapshotRequests = fetchImpl.requested.filter((url) => String(url).includes('/v2/stocks/snapshots'));
  const requestedSymbols = [...new Set(snapshotRequests.flatMap((url) => parseRequestedSymbols(url)))];
  assert.deepEqual(requestedSymbols.sort(), ['SMCI', 'SPCX']);
  assert.equal(status.status, 'active');
  assert.equal(status.stale, false);
  assert.equal(status.lastError, null);
});

test('regular watch runner handles missing credentials without crashing', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    ...process.env,
    STOCK_SCANNER_SYMBOLS: 'SPCX,SMCI',
  };
  writeEnabledState({ dataDir, env });

  const status = await runRegularWatchSources({
    env,
    fetchImpl: createFetchStub(),
    repoRoot,
    dataDir,
  });

  assert.equal(status.status, 'warn');
  assert.ok(Array.isArray(status.sources));
  assert.match(JSON.stringify(status.sources), /missing_credentials|inactive/);
  assert.ok(fs.existsSync(resolveRegularWatchStatusPath({ dataDir })));
});

test('regular watch loads broad Alpaca universe and rotates scan batches', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const symbols = Array.from({ length: 125 }, (_, index) => `T${String(index + 1).padStart(3, '0')}`);
  const assets = symbols.map((symbol) => ({
    symbol,
    tradable: true,
    status: 'active',
    asset_class: 'us_equity',
  }));
  const env = {
    ...process.env,
    STOCK_SCANNER_SYMBOLS: '',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
    REGULAR_WATCH_UNIVERSE_SOURCE: 'alpaca_assets',
    REGULAR_WATCH_MAX_SYMBOLS_PER_RUN: '50',
    REGULAR_WATCH_MARKET_DATA_BATCH_SIZE: '25',
    REGULAR_WATCH_DISPLAY_LIMIT: '10',
    REGULAR_WATCH_FAST_LANE_ENABLED: 'false',
  };
  writeEnabledState({ dataDir, env });
  const fetchImpl = createFetchStub({ assets });

  const first = await runRegularWatchSources({
    env,
    fetchImpl,
    repoRoot,
    dataDir,
  });
  const second = await runRegularWatchSources({
    env,
    fetchImpl,
    repoRoot,
    dataDir,
  });

  assert.equal(first.universe.full_eligible_count, 125);
  assert.equal(first.universe.current_batch_size, 50);
  assert.equal(first.universe.displayed_top_limit, 10);
  assert.equal(first.regularWatchList.length, 50);
  assert.equal(first.universe.rotation.next_offset, 50);
  assert.equal(second.universe.full_eligible_count, 125);
  assert.equal(second.universe.current_batch_size, 50);
  assert.equal(second.universe.rotation.offset, 50);
  assert.equal(second.universe.scanned_today_count, 100);
  assert.notDeepEqual(
    first.regularWatchList.map((entry) => entry.symbol),
    second.regularWatchList.map((entry) => entry.symbol),
  );
  const snapshotRequests = fetchImpl.requested.filter((url) => String(url).includes('/v2/stocks/snapshots'));
  assert(snapshotRequests.length >= 4);
  assert(snapshotRequests.every((url) => parseRequestedSymbols(url).length <= 25));
});

test('regular watch isolates a rejected Alpaca batch and preserves successful batches', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    ...process.env,
    STOCK_SCANNER_SYMBOLS: 'SPCX,SMCI,AAPL',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
    REGULAR_WATCH_MARKET_DATA_BATCH_SIZE: '2',
  };
  writeEnabledState({ dataDir, env });
  const fetchImpl = createFetchStub({
    assets: [
      { symbol: 'SPCX', tradable: true, status: 'active', asset_class: 'us_equity' },
      { symbol: 'SMCI', tradable: true, status: 'active', asset_class: 'us_equity' },
      { symbol: 'AAPL', tradable: true, status: 'active', asset_class: 'us_equity' },
    ],
    rejectSymbols: ['SMCI'],
    rejectBody: { message: 'unsupported symbol SMCI' },
  });

  const status = await runRegularWatchSources({
    env,
    fetchImpl,
    repoRoot,
    dataDir,
  });

  const symbols = new Map(status.regularWatchList.map((entry) => [entry.symbol, entry]));
  const snapshotRequests = fetchImpl.requested.filter((url) => String(url).includes('/v2/stocks/snapshots'));
  assert.equal(symbols.has('SPCX'), true);
  assert.equal(symbols.has('AAPL'), true);
  assert.equal(symbols.get('SPCX').sourceContributors.length > 0, true);
  assert.equal(symbols.get('AAPL').sourceContributors.length > 0, true);
  assert.equal(symbols.get('SMCI').sourceContributors.some((contributor) => contributor.source === 'alpacaMarket'), false);
  assert.equal(symbols.get('SMCI').stale, false);
  assert.equal(status.stale, false);
  assert.equal(status.regularWatchIntelligence.status, 'warn');
  assert.match(status.lastError || '', /SMCI|unsupported|ignored/i);
  assert.doesNotMatch(status.lastError || '', /authorization|apikey|secret/i);
  assert(snapshotRequests.length <= 4);
  assert(snapshotRequests.some((url) => parseRequestedSymbols(url).join(',') === 'SPCX,SMCI'));
  assert(snapshotRequests.some((url) => parseRequestedSymbols(url).length === 1 && parseRequestedSymbols(url)[0] === 'SMCI'));
  assert(snapshotRequests.some((url) => parseRequestedSymbols(url).length === 1 && parseRequestedSymbols(url)[0] === 'AAPL'));
});

test('regular watch preserves successful batches and reports a bounded rate-limit cooldown', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    ...process.env,
    STOCK_SCANNER_SYMBOLS: 'AAPL,SPCX,SMCI',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
    REGULAR_WATCH_MARKET_DATA_BATCH_SIZE: '2',
    REGULAR_WATCH_RATE_LIMIT_COOLDOWN_SECONDS: '90',
  };
  writeEnabledState({ dataDir, env });
  const fetchImpl = createFetchStub({
    assets: [
      { symbol: 'AAPL', tradable: true, status: 'active', asset_class: 'us_equity' },
      { symbol: 'SPCX', tradable: true, status: 'active', asset_class: 'us_equity' },
      { symbol: 'SMCI', tradable: true, status: 'active', asset_class: 'us_equity' },
    ],
    rejectSymbols: ['SMCI'],
    rejectStatus: 429,
    rejectBody: { message: 'rate limit exceeded' },
  });

  const status = await runRegularWatchSources({ env, fetchImpl, repoRoot, dataDir });
  const alpacaMarket = status.regularWatchIntelligence.sources.find((source) => source.source === 'alpacaMarket');

  assert.equal(alpacaMarket.status, 'warn');
  assert.equal(alpacaMarket.blockedReason, 'rate_limited');
  assert.equal(alpacaMarket.httpStatus, 429);
  assert.equal(alpacaMarket.symbolsConfirmed, 2);
  assert.equal(alpacaMarket.retryAfterSeconds, 90);
  assert.equal(Number.isFinite(new Date(alpacaMarket.nextRetryAt).getTime()), true);
  assert.match(status.lastError || '', /rate_limited batch failure/i);
  assert.equal(status.regularWatchList.length, 3);
});

test('regular watch loop prevents overlapping refreshes and honors rate-limit cooldown', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  let releaseFirst;
  let calls = 0;
  const firstResult = new Promise((resolve) => { releaseFirst = resolve; });
  const loop = createRegularWatchLoop({
    repoRoot,
    dataDir,
    env: {},
    runRegularWatchSources: async () => {
      calls += 1;
      if (calls === 1) return firstResult;
      return { updated_at: new Date().toISOString(), sources: [] };
    },
  });

  const firstRefresh = loop.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await loop.refresh();
  assert.equal(calls, 1);
  assert.equal(loop.getState().lastSkipReason, 'refresh_in_flight');

  const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
  releaseFirst({
    updated_at: new Date().toISOString(),
    sources: [{ source: 'alpacaMarket', status: 'rate_limited', blockedReason: 'rate_limited', nextRetryAt }],
  });
  await firstRefresh;
  await loop.refresh();
  assert.equal(calls, 1);
  assert.equal(loop.getState().lastSkipReason, 'rate_limit_cooldown');
  assert.equal(loop.getState().nextRetryAt, nextRetryAt);
});

test('regular watch fast lane rescans prior movers while rotation continues', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const symbols = Array.from({ length: 125 }, (_, index) => `F${String(index + 1).padStart(3, '0')}`);
  const assets = symbols.map((symbol) => ({
    symbol,
    tradable: true,
    status: 'active',
    asset_class: 'us_equity',
  }));
  const env = {
    ...process.env,
    STOCK_SCANNER_SYMBOLS: '',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
    REGULAR_WATCH_UNIVERSE_SOURCE: 'alpaca_assets',
    REGULAR_WATCH_MAX_SYMBOLS_PER_RUN: '60',
    REGULAR_WATCH_MARKET_DATA_BATCH_SIZE: '30',
    REGULAR_WATCH_FAST_LANE_ENABLED: 'true',
    REGULAR_WATCH_FAST_LANE_LIMIT: '10',
  };
  writeEnabledState({ dataDir, env });
  const fetchImpl = createFetchStub({ assets });

  const first = await runRegularWatchSources({ env, fetchImpl, repoRoot, dataDir });
  const firstSymbols = first.regularWatchList.map((entry) => entry.symbol);
  const second = await runRegularWatchSources({ env, fetchImpl, repoRoot, dataDir });
  const secondSymbols = second.regularWatchList.map((entry) => entry.symbol);

  assert.equal(first.universe.fast_lane_candidate_count, 0);
  assert.equal(second.universe.fast_lane_candidate_count, 10);
  assert.equal(second.universe.rotation_batch_size, 50);
  assert.equal(second.universe.merged_scan_size, 60);
  assert.equal(second.universe.scanned_today_count, 110);
  assert(firstSymbols.slice(0, 10).some((symbol) => secondSymbols.includes(symbol)));
  assert(secondSymbols.some((symbol) => !firstSymbols.includes(symbol)));
});

test('regular watch blocks halted and not-tradable symbols', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    ...process.env,
    STOCK_SCANNER_SYMBOLS: 'SPCX,SMCI',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
  };
  writeEnabledState({ dataDir, env });
  const fetchImpl = createFetchStub({
    snapshots: {
      SPCX: {
        latestTrade: { p: 10.2, t: new Date().toISOString() },
        latestQuote: { bp: 10.18, ap: 10.22, t: new Date().toISOString() },
        dailyBar: { c: 9.8, o: 9.6, v: 1_100_000 },
        previousDailyBar: { c: 9.5, v: 400_000 },
      },
      SMCI: {
        latestTrade: { p: 18.5, t: new Date().toISOString() },
        latestQuote: { bp: 18.4, ap: 18.6, t: new Date().toISOString() },
        dailyBar: { c: 17.9, o: 17.4, v: 3_200_000 },
        previousDailyBar: { c: 17.1, v: 1_000_000 },
      },
    },
    assets: [
      { symbol: 'SPCX', tradable: true, status: 'active', asset_class: 'us_equity' },
      { symbol: 'SMCI', tradable: false, status: 'active', asset_class: 'us_equity' },
    ],
    haltedSymbols: ['SPCX'],
  });

  const status = await runRegularWatchSources({
    env,
    fetchImpl,
    repoRoot,
    dataDir,
  });

  const symbols = new Map(status.regularWatchList.map((entry) => [entry.symbol, entry]));
  assert.equal(symbols.get('SPCX').status, 'blocked');
  assert.equal(symbols.get('SPCX').blockedReason, 'halted');
  assert.equal(symbols.get('SMCI').status, 'blocked');
  assert.ok(['not_tradable', 'excluded'].includes(symbols.get('SMCI').blockedReason));
});

test('regular watch flags stale market data', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    ...process.env,
    STOCK_SCANNER_SYMBOLS: 'SPCX',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
  };
  writeEnabledState({ dataDir, env });
  const oldTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const status = await runRegularWatchSources({
    env,
    fetchImpl: createFetchStub({
      snapshots: {
        SPCX: {
          latestTrade: { p: 10.2, t: oldTimestamp },
          latestQuote: { bp: 10.1, ap: 10.3, t: oldTimestamp },
          dailyBar: { c: 9.8, o: 9.6, v: 1_100_000 },
          previousDailyBar: { c: 9.5, v: 400_000 },
        },
      },
      assets: [
        { symbol: 'SPCX', tradable: true, status: 'active', asset_class: 'us_equity' },
      ],
    }),
    repoRoot,
    dataDir,
  });

  const entry = status.regularWatchList[0];
  assert.equal(status.stale, true);
  assert.ok(entry.riskWarnings.includes('stale_market_data'));
});

test('regular watch scores a strong mover higher than a quiet symbol', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    ...process.env,
    STOCK_SCANNER_SYMBOLS: 'SPCX,SMCI',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
  };
  writeEnabledState({ dataDir, env });
  const status = await runRegularWatchSources({
    env,
    fetchImpl: createFetchStub({
      snapshots: {
        SPCX: {
          latestTrade: { p: 12.5, t: new Date().toISOString() },
          latestQuote: { bp: 12.45, ap: 12.55, t: new Date().toISOString() },
          dailyBar: { c: 10, o: 9.8, v: 2_500_000 },
          previousDailyBar: { c: 9.4, v: 600_000 },
        },
        SMCI: {
          latestTrade: { p: 10.02, t: new Date().toISOString() },
          latestQuote: { bp: 10.01, ap: 10.03, t: new Date().toISOString() },
          dailyBar: { c: 10, o: 10, v: 220_000 },
          previousDailyBar: { c: 9.98, v: 210_000 },
        },
      },
      assets: [
        { symbol: 'SPCX', tradable: true, status: 'active', asset_class: 'us_equity' },
        { symbol: 'SMCI', tradable: true, status: 'active', asset_class: 'us_equity' },
      ],
    }),
    repoRoot,
    dataDir,
  });

  const spcx = status.regularWatchList.find((entry) => entry.symbol === 'SPCX');
  const smci = status.regularWatchList.find((entry) => entry.symbol === 'SMCI');
  assert.ok(Number(spcx.score) > Number(smci.score));
  assert.ok(status.regularWatchMovers.some((entry) => entry.symbol === 'SPCX'));
});

test('regular watch penalizes wide spreads', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    ...process.env,
    STOCK_SCANNER_SYMBOLS: 'SPCX,SMCI',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
  };
  writeEnabledState({ dataDir, env });
  const status = await runRegularWatchSources({
    env,
    fetchImpl: createFetchStub({
      snapshots: {
        SPCX: {
          latestTrade: { p: 12.5, t: new Date().toISOString() },
          latestQuote: { bp: 11.9, ap: 12.6, t: new Date().toISOString() },
          dailyBar: { c: 10, o: 9.8, v: 2_500_000 },
          previousDailyBar: { c: 9.4, v: 600_000 },
        },
        SMCI: {
          latestTrade: { p: 12.5, t: new Date().toISOString() },
          latestQuote: { bp: 12.48, ap: 12.52, t: new Date().toISOString() },
          dailyBar: { c: 10, o: 9.8, v: 2_500_000 },
          previousDailyBar: { c: 9.4, v: 600_000 },
        },
      },
      assets: [
        { symbol: 'SPCX', tradable: true, status: 'active', asset_class: 'us_equity' },
        { symbol: 'SMCI', tradable: true, status: 'active', asset_class: 'us_equity' },
      ],
    }),
    repoRoot,
    dataDir,
  });

  const spcx = status.regularWatchList.find((entry) => entry.symbol === 'SPCX');
  const smci = status.regularWatchList.find((entry) => entry.symbol === 'SMCI');
  assert.ok(Number(smci.score) > Number(spcx.score));
  assert.ok(spcx.riskWarnings.includes('wide_spread'));
});

test('regular watch status file contains dashboard-ready output and leaves execution untouched', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    ...process.env,
    STOCK_SCANNER_SYMBOLS: 'SPCX',
    ALPACA_API_KEY_ID: 'key',
    ALPACA_API_SECRET_KEY: 'secret',
    BLOCK_BUYS: 'true',
  };
  writeEnabledState({ dataDir, env });
  const scannerBefore = buildScannerConfig(env);
  const status = await runRegularWatchSources({
    env,
    fetchImpl: createFetchStub({
      snapshots: {
        SPCX: {
          latestTrade: { p: 12.5, t: new Date().toISOString() },
          latestQuote: { bp: 12.45, ap: 12.55, t: new Date().toISOString() },
          dailyBar: { c: 10, o: 9.8, v: 2_500_000 },
          previousDailyBar: { c: 9.4, v: 600_000 },
        },
      },
      assets: [
        { symbol: 'SPCX', tradable: true, status: 'active', asset_class: 'us_equity' },
      ],
    }),
    repoRoot,
    dataDir,
  });
  const scannerAfter = buildScannerConfig(env);
  const onDisk = loadRegularWatchStatus({ dataDir, filePath: resolveRegularWatchStatusPath({ dataDir }) });

  assert.deepEqual(scannerAfter, scannerBefore);
  assert.equal(status.regularWatchList.length, 1);
  assert.equal(Array.isArray(status.sources), true);
  assert.equal(onDisk.regularWatchList.length, 1);
  assert.equal(onDisk.regularWatchIntelligence.status, status.regularWatchIntelligence.status);
  assert.equal(env.BLOCK_BUYS, 'true');
});
