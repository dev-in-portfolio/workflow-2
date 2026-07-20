const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLiveEntryOverrides, buildLiveRiskOverrides, buildLiveExitOverrides, buildPolicyExitOverrides } = require('../scripts/start-stock-scanner');

test('stock scanner launcher maps live policy exit rules into scanner options', () => {
  const overrides = buildPolicyExitOverrides({
    positionStopLossDollars: 1.25,
    positionStopLossNotionalPct: 0.6,
    positionStopLossMaxDollars: 3,
    trailingProfitStartDollars: 0.8,
    trailingProfitGivebackDollars: 0.35,
  });

  assert.deepEqual(overrides, {
    stopLossDollars: 1.25,
    stopLossNotionalPct: 0.6,
    stopLossMaxDollars: 3,
    trailingProfitStartDollars: 0.8,
    trailingProfitGivebackDollars: 0.35,
  });
});

test('stock scanner launcher honors explicit operator entry thresholds', () => {
  const overrides = buildLiveEntryOverrides({
    minMovePct: 0.1,
    requireRecentMomentum: false,
    minRecentMovePct: 0.02,
    minRecentRangePct: 0.03,
    minRecentCloseLocationPct: 50,
  }, {
    STOCK_SCANNER_MIN_MOVE_PCT: '0.2',
    STOCK_SCANNER_MIN_RECENT_MOVE_PCT: '0.03',
    STOCK_SCANNER_MIN_RECENT_RANGE_PCT: '0.05',
    STOCK_SCANNER_MIN_RECENT_CLOSE_LOCATION_PCT: '60',
    SCANNER_MIN_ADJUSTED_RANK_SCORE: '6',
  });

  assert.deepEqual(overrides, {
    minMovePct: 0.2,
    requireRecentMomentum: false,
    minRecentMovePct: 0.03,
    minRecentRangePct: 0.05,
    minRecentCloseLocationPct: 60,
    allowContrarianEntries: false,
    minAdjustedRankScore: 6,
    scannerSelectionV2ShadowEnabled: true,
    scannerSelectionV2AuthorityEnabled: true,
  });
});

test('stock scanner launcher enables stale and stalled winner exits in live mode', () => {
  const overrides = buildLiveExitOverrides({});

  assert.equal(overrides.stalePositionExitEnabled, true);
  assert.equal(overrides.stalledWinnerExitEnabled, true);
  assert.equal(overrides.stalePositionMaxHoldMinutes, 12);
  assert.equal(overrides.stalledWinnerMaxHoldMinutes, 10);
});

test('stock scanner launcher preserves env-driven multi-source confirmation behavior', () => {
  const scriptPath = require.resolve('../scripts/start-stock-scanner');
  const stockScannerPath = require.resolve('../src/stock-scanner');
  const originalStockScannerModule = require.cache[stockScannerPath];
  let capturedOptions = null;

  require.cache[stockScannerPath] = {
    id: stockScannerPath,
    filename: stockScannerPath,
    loaded: true,
    exports: {
      createStockScanner(options) {
        capturedOptions = options;
        return { start() {} };
      },
    },
  };

  delete require.cache[scriptPath];
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const { main } = require('../scripts/start-stock-scanner');
    main({
      ...process.env,
      TWELVE_DATA_API_KEY: 'test-twelve-data',
      TWELVE_DATA_ENABLED: 'true',
      STOCK_SCANNER_SYMBOLS: 'NVDA',
    });
  } finally {
    process.stdout.write = originalWrite;
    delete require.cache[scriptPath];
    if (originalStockScannerModule) {
      require.cache[stockScannerPath] = originalStockScannerModule;
    } else {
      delete require.cache[stockScannerPath];
    }
  }

  assert(capturedOptions);
  assert.equal(capturedOptions.scannerConfig.requireMultiSourceConfirmation, true);
  assert.notEqual(capturedOptions.requireMultiSourceConfirmation, false);
});

test('stock scanner launcher keeps total-position loss capped for live trading', () => {
  const overrides = buildLiveRiskOverrides({
    positionStopLossDollars: 1,
    positionStopLossNotionalPct: 0.75,
    positionStopLossMaxDollars: 2.5,
  });

  assert.deepEqual(overrides, {
    stopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 1.5,
  });
});

test('policy exit override builder safely handles a missing policy file', () => {
  assert.deepEqual(buildPolicyExitOverrides(null), {});
});
