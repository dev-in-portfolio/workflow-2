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

test('hot slot rotation blocks when post-exit reconciliation is disabled', () => {
  const plan = evaluateHotSlotRotationPlan({
    featureState: { status: 'active', configured: true, runtime: true, effective: true },
    config: resolveHotSlotRotationConfig({
      MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
      MEME_ROTATION_RECHECK_AFTER_EXIT: 'false',
    }),
    portfolio: buildPortfolioSnapshot({ positions: [], openOrders: [], account: { buying_power: 500 } }),
  });

  assert.equal(plan.status, 'blocked');
  assert.equal(plan.lastDecision, 'rotation_blocked_recheck_after_exit_disabled');
  assert.equal(plan.blockReason, 'rotation_blocked_recheck_after_exit_disabled');
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
    symbols: ['MARA', 'SOUN', 'AAA'],
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
          } else if (symbol === 'AAA') {
            payload[symbol] = {
              latestQuote: { bp: 34.98, ap: 35.02, t: '2026-06-30T14:00:00.000Z' },
              latestTrade: { p: 35.01, t: '2026-06-30T14:00:00.000Z' },
              minuteBar: { v: 500, h: 35.25, l: 34.8, t: '2026-06-30T14:00:00.000Z' },
              prevDailyBar: { c: 32.5, v: 250000 },
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
    assert.equal(requests.some((entry) => entry.symbol === 'AAA'), false);
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
    assert.equal(requests.length, 0);
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

test('hot slot rotation rejects hot hot candidates that fail the blocker matrix', () => {
  const config = resolveHotSlotRotationConfig({
    MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
    MEME_HOT_SLOT_ROTATION_MIN_HEAT_SCORE: '90',
    MEME_HOT_SLOT_ROTATION_MIN_MARKET_SCORE: '75',
  });

  const cases = [
    {
      name: 'no hot hot candidate exists',
      buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
      hotHotEntries: [],
    },
    {
      name: 'candidate status is not hot_hot',
      buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
      hotHotEntries: [{
        symbol: 'SOUN',
        status: 'shadow',
        memeHeatScore: 96,
        marketConfirmationScore: 82,
        marketConfirmationDetails: { tradable: true, halted: false },
      }],
    },
    {
      name: 'candidate is expired',
      buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
      hotHotEntries: [{
        symbol: 'SOUN',
        status: 'hot_hot',
        expired: true,
        memeHeatScore: 96,
        marketConfirmationScore: 82,
        marketConfirmationDetails: { tradable: true, halted: false },
      }],
    },
    {
      name: 'meme heat score is below threshold',
      buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
      hotHotEntries: [{
        symbol: 'SOUN',
        status: 'hot_hot',
        memeHeatScore: 89,
        marketConfirmationScore: 82,
        marketConfirmationDetails: { tradable: true, halted: false },
      }],
    },
    {
      name: 'market confirmation score is below threshold',
      buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
      hotHotEntries: [{
        symbol: 'SOUN',
        status: 'hot_hot',
        memeHeatScore: 96,
        marketConfirmationScore: 74,
        marketConfirmationDetails: { tradable: true, halted: false },
      }],
    },
    {
      name: 'tradability is unknown',
      buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
      hotHotEntries: [{
        symbol: 'SOUN',
        status: 'hot_hot',
        memeHeatScore: 96,
        marketConfirmationScore: 82,
        marketConfirmationDetails: { tradable: null, halted: null },
        phaseA: { tradableStatus: 'unknown', haltStatus: 'unknown', sourceConfirmations: {} },
      }],
    },
    {
      name: 'tradability is blocked',
      buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
      hotHotEntries: [{
        symbol: 'SOUN',
        status: 'hot_hot',
        memeHeatScore: 96,
        marketConfirmationScore: 82,
        marketConfirmationDetails: { tradable: false, halted: false },
      }],
    },
    {
      name: 'candidate is halted',
      buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
      hotHotEntries: [{
        symbol: 'SOUN',
        status: 'hot_hot',
        memeHeatScore: 96,
        marketConfirmationScore: 82,
        marketConfirmationDetails: { tradable: true, halted: true },
        phaseA: { tradableStatus: 'tradable', haltStatus: 'halted', sourceConfirmations: { alpacaAssets: true, nasdaqHalts: false } },
      }],
    },
    {
      name: 'candidate is excluded',
      buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
      hotHotEntries: [{
        symbol: 'SOUN',
        status: 'hot_hot',
        memeHeatScore: 96,
        marketConfirmationScore: 82,
        marketConfirmationDetails: { tradable: true, halted: false, excluded: true },
      }],
    },
    {
      name: 'no matching buy candidate exists',
      buyCandidates: [{ symbol: 'MARA', priorityOverrideSortScore: 100 }],
      hotHotEntries: [{
        symbol: 'SOUN',
        status: 'hot_hot',
        memeHeatScore: 96,
        marketConfirmationScore: 82,
        marketConfirmationDetails: { tradable: true, halted: false },
      }],
    },
  ];

  for (const testCase of cases) {
    const selection = selectHotHotRotationCandidate({
      buyCandidates: testCase.buyCandidates,
      hotHotEntries: testCase.hotHotEntries,
      config,
    });

    assert.equal(selection, null, testCase.name);
  }
});

test('hot slot rotation selects a deterministic eviction candidate and blocks unsafe positions', () => {
  const baseConfig = resolveHotSlotRotationConfig({
    MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
    MEME_ROTATION_REQUIRE_BREAKEVEN_OR_BETTER: 'true',
    MEME_ROTATION_ALLOW_TINY_LOSS: 'false',
    MEME_ROTATION_PROTECT_STRONG_RUNNERS: 'true',
  });
  const permissiveConfig = resolveHotSlotRotationConfig({
    MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
    MEME_ROTATION_REQUIRE_BREAKEVEN_OR_BETTER: 'true',
    MEME_ROTATION_ALLOW_TINY_LOSS: 'true',
    MEME_ROTATION_MAX_ALLOWED_LOSS_DOLLARS: '1',
    MEME_ROTATION_PROTECT_STRONG_RUNNERS: 'true',
  });
  const hotHotCandidate = { heatScore: 94, marketScore: 82, candidate: { symbol: 'SOUN' } };

  const blockedCases = [
    {
      name: 'missing symbol',
      position: {},
      snapshots: {},
      config: baseConfig,
      blockReason: 'rotation_blocked_no_eligible_position',
    },
    {
      name: 'zero quantity',
      position: { symbol: 'MARA', qty: 0, avg_entry_price: 10 },
      snapshots: { MARA: { latestQuote: { p: 10.1, bp: 10.09, ap: 10.11 }, prevDailyBar: { c: 10, v: 100000 } } },
      config: baseConfig,
      blockReason: 'rotation_blocked_no_eligible_position',
    },
    {
      name: 'missing entry price',
      position: { symbol: 'MARA', qty: 10 },
      snapshots: { MARA: { latestQuote: { p: 10.1, bp: 10.09, ap: 10.11 }, prevDailyBar: { c: 10, v: 100000 } } },
      config: baseConfig,
      blockReason: 'rotation_blocked_no_eligible_position',
    },
    {
      name: 'missing current price',
      position: { symbol: 'MARA', qty: 10, avg_entry_price: 10 },
      snapshots: { MARA: {} },
      config: baseConfig,
      blockReason: 'rotation_blocked_no_eligible_position',
    },
    {
      name: 'losing position blocked by default',
      position: { symbol: 'MARA', qty: 10, avg_entry_price: 10 },
      snapshots: { MARA: { latestQuote: { p: 9.7, bp: 9.68, ap: 9.72 }, prevDailyBar: { c: 9.8, v: 100000 } } },
      config: baseConfig,
      blockReason: 'rotation_blocked_eviction_not_breakeven',
    },
    {
      name: 'gross breakeven but net negative after spread and slippage',
      position: { symbol: 'MARA', qty: 10, avg_entry_price: 10 },
      snapshots: { MARA: { latestQuote: { p: 10, bp: 9.7, ap: 10.3 }, prevDailyBar: { c: 10, v: 100000 } } },
      config: baseConfig,
      blockReason: 'rotation_blocked_eviction_not_breakeven',
    },
    {
      name: 'strong runner blocked',
      position: { symbol: 'MARA', qty: 10, avg_entry_price: 10 },
      snapshots: { MARA: { latestQuote: { p: 10.5, bp: 10.48, ap: 10.52 }, prevDailyBar: { c: 10, v: 100000 } } },
      config: baseConfig,
      blockReason: 'rotation_blocked_strong_runner',
    },
    {
      name: 'accelerating position blocked',
      position: { symbol: 'MARA', qty: 10, avg_entry_price: 10 },
      snapshots: { MARA: { latestQuote: { p: 10.3, bp: 10.28, ap: 10.32 }, prevDailyBar: { c: 10, v: 100000 }, minuteBar: { v: 220000 } } },
      config: baseConfig,
      blockReason: 'rotation_blocked_strong_runner',
    },
    {
      name: 'open sell order conflict',
      position: { symbol: 'MARA', qty: 10, avg_entry_price: 10 },
      snapshots: { MARA: { latestQuote: { p: 10.1, bp: 10.09, ap: 10.11 }, prevDailyBar: { c: 10, v: 100000 } } },
      openOrders: [{ symbol: 'MARA', side: 'sell', status: 'new', type: 'limit' }],
      config: baseConfig,
      blockReason: 'rotation_blocked_open_order_conflict',
    },
    {
      name: 'open buy order conflict',
      position: { symbol: 'MARA', qty: 10, avg_entry_price: 10 },
      snapshots: { MARA: { latestQuote: { p: 10.1, bp: 10.09, ap: 10.11 }, prevDailyBar: { c: 10, v: 100000 } } },
      openOrders: [{ symbol: 'MARA', side: 'buy', status: 'new', type: 'limit' }],
      config: baseConfig,
      blockReason: 'rotation_blocked_open_order_conflict',
    },
    {
      name: 'partial-fill conflict',
      position: { symbol: 'MARA', qty: 10, avg_entry_price: 10 },
      snapshots: { MARA: { latestQuote: { p: 10.1, bp: 10.09, ap: 10.11 }, prevDailyBar: { c: 10, v: 100000 } } },
      partialFillSummary: { partial_sells: [{ symbol: 'MARA', remaining_qty: 1, side: 'sell' }] },
      config: baseConfig,
      blockReason: 'rotation_blocked_partial_fill_state',
    },
    {
      name: 'protective order conflict',
      position: { symbol: 'MARA', qty: 10, avg_entry_price: 10 },
      snapshots: { MARA: { latestQuote: { p: 10.1, bp: 10.09, ap: 10.11 }, prevDailyBar: { c: 10, v: 100000 } } },
      openOrders: [{ symbol: 'MARA', side: 'sell', status: 'new', type: 'trailing_stop' }],
      config: baseConfig,
      blockReason: 'rotation_blocked_open_order_conflict',
    },
  ];

  for (const testCase of blockedCases) {
    const evaluation = evaluateRotationPositionCandidate(testCase.position, {
      snapshots: testCase.snapshots,
      openOrders: testCase.openOrders,
      partialFillSummary: testCase.partialFillSummary,
      trailingState: testCase.trailingState,
      hotHotCandidate,
      config: testCase.config,
    });

    assert.equal(evaluation.eligible, false, testCase.name);
    assert.equal(evaluation.blockReason, testCase.blockReason, testCase.name);
    assert(Array.isArray(evaluation.reasonCodes) && evaluation.reasonCodes.length > 0, testCase.name);
  }

  const flatBreakevenRemainsBlocked = evaluateRotationPositionCandidate({
    symbol: 'MARA',
    qty: 10,
    avg_entry_price: 10,
  }, {
    snapshots: {
      MARA: { latestQuote: { p: 10, bp: 10, ap: 10.01 }, prevDailyBar: { c: 10, v: 100000 } },
    },
    hotHotCandidate,
    config: permissiveConfig,
  });
  assert.equal(flatBreakevenRemainsBlocked.eligible, false);
  assert.equal(flatBreakevenRemainsBlocked.blockReason, 'rotation_blocked_eviction_spread_slippage');

  const allowedWeakFlat = evaluateRotationPositionCandidate({
    symbol: 'MARA',
    qty: 10,
    avg_entry_price: 10,
  }, {
    snapshots: {
      MARA: { latestQuote: { p: 10.08, bp: 10.07, ap: 10.09 }, prevDailyBar: { c: 10, v: 100000 } },
    },
    hotHotCandidate,
    config: baseConfig,
  });
  assert.equal(allowedWeakFlat.eligible, true);
  assert.equal(allowedWeakFlat.reasonCodes.includes('rotation_eviction_candidate_selected'), true);
  assert.equal(Number.isFinite(allowedWeakFlat.netPnl), true);

  const tieBreak = selectRotationEvictionCandidate({
    positions: [
      { symbol: 'BBB', qty: 10, avg_entry_price: 10 },
      { symbol: 'AAA', qty: 10, avg_entry_price: 10 },
    ],
    snapshots: {
      AAA: { latestQuote: { p: 10.1, bp: 10.09, ap: 10.11 }, prevDailyBar: { c: 10, v: 100000 } },
      BBB: { latestQuote: { p: 10.1, bp: 10.09, ap: 10.11 }, prevDailyBar: { c: 10, v: 100000 } },
    },
    hotHotCandidate,
    config: baseConfig,
  });
  const tieBreakRepeat = selectRotationEvictionCandidate({
    positions: [
      { symbol: 'BBB', qty: 10, avg_entry_price: 10 },
      { symbol: 'AAA', qty: 10, avg_entry_price: 10 },
    ],
    snapshots: {
      AAA: { latestQuote: { p: 10.1, bp: 10.09, ap: 10.11 }, prevDailyBar: { c: 10, v: 100000 } },
      BBB: { latestQuote: { p: 10.1, bp: 10.09, ap: 10.11 }, prevDailyBar: { c: 10, v: 100000 } },
    },
    hotHotCandidate,
    config: baseConfig,
  });
  assert.equal(tieBreak.candidate.symbol, 'AAA');
  assert.equal(tieBreakRepeat.candidate.symbol, 'AAA');
});

test('hot slot rotation plan covers feature, dependency, broker, account, and empty-eviction blockers', () => {
  const hotHotEntries = [{
    symbol: 'SOUN',
    status: 'hot_hot',
    memeHeatScore: 94,
    marketConfirmationScore: 82,
    marketConfirmationDetails: { tradable: true, halted: false },
    phaseA: { tradableStatus: 'tradable', haltStatus: 'not_halted', sourceConfirmations: { alpacaAssets: true, nasdaqHalts: true } },
    sourceConfirmations: { alpacaAssets: true, nasdaqHalts: true },
  }];

  const disabled = evaluateHotSlotRotationPlan({
    config: resolveHotSlotRotationConfig({ MEME_HOT_SLOT_ROTATION_ENABLED: 'false' }),
  });
  assert.equal(disabled.rotationEligible, false);
  assert.equal(disabled.status, 'off');
  assert.equal(disabled.lastDecision, 'rotation_blocked_feature_disabled');

  const dependencyBlocked = evaluateHotSlotRotationPlan({
    featureState: { status: 'blocked', blocked_reason: 'MEME_PRIORITY_OVERRIDE_ENABLED is off' },
    config: resolveHotSlotRotationConfig({ MEME_HOT_SLOT_ROTATION_ENABLED: 'true' }),
  });
  assert.equal(dependencyBlocked.rotationEligible, false);
  assert.equal(dependencyBlocked.status, 'blocked');
  assert.equal(dependencyBlocked.blockReason, 'MEME_PRIORITY_OVERRIDE_ENABLED is off');

  const brokerUnavailable = evaluateHotSlotRotationPlan({
    config: resolveHotSlotRotationConfig({ MEME_HOT_SLOT_ROTATION_ENABLED: 'true' }),
    brokerState: { available: false, account_available: false, positions_available: true, open_orders_available: true },
  });
  assert.equal(brokerUnavailable.rotationEligible, false);
  assert.equal(brokerUnavailable.status, 'error');
  assert.equal(brokerUnavailable.lastDecision, 'rotation_blocked_broker_reconciliation_failed');

  const accountNotFull = evaluateHotSlotRotationPlan({
    config: resolveHotSlotRotationConfig({ MEME_HOT_SLOT_ROTATION_ENABLED: 'true' }),
    portfolio: { remaining_position_slots: 1 },
    buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
    hotHotEntries,
  });
  assert.equal(accountNotFull.rotationEligible, false);
  assert.equal(accountNotFull.status, 'active');
  assert.equal(accountNotFull.lastDecision, 'rotation_blocked_account_not_full');
  assert.equal(accountNotFull.selectedCandidate?.symbol, 'SOUN');

  const accountFullNoCandidate = evaluateHotSlotRotationPlan({
    config: resolveHotSlotRotationConfig({ MEME_HOT_SLOT_ROTATION_ENABLED: 'true' }),
    portfolio: { remaining_position_slots: 0 },
    buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
    hotHotEntries: [{
      symbol: 'SOUN',
      status: 'shadow',
      memeHeatScore: 94,
      marketConfirmationScore: 82,
      marketConfirmationDetails: { tradable: true, halted: false },
    }],
  });
  assert.equal(accountFullNoCandidate.rotationEligible, false);
  assert.equal(accountFullNoCandidate.lastDecision, 'rotation_blocked_no_eligible_position');
  assert.equal(accountFullNoCandidate.selectedCandidate, null);

  const accountFullNoEviction = evaluateHotSlotRotationPlan({
    config: resolveHotSlotRotationConfig({ MEME_HOT_SLOT_ROTATION_ENABLED: 'true' }),
    portfolio: { remaining_position_slots: 0 },
    buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
    hotHotEntries,
    positions: [{ symbol: 'MARA', qty: 0, avg_entry_price: 10 }],
    snapshots: { MARA: { latestQuote: { p: 9.8, bp: 9.79, ap: 9.81 }, prevDailyBar: { c: 9.9, v: 100000 } } },
  });
  assert.equal(accountFullNoEviction.rotationEligible, false);
  assert.equal(accountFullNoEviction.lastDecision, 'rotation_blocked_no_eligible_position');
  assert.equal(accountFullNoEviction.selectedCandidate?.symbol, 'SOUN');
  assert.equal(accountFullNoEviction.selectedEviction, null);

  const recheckDisabled = evaluateHotSlotRotationPlan({
    config: resolveHotSlotRotationConfig({
      MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
      MEME_ROTATION_RECHECK_AFTER_EXIT: 'false',
    }),
    portfolio: { remaining_position_slots: 0 },
    buyCandidates: [{ symbol: 'SOUN', priorityOverrideSortScore: 100 }],
    hotHotEntries,
  });
  assert.equal(recheckDisabled.rotationEligible, false);
  assert.equal(recheckDisabled.status, 'blocked');
  assert.equal(recheckDisabled.blockReason, 'rotation_blocked_recheck_after_exit_disabled');
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
