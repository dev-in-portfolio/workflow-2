const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCandidates, evaluatePostOpenSetupGate, refreshFinalQuote } = require('../src/stock-scanner');
const { updateTrailingSnapshot } = require('../src/position-trailing-state');

function bundle(price, timestamp = '2026-07-17T14:00:00.000Z') {
  const bid = price - 0.005;
  const ask = price + 0.005;
  return {
    snapshots: { TEST: { latestQuote: { bp: bid, ap: ask, t: timestamp }, latestTrade: { p: price, t: timestamp }, minuteBar: { o: price - 0.02, h: price, l: price - 0.03, c: price, v: 1000, t: timestamp }, dailyBar: { c: price, v: 100000, t: timestamp }, prevDailyBar: { c: price - 0.1, v: 100000, t: timestamp } } },
    latestQuotes: { TEST: { bp: bid, ap: ask, t: timestamp } },
  };
}

test('candidate builder forwards the configured minimum price to the buy gate', () => {
  const reasons = [];
  const result = buildCandidates(bundle(7.5), {
    receivedAt: '2026-07-17T14:00:01.000Z', attentionSymbols: ['TEST'], positions: [], openOrders: [],
    portfolio: { remaining_position_slots: 2 }, allocation: { accepted: true, notional: 100 }, notional: 100,
    minPrice: 10, allowContrarianEntries: true, marketOpen: true, regimeBuysAllowed: true,
    skipTracker: { record: (reason, details) => reasons.push({ reason, details }) },
  });
  assert.equal(result.allBuyCandidates.length, 0);
  assert(reasons.some((item) => item.reason === 'PRICE_BELOW_ENTRY_MINIMUM'));
});

test('measured rolling momentum replaces the conflicting legacy one-bar veto', () => {
  const market = bundle(20);
  market.snapshots.TEST.minuteBar = { o: 20.1, h: 20.1, l: 19.98, c: 20, v: 1000, t: '2026-07-17T14:00:00.000Z' };
  market.snapshots.TEST.intradayMomentum = { measured: true, qualified: true, bar_count: 20, three_minute_return_pct: 0.5, five_minute_return_pct: 0.8, trend_consistency: 0.75, volume_acceleration: 1.1, reason_codes: [] };
  market.snapshots.TEST.momentumEpisode = { active: true, episode_id: 'fresh' };
  const persistence = new Map([['TEST', { streak: 5, last_price: 20.2, cooldown_until_ms: Date.parse('2026-07-17T14:10:00.000Z') }]]);
  const result = buildCandidates(market, {
    receivedAt: '2026-07-17T14:00:01.000Z', attentionSymbols: ['TEST'], positions: [], openOrders: [],
    portfolio: { remaining_position_slots: 2 }, allocation: { accepted: true, notional: 100 }, notional: 100,
    minPrice: 10, minMovePct: 0, requireRecentMomentum: true, requireRecentMove: true,
    prolongedMomentumEnabled: true, momentumPersistence: persistence, intradayMomentumEnabled: true,
    marketOpen: true, regimeBuysAllowed: true, maxBuyRiskScore: 100,
  });
  assert.equal(result.allBuyCandidates.length, 1);
});

test('post-open gate allows continuation setups and blocks breakout/unclassified setups', () => {
  const options = { postOpenSetupGateEnabled: true, postOpenSetupGateAfterMinutes: 30, postOpenMinOpportunityScore: 70, postOpenAllowedSetups: ['MOMENTUM_CONTINUATION', 'PULLBACK_CONTINUATION'], intradayRegime: { minutes_since_open: 73 } };
  assert.equal(evaluatePostOpenSetupGate('MOMENTUM_CONTINUATION', options, 75).allowed, true);
  assert.equal(evaluatePostOpenSetupGate('PULLBACK_CONTINUATION', options, 70).allowed, true);
  assert.equal(evaluatePostOpenSetupGate('MOMENTUM_CONTINUATION', options, 69.99).reason_code, 'POST_OPEN_OPPORTUNITY_SCORE_BELOW_MINIMUM');
  assert.equal(evaluatePostOpenSetupGate('BREAKOUT_CONTINUATION', options, 90).allowed, false);
  assert.equal(evaluatePostOpenSetupGate('UNCLASSIFIED', options, 90).allowed, false);
  assert.equal(evaluatePostOpenSetupGate('BREAKOUT_CONTINUATION', { ...options, intradayRegime: { minutes_since_open: 29 } }, 20).allowed, true);
});

test('final quote revalidation rejects a price below the floor and an excessive spread', async () => {
  const makeFetch = (bid, ask) => async () => {
    const body = { snapshots: { TEST: { latestQuote: { bp: bid, ap: ask, t: new Date().toISOString() } } } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const cheap = await refreshFinalQuote({ fetchImpl: makeFetch(7.49, 7.51), baseUrl: 'https://example.test', symbol: 'TEST', maxAgeSeconds: 5, minPrice: 10, maxSpreadPct: 0.15 });
  assert.equal(cheap.reason_code, 'FINAL_QUOTE_PRICE_BELOW_MINIMUM');
  const wide = await refreshFinalQuote({ fetchImpl: makeFetch(19.95, 20.05), baseUrl: 'https://example.test', symbol: 'TEST', maxAgeSeconds: 5, minPrice: 10, maxSpreadPct: 0.15 });
  assert.equal(wide.reason_code, 'FINAL_QUOTE_SPREAD_TOO_WIDE');
});

test('position tracking preserves maximum adverse excursion for future pulse analysis', () => {
  const first = updateTrailingSnapshot({ positions: [{ symbol: 'TEST', unrealized_pl: -0.2 }], previousState: {} });
  const second = updateTrailingSnapshot({ positions: [{ symbol: 'TEST', unrealized_pl: 0.3 }], previousState: first });
  const third = updateTrailingSnapshot({ positions: [{ symbol: 'TEST', unrealized_pl: -0.1 }], previousState: second });
  assert.equal(third.positions.TEST.minimum_unrealized_pl, -0.2);
  assert.equal(third.positions.TEST.peak_unrealized_pl, 0.3);
});
