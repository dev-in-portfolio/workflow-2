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
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state', 'scanner-runtime.json'), JSON.stringify({
    updated_at: '2026-07-02T20:20:37.728Z',
    last_scan_time: '2026-07-02T20:20:37.728Z',
    candidate_count: 0,
    approved_count: 0,
    rejected_count: 0,
    preview_candidate_count: 2,
    market_closed_execution_block: true,
    scanner_symbol_source: 'dynamic',
    active_source_count: 2,
    approved_source_count: 1,
    source_counts: {
      approved_source_count: 1,
      regular_watch_source_count: 1,
      regular_watch_movers_source_count: 1,
      dynamic_hot_source_count: 1,
      hot_hot_source_count: 1,
      dynamic_source_count: 2,
      active_source_count: 2,
    },
    preview_reason_codes: ['MARKET_CLOSED_FOR_STOCKS'],
    preview_candidates: [
      {
        symbol: 'MARA',
        source: 'scanner',
        status: 'preview_only',
        execution_blocked: true,
        reason_codes: ['MARKET_CLOSED_FOR_STOCKS'],
      },
    ],
    top_preview_candidates: [
      {
        symbol: 'MARA',
        source: 'scanner',
        status: 'preview_only',
        execution_blocked: true,
        reason_codes: ['MARKET_CLOSED_FOR_STOCKS'],
      },
    ],
  }));

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
  assert.equal(snapshot.watch.scannerSource.mode, 'dynamic');
  assert.equal(snapshot.watch.scannerSource.activeSymbolCount, 2);
  assert.equal(snapshot.watch.scannerPreview.previewCandidateCount, 2);
  assert.equal(snapshot.watch.scannerPreview.marketClosedExecutionBlock, true);
});
