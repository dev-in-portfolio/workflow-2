const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadRegularWatchState,
  resolveRegularWatchStatePath,
  updateRegularWatchFeatureState,
} = require('../src/regular-watch/regular-watch-feature-state');
const { resolveRegularWatchSourceRuntime } = require('../src/regular-watch/regular-watch-source-runner');
const {
  loadRegularWatchStatus,
  resolveRegularWatchStatusPath,
  refreshRegularWatchStatus,
  resetRegularWatchRuntimeState,
  clearRegularWatchErrors,
  saveRegularWatchStatus,
} = require('../src/regular-watch/regular-watch-status');

function tempWorkspace() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'regular-watch-'));
  const dataDir = path.join(repoRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  return { repoRoot, dataDir };
}

test('regular watch defaults stay off with safe status placeholders', () => {
  const { dataDir } = tempWorkspace();
  const state = loadRegularWatchState({
    env: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'false',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'false',
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'false',
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: 'false',
      REGULAR_WATCH_POSITION_AWARENESS_ENABLED: 'false',
    },
    filePath: resolveRegularWatchStatePath({ dataDir }),
  });
  const status = loadRegularWatchStatus({ dataDir, filePath: resolveRegularWatchStatusPath({ dataDir }) });

  assert.equal(state.features.REGULAR_WATCH_INTELLIGENCE_ENABLED.status, 'off');
  assert.equal(state.features.REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED.status, 'off');
  assert.equal(state.features.REGULAR_WATCH_PRIORITY_SCORING_ENABLED.status, 'off');
  assert.equal(state.features.REGULAR_WATCH_SCANNER_RANKING_ENABLED.status, 'off');
  assert.equal(state.features.REGULAR_WATCH_POSITION_AWARENESS_ENABLED.status, 'off');
  assert.equal(status.status, 'disabled');
  assert.equal(status.stale, true);
  assert.deepEqual(status.regularWatchList, []);
  assert.deepEqual(status.regularWatchMovers, []);
});

test('regular watch child features cannot enable while the master is off', () => {
  const { dataDir } = tempWorkspace();
  const filePath = resolveRegularWatchStatePath({ dataDir });
  const result = updateRegularWatchFeatureState({
    featureKey: 'REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED',
    enabled: true,
    env: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'false',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
    },
    filePath,
    changedBy: 'test',
    source: 'unit-test',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'dependency_blocked');
});

test('regular watch scanner ranking cannot enable while priority scoring is off', () => {
  const { dataDir } = tempWorkspace();
  const filePath = resolveRegularWatchStatePath({ dataDir });
  const result = updateRegularWatchFeatureState({
    featureKey: 'REGULAR_WATCH_SCANNER_RANKING_ENABLED',
    enabled: true,
    env: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'false',
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: 'true',
    },
    filePath,
    changedBy: 'test',
    source: 'unit-test',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'dependency_blocked');
});

test('regular watch scanner ranking still requires config allowment', () => {
  const { dataDir } = tempWorkspace();
  const filePath = resolveRegularWatchStatePath({ dataDir });
  const result = updateRegularWatchFeatureState({
    featureKey: 'REGULAR_WATCH_SCANNER_RANKING_ENABLED',
    enabled: true,
    env: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'true',
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: 'false',
    },
    filePath,
    changedBy: 'test',
    source: 'unit-test',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'feature_disabled_in_config');
});

test('regular watch two-key features only become active when effective', () => {
  const runtimeState = {
    features: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: { effective: true, runtime: true },
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: { effective: false, runtime: true },
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: { effective: false, runtime: true },
      REGULAR_WATCH_POSITION_AWARENESS_ENABLED: { effective: false, runtime: true },
    },
  };
  const runtime = resolveRegularWatchSourceRuntime({
    REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
    REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'true',
    REGULAR_WATCH_SCANNER_RANKING_ENABLED: 'true',
    REGULAR_WATCH_POSITION_AWARENESS_ENABLED: 'true',
  }, runtimeState);

  assert.equal(runtime.master, true);
  assert.equal(runtime.priorityScoring, false);
  assert.equal(runtime.scannerRanking, false);
  assert.equal(runtime.positionAwareness, false);
});

test('regular watch runtime state does not rewrite .env.local', () => {
  const { dataDir, repoRoot } = tempWorkspace();
  const envLocalPath = path.join(repoRoot, '.env.local');
  const before = 'REGULAR_WATCH_INTELLIGENCE_ENABLED=false\n';
  fs.writeFileSync(envLocalPath, before, 'utf8');
  const filePath = resolveRegularWatchStatePath({ dataDir });

  const result = updateRegularWatchFeatureState({
    featureKey: 'REGULAR_WATCH_INTELLIGENCE_ENABLED',
    enabled: true,
    env: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
    },
    filePath,
    changedBy: 'test',
    source: 'unit-test',
  });

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(envLocalPath, 'utf8'), before);
});

test('regular watch status refresh and reset stay safe', () => {
  const { dataDir } = tempWorkspace();
  const filePath = resolveRegularWatchStatusPath({ dataDir });
  const featureFilePath = resolveRegularWatchStatePath({ dataDir });
  updateRegularWatchFeatureState({
    featureKey: 'REGULAR_WATCH_INTELLIGENCE_ENABLED',
    enabled: true,
    env: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'true',
    },
    filePath: featureFilePath,
    changedBy: 'test',
    source: 'unit-test',
  });
  updateRegularWatchFeatureState({
    featureKey: 'REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED',
    enabled: true,
    env: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'true',
    },
    filePath: featureFilePath,
    changedBy: 'test',
    source: 'unit-test',
  });
  updateRegularWatchFeatureState({
    featureKey: 'REGULAR_WATCH_PRIORITY_SCORING_ENABLED',
    enabled: true,
    env: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'true',
    },
    filePath: featureFilePath,
    changedBy: 'test',
    source: 'unit-test',
  });
  const featureState = loadRegularWatchState({
    env: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'true',
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: 'false',
      REGULAR_WATCH_POSITION_AWARENESS_ENABLED: 'false',
    },
    filePath: resolveRegularWatchStatePath({ dataDir }),
  });

  const refreshed = refreshRegularWatchStatus({ featureState });
  assert.equal(refreshed.status, 'active');
  const saved = saveRegularWatchStatus(refreshed, { dataDir, filePath });
  assert.equal(saved.regularWatchIntelligence.status, 'active');

  const cleared = clearRegularWatchErrors(saved);
  assert.equal(cleared.lastError, null);

  const reset = resetRegularWatchRuntimeState();
  assert.equal(reset.status, 'disabled');
  assert.equal(loadRegularWatchStatus({ dataDir, filePath }).status, 'active');
});
