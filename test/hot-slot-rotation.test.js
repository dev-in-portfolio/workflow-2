const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('node:url');
const test = require('node:test');
const {
  evaluateHotSlotRotationPlan,
  evaluateRotationPositionCandidate,
  resolveHotSlotRotationConfig,
  selectHotHotRotationCandidate,
  selectRotationEvictionCandidate,
  summarizeHotSlotRotationRuntime,
} = require('../src/hot-slot-rotation');
const { createStockScanner } = require('../src/stock-scanner');
const { buildPortfolioSnapshot } = require('../src/portfolio-allocation');

test('hot slot rotation selects the strongest hot hot candidate', () => {
  const candidate = {
    symbol: 'SOUN',
    rankScore: 92,
    priorityOverrideSortScore: 1092,
    payload: { side: 'buy' },
  };
  const selection = selectHotHotRotationCandidate({
    buyCandidates: [candidate],
    hotHotEntries: [{
      symbol: 'SOUN',
      status: 'hot_hot',
      memeHeatScore: 94,
      marketConfirmationScore: 82,
      marketConfirmationDetails: { tradable: true, halted: false },
    }],
    config: resolveHotSlotRotationConfig({
      MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
      MEME_HOT_SLOT_ROTATION_MIN_HEAT_SCORE: '90',
      MEME_HOT_SLOT_ROTATION_MIN_MARKET_SCORE: '75',
    }),
  });

  assert(selection);
  assert.equal(selection.candidate.symbol, 'SOUN');
  assert.equal(selection.heatScore, 94);
  assert.equal(selection.marketScore, 82);
});

test('hot slot rotation blocks losing positions, strong runners, open orders, and partial fills', () => {
  const config = resolveHotSlotRotationConfig({
    MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
    MEME_ROTATION_REQUIRE_BREAKEVEN_OR_BETTER: 'true',
    MEME_ROTATION_PROTECT_STRONG_RUNNERS: 'true',
  });
  const hotHotCandidate = {
    candidate: { symbol: 'SOUN' },
    heatScore: 94,
    marketScore: 82,
  };

  const losing = evaluateRotationPositionCandidate({
    symbol: 'MARA',
    qty: 10,
    avg_entry_price: 10,
  }, {
    snapshots: {
      MARA: { latestQuote: { p: 9.2, bp: 9.18, ap: 9.22 }, prevDailyBar: { c: 9.7, v: 100000 } },
    },
    hotHotCandidate,
    config,
  });
  assert.equal(losing.eligible, false);
  assert.equal(losing.blockReason, 'rotation_blocked_eviction_not_breakeven');

  const runner = evaluateRotationPositionCandidate({
    symbol: 'MARA',
    qty: 10,
    avg_entry_price: 10,
  }, {
    snapshots: {
      MARA: { latestQuote: { p: 10.9, bp: 10.85, ap: 10.95 }, prevDailyBar: { c: 10.1, v: 100000 } },
    },
    hotHotCandidate,
    config,
  });
  assert.equal(runner.eligible, false);
  assert.equal(runner.blockReason, 'rotation_blocked_strong_runner');

  const openOrderConflict = evaluateRotationPositionCandidate({
    symbol: 'MARA',
    qty: 10,
    avg_entry_price: 10,
  }, {
    snapshots: {
      MARA: { latestQuote: { p: 10.1, bp: 10.09, ap: 10.11 }, prevDailyBar: { c: 10, v: 100000 } },
    },
    openOrders: [{
      symbol: 'MARA',
      side: 'sell',
      status: 'new',
      type: 'limit',
    }],
    hotHotCandidate,
    config,
  });
  assert.equal(openOrderConflict.eligible, false);
  assert.equal(openOrderConflict.blockReason, 'rotation_blocked_open_order_conflict');

  const partialFillConflict = evaluateRotationPositionCandidate({
    symbol: 'MARA',
    qty: 10,
    avg_entry_price: 10,
  }, {
    snapshots: {
      MARA: { latestQuote: { p: 10.1, bp: 10.09, ap: 10.11 }, prevDailyBar: { c: 10, v: 100000 } },
    },
    partialFillSummary: {
      partial_sells: [{ symbol: 'MARA', remaining_qty: 1, side: 'sell' }],
    },
    hotHotCandidate,
    config,
  });
  assert.equal(partialFillConflict.eligible, false);
  assert.equal(partialFillConflict.blockReason, 'rotation_blocked_partial_fill_state');
});

