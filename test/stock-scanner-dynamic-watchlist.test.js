const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveMemeWatchlistAttention } = require('../src/stock-scanner');
const { resolveMemeMonitorStatePath, saveMemeMonitorState } = require('../src/meme-monitor-state');
const { resolveDynamicHotListPath, saveDynamicHotList } = require('../src/meme-monitor/hot-list-store');

test('stock scanner includes dynamic watchlist symbols only when the feature is effective', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-scanner-watchlist-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  const memeMonitorStatePath = resolveMemeMonitorStatePath({ dataDir });
  const dynamicHotListPath = resolveDynamicHotListPath({ dataDir });
  saveMemeMonitorState({
    features: {
      MEME_MONITOR_ENABLED: { runtime: true },
      MEME_REDDIT_SCANNER_ENABLED: { runtime: true },
      MEME_HOT_LIST_ENABLED: { runtime: true },
      MEME_DYNAMIC_WATCHLIST_ENABLED: { runtime: true },
      MEME_PRIORITY_OVERRIDE_ENABLED: { runtime: false },
    },
  }, { dataDir });
  saveDynamicHotList({
    enabled: true,
    status: 'active',
    dynamicHotList: [{ symbol: 'GME', status: 'dynamic_watch' }],
    hotHotList: [],
    generatedAt: '2026-06-30T14:05:00.000Z',
  }, { dataDir, now: new Date('2026-06-30T14:05:00.000Z') });

  const active = resolveMemeWatchlistAttention({
    env: {
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_MONITOR_ENABLED: 'true',
    },
    dataDir,
    memeMonitorStatePath,
    dynamicHotListPath,
    approvedSymbols: ['SPCX'],
    currentDate: new Date('2026-06-30T14:05:00.000Z'),
  });

  assert(active.attentionSymbols.includes('GME'));
  assert(active.dynamicWatchlistSymbols.has('GME'));
  assert.equal(active.priorityOverrideSymbols.has('GME'), false);
});
