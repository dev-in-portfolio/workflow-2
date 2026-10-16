const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStockCandidateForSymbol, resolveMemeWatchlistAttention, resolveScannerWatchConfig } = require('../src/stock-scanner');

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

test('resolveScannerWatchConfig excludes trashed regular watch symbols in dynamic mode', () => {
  const config = resolveScannerWatchConfig({
    env: { SCANNER_SYMBOL_SOURCE: 'dynamic' },
    scannerSymbolSource: 'dynamic',
    approvedSymbols: [],
    regularWatchStatus: {
      status: 'active',
      regularWatchList: [
        { symbol: 'SITC', score: 91, rawScore: 91, trashed: false },
        { symbol: 'GLND', score: 48, rawScore: 48, trashed: true, trashedReason: 'raw_score_below_90' },
      ],
      regularWatchMovers: [
        { symbol: 'SITC', score: 91, rawScore: 91, trashed: false },
        { symbol: 'GLND', score: 48, rawScore: 48, trashed: true, trashedReason: 'raw_score_below_90' },
      ],
      sources: [],
    },
    dynamicHotList: {
      enabled: false,
      dynamicHotList: [],
      hotHotList: [],
    },
  });

  assert.deepEqual(config.attentionSymbols, ['SITC']);
  assert.equal(config.attentionSymbols.includes('GLND'), false);
});

test('buildStockCandidateForSymbol blocks leveraged ETF buys while preserving sell exits for held positions', () => {
  const reasons = [];
  const skipTracker = { record: (reason) => reasons.push(reason) };
  const snapshot = {
    latestQuote: { bp: 37.5, ap: 37.55, t: '2026-10-16T15:00:00.000Z' },
    latestTrade: { p: 37.52, t: '2026-10-16T15:00:00.000Z' },
    minuteBar: { o: 37.2, h: 37.6, l: 37.1, c: 37.52, v: 50000, t: '2026-10-16T15:00:00.000Z' },
    prevDailyBar: { c: 36.5, v: 5000000 },
  };

  const buyCandidate = buildStockCandidateForSymbol('SQQQ', snapshot, snapshot.latestQuote, {
    receivedAt: '2026-10-16T15:00:00.000Z',
    notional: 150,
    marketOpen: true,
    requireMarketOpen: true,
    skipTracker,
  });
  assert.equal(buyCandidate, null);
  assert(reasons.includes('LEVERAGED_OR_VOLATILITY_ETF_EXCLUDED'));

  const sellCandidate = buildStockCandidateForSymbol('SQQQ', snapshot, snapshot.latestQuote, {
    receivedAt: '2026-10-16T15:00:00.000Z',
    notional: 150,
    marketOpen: true,
    requireMarketOpen: true,
    stopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 5,
    position: {
      symbol: 'SQQQ',
      qty: '5',
      avg_entry_price: '40.00',
      current_price: '37.52',
      market_value: '187.60',
      unrealized_pl: '-12.40',
    },
  });
  assert(sellCandidate);
  assert.equal(sellCandidate.payload.side, 'sell');
});
