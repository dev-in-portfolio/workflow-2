const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTwelveDataClient, compareTwelveDataConfirmation, TwelveDataReason } = require('../src/twelve-data-client');
const { selectTwelveDataShortlist } = require('../src/stock-scanner');

function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function quote(overrides = {}) { return { symbol: 'AAPL', datetime: '2026-07-15T13:30:00Z', close: '210.50', open: '209', high: '211', low: '208', previous_close: '208.25', volume: '123456', ...overrides }; }
function harness(overrides = {}) {
  let now = new Date('2026-07-15T13:30:30Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twelve-data-'));
  const calls = [];
  const client = createTwelveDataClient({ enabled: true, apiKey: 'unit-test-secret', statePath: path.join(dir, 'usage.json'), clock: () => now, fetchImpl: async (url, init) => { calls.push({ url, init }); return response(quote()); }, ...overrides });
  return { client, calls, setNow: (value) => { now = new Date(value); }, dir };
}

test('disabled provider needs no key and makes no request', async () => {
  const { client, calls } = harness({ enabled: false, apiKey: '' });
  const result = await client.getQuote('AAPL');
  assert.equal(result.reason_code, TwelveDataReason.DISABLED);
  assert.equal(calls.length, 0);
});

test('enabled provider with missing key is blocked and degraded', async () => {
  const { client, calls } = harness({ enabled: true, apiKey: '' });
  assert.equal((await client.getQuote('AAPL')).reason_code, TwelveDataReason.NOT_CONFIGURED);
  assert.equal(client.getHealth().status, 'degraded');
  assert.equal(calls.length, 0);
});

test('successful quote is normalized without putting secret in URL', async () => {
  const { client, calls } = harness();
  const result = await client.getQuote('AAPL');
  assert.equal(result.ok, true);
  assert.equal(result.quote.provider_name, 'twelvedata');
  assert.equal(result.quote.price, 210.5);
  assert.equal(result.quote.volume, 123456);
  assert.equal(calls[0].url.includes('unit-test-secret'), false);
  assert.equal(calls[0].init.headers.Authorization, 'apikey unit-test-secret');
});

test('fresh cache avoids a second provider credit', async () => {
  const h = harness();
  await h.client.getQuote('AAPL');
  const cached = await h.client.getQuote('AAPL');
  assert.equal(cached.cache.hit, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.client.getHealth().cache_hits, 1);
});

test('expired cache fetches again', async () => {
  const h = harness({ cacheSeconds: 1 });
  await h.client.getQuote('AAPL');
  h.setNow('2026-07-15T13:30:32Z');
  await h.client.getQuote('AAPL');
  assert.equal(h.calls.length, 2);
});

