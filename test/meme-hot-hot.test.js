const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { updateMemeMonitorFeatureState, resolveMemeMonitorStatePath } = require('../src/meme-monitor-state');
const { createMemeMonitorLoop } = require('../src/meme-monitor/meme-monitor-loop');
const { loadDynamicHotList, resolveDynamicHotListPath, saveDynamicHotList } = require('../src/meme-monitor/hot-list-store');
const { resolveMemeEscalationPolicy } = require('../src/meme-monitor/meme-escalation-policy');
const { classifyHotHotCandidate } = require('../src/meme-monitor/hot-hot-classifier');
const { extractMentionsFromRecord } = require('../src/meme-monitor/symbol-extractor');
const { scoreMemeHeat } = require('../src/meme-monitor/meme-heat-score');
const { scoreMarketConfirmation } = require('../src/meme-monitor/market-confirmation-score');

function tempWorkspace() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-hot-hot-'));
  const dataDir = path.join(repoRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  return { repoRoot, dataDir };
}

function enableCoreFeatures({ dataDir, env, hotList = true, dynamicWatchlist = true }) {
  const filePath = resolveMemeMonitorStatePath({ dataDir });
  const features = [
    ['MEME_MONITOR_ENABLED', true],
    ['MEME_REDDIT_SCANNER_ENABLED', true],
    ['MEME_HOT_LIST_ENABLED', hotList],
    ['MEME_DYNAMIC_WATCHLIST_ENABLED', dynamicWatchlist],
  ];
  for (const [featureKey, enabled] of features) {
    updateMemeMonitorFeatureState({
      featureKey,
      enabled,
      env,
      filePath,
      changedBy: 'test',
      source: 'unit-test',
    });
  }
}

test('social-only symbol enters the dynamic hot list but not hot hot', async () => {
  const record = {
    kind: 'post',
    source: 'reddit:wallstreetbets',
    sourceId: 'p1',
    threadId: 'p1',
    author: 'user1',
    createdAt: '2026-06-30T14:00:00.000Z',
    engagement: 15,
    title: 'GME is back and $GME calls are loud',
  };
  const extracted = extractMentionsFromRecord(record, {});
  const heat = scoreMemeHeat(extracted.mentions, {
    generatedAt: '2026-06-30T14:05:00.000Z',
    dynamicMinScore: 30,
    hotCandidateMinScore: 35,
    hotHotMinScore: 45,
  });
  const policy = resolveMemeEscalationPolicy({
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'true',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
    MEME_DYNAMIC_MIN_SCORE: '30',
    MEME_HOT_CANDIDATE_MIN_SCORE: '35',
    MEME_HOT_HOT_MIN_SCORE: '45',
    MEME_MARKET_CONFIRMATION_MIN_SCORE: '30',
  });
  const socialOnly = classifyHotHotCandidate({
    symbol: heat[0].symbol,
    memeHeatScore: heat[0].memeHeatScore,
    marketConfirmation: scoreMarketConfirmation('GME', null, { marketConfirmationMinScore: 30 }),
    policy,
    now: new Date('2026-06-30T14:05:00.000Z'),
  });

  assert.equal(heat[0].status, 'hot_candidate');
  assert.equal(socialOnly.status, 'dynamic_watch');
  assert.equal(socialOnly.marketConfirmationScore, null);
  assert(socialOnly.reasonCodes.includes('market_confirmation_unavailable'));
});

test('market-confirmed symbol enters the hot hot list', async () => {
  const marketConfirmation = scoreMarketConfirmation('SOUN', {
    currentPrice: 23,
    previousClose: 20,
    openPrice: 20.5,
    volume: 2500000,
    averageVolume: 1000000,
    bid: 22.98,
    ask: 23.02,
    tradable: true,
    halted: false,
  }, { marketConfirmationMinScore: 30 });
  const policy = resolveMemeEscalationPolicy({
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'true',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
    MEME_DYNAMIC_MIN_SCORE: '30',
    MEME_HOT_CANDIDATE_MIN_SCORE: '35',
    MEME_HOT_HOT_MIN_SCORE: '45',
    MEME_MARKET_CONFIRMATION_MIN_SCORE: '30',
  });
  const result = classifyHotHotCandidate({
    symbol: 'SOUN',
    memeHeatScore: 91,
    marketConfirmation,
    policy,
    now: new Date('2026-06-30T14:05:00.000Z'),
  });

  assert.equal(result.status, 'hot_hot');
  assert.equal(result.marketConfirmationScore >= 30, true);
  assert(result.reasonCodes.includes('market_confirmation_passed'));
  assert(result.reasonCodes.includes('tradable_confirmed'));
});

