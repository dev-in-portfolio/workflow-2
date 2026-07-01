const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  updateMemeMonitorFeatureState,
  resolveMemeMonitorStatePath,
} = require('../src/meme-monitor-state');
const { createMemeMonitorLoop } = require('../src/meme-monitor/meme-monitor-loop');
const { loadDynamicHotList, resolveDynamicHotListPath } = require('../src/meme-monitor/hot-list-store');

function tempWorkspace() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-loop-'));
  const dataDir = path.join(repoRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  return { repoRoot, dataDir };
}

function enableMemeFeatures({ dataDir, env }) {
  const filePath = resolveMemeMonitorStatePath({ dataDir });
  const featureKeys = [
    'MEME_MONITOR_ENABLED',
    'MEME_REDDIT_SCANNER_ENABLED',
    'MEME_HOT_LIST_ENABLED',
    'MEME_DYNAMIC_WATCHLIST_ENABLED',
  ];
  for (const featureKey of featureKeys) {
    if (!env?.[featureKey]) continue;
    updateMemeMonitorFeatureState({
      featureKey,
      enabled: true,
      env,
      filePath,
      changedBy: 'test',
      source: 'unit-test',
    });
  }
}

test('meme monitor loop stays inactive when the master flag is off', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const collectorCalls = [];
  const loop = createMemeMonitorLoop({
    repoRoot,
    dataDir,
    env: {
      MEME_MONITOR_ENABLED: 'false',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
    },
    collector: {
      collectSources: async () => {
        collectorCalls.push('called');
        return { ok: true, records: [], rejected: [], sources: ['wallstreetbets'] };
      },
    },
  });

  const status = await loop.refresh();
  assert.equal(collectorCalls.length, 0);
  assert.equal(status.redditScanner.status, 'off');
});

test('meme monitor loop stays inactive when the reddit flag is off', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const collectorCalls = [];
  const loop = createMemeMonitorLoop({
    repoRoot,
    dataDir,
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'false',
      MEME_HOT_LIST_ENABLED: 'true',
    },
    collector: {
      collectSources: async () => {
        collectorCalls.push('called');
        return { ok: true, records: [], rejected: [], sources: ['wallstreetbets'] };
      },
    },
  });

  const status = await loop.refresh();
  assert.equal(collectorCalls.length, 0);
  assert.equal(status.redditScanner.status, 'off');
});

test('meme monitor loop writes a shadow hot list with reasons and expiration', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'true',
    REDDIT_CLIENT_ID: 'test-client',
    REDDIT_CLIENT_SECRET: 'test-secret',
    REDDIT_USER_AGENT: 'workflow-2-meme-monitor-test',
    MEME_DYNAMIC_MIN_SCORE: '50',
    MEME_HOT_CANDIDATE_MIN_SCORE: '65',
    MEME_HOT_HOT_MIN_SCORE: '80',
  };
  enableMemeFeatures({ dataDir, env });
  const loop = createMemeMonitorLoop({
    repoRoot,
    dataDir,
    env,
    collector: {
      collectSources: async () => ({
        ok: true,
        status: 'ok',
        sources: ['wallstreetbets', 'stocks'],
        records: [
          {
            kind: 'post',
            source: 'reddit:wallstreetbets',
            sourceId: 'p1',
            threadId: 'p1',
            author: 'user1',
            createdAt: '2026-06-30T14:00:00.000Z',
            engagement: 12,
            title: 'Buying $GME and SOUN today',
            body: '',
          },
          {
            kind: 'comment',
            source: 'reddit:stocks',
            sourceId: 'c1',
            threadId: 'p1',
            author: 'user2',
            createdAt: '2026-06-30T14:02:00.000Z',
            engagement: 5,
            body: 'GME calls and SOUN momentum',
          },
          {
            kind: 'comment',
            source: 'reddit:wallstreetbets',
            sourceId: 'c2',
            threadId: 'p2',
            author: 'user3',
            createdAt: '2026-06-30T14:03:00.000Z',
            engagement: 4,
            body: 'GameStop to the moon',
          },
        ],
        rejected: [{ token: 'IT', reason: 'common_word_rejected' }],
      }),
    },
  });

  const status = await loop.refresh({ forceWrite: true });
  const hotListPath = resolveDynamicHotListPath({ dataDir });
  const hotList = loadDynamicHotList({ dataDir, filePath: hotListPath });

  assert.equal(status.redditScanner.status, 'shadow');
  assert.equal(status.redditScanner.symbolsDetected, 6);
  assert.equal(hotList.mode, 'shadow');
  assert.equal(hotList.source, 'meme-monitor');
  assert.equal(hotList.symbols.length > 0, true);
  assert.equal(hotList.summary.dynamicCount, 1);
  assert.equal(hotList.summary.hotHotCount, 0);
  assert.match(hotList.symbols[0].expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.notEqual(hotList.symbols[0].status, 'ignore');
  assert(hotList.symbols[0].reasonCodes.includes('multi_source_confirmation'));
  assert(hotList.symbols[0].reasonCodes.includes('engagement_confirmed'));
  assert(hotList.symbols[0].reasonCodes.includes('market_confirmation_unavailable'));
});