test('hot slot rotation selects the weakest eligible position', () => {
  const config = resolveHotSlotRotationConfig({
    MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
  });
  const result = selectRotationEvictionCandidate({
    positions: [
      { symbol: 'AAA', qty: 10, avg_entry_price: 10 },
      { symbol: 'BBB', qty: 10, avg_entry_price: 10 },
    ],
    snapshots: {
      AAA: { latestQuote: { p: 10.2, bp: 10.18, ap: 10.22 }, prevDailyBar: { c: 10, v: 100000 } },
      BBB: { latestQuote: { p: 10.3, bp: 10.28, ap: 10.32 }, prevDailyBar: { c: 10, v: 100000 } },
    },
    runtimeBySymbol: new Map([
      ['AAA', { adjusted_rank_score: 41 }],
      ['BBB', { adjusted_rank_score: 70 }],
    ]),
    hotHotCandidate: { heatScore: 94, marketScore: 82, candidate: { symbol: 'SOUN' } },
    config,
  });

  assert(result.candidate);
  assert.equal(result.candidate.symbol, 'AAA');
  assert.equal(result.reason, 'slightly_profitable_but_stale_low_momentum');
});

test('hot slot rotation plan stays off when feature or dependency is disabled', () => {
  const disabled = evaluateHotSlotRotationPlan({
    featureState: { status: 'off', configured: false, runtime: false, effective: false },
    config: resolveHotSlotRotationConfig({ MEME_HOT_SLOT_ROTATION_ENABLED: 'false' }),
    portfolio: buildPortfolioSnapshot({ positions: [], openOrders: [], account: { buying_power: 500 } }),
  });
  assert.equal(disabled.status, 'off');
  assert.equal(disabled.lastDecision, 'rotation_blocked_feature_disabled');

  const dependencyBlocked = evaluateHotSlotRotationPlan({
    featureState: { status: 'blocked', blocked_reason: 'MEME_PRIORITY_OVERRIDE_ENABLED is off' },
    config: resolveHotSlotRotationConfig({ MEME_HOT_SLOT_ROTATION_ENABLED: 'true' }),
    portfolio: buildPortfolioSnapshot({ positions: [], openOrders: [], account: { buying_power: 500 } }),
  });
  assert.equal(dependencyBlocked.status, 'blocked');
  assert.equal(dependencyBlocked.lastDecision, 'rotation_blocked_dependency_disabled');
});

test('hot slot rotation runtime flags the broker reconciliation wait state', () => {
  const runtime = summarizeHotSlotRotationRuntime({
    status: 'active',
    lastDecision: 'rotation_reconcile_after_exit_started',
    requested: true,
  }, {
    effective: true,
  });

  assert.equal(runtime.waitingForBrokerReconciliation, true);
  assert.equal(runtime.status, 'active');
});

