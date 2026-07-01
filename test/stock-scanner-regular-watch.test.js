const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMemeWatchlistAttention } = require('../src/stock-scanner');

test('stock scanner keeps regular watch ranking isolated from meme watch features', () => {
  const active = resolveMemeWatchlistAttention({
    env: {
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_LIST_ENABLED: 'false',
    },
    memeMonitorState: {
      features: {
        MEME_DYNAMIC_WATCHLIST_ENABLED: { effective: false },
        MEME_PRIORITY_OVERRIDE_ENABLED: { effective: false },
      },
    },
    approvedSymbols: ['AAA'],
  });

  assert.equal(active.dynamicEnabled, false);
  assert.equal(active.priorityEnabled, false);
  assert(active.attentionSymbols.includes('AAA'));
});
