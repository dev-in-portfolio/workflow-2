const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadDynamicHotList, saveDynamicHotList, resolveDynamicHotListPath } = require('../src/meme-monitor/hot-list-store');

test('hot list store saves and loads the dynamic hot list payload', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-list-store-'));
  const dataDir = path.join(tempRoot, 'data');
  const filePath = resolveDynamicHotListPath({ dataDir });
  const payload = saveDynamicHotList({
    dynamicHotList: [{ symbol: 'GME', status: 'dynamic_watch', memeHeatScore: 88 }],
    hotHotList: [],
    mode: 'shadow',
  }, { dataDir });

  assert.equal(payload.summary.dynamicCount, 1);
  const loaded = loadDynamicHotList({ dataDir, filePath });
  assert.equal(loaded.symbols[0].symbol, 'GME');
});