test('duplicate in-flight requests are coalesced', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const h = harness({ fetchImpl: async () => { calls += 1; await pending; return response(quote()); } });
  const first = h.client.getQuote('AAPL');
  const second = h.client.getQuote('AAPL');
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('timeout is classified', async () => {
  const h = harness({ timeoutMs: 10, fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  assert.equal((await h.client.getQuote('AAPL')).reason_code, TwelveDataReason.TIMEOUT);
});

test('HTTP error is classified without leaking URL credentials', async () => {
  const logs = [];
  const h = harness({ fetchImpl: async () => response({ message: 'server error' }, 500), logger: (entry) => logs.push(entry) });
  assert.equal((await h.client.getQuote('AAPL')).reason_code, TwelveDataReason.PROVIDER_ERROR);
  assert.equal(JSON.stringify(logs).includes('unit-test-secret'), false);
});

test('Twelve Data error payload returned with HTTP 200 is rejected', async () => {
  const h = harness({ fetchImpl: async () => response({ status: 'error', code: 400, message: 'bad request' }) });
  assert.equal((await h.client.getQuote('AAPL')).reason_code, TwelveDataReason.PROVIDER_ERROR);
});

test('invalid API key is classified', async () => {
  const h = harness({ fetchImpl: async () => response({ status: 'error', code: 401, message: 'invalid api key' }) });
  assert.equal((await h.client.getQuote('AAPL')).reason_code, TwelveDataReason.AUTH_FAILED);
  assert.equal(h.client.getHealth().authentication_state, 'failed');
});

test('minute protection stops before issuing excess calls', async () => {
  const h = harness({ maxRequestsPerMinute: 1, cacheSeconds: 0 });
  await h.client.getQuote('AAPL');
  const result = await h.client.getQuote('MSFT');
  assert.equal(result.reason_code, TwelveDataReason.MINUTE_LIMIT);
  assert.equal(h.calls.length, 1);
});

test('daily budget and reserve stop normal requests', async () => {
  const h = harness({ maxDailyCredits: 3, dailyReserveCredits: 2, cacheSeconds: 0 });
  await h.client.getQuote('AAPL');
  assert.equal((await h.client.getQuote('MSFT')).reason_code, TwelveDataReason.DAILY_BUDGET);
  assert.equal(h.client.getHealth().normal_request_budget, 1);
});

test('daily counter resets on UTC provider-day boundary', async () => {
  let day = '2026-07-15T13:30:00Z';
  const h = harness({ maxDailyCredits: 1, dailyReserveCredits: 0, cacheSeconds: 0, fetchImpl: async () => response(quote({ datetime: day })) });
  await h.client.getQuote('AAPL');
  assert.equal((await h.client.getQuote('MSFT')).reason_code, TwelveDataReason.DAILY_BUDGET);
  h.setNow('2026-07-16T00:00:01Z');
  day = '2026-07-16T00:00:00Z';
  assert.equal((await h.client.getQuote('MSFT')).ok, true);
  assert.equal(h.client.getHealth().provider_day, '2026-07-16');
});

test('malformed numeric fields and missing timestamps are rejected', async () => {
  const malformed = harness({ fetchImpl: async () => response(quote({ close: 'not-a-number' })) });
  assert.equal((await malformed.client.getQuote('AAPL')).reason_code, TwelveDataReason.MALFORMED);
  const missingTime = harness({ fetchImpl: async () => response(quote({ datetime: undefined })) });
  assert.equal((await missingTime.client.getQuote('AAPL')).reason_code, TwelveDataReason.MALFORMED);
});

test('stale quotes and price mismatches cannot confirm', async () => {
  const stale = harness({ fetchImpl: async () => response(quote({ datetime: '2026-07-15T13:00:00Z' })), maxStalenessSeconds: 90 });
  assert.equal((await stale.client.getQuote('AAPL')).reason_code, TwelveDataReason.STALE);
  const h = harness();
  const result = await h.client.getQuote('AAPL');
  assert.equal(compareTwelveDataConfirmation({ price: 200 }, result, { maxPriceDifferencePct: 0.5 }).reason_code, TwelveDataReason.PRICE_MISMATCH);
  assert.equal(compareTwelveDataConfirmation({ price: 210 }, result, { maxPriceDifferencePct: 0.5 }).confirmed, true);
});

test('candidate shortlist is deduplicated, ranked, and capped before provider calls', () => {
  const bundle = { snapshots: {}, latestQuotes: {} };
  for (let i = 0; i < 1000; i += 1) {
    const symbol = `S${i}`;
    bundle.snapshots[symbol] = { dailyBar: { c: 101 + i / 100, v: 1000 + i }, prevDailyBar: { c: 100 }, latestQuote: { bp: 101 + i / 100, ap: 101 + i / 100 } };
  }
  const selected = selectTwelveDataShortlist(bundle, [...Object.keys(bundle.snapshots), 'S999'], 2);
  assert.deepEqual(selected, ['S999', 'S998']);
});

test('getQuotes never queries more than configured candidates', async () => {
  const h = harness({ maxSymbolsPerCycle: 2 });
  const results = await h.client.getQuotes(['AAPL', 'MSFT', 'NVDA', 'AAPL']);
  assert.deepEqual(Object.keys(results), ['AAPL', 'MSFT']);
  assert.equal(h.calls.length, 2);
});
