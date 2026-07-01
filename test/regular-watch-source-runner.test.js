const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRegularWatchSourceRuntime } = require('../src/regular-watch/regular-watch-source-runner');

test('regular watch source runtime keeps two-key scanner ranking off until effective', () => {
  const runtime = resolveRegularWatchSourceRuntime({
    REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
    REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
    REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'true',
    REGULAR_WATCH_SCANNER_RANKING_ENABLED: 'true',
    REGULAR_WATCH_POSITION_AWARENESS_ENABLED: 'true',
  }, {
    features: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: { effective: true, runtime: true },
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: { effective: false, runtime: true },
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: { effective: false, runtime: true },
      REGULAR_WATCH_POSITION_AWARENESS_ENABLED: { effective: false, runtime: true },
    },
  });

  assert.equal(runtime.priorityScoring, false);
  assert.equal(runtime.scannerRanking, false);
  assert.equal(runtime.positionAwareness, false);
});

