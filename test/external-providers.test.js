const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMassiveClient } = require('../src/massive-client');
const { createFinnhubClient } = require('../src/finnhub-client');
const { createFmpClient } = require('../src/fmp-client');
const { ProviderRuntime } = require('../src/provider-runtime');

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

test('Massive stays disabled without opt-in and supports Polygon key alias', async () => {
  const disabled = createMassiveClient({ env: { MASSIVE_ENABLED: 'false' }, fetchImpl: async () => { throw new Error('not called'); } });
  assert.equal((await disabled.quote('AAPL')).reasonCode, 'MASSIVE_DISABLED');
  assert.equal(disabled.health().status, 'disabled');
  let authorization = '';
  const client = createMassiveClient({ env: { MASSIVE_ENABLED: 'true', POLYGON_API_KEY: 'legacy', MASSIVE_MAX_STALENESS_SECONDS: '90' }, fetchImpl: async (_url, init) => { authorization = init.headers.authorization; return response({ ticker: { lastTrade: { p: 100, t: Date.now() * 1e6 }, day: { c: 100 } } }); } });
  const result = await client.quote('AAPL', 100);
  assert.equal(result.ok, true);
  assert.equal(client.health().legacyPolygonAliasUsed, true);
  assert.equal(authorization, 'Bearer legacy');
});

test('Massive canonical key wins and stale data cannot confirm', async () => {
  let authorization = '';
  const client = createMassiveClient({ env: { MASSIVE_ENABLED: 'true', MASSIVE_API_KEY: 'canonical', POLYGON_API_KEY: 'legacy', MASSIVE_MAX_STALENESS_SECONDS: '10' }, fetchImpl: async (_url, init) => { authorization = init.headers.authorization; return response({ ticker: { lastTrade: { p: 100, t: (Date.now() - 60000) * 1e6 } } }); } });
  const result = await client.quote('AAPL', 100);
  assert.equal(result.reasonCode, 'MASSIVE_STALE');
  assert.equal(authorization, 'Bearer canonical');
});

test('Finnhub normalizes fresh quote and rejects price mismatch', async () => {
  const client = createFinnhubClient({ env: { FINNHUB_ENABLED: 'true', FINNHUB_API_KEY: 'secret', FINNHUB_MAX_PRICE_DIFFERENCE_PCT: '0.5' }, fetchImpl: async () => response({ c: 101, o: 99, h: 102, l: 98, pc: 100, t: Math.floor(Date.now() / 1000) }) });
  const result = await client.quote('AAPL', 100);
  assert.equal(result.reasonCode, 'FINNHUB_PRICE_MISMATCH');
});

test('Finnhub news is normalized and deduplicated', async () => {
  const client = createFinnhubClient({ env: { FINNHUB_ENABLED: 'true', FINNHUB_API_KEY: 'secret' }, fetchImpl: async () => response([{ id: 1, headline: 'A', datetime: Math.floor(Date.now() / 1000), related: 'AAPL' }, { id: 1, headline: 'A duplicate' }]) });
  const result = await client.news('AAPL', '2026-07-01', '2026-07-15');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].provider, 'finnhub');
});

test('FMP fundamentals never qualify as live confirmation', async () => {
  const client = createFmpClient({ env: { FMP_ENABLED: 'true', FMP_API_KEY: 'secret' }, fetchImpl: async () => response([{ companyName: 'Example', mktCap: 100000000, sharesOutstanding: 10000000, floatShares: 5000000 }]) });
  const result = await client.fundamentals('TEST');
  assert.equal(result.ok, true);
  assert.equal(result.liveConfirmationEligible, false);
  assert.equal(result.derivedFlags.some((flag) => flag.flag === 'micro_cap'), true);
});

test('Massive exposes cached reference, aggregate, corporate-action, and news enrichment only', async () => {
  const calls = [];
  const client = createMassiveClient({ env: { MASSIVE_ENABLED: 'true', MASSIVE_API_KEY: 'secret' }, fetchImpl: async (url) => {
    calls.push(String(url));
    return response({ status: 'OK', results: [{ ticker: 'AAPL' }] });
  } });
  for (const result of [
    await client.reference('AAPL'),
    await client.aggregates('AAPL', { from: '2026-07-15', to: '2026-07-16' }),
    await client.dividends('AAPL'),
    await client.news('AAPL'),
  ]) {
    assert.equal(result.ok, true);
    assert.equal(result.liveConfirmationEligible, false);
    assert.equal(result.rawDataExcluded, true);
  }
  assert.equal(calls.length, 4);
  assert.equal((await client.reference('AAPL')).cached, true);
});