test('meme monitor loop reports an active hot list when dynamic watchlist is effective', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'true',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
    REDDIT_CLIENT_ID: 'test-client',
    REDDIT_CLIENT_SECRET: 'test-secret',
    REDDIT_USER_AGENT: 'workflow-2-meme-monitor-test',
    MEME_DYNAMIC_MIN_SCORE: '50',
    MEME_HOT_CANDIDATE_MIN_SCORE: '65',
    MEME_HOT_HOT_MIN_SCORE: '80',
  };
  enableMemeFeatures({ dataDir, env });
  const loop = createMemeMonitorLoop({
    repoRoot,
    dataDir,
    env,
    collector: {
      collectSources: async () => ({
        ok: true,
        status: 'ok',
        sources: ['wallstreetbets'],
        records: [{
          kind: 'post',
          source: 'reddit:wallstreetbets',
          sourceId: 'p1',
          threadId: 'p1',
          author: 'user1',
          createdAt: '2026-06-30T14:00:00.000Z',
          engagement: 12,
          title: 'Buying $GME and SOUN today',
          body: '',
        }],
        rejected: [],
      }),
    },
  });

  const status = await loop.refresh({ forceWrite: true });
  const hotList = loadDynamicHotList({ dataDir, filePath: resolveDynamicHotListPath({ dataDir }) });

  assert.equal(status.redditScanner.status, 'active');
  assert.equal(status.hotList.status, 'active');
  assert.equal(status.hotHotScoring.status, 'active');
  assert.equal(hotList.mode, 'active');
  assert.equal(hotList.status, 'active');
});

test('meme monitor loop preserves source status metadata and source contributors', async () => {
  const { repoRoot, dataDir } = tempWorkspace();
  const env = {
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'true',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
    REDDIT_CLIENT_ID: 'test-client',
    REDDIT_CLIENT_SECRET: 'test-secret',
    REDDIT_USER_AGENT: 'workflow-2-meme-monitor-test',
    MEME_DYNAMIC_MIN_SCORE: '50',
    MEME_HOT_CANDIDATE_MIN_SCORE: '65',
    MEME_HOT_HOT_MIN_SCORE: '80',
  };
  enableMemeFeatures({ dataDir, env });
  const loop = createMemeMonitorLoop({
    repoRoot,
    dataDir,
    env,
    collector: {
      collectSources: async () => ({
        ok: true,
        status: 'ok',
        sources: [
          { source: 'wallstreetbets', tier: 'tier_1', status: 'active', symbolsDetected: 1, rejectedTokens: 0 },
          { source: 'stocks', tier: 'tier_2', status: 'inactive', blockedReason: 'source_not_found_or_inaccessible', lastError: 'Unable to validate subreddit', symbolsDetected: 0, rejectedTokens: 0 },
        ],
        records: [
          {
            kind: 'post',
            source: 'reddit:wallstreetbets',
            sourceMeta: { source: 'wallstreetbets', tier: 'tier_1', weight: 1.35, status: 'active' },
            sourceId: 'p1',
            threadId: 'p1',
            author: 'user1',
            createdAt: '2026-06-30T14:00:00.000Z',
            engagement: 15,
            title: 'GME and SOUN are moving',
            body: '',
          },
          {
            kind: 'comment',
            source: 'reddit:stocks',
            sourceMeta: { source: 'stocks', tier: 'tier_2', weight: 1.0, status: 'inactive' },
            sourceId: 'c1',
            threadId: 'p1',
            author: 'user2',
            createdAt: '2026-06-30T14:02:00.000Z',
            engagement: 5,
            body: 'GME still looks strong',
          },
        ],
        rejected: [],
      }),
    },
  });

  const status = await loop.refresh({ forceWrite: true });
  const hotListPath = resolveDynamicHotListPath({ dataDir });
  const hotList = loadDynamicHotList({ dataDir, filePath: hotListPath });

  assert.equal(status.redditScanner.sources.find((entry) => entry.source === 'wallstreetbets')?.status, 'active');
  assert.equal(status.redditScanner.sources.find((entry) => entry.source === 'stocks')?.status, 'inactive');
  assert.equal(hotList.symbols[0].sources.includes('wallstreetbets (tier_1)'), true);
  assert.equal(hotList.symbols[0].sourceProfile?.sources?.some((entry) => entry.source.includes('wallstreetbets')), true);
  assert.equal(hotList.symbols[0].sourceProfile?.tierCounts?.tier_1 > 0, true);
});
