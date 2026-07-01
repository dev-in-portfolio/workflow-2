const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveMemeWatchlistAttention, rankScannerBuyCandidates } = require('../src/stock-scanner');
const { resolveMemeMonitorStatePath, saveMemeMonitorState, updateMemeMonitorFeatureState } = require('../src/meme-monitor-state');
const { resolveDynamicHotListPath, saveDynamicHotList } = require('../src/meme-monitor/hot-list-store');
const { evaluateHotSlotRotationPlan, resolveHotSlotRotationConfig } = require('../src/hot-slot-rotation');
const { evaluateRegularWatchState } = require('../src/regular-watch/regular-watch-feature-state');

function makeTempDataDir(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  return { tempRoot, dataDir };
}

test('shadow-only meme sources stay visible but do not enter scanner influence paths', () => {
  const { dataDir } = makeTempDataDir('shadow-only-meme-');
  const memeMonitorStatePath = resolveMemeMonitorStatePath({ dataDir });
  const dynamicHotListPath = resolveDynamicHotListPath({ dataDir });

  saveMemeMonitorState({
    features: {
      MEME_MONITOR_ENABLED: { runtime: true },
      MEME_REDDIT_SCANNER_ENABLED: { runtime: true },
      MEME_HOT_LIST_ENABLED: { runtime: true },
      MEME_DYNAMIC_WATCHLIST_ENABLED: { runtime: true },
      MEME_PRIORITY_OVERRIDE_ENABLED: { runtime: true },
      MEME_HOT_SLOT_ROTATION_ENABLED: { runtime: true },
    },
  }, { dataDir });

  saveDynamicHotList({
    enabled: true,
    status: 'active',
    generatedAt: '2026-06-30T14:05:00.000Z',
    dynamicHotList: [
      { symbol: 'GME', status: 'dynamic_watch' },
      { symbol: 'AMC', status: 'hot_hot', memeHeatScore: 96, marketConfirmationScore: 84 },
    ],
    hotHotList: [
      { symbol: 'SOUN', status: 'hot_hot', memeHeatScore: 95, marketConfirmationScore: 83 },
    ],
  }, { dataDir, now: new Date('2026-06-30T14:05:00.000Z') });

  const attention = resolveMemeWatchlistAttention({
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
    },
    dataDir,
    memeMonitorStatePath,
    dynamicHotListPath,
    approvedSymbols: ['SPCX', 'NVDA'],
    currentDate: new Date('2026-06-30T14:05:00.000Z'),
  });

  assert.deepEqual(new Set(attention.attentionSymbols), new Set(['SPCX', 'NVDA']));
  assert.equal(attention.dynamicEnabled, false);
  assert.equal(attention.priorityEnabled, false);
  assert.equal(attention.dynamicWatchlistSymbols.size, 0);
  assert.equal(attention.priorityOverrideSymbols.size, 0);

  const ranked = rankScannerBuyCandidates([
    { symbol: 'NVDA', rankScore: 40 },
    { symbol: 'GME', rankScore: 99 },
    { symbol: 'SPCX', rankScore: 50 },
  ], {
    priorityOverrideSymbols: attention.priorityOverrideSymbols,
    priorityOverrideBonus: attention.priorityOverrideBonus,
  });

  assert.deepEqual(ranked.map((candidate) => candidate.symbol), ['GME', 'SPCX', 'NVDA']);
});

test('shadow-only regular watch and hot-slot rotation flags remain ineffective without config allowment', () => {
  const regularWatchState = evaluateRegularWatchState({
    features: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: { runtime: true },
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: { runtime: true },
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: { runtime: true },
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: { runtime: true },
      REGULAR_WATCH_POSITION_AWARENESS_ENABLED: { runtime: true },
    },
  }, {
    env: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'false',
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: 'false',
      REGULAR_WATCH_POSITION_AWARENESS_ENABLED: 'false',
    },
  });

  assert.equal(regularWatchState.features.REGULAR_WATCH_SCANNER_RANKING_ENABLED.status, 'blocked');
  assert.equal(regularWatchState.features.REGULAR_WATCH_SCANNER_RANKING_ENABLED.effective, false);
  assert.equal(regularWatchState.features.REGULAR_WATCH_POSITION_AWARENESS_ENABLED.status, 'blocked');
  assert.equal(regularWatchState.features.REGULAR_WATCH_POSITION_AWARENESS_ENABLED.effective, false);

  const hotSlotRotationPlan = evaluateHotSlotRotationPlan({
    featureState: { status: 'shadow', configured: true, runtime: false, effective: false },
    config: resolveHotSlotRotationConfig({ MEME_HOT_SLOT_ROTATION_ENABLED: 'false' }),
    buyCandidates: [{
      symbol: 'SOUN',
      rankScore: 95,
      priorityOverrideSortScore: 1095,
    }],
    hotHotEntries: [{
      symbol: 'SOUN',
      status: 'hot_hot',
      memeHeatScore: 96,
      marketConfirmationScore: 84,
    }],
    portfolio: {
      open_positions_count: 2,
      remaining_position_slots: 0,
    },
  });

  assert.equal(hotSlotRotationPlan.status, 'off');
  assert.equal(hotSlotRotationPlan.lastDecision, 'rotation_blocked_feature_disabled');
  assert.equal(hotSlotRotationPlan.rotationEligible, false);
});

test('shadow-only auto action stays locked', () => {
  const result = updateMemeMonitorFeatureState({
    featureKey: 'MEME_AUTO_ACTION_ENABLED',
    enabled: true,
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      MEME_AUTO_ACTION_ENABLED: 'false',
    },
    repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-only-auto-action-')),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'feature_locked');
  assert.match(result.message, /locked/i);
});