test('Finnhub exposes market status, fundamentals, and earnings as non-execution context', async () => {
  const client = createFinnhubClient({ env: { FINNHUB_ENABLED: 'true', FINNHUB_API_KEY: 'secret' }, fetchImpl: async (url) => {
    if (String(url).includes('market-status')) return response({ isOpen: true, session: 'regular' });
    if (String(url).includes('stock/metric')) return response({ metric: { peTTM: 20 } });
    return response({ earningsCalendar: [{ symbol: 'AAPL', date: '2026-07-20' }] });
  } });
  assert.equal((await client.marketStatus()).liveConfirmationEligible, false);
  assert.equal((await client.basicFinancials('AAPL')).liveConfirmationEligible, false);
  assert.equal((await client.earningsCalendar({ symbol: 'AAPL', from: '2026-07-16', to: '2026-07-31' })).items.length, 1);
});

test('FMP statement, ratio, metric, and earnings collections remain historical enrichment', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmp-collections-'));
  const client = createFmpClient({ env: { FMP_ENABLED: 'true', FMP_API_KEY: 'secret' }, dataDir, fetchImpl: async () => response([{ symbol: 'AAPL', date: '2026-06-30' }]) });
  for (const result of [
    await client.incomeStatements('AAPL'), await client.balanceSheets('AAPL'), await client.cashFlows('AAPL'),
    await client.ratios('AAPL'), await client.keyMetrics('AAPL'), await client.earnings('AAPL'),
  ]) {
    assert.equal(result.ok, true);
    assert.equal(result.liveConfirmationEligible, false);
    assert.equal(result.freshness, 'historical');
  }
});

test('provider runtime coalesces requests, caches, and enforces daily reserve', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-runtime-'));
  const runtime = new ProviderRuntime({ provider: 'fmp', maxRequests: 10, dailyMax: 2, dailyReserve: 1, statePath: path.join(dir, 'usage.json') });
  let calls = 0;
  const request = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { ok: true, value: 1 }; };
  const [a, b] = await Promise.all([runtime.run('x', request, { cacheSeconds: 60 }), runtime.run('x', request, { cacheSeconds: 60 })]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(calls, 1);
  assert.equal((await runtime.run('x', request, { cacheSeconds: 60 })).cached, true);
  assert.equal((await runtime.run('y', request, { cacheSeconds: 0 })).reasonCode, 'FMP_DAILY_RESERVE_REACHED');
});

test('provider runtime applies cooldown and opens then recovers its circuit', async () => {
  let now = new Date('2026-07-16T15:00:00.000Z');
  const runtime = new ProviderRuntime({
    provider: 'finnhub', maxRequests: 10, cooldownMs: 1000, circuitFailureThreshold: 2,
    clock: () => now,
  });
  const failed = async () => ({ ok: false, reasonCode: 'FINNHUB_PROVIDER_FAILURE' });
  await runtime.run('a', failed);
  await runtime.run('b', failed);
  assert.equal(runtime.snapshot().circuitState, 'open');
  assert.equal((await runtime.run('c', async () => ({ ok: true }))).reasonCode, 'FINNHUB_CIRCUIT_OPEN');
  now = new Date(now.getTime() + 1001);
  assert.equal((await runtime.run('c', async () => ({ ok: true, freshness: 'real_time' }))).ok, true);
  assert.equal(runtime.snapshot().circuitState, 'closed');
  assert.equal(runtime.snapshot().freshnessClassification, 'real_time');
  assert.equal(runtime.snapshot().source, 'finnhub');
});

test('provider runtime resets persisted daily usage at the UTC day boundary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-day-'));
  let now = new Date('2026-07-16T23:59:59.000Z');
  const runtime = new ProviderRuntime({ provider: 'fmp', dailyMax: 3, dailyReserve: 1, statePath: path.join(dir, 'usage.json'), clock: () => now });
  await runtime.run('a', async () => ({ ok: true }));
  assert.equal(runtime.snapshot().estimatedDailyUsage, 1);
  now = new Date('2026-07-17T00:00:01.000Z');
  assert.equal(runtime.snapshot().estimatedDailyUsage, 0);
});

test('provider structured logs contain health facts but never authorization secrets', async () => {
  const logs = [];
  const client = createMassiveClient({
    env: { MASSIVE_ENABLED: 'true', MASSIVE_API_KEY: 'do-not-log-this' }, logger: (entry) => logs.push(entry),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'provider-logs-')),
    fetchImpl: async () => response({ ticker: { lastTrade: { p: 100, t: Date.now() * 1e6 } } }),
  });
  assert.equal((await client.quote('AAPL', 100)).ok, true);
  assert(logs.some((entry) => entry.event === 'provider_request_success'));
  assert.equal(JSON.stringify(logs).includes('do-not-log-this'), false);
});
