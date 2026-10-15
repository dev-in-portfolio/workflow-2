const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveRegularWatchSourceRuntime,
  isSuitableRegularWatchAsset,
  buildFastLaneSymbols,
  selectRotatingSymbolBatch,
  applyIncumbencyDecay,
} = require('../src/regular-watch/regular-watch-source-runner');

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

test('isSuitableRegularWatchAsset filters out OTC, warrants, leveraged ETFs, and keeps valid common stocks', () => {
  assert.equal(isSuitableRegularWatchAsset({ symbol: 'AAPL', name: 'Apple Inc Common Stock', exchange: 'NASDAQ' }), true);
  assert.equal(isSuitableRegularWatchAsset({ symbol: 'NKE', name: 'Nike Inc Class B', exchange: 'NYSE' }), true);
  assert.equal(isSuitableRegularWatchAsset({ symbol: 'PENNY', name: 'Penny Corp', exchange: 'OTC' }), false);
  assert.equal(isSuitableRegularWatchAsset({ symbol: 'SEAT.WS', name: 'SeatGeek Warrant', exchange: 'NASDAQ' }), false);
  assert.equal(isSuitableRegularWatchAsset({ symbol: 'WARRT', name: 'Warrant Inc', exchange: 'NASDAQ' }), false);
  assert.equal(isSuitableRegularWatchAsset({ symbol: 'TQQQ', name: 'ProShares UltraPro QQQ', exchange: 'NASDAQ' }), false);
  assert.equal(isSuitableRegularWatchAsset({ symbol: 'XYZPR', name: 'XYZ Preferred Series A', exchange: 'NYSE' }), false);
});

test('buildFastLaneSymbols prioritizes market leader gainers, most actives, and volatile core at top', () => {
  const fastLane = buildFastLaneSymbols({
    enabled: true,
    limit: 10,
    marketLeaders: {
      gainers: ['ROCKET', 'SURGE'],
      mostActives: ['HEAVY'],
    },
    coreSymbols: ['TSLA', 'NVDA'],
    universeSymbols: ['ROCKET', 'SURGE', 'HEAVY', 'TSLA', 'NVDA', 'RANDOM'],
  });

  assert.equal(fastLane.enabled, true);
  assert.ok(fastLane.symbols.includes('ROCKET'));
  assert.ok(fastLane.symbols.includes('SURGE'));
  assert.ok(fastLane.symbols.includes('HEAVY'));
  assert.ok(fastLane.symbols.includes('TSLA'));
  // Gainers have score 95, most actives 90, core 80
  const rocketIdx = fastLane.symbols.indexOf('ROCKET');
  const tslaIdx = fastLane.symbols.indexOf('TSLA');
  assert.ok(rocketIdx < tslaIdx, 'Market leader gainer must rank above baseline core symbol');
  assert.equal(fastLane.sources.market_leader_gainers, 2);
  assert.equal(fastLane.sources.market_leader_most_actives, 1);
  assert.equal(fastLane.sources.core_volatile_universe, 2);
});

test('selectRotatingSymbolBatch partitions priority symbols and sweeps broader universe without starvation', () => {
  const universe = ['P1', 'P2', 'P3', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10'];
  const prioritySymbols = ['P1', 'P2', 'P3'];

  const batch1 = selectRotatingSymbolBatch({
    symbols: universe,
    batchSize: 5,
    previousOffset: 0,
    prioritySymbols,
  });

  // Priority quota is min(3, floor(5 * 0.3)) = 1 symbol from priority, 4 from broader
  assert.equal(batch1.symbols.length, 5);
  assert.ok(batch1.symbols.includes('P1'), 'Priority symbol should be included');
  assert.ok(batch1.symbols.includes('B1'), 'Broader universe should be included');
  assert.equal(batch1.next_offset, 4);

  const batch2 = selectRotatingSymbolBatch({
    symbols: universe,
    batchSize: 5,
    previousOffset: batch1.next_offset,
    prioritySymbols,
  });

  assert.equal(batch2.symbols.length, 5);
  assert.ok(batch2.symbols.includes('B5'), 'Next batch rotates to subsequent broader symbols');
});

test('applyIncumbencyDecay preserves active runners and applies dormancy penalties to dead stocks', () => {
  const entries = [
    { symbol: 'RUNNER', score: 80, movePct: 3.5, volumeMultiple: 2.2, volume: 500000 },
    { symbol: 'DORMANT', score: 80, movePct: 0.0, volumeMultiple: 0, volume: 0 },
    { symbol: 'NORMAL', score: 80, movePct: 0.5, volumeMultiple: 0.8, volume: 10000 },
  ];

  const previousStatus = {
    regularWatchList: [
      { symbol: 'RUNNER', fastLaneStreak: 3 },
      { symbol: 'NORMAL', fastLaneStreak: 3 },
    ],
  };

  const results = applyIncumbencyDecay(entries, {
    previousStatus,
    fastLaneSymbols: ['RUNNER', 'NORMAL'],
    decayPoints: 10,
  });

  const runner = results.find((r) => r.symbol === 'RUNNER');
  const dormant = results.find((r) => r.symbol === 'DORMANT');
  const normal = results.find((r) => r.symbol === 'NORMAL');

  // Normal has streak 3 -> fastLaneStreak 4 -> (4-1)*10 = 30 penalty -> score 50
  assert.equal(normal.incumbencyPenalty, 30);
  assert.equal(normal.score, 50);

  // Runner has decay halved from 30 to 15 -> score 65
  assert.equal(runner.incumbencyPenalty, 15);
  assert.equal(runner.score, 65);

  // Dormant gets dormancyPenalty 10 -> score 70
  assert.equal(dormant.dormancyPenalty, 10);
  assert.equal(dormant.score, 70);
});