test('scanner rotation sells a weak position, rechecks broker state, and promotes the candidate', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-slot-rotation-success-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  const env = {
    ...process.env,
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'true',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
    MEME_PRIORITY_OVERRIDE_ENABLED: 'true',
    MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
    MEME_HOT_SLOT_ROTATION_MIN_HEAT_SCORE: '90',
    MEME_HOT_SLOT_ROTATION_MIN_MARKET_SCORE: '75',
    MEME_ROTATION_RECHECK_AFTER_EXIT: 'true',
    MEME_ROTATION_EXIT_TIMEOUT_SECONDS: '3',
    MEME_ROTATION_ENTRY_RECHECK_MAX_AGE_SECONDS: '3',
    MAX_OPEN_POSITIONS: '1',
    SCANNER_RUNTIME_STATE_PATH: path.join(dataDir, 'state', 'scanner-runtime.json'),
  };

  fs.writeFileSync(path.join(tempRoot, '.env.local'), 'EXAMPLE=1\n');
  const envLocalStat = fs.statSync(path.join(tempRoot, '.env.local'));

  fs.writeFileSync(path.join(dataDir, 'state', 'meme-monitor-state.json'), JSON.stringify({
    version: '2026-06-30.meme-monitor-state.1',
    updated_at: '2026-06-30T14:00:00.000Z',
    source: 'unit-test',
    features: {
      MEME_MONITOR_ENABLED: { key: 'MEME_MONITOR_ENABLED', runtime: true },
      MEME_REDDIT_SCANNER_ENABLED: { key: 'MEME_REDDIT_SCANNER_ENABLED', runtime: true },
      MEME_HOT_LIST_ENABLED: { key: 'MEME_HOT_LIST_ENABLED', runtime: true },
      MEME_DYNAMIC_WATCHLIST_ENABLED: { key: 'MEME_DYNAMIC_WATCHLIST_ENABLED', runtime: true },
      MEME_PRIORITY_OVERRIDE_ENABLED: { key: 'MEME_PRIORITY_OVERRIDE_ENABLED', runtime: true },
      MEME_HOT_SLOT_ROTATION_ENABLED: { key: 'MEME_HOT_SLOT_ROTATION_ENABLED', runtime: true },
      MEME_AUTO_ACTION_ENABLED: { key: 'MEME_AUTO_ACTION_ENABLED', runtime: false },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'dynamic-hot-list.json'), JSON.stringify({
    generatedAt: '2026-06-30T14:00:00.000Z',
    lastScoredAt: '2026-06-30T14:00:00.000Z',
    mode: 'active',
    source: 'meme-monitor',
    enabled: true,
    stale: false,
    dynamicHotList: [],
    hotHotList: [{
      symbol: 'SOUN',
      status: 'hot_hot',
      memeHeatScore: 94,
      marketConfirmationScore: 82,
      marketConfirmationDetails: { tradable: true, halted: false, spreadPct: 0.24 },
      phaseA: {
        tradableStatus: 'tradable',
        haltStatus: 'not_halted',
        sourceConfirmations: { alpacaAssets: true, nasdaqHalts: true },
      },
      sourceConfirmations: { alpacaAssets: true, nasdaqHalts: true },
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      reasonCodes: ['market_confirmation_passed'],
      riskWarnings: [],
      priorityOverrideEligible: true,
      priorityOverrideApplied: true,
    }],
    expired: [],
    rejected: [],
  }, null, 2));

  let sold = false;
  const requests = [];
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['MARA', 'SOUN'],
    intervalMs: 60_000,
    maxCandidatesPerRun: 2,
    maxOpenPositions: 1,
    maxBuyRiskScore: 100,
    marketOpen: true,
    manageOnlyBlocksBuys: false,
    requireMultiSourceConfirmation: false,
    sessionGuards: {
      status: 'CLEAR',
      active_guards: [],
      buy_blocked: false,
      sells_allowed: true,
      manage_only: false,
      reason_codes: [],
      expires_at: null,
      explanation: 'Unit test override.',
      intraday_regime: {
        regime: 'open',
        market_open: true,
        manage_only: false,
        buys_allowed: true,
        reason_code: null,
      },
      metrics: {},
      setup_fatigue_summary: {
        active_setup_count: 0,
        paused_setups: [],
      },
    },
    dataDir,
    repoRoot: tempRoot,
    env,
    runtimeStateEnabled: true,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse(sold ? [] : [{
          symbol: 'MARA',
          qty: '1',
          avg_entry_price: '10',
          unrealized_pl: sold ? '0' : '0.05',
          current_price: sold ? '10' : '10.05',
        }]);
      }
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: sold ? '510' : '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        const parsed = new URL(url);
        const symbolList = decodeURIComponent(parsed.searchParams.get('symbols') || '').split(',').map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean);
        const payload = {};
        for (const symbol of symbolList) {
          if (symbol === 'MARA') {
            payload[symbol] = {
              latestQuote: { bp: 9.99, ap: 10.01, t: '2026-06-30T14:00:00.000Z' },
              latestTrade: { p: 10.05, t: '2026-06-30T14:00:00.000Z' },
              minuteBar: { v: 50, h: 10.08, l: 10.0, t: '2026-06-30T14:00:00.000Z' },
              prevDailyBar: { c: 10, v: 100000 },
            };
          } else if (symbol === 'SOUN') {
            payload[symbol] = {
              latestQuote: { bp: 23.18, ap: 23.24, t: '2026-06-30T14:00:00.000Z' },
              latestTrade: { p: 23.21, t: '2026-06-30T14:00:00.000Z' },
              minuteBar: { v: 200, h: 23.35, l: 23.05, t: '2026-06-30T14:00:00.000Z' },
              prevDailyBar: { c: 21.1, v: 200000 },
            };
          }
        }
        return buildResponse({ snapshots: payload });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (_url, init = {}) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      requests.push({ symbol: body.symbol, side: body.side });
      if (body.side === 'sell') {
        sold = true;
        return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
      }
      return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
    },
  });

  try {
    const result = await scanner.runOnce({ runId: 'rotation-success' });
    assert.equal(result.accepted, true);
    assert.equal(requests[0].side, 'sell');
    assert.equal(requests[1].symbol, 'SOUN');
    assert.equal(requests[1].side, 'buy');
    assert.equal(fs.readFileSync(path.join(tempRoot, '.env.local'), 'utf8'), 'EXAMPLE=1\n');
    assert.equal(fs.statSync(path.join(tempRoot, '.env.local')).mtimeMs, envLocalStat.mtimeMs);
    const runtime = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'scanner-runtime.json'), 'utf8'));
    assert.equal(runtime.hot_slot_rotation.lastDecision, 'rotation_complete');
    assert.equal(runtime.hot_slot_rotation.candidate, 'SOUN');
    assert.equal(runtime.hot_slot_rotation.evictionCandidate, 'MARA');
  } finally {
    scanner.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('scanner still posts normal buy candidates when rotation is enabled but no rotation is eligible', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-slot-rotation-no-rotation-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  const env = {
    ...process.env,
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'true',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
    MEME_PRIORITY_OVERRIDE_ENABLED: 'true',
    MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
    MEME_HOT_SLOT_ROTATION_MIN_HEAT_SCORE: '90',
    MEME_HOT_SLOT_ROTATION_MIN_MARKET_SCORE: '75',
    MAX_OPEN_POSITIONS: '1',
    SCANNER_RUNTIME_STATE_PATH: path.join(dataDir, 'state', 'scanner-runtime.json'),
  };

  fs.writeFileSync(path.join(dataDir, 'state', 'meme-monitor-state.json'), JSON.stringify({
    version: '2026-06-30.meme-monitor-state.1',
    updated_at: '2026-06-30T14:00:00.000Z',
    source: 'unit-test',
    features: {
      MEME_MONITOR_ENABLED: { key: 'MEME_MONITOR_ENABLED', runtime: true },
      MEME_REDDIT_SCANNER_ENABLED: { key: 'MEME_REDDIT_SCANNER_ENABLED', runtime: true },
      MEME_HOT_LIST_ENABLED: { key: 'MEME_HOT_LIST_ENABLED', runtime: true },
      MEME_DYNAMIC_WATCHLIST_ENABLED: { key: 'MEME_DYNAMIC_WATCHLIST_ENABLED', runtime: true },
      MEME_PRIORITY_OVERRIDE_ENABLED: { key: 'MEME_PRIORITY_OVERRIDE_ENABLED', runtime: true },
      MEME_HOT_SLOT_ROTATION_ENABLED: { key: 'MEME_HOT_SLOT_ROTATION_ENABLED', runtime: true },
      MEME_AUTO_ACTION_ENABLED: { key: 'MEME_AUTO_ACTION_ENABLED', runtime: false },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'dynamic-hot-list.json'), JSON.stringify({
    generatedAt: '2026-06-30T14:00:00.000Z',
    lastScoredAt: '2026-06-30T14:00:00.000Z',
    mode: 'active',
    source: 'meme-monitor',
    enabled: true,
    stale: false,
    dynamicHotList: [],
    hotHotList: [{
      symbol: 'GME',
      status: 'hot_hot',
      memeHeatScore: 85,
      marketConfirmationScore: 70,
      marketConfirmationDetails: { tradable: true, halted: false, spreadPct: 0.24 },
      phaseA: {
        tradableStatus: 'tradable',
        haltStatus: 'not_halted',
        sourceConfirmations: { alpacaAssets: true, nasdaqHalts: true },
      },
      sourceConfirmations: { alpacaAssets: true, nasdaqHalts: true },
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      reasonCodes: ['market_confirmation_passed'],
      riskWarnings: [],
      priorityOverrideEligible: true,
      priorityOverrideApplied: true,
    }],
    expired: [],
    rejected: [],
  }, null, 2));

  const requests = [];
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['MARA', 'SOUN'],
    intervalMs: 60_000,
    maxCandidatesPerRun: 2,
    maxOpenPositions: 1,
    maxBuyRiskScore: 100,
    marketOpen: true,
    manageOnlyBlocksBuys: false,
    requireMultiSourceConfirmation: false,
    sessionGuards: {
      status: 'CLEAR',
      active_guards: [],
      buy_blocked: false,
      sells_allowed: true,
      manage_only: false,
      reason_codes: [],
      expires_at: null,
      explanation: 'Unit test override.',
      intraday_regime: {
        regime: 'open',
        market_open: true,
        manage_only: false,
        buys_allowed: true,
        reason_code: null,
      },
      metrics: {},
      setup_fatigue_summary: {
        active_setup_count: 0,
        paused_setups: [],
      },
    },
    dataDir,
    repoRoot: tempRoot,
    env,
    runtimeStateEnabled: true,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse([{
          symbol: 'MARA',
          qty: '1',
          avg_entry_price: '10',
          unrealized_pl: '0.05',
          current_price: '10.05',
        }]);
      }
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        const parsed = new URL(url);
        const symbolList = decodeURIComponent(parsed.searchParams.get('symbols') || '').split(',').map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean);
        const payload = {};
        for (const symbol of symbolList) {
          if (symbol === 'MARA') {
            payload[symbol] = {
              latestQuote: { bp: 9.99, ap: 10.01, t: '2026-06-30T14:00:00.000Z' },
              latestTrade: { p: 10.05, t: '2026-06-30T14:00:00.000Z' },
              minuteBar: { v: 50, h: 10.08, l: 10.0, t: '2026-06-30T14:00:00.000Z' },
              prevDailyBar: { c: 10, v: 100000 },
            };
          } else if (symbol === 'SOUN') {
            payload[symbol] = {
              latestQuote: { bp: 23.18, ap: 23.24, t: '2026-06-30T14:00:00.000Z' },
              latestTrade: { p: 23.21, t: '2026-06-30T14:00:00.000Z' },
              minuteBar: { v: 200, h: 23.35, l: 23.05, t: '2026-06-30T14:00:00.000Z' },
              prevDailyBar: { c: 21.1, v: 200000 },
            };
          }
        }
        return buildResponse({ snapshots: payload });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (_url, init = {}) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      requests.push({ symbol: body.symbol, side: body.side });
      return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
    },
  });

  try {
    const result = await scanner.runOnce({ runId: 'rotation-no-rotation' });
    assert.equal(result.accepted, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].symbol, 'SOUN');
    assert.equal(requests[0].side, 'buy');
  } finally {
    scanner.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('scanner rotation blocks a candidate that goes stale after the exit', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-slot-rotation-stale-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  const env = {
    ...process.env,
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'true',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
    MEME_PRIORITY_OVERRIDE_ENABLED: 'true',
    MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
    MEME_HOT_SLOT_ROTATION_MIN_HEAT_SCORE: '90',
    MEME_HOT_SLOT_ROTATION_MIN_MARKET_SCORE: '75',
    MEME_ROTATION_RECHECK_AFTER_EXIT: 'true',
    MEME_ROTATION_EXIT_TIMEOUT_SECONDS: '3',
    MEME_ROTATION_ENTRY_RECHECK_MAX_AGE_SECONDS: '1',
    MAX_OPEN_POSITIONS: '1',
    SCANNER_RUNTIME_STATE_PATH: path.join(dataDir, 'state', 'scanner-runtime.json'),
  };
  fs.writeFileSync(path.join(dataDir, 'state', 'meme-monitor-state.json'), JSON.stringify({
    version: '2026-06-30.meme-monitor-state.1',
    updated_at: '2026-06-30T14:00:00.000Z',
    source: 'unit-test',
    features: {
      MEME_MONITOR_ENABLED: { key: 'MEME_MONITOR_ENABLED', runtime: true },
      MEME_REDDIT_SCANNER_ENABLED: { key: 'MEME_REDDIT_SCANNER_ENABLED', runtime: true },
      MEME_HOT_LIST_ENABLED: { key: 'MEME_HOT_LIST_ENABLED', runtime: true },
      MEME_DYNAMIC_WATCHLIST_ENABLED: { key: 'MEME_DYNAMIC_WATCHLIST_ENABLED', runtime: true },
      MEME_PRIORITY_OVERRIDE_ENABLED: { key: 'MEME_PRIORITY_OVERRIDE_ENABLED', runtime: true },
      MEME_HOT_SLOT_ROTATION_ENABLED: { key: 'MEME_HOT_SLOT_ROTATION_ENABLED', runtime: true },
      MEME_AUTO_ACTION_ENABLED: { key: 'MEME_AUTO_ACTION_ENABLED', runtime: false },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'dynamic-hot-list.json'), JSON.stringify({
    generatedAt: '2026-06-30T14:00:00.000Z',
    lastScoredAt: '2026-06-30T14:00:00.000Z',
    mode: 'active',
    source: 'meme-monitor',
    enabled: true,
    stale: false,
    dynamicHotList: [],
    hotHotList: [{
      symbol: 'SOUN',
      status: 'hot_hot',
      memeHeatScore: 94,
      marketConfirmationScore: 82,
      marketConfirmationDetails: { tradable: true, halted: false, spreadPct: 0.24 },
      phaseA: {
        tradableStatus: 'tradable',
        haltStatus: 'not_halted',
        sourceConfirmations: { alpacaAssets: true, nasdaqHalts: true },
      },
      sourceConfirmations: { alpacaAssets: true, nasdaqHalts: true },
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      reasonCodes: ['market_confirmation_passed'],
      riskWarnings: [],
      priorityOverrideEligible: true,
      priorityOverrideApplied: true,
    }],
    expired: [],
    rejected: [],
  }, null, 2));

  const requests = [];
  let sold = false;
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['MARA', 'SOUN'],
    intervalMs: 60_000,
    maxCandidatesPerRun: 2,
    maxOpenPositions: 1,
    maxBuyRiskScore: 100,
    marketOpen: true,
    manageOnlyBlocksBuys: false,
    requireMultiSourceConfirmation: false,
    sessionGuards: {
      status: 'CLEAR',
      active_guards: [],
      buy_blocked: false,
      sells_allowed: true,
      manage_only: false,
      reason_codes: [],
      expires_at: null,
      explanation: 'Unit test override.',
      intraday_regime: {
        regime: 'open',
        market_open: true,
        manage_only: false,
        buys_allowed: true,
        reason_code: null,
      },
      metrics: {},
      setup_fatigue_summary: {
        active_setup_count: 0,
        paused_setups: [],
      },
    },
    dataDir,
    repoRoot: tempRoot,
    env,
    runtimeStateEnabled: true,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse(sold ? [] : [{
          symbol: 'MARA',
          qty: '1',
          avg_entry_price: '10',
          unrealized_pl: sold ? '0' : '0.05',
          current_price: sold ? '10' : '10.05',
        }]);
      }
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: sold ? '510' : '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        const parsed = new URL(url);
        const symbolList = decodeURIComponent(parsed.searchParams.get('symbols') || '').split(',').map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean);
        const payload = {};
        for (const symbol of symbolList) {
          if (symbol === 'MARA') {
            payload[symbol] = {
              latestQuote: { bp: 9.99, ap: 10.01, t: '2026-06-30T14:00:00.000Z' },
              latestTrade: { p: 10.05, t: '2026-06-30T14:00:00.000Z' },
              minuteBar: { v: 50, h: 10.08, l: 10.0, t: '2026-06-30T14:00:00.000Z' },
              prevDailyBar: { c: 10, v: 100000 },
            };
          } else if (symbol === 'SOUN') {
            payload[symbol] = {
              latestQuote: { bp: 23.18, ap: 23.24, t: '2026-06-30T14:00:00.000Z' },
              latestTrade: { p: 23.21, t: '2026-06-30T14:00:00.000Z' },
              minuteBar: { v: 200, h: 23.35, l: 23.05, t: '2026-06-30T14:00:00.000Z' },
              prevDailyBar: { c: 21.1, v: 200000 },
            };
          }
        }
        return buildResponse({ snapshots: payload });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (_url, init = {}) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      requests.push({ symbol: body.symbol, side: body.side });
      if (body.side === 'sell') {
        sold = true;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
      }
      return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
    },
  });

  try {
    const result = await scanner.runOnce({ runId: 'rotation-stale' });
    assert.equal(result.accepted, true);
    assert.equal(requests.some((entry) => entry.side === 'buy'), false);
    const runtime = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'scanner-runtime.json'), 'utf8'));
    assert.equal(runtime.hot_slot_rotation.lastDecision, 'rotation_candidate_no_longer_valid');
  } finally {
    scanner.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('hot slot rotation blocks hot hot entries when tradability or halt status is unknown or risky', () => {
  const config = resolveHotSlotRotationConfig({
    MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
    MEME_HOT_SLOT_ROTATION_MIN_HEAT_SCORE: '90',
    MEME_HOT_SLOT_ROTATION_MIN_MARKET_SCORE: '75',
  });

  const unknownSafety = selectHotHotRotationCandidate({
    buyCandidates: [{ symbol: 'GME', priorityOverrideSortScore: 100 }],
    hotHotEntries: [{
      symbol: 'GME',
      status: 'hot_hot',
      memeHeatScore: 96,
      marketConfirmationScore: 88,
      marketConfirmationDetails: { tradable: null, halted: null },
      phaseA: { tradableStatus: 'unknown', haltStatus: 'unknown', sourceConfirmations: {} },
      sourceConfirmations: { alpacaAssets: false, nasdaqHalts: false },
    }],
    config,
  });

  const haltedSafety = selectHotHotRotationCandidate({
    buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
    hotHotEntries: [{
      symbol: 'SOUN',
      status: 'hot_hot',
      memeHeatScore: 96,
      marketConfirmationScore: 88,
      marketConfirmationDetails: { tradable: true, halted: true },
      phaseA: { tradableStatus: 'tradable', haltStatus: 'halted', sourceConfirmations: { alpacaAssets: true, nasdaqHalts: false } },
      sourceConfirmations: { alpacaAssets: true, nasdaqHalts: false },
    }],
    config,
  });

  assert.equal(unknownSafety, null);
  assert.equal(haltedSafety, null);
});

function buildResponse(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload);
    },
  };
}
