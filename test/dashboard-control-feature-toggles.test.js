const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDashboardServer } = require('../src/dashboard-server');

test('dashboard control exposes feature toggles without manual trade controls', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-control-feature-toggles-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });

  const server = createDashboardServer({
    port: 0,
    dashboardDir: path.resolve(process.cwd(), 'dashboard'),
    dataDir,
    env: {
      MEME_MONITOR_ENABLED: 'false',
      MEME_REDDIT_SCANNER_ENABLED: 'false',
      MEME_HOT_LIST_ENABLED: 'false',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      MEME_AUTO_ACTION_ENABLED: 'false',
    },
    fetchImpl: global.fetch,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const html = await fetch(`http://127.0.0.1:${port}/control`).then((response) => response.text());
    assert(html.includes('Enable Meme Monitor'));
    assert(html.includes('Enable Hot Slot Rotation'));
    assert.equal(html.includes('Buy now'), false);
    assert.equal(html.includes('Sell now'), false);
    assert.equal(html.includes('Cancel order'), false);
    assert.equal(html.includes('Liquidate'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
