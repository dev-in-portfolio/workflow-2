const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIntradayMomentumFeatures, updateMomentumEpisode } = require('../src/intraday-momentum');
const { buildSelectionV2Score } = require('../src/scanner-selection-v2');
const { reconcileCandidateLifecycleState } = require('../src/candidate-lifecycle-state');
const { fetchIntradayMomentumBars, selectIntradayMomentumShortlist } = require('../src/stock-scanner');

function bars({ start = 100, step = 0.08, count = 20, end = Date.parse('2026-07-17T18:00:00.000Z') } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const open = start + index * step;
    const close = open + step * 0.8;
    return {
      t: new Date(end - (count - 1 - index) * 60_000).toISOString(),
      o: open,
      h: close + 0.03,
      l: open - 0.02,
      c: close,
      v: 1000 + index * 40,
      vw: (open + close) / 2,
    };
  });
}

test('rolling bars measure persistent multi-horizon momentum', () => {
  const features = buildIntradayMomentumFeatures(bars(), { receivedAt: '2026-07-17T18:00:30.000Z' });
  assert.equal(features.measured, true);
  assert.equal(features.qualified, true);
  assert(features.three_minute_return_pct > 0);
  assert(features.five_minute_return_pct > features.three_minute_return_pct);
  assert(features.trend_consistency >= 0.9);
  assert.equal(features.reason_codes.length, 0);
});

test('flat or stale bars cannot become a live momentum episode', () => {
  const flat = buildIntradayMomentumFeatures(bars({ step: 0 }), { receivedAt: '2026-07-17T18:00:30.000Z' });
  assert.equal(flat.qualified, false);
  assert(flat.reason_codes.includes('INTRADAY_THREE_MINUTE_MOMENTUM_WEAK'));
  const stale = buildIntradayMomentumFeatures(bars(), { receivedAt: '2026-07-17T18:10:00.000Z', maxBarAgeSeconds: 90 });
  assert.equal(stale.qualified, false);
  assert(stale.reason_codes.includes('INTRADAY_MOMENTUM_BARS_STALE'));
});

test('a negative entry minute or available fifteen-minute downtrend cannot qualify', () => {
  const negativeLast = bars();
  negativeLast[negativeLast.length - 1] = { ...negativeLast.at(-1), c: negativeLast.at(-2).c - 0.01 };
  const entryFading = buildIntradayMomentumFeatures(negativeLast, { receivedAt: '2026-07-17T18:00:30.000Z' });
  assert.equal(entryFading.qualified, false);
  assert(entryFading.reason_codes.includes('INTRADAY_ENTRY_MOMENTUM_NOT_UPWARD'));

  const reversal = bars({ start: 102, step: -0.08 });
  for (let index = reversal.length - 6; index < reversal.length; index += 1) {
    const prior = reversal[index - 1].c;
    reversal[index] = { ...reversal[index], o: prior, l: prior - 0.01, c: prior + 0.06, h: prior + 0.08 };
  }
  const againstTrend = buildIntradayMomentumFeatures(reversal, { receivedAt: '2026-07-17T18:00:30.000Z', minThreeMinuteReturnPct: 0.05, minFiveMinuteReturnPct: 0.05 });
  assert(againstTrend.fifteen_minute_return_pct < 0);
  assert(againstTrend.reason_codes.includes('INTRADAY_FIFTEEN_MINUTE_TREND_WEAK'));
});

test('a weak positive fifteen-minute drift is not prolonged momentum', () => {
  const weakContext = bars({ step: 0.01 });
  const measured = buildIntradayMomentumFeatures(weakContext, {
    receivedAt: '2026-07-17T18:00:30.000Z',
    minOneMinuteReturnPct: 0,
    minThreeMinuteReturnPct: 0,
    minFiveMinuteReturnPct: 0,
    minFifteenMinuteReturnPct: 0.25,
  });
  assert(measured.fifteen_minute_return_pct > 0);
  assert(measured.fifteen_minute_return_pct < 0.25);
  assert.equal(measured.qualified, false);
  assert(measured.reason_codes.includes('INTRADAY_FIFTEEN_MINUTE_TREND_WEAK'));
});

test('a vertical three-minute burst is rejected as overextended rather than chased', () => {
  const vertical = buildIntradayMomentumFeatures(bars({ step: 0.4 }), {
    receivedAt: '2026-07-17T18:00:30.000Z',
    maxThreeMinuteReturnPct: 1,
  });
  assert(vertical.three_minute_return_pct > 1);
  assert.equal(vertical.qualified, false);
  assert(vertical.reason_codes.includes('INTRADAY_MOMENTUM_BURST_OVEREXTENDED'));
});

test('a broken move invalidates its episode and a later move gets a new identity', () => {
  const good = buildIntradayMomentumFeatures(bars(), { receivedAt: '2026-07-17T18:00:30.000Z' });
  const first = updateMomentumEpisode(null, good, { symbol: 'TEST', receivedAt: '2026-07-17T18:00:30.000Z' });
  assert.equal(first.active, true);
  const weak = buildIntradayMomentumFeatures(bars({ step: 0 }), { receivedAt: '2026-07-17T18:01:30.000Z' });
  const broken = updateMomentumEpisode(first, weak, { symbol: 'TEST', receivedAt: '2026-07-17T18:01:30.000Z' });
  assert.equal(broken.active, false);
  const laterFeatures = buildIntradayMomentumFeatures(bars({ end: Date.parse('2026-07-17T18:08:00.000Z') }), { receivedAt: '2026-07-17T18:08:30.000Z' });
  const later = updateMomentumEpisode(broken, laterFeatures, { symbol: 'TEST', receivedAt: '2026-07-17T18:08:30.000Z' });
  assert.equal(later.active, true);
  assert.notEqual(later.episode_id, first.episode_id);
});

