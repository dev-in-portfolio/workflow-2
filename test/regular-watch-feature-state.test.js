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

test('regular watch feature state keeps scanner ranking two-key gated', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'regular-watch-feature-state-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
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
  const state = loadRegularWatchState({ dataDir, filePath });
  assert.equal(state.features.REGULAR_WATCH_SCANNER_RANKING_ENABLED.status, 'off');
});