test('missing market data keeps candidates on the dynamic list only', async () => {
  const heat = scoreMemeHeat(extractMentionsFromRecord({
    kind: 'post',
    source: 'reddit:wallstreetbets',
    sourceId: 'p3',
    threadId: 'p3',
    author: 'user3',
    createdAt: '2026-06-30T14:02:00.000Z',
    engagement: 11,
    title: '$GME to the moon',
  }, {}).mentions, {
    generatedAt: '2026-06-30T14:05:00.000Z',
    dynamicMinScore: 30,
    hotCandidateMinScore: 35,
    hotHotMinScore: 45,
  });
  const policy = resolveMemeEscalationPolicy({
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'true',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
    MEME_DYNAMIC_MIN_SCORE: '30',
    MEME_HOT_CANDIDATE_MIN_SCORE: '35',
    MEME_HOT_HOT_MIN_SCORE: '45',
    MEME_MARKET_CONFIRMATION_MIN_SCORE: '30',
  });
  const gme = classifyHotHotCandidate({
    symbol: heat[0].symbol,
    memeHeatScore: heat[0].memeHeatScore,
    marketConfirmation: scoreMarketConfirmation('GME', null, { marketConfirmationMinScore: 30 }),
    policy,
    now: new Date('2026-06-30T14:05:00.000Z'),
  });

  assert.equal(heat[0].status, 'hot_candidate');
  assert.equal(gme.status, 'dynamic_watch');
  assert.equal(gme.marketConfirmationScore, null);
  assert(gme.reasonCodes.includes('market_confirmation_unavailable'));
});

test('expired symbols are moved out of the active lists', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'true',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
  };
  enableCoreFeatures({ dataDir, env });
  const hotListPath = resolveDynamicHotListPath({ dataDir });
  saveDynamicHotList({
    generatedAt: '2026-06-30T14:00:00.000Z',
    lastScoredAt: '2026-06-30T14:00:00.000Z',
    mode: 'active',
    source: 'meme-monitor',
    status: 'active',
    enabled: true,
    stale: false,
    dynamicHotList: [{
      symbol: 'OLD',
      status: 'dynamic_watch',
      memeHeatScore: 68,
      marketConfirmationScore: null,
      reasonCodes: ['market_confirmation_unavailable'],
      riskWarnings: ['social_signal_only'],
      expiresAt: '2020-01-01T00:00:00.000Z',
    }],
    hotHotList: [],
    expired: [],
    rejected: [],
  }, { dataDir, filePath: hotListPath, env });

  const loop = createMemeMonitorLoop({ repoRoot, dataDir, env, collector: { collectSources: async () => ({ ok: true, records: [], rejected: [], sources: [] }) } });
  await loop.clearExpiredHotSymbols();
  const hotList = loadDynamicHotList({ dataDir, filePath: hotListPath });

  assert.equal(hotList.dynamicHotList.length, 0);
  assert.equal(hotList.expired.length, 1);
  assert.equal(hotList.expired[0].symbol, 'OLD');
  assert.equal(hotList.expired[0].expired, true);
});

test('thresholds are configurable and the classifier respects them', () => {
  const policy = resolveMemeEscalationPolicy({
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'true',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
    MEME_DYNAMIC_MIN_SCORE: '65',
    MEME_HOT_CANDIDATE_MIN_SCORE: '80',
    MEME_HOT_HOT_MIN_SCORE: '95',
    MEME_MARKET_CONFIRMATION_MIN_SCORE: '88',
  });
  const result = classifyHotHotCandidate({
    symbol: 'TEST',
    memeHeatScore: 92,
    marketConfirmation: { available: true, marketConfirmationScore: 86, reasonCodes: ['tradable_confirmed'] },
    policy,
    now: new Date('2026-06-30T14:00:00.000Z'),
  });
  assert.equal(policy.dynamicMinScore, 65);
  assert.equal(policy.hotHotMinScore, 95);
  assert.equal(result.status, 'hot_candidate');
  assert.equal(result.marketConfirmationScore, 86);
});

test('feature flags can disable scoring output', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'false',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
    REDDIT_CLIENT_ID: 'client',
    REDDIT_CLIENT_SECRET: 'secret',
  };
  enableCoreFeatures({ dataDir, env, hotList: false, dynamicWatchlist: false });
  const loop = createMemeMonitorLoop({
    repoRoot,
    dataDir,
    env,
    collector: {
      collectSources: async () => ({
        ok: true,
        records: [{
          kind: 'post',
          source: 'reddit:wallstreetbets',
          sourceId: 'p4',
          threadId: 'p4',
          author: 'user4',
          createdAt: '2026-06-30T14:03:00.000Z',
          engagement: 10,
          title: 'GME again',
        }],
        rejected: [],
        sources: ['wallstreetbets'],
      }),
    },
  });

  const status = await loop.refresh({ forceWrite: true });
  const hotList = loadDynamicHotList({ dataDir, filePath: resolveDynamicHotListPath({ dataDir }) });
  assert.equal(status.hotList.status, 'off');
  assert.equal(status.hotHotScoring.status, 'off');
  assert.equal(hotList.status, 'off');
  assert.equal(hotList.dynamicHotList.length, 0);
});