test('an over-aged episode cannot silently renew until momentum actually breaks', () => {
  const good = buildIntradayMomentumFeatures(bars(), { receivedAt: '2026-07-17T18:00:30.000Z' });
  const first = updateMomentumEpisode(null, good, { symbol: 'TEST', receivedAt: '2026-07-17T18:00:30.000Z', maxEpisodeAgeSeconds: 60 });
  const expired = updateMomentumEpisode(first, good, { symbol: 'TEST', receivedAt: '2026-07-17T18:02:00.000Z', maxEpisodeAgeSeconds: 60 });
  const stillBlocked = updateMomentumEpisode(expired, good, { symbol: 'TEST', receivedAt: '2026-07-17T18:02:30.000Z', maxEpisodeAgeSeconds: 60 });
  assert.equal(expired.active, false);
  assert.equal(stillBlocked.active, false);
  assert.equal(stillBlocked.requires_reset, true);
});

test('selection authority requires measured intraday momentum when enabled', () => {
  const inputBars = bars();
  const features = buildIntradayMomentumFeatures(inputBars, { receivedAt: '2026-07-17T18:00:30.000Z' });
  const episode = updateMomentumEpisode(null, features, { symbol: 'TEST', receivedAt: '2026-07-17T18:00:30.000Z' });
  const snapshot = {
    intradayBars: inputBars,
    intradayMomentum: features,
    momentumEpisode: episode,
    minuteBar: inputBars.at(-1),
    dailyBar: { o: 99, h: 102, l: 98, c: 101.5, v: 500000, vw: 100.5 },
    prevDailyBar: { c: 99, v: 400000 },
  };
  const scored = buildSelectionV2Score({
    symbol: 'TEST', snapshot, latestQuote: { t: '2026-07-17T18:00:29.000Z' }, currentPrice: inputBars.at(-1).c,
    previousClose: 99, spreadPct: 0.05, receivedAt: '2026-07-17T18:00:30.000Z',
    options: { intradayMomentumRequired: true },
  });
  assert.equal(scored.qualified, true);
  assert.equal(scored.setup_classification, 'MOMENTUM_CONTINUATION');
  assert.equal(scored.features.momentum_data_quality, 'rolling_minute_bars');
  assert.equal(scored.features.momentum_episode_id, episode.episode_id);

  const missing = buildSelectionV2Score({
    symbol: 'OLD', snapshot: { ...snapshot, intradayMomentum: null, momentumEpisode: null },
    latestQuote: { t: '2026-07-17T18:00:29.000Z' }, currentPrice: 101, previousClose: 99,
    spreadPct: 0.05, receivedAt: '2026-07-17T18:00:30.000Z', options: { intradayMomentumRequired: true },
  });
  assert.equal(missing.qualified, false);
  assert(missing.reason_codes.includes('INTRADAY_MOMENTUM_NOT_QUALIFIED'));
});

test('candidate lifecycle keys separate new momentum episodes', () => {
  const candidate = (episode, score) => ({ symbol: 'TEST', lifecycleSetupKey: `intraday_momentum:${episode}`, rankScore: score, payload: { market_context: { scanner: {} } } });
  const first = reconcileCandidateLifecycleState({ candidates: [candidate('one', 80)], now: '2026-07-17T18:00:00.000Z', queueEnabled: true, minScansBeforeEntry: 2, minSecondsBeforeEntry: 0 });
  const second = reconcileCandidateLifecycleState({ previousState: first.state, candidates: [candidate('two', 82)], now: '2026-07-17T18:01:00.000Z', queueEnabled: true, minScansBeforeEntry: 2, minSecondsBeforeEntry: 0 });
  assert.equal(second.state.candidates['TEST::intraday_momentum:two'].scans_seen, 1);
  assert.equal(second.state.candidates['TEST::intraday_momentum:two'].first_seen_at, '2026-07-17T18:01:00.000Z');
});

test('bar enrichment uses one batched finalist request and its cache', async () => {
  let requests = 0;
  let requestedUrl = null;
  const inputBars = bars();
  const fetchImpl = async (url) => {
    requests += 1;
    requestedUrl = url;
    return { ok: true, status: 200, text: async () => JSON.stringify({ bars: { AAA: inputBars, BBB: inputBars } }) };
  };
  const cache = new Map();
  const first = await fetchIntradayMomentumBars({ fetchImpl, apiKeyId: 'id', apiSecretKey: 'secret', baseUrl: 'https://data.example', symbols: ['AAA', 'BBB'], cache });
  const second = await fetchIntradayMomentumBars({ fetchImpl, apiKeyId: 'id', apiSecretKey: 'secret', baseUrl: 'https://data.example', symbols: ['AAA', 'BBB'], cache });
  assert.equal(requests, 1);
  assert.match(requestedUrl, /symbols=AAA%2CBBB/);
  assert.equal(first.AAA.length, 20);
  assert.equal(second.BBB.length, 20);
});

test('only the configured strongest shortlist receives rolling-bar enrichment', () => {
  const snapshot = (price, previousClose, volume) => ({ latestTrade: { p: price }, minuteBar: { o: price - 0.1, c: price }, dailyBar: { c: price, v: volume }, prevDailyBar: { c: previousClose } });
  const selected = selectIntradayMomentumShortlist({ snapshots: {
    AAA: snapshot(105, 100, 100000), BBB: snapshot(102, 100, 1000000), CCC: snapshot(101, 100, 5000000), DDD: snapshot(99, 100, 9000000),
  } }, ['AAA', 'BBB', 'CCC', 'DDD'], 2);
  assert.equal(selected.length, 2);
  assert(selected.includes('AAA'));
  assert.equal(selected.includes('DDD'), false);
});
