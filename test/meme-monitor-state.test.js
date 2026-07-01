const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadMemeMonitorState,
  updateMemeMonitorFeatureState,
  resolveMemeMonitorStatePath,
} = require('../src/meme-monitor-state');

function tempWorkspace() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-monitor-state-'));
  const dataDir = path.join(repoRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  return { repoRoot, dataDir };
}

test('meme monitor defaults stay off with dependency warnings summarized separately', () => {
  const { dataDir } = tempWorkspace();
  const state = loadMemeMonitorState({
    env: {
      MEME_MONITOR_ENABLED: 'false',
      MEME_REDDIT_SCANNER_ENABLED: 'false',
      MEME_HOT_LIST_ENABLED: 'false',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      MEME_AUTO_ACTION_ENABLED: 'false',
    },
    filePath: resolveMemeMonitorStatePath({ dataDir }),
  });

  assert.equal(state.features.MEME_MONITOR_ENABLED.status, 'off');
  assert.equal(state.features.MEME_REDDIT_SCANNER_ENABLED.status, 'off');
  assert.equal(state.features.MEME_HOT_LIST_ENABLED.status, 'off');
  assert.equal(state.features.MEME_DYNAMIC_WATCHLIST_ENABLED.status, 'off');
  assert.equal(state.features.MEME_PRIORITY_OVERRIDE_ENABLED.status, 'off');
  assert.equal(state.features.MEME_HOT_SLOT_ROTATION_ENABLED.status, 'off');
  assert.equal(state.features.MEME_AUTO_ACTION_ENABLED.status, 'off');
  assert.equal(state.features.MEME_SOURCE_REDDIT_ENABLED.status, 'off');
  assert.equal(state.features.MEME_SOURCE_ALPACA_MARKET_ENABLED.status, 'off');
  assert.equal(state.features.MEME_SOURCE_ALPACA_ASSETS_ENABLED.status, 'off');
  assert.equal(state.features.MEME_SOURCE_NASDAQ_HALTS_ENABLED.status, 'off');
  assert.equal(state.features.MEME_SOURCE_SEC_EDGAR_ENABLED.status, 'off');
  assert.equal(state.features.MEME_SOURCE_STOCKTWITS_ENABLED.status, 'off');
  assert.equal(state.features.MEME_SOURCE_POLYGON_ENABLED.status, 'off');
  assert.equal(state.features.MEME_SOURCE_ALPHA_VANTAGE_ENABLED.status, 'off');
  assert.deepEqual(state.summary.blocked_features, []);
  assert.deepEqual(state.summary.warnings, []);
});

test('child feature cannot enable while its parent is off', () => {
  const { dataDir } = tempWorkspace();
  const filePath = resolveMemeMonitorStatePath({ dataDir });
  const result = updateMemeMonitorFeatureState({
    featureKey: 'MEME_REDDIT_SCANNER_ENABLED',
    enabled: true,
    env: {
      MEME_MONITOR_ENABLED: 'false',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
    },
    filePath,
    changedBy: 'test',
    source: 'unit-test',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'dependency_blocked');
  assert.match(result.blocked_reason || '', /MEME_MONITOR_ENABLED/);
});

test('runtime toggle changes the state file without touching .env.local', () => {
  const { dataDir, repoRoot } = tempWorkspace();
  const envLocalPath = path.join(repoRoot, '.env.local');
  const before = 'MEME_MONITOR_ENABLED=false\n';
  fs.writeFileSync(envLocalPath, before, 'utf8');
  const filePath = resolveMemeMonitorStatePath({ dataDir });

  const result = updateMemeMonitorFeatureState({
    featureKey: 'MEME_MONITOR_ENABLED',
    enabled: true,
    env: {
      MEME_MONITOR_ENABLED: 'true',
    },
    filePath,
    changedBy: 'test',
    source: 'unit-test',
    reason: 'turn on for test',
  });

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(envLocalPath, 'utf8'), before);
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(stored.features.MEME_MONITOR_ENABLED.runtime, true);
});

test('display runtime toggles can be enabled without config allowment', () => {
  const { dataDir } = tempWorkspace();
  const filePath = resolveMemeMonitorStatePath({ dataDir });

  const result = updateMemeMonitorFeatureState({
    featureKey: 'MEME_MONITOR_ENABLED',
    enabled: true,
    env: {
      MEME_MONITOR_ENABLED: 'false',
    },
    filePath,
    changedBy: 'test',
    source: 'unit-test',
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.features.MEME_MONITOR_ENABLED.status, 'active');
  assert.equal(result.state.features.MEME_MONITOR_ENABLED.effective, true);
});

test('two-key meme toggles still require config allowment', () => {
  const { dataDir } = tempWorkspace();
  const filePath = resolveMemeMonitorStatePath({ dataDir });

  const result = updateMemeMonitorFeatureState({
    featureKey: 'MEME_DYNAMIC_WATCHLIST_ENABLED',
    enabled: true,
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
    },
    filePath,
    changedBy: 'test',
    source: 'unit-test',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'feature_disabled_in_config');
});

test('meme auto action remains locked', () => {
  const { dataDir } = tempWorkspace();
  const filePath = resolveMemeMonitorStatePath({ dataDir });

  const result = updateMemeMonitorFeatureState({
    featureKey: 'MEME_AUTO_ACTION_ENABLED',
    enabled: true,
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'true',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'true',
      MEME_AUTO_ACTION_ENABLED: 'false',
    },
    filePath,
    changedBy: 'test',
    source: 'unit-test',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'feature_locked');
});

test('source toggles can be enabled safely without modifying env files', () => {
  const { dataDir, repoRoot } = tempWorkspace();
  const envLocalPath = path.join(repoRoot, '.env.local');
  const before = 'MEME_MONITOR_ENABLED=false\n';
  fs.writeFileSync(envLocalPath, before, 'utf8');
  const filePath = resolveMemeMonitorStatePath({ dataDir });

  const result = updateMemeMonitorFeatureState({
    featureKey: 'MEME_SOURCE_REDDIT_ENABLED',
    enabled: true,
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_SOURCE_REDDIT_ENABLED: 'false',
    },
    filePath,
    changedBy: 'test',
    source: 'unit-test',
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.features.MEME_SOURCE_REDDIT_ENABLED.status, 'missing_credentials');
  assert.equal(result.state.features.MEME_SOURCE_REDDIT_ENABLED.runtime, true);
  assert.equal(result.state.features.MEME_SOURCE_REDDIT_ENABLED.configured, false);
  assert.equal(fs.readFileSync(envLocalPath, 'utf8'), before);
});

test('phase B source toggles can be enabled safely without modifying env files', () => {
  const { dataDir, repoRoot } = tempWorkspace();
  const envLocalPath = path.join(repoRoot, '.env.local');
  const before = 'MEME_MONITOR_ENABLED=false\n';
  fs.writeFileSync(envLocalPath, before, 'utf8');
  const filePath = resolveMemeMonitorStatePath({ dataDir });

  const result = updateMemeMonitorFeatureState({
    featureKey: 'MEME_SOURCE_STOCKTWITS_ENABLED',
    enabled: true,
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_SOURCE_STOCKTWITS_ENABLED: 'false',
    },
    filePath,
    changedBy: 'test',
    source: 'unit-test',
  });

  assert.equal(result.ok, true);
  assert.equal(result.state.features.MEME_SOURCE_STOCKTWITS_ENABLED.status, 'missing_credentials');
  assert.equal(result.state.features.MEME_SOURCE_STOCKTWITS_ENABLED.runtime, true);
  assert.equal(fs.readFileSync(envLocalPath, 'utf8'), before);
});
