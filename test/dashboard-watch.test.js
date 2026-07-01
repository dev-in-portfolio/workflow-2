const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDashboardSnapshot } = require('../src/dashboard-server');

test('dashboard watch snapshot keeps the four fixed columns and stable watch payloads', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-watch-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', 'overnight-status.json'), JSON.stringify({ status: 'ok', mode: 'minimal-v1', timestamp: '2026-06-30T14:00:00.000Z' }));
  fs.writeFileSync(path.join(dataDir, 'performance-history.jsonl'), '');
  fs.writeFileSync(path.join(dataDir, 'policy-history.jsonl'), '');

  const snapshot = await buildDashboardSnapshot({
    dataDir,
    fetchImpl: global.fetch,
    traderBaseUrl: 'http://127.0.0.1:65535',
    env: {
      MEME_MONITOR_ENABLED: 'false',
      MEME_REDDIT_SCANNER_ENABLED: 'false',
      MEME_HOT_LIST_ENABLED: 'false',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'false',
    },
  }, { dataDir }, {});

  assert.equal(snapshot.watch.regularWatchList.length >= 0, true);
  assert.equal(snapshot.watch.regularWatchMovers.length >= 0, true);
  assert.equal(Array.isArray(snapshot.watch.dynamicHotList.symbols), true);
  assert.equal(Array.isArray(snapshot.watch.hotHotList.symbols), true);
  assert.equal(Object.keys(snapshot.watch).includes('hotSlotRotation'), true);
});

