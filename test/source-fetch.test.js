const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  buildSourceStatus,
  classifyHttpSourceStatus,
  fetchJsonWithTimeout,
  redactSourceMessage,
  redactSourceUrl,
  readSourceCache,
  writeSourceCache,
} = require('../src/source-fetch');
const { fetchStocktwitsSignals } = require('../src/meme-monitor/sources/stocktwits-source');
const { fetchPolygonMarketSignals } = require('../src/meme-monitor/sources/polygon-market-source');

test('source url redaction hides keys and tokens', () => {
  const redacted = redactSourceUrl('https://example.com/query?apiKey=abc123&token=secret&symbol=SPCX');
  assert.equal(redacted.includes('abc123'), false);
  assert.equal(redacted.includes('secret'), false);
  assert.equal(redacted.includes('REDACTED'), true);
});

test('source message redaction hides embedded credentials', () => {
  const redacted = redactSourceMessage('request failed with token=secret and Authorization: Bearer abc123');
  assert.equal(redacted.includes('secret'), false);
  assert.equal(redacted.includes('abc123'), false);
  assert.equal(redacted.includes('REDACTED'), true);
});

test('source cache stores and reuses successful json payloads', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'source-cache-test-'));
  const cache = {
    cacheDir: path.join(tempRoot, 'cache'),
    source: 'polygon',
    category: 'snapshot',
    key: 'SPCX',
    ttlSeconds: 60,
  };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, calls });
      },
    };
  };

  const first = await fetchJsonWithTimeout(fetchImpl, 'https://example.com/data?apiKey=secret', { cache });
  assert.equal(first.cache.hit, false);
  assert.equal(first.body.ok, true);
  assert.equal(calls, 1);

  const second = await fetchJsonWithTimeout(async () => {
    throw new Error('cache should have been used');
  }, 'https://example.com/data?apiKey=secret', { cache });
  assert.equal(second.cache.hit, true);
  assert.equal(second.body.ok, true);
  assert.equal(calls, 1);

  const cachedFile = readSourceCache(cache);
  assert.equal(Boolean(cachedFile), true);
  assert.equal(cachedFile.fresh, true);
});

test('stale cache reports stale metadata', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'source-cache-stale-'));
  const cache = {
    cacheDir: path.join(tempRoot, 'cache'),
    source: 'polygon',
    category: 'snapshot',
    key: 'SPCX',
    ttlSeconds: 1,
  };
  writeSourceCache(cache, { ok: true });
  const filePath = path.join(cache.cacheDir, 'polygon', 'snapshot');
  const cachedFile = fs.readdirSync(filePath).map((name) => path.join(filePath, name))[0];
  const payload = JSON.parse(fs.readFileSync(cachedFile, 'utf8'));
  payload.storedAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(cachedFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const stale = readSourceCache(cache);
  assert.equal(Boolean(stale), true);
  assert.equal(stale.stale, true);
});

test('source status builder preserves cache metadata', () => {
  const status = buildSourceStatus({
    source: 'polygon',
    enabled: true,
    available: true,
    status: 'active',
    cache: { used: true, hit: true, ageSeconds: 3, ttlSeconds: 30, stale: false },
  });
  assert.equal(status.cache.used, true);
  assert.equal(status.cache.hit, true);
  assert.equal(status.cache.ageSeconds, 3);
});

test('source status classifier maps auth and access failures', () => {
  const missing = classifyHttpSourceStatus(401, { error: 'bad token' });
  const banned = classifyHttpSourceStatus(403, { message: 'restricted' });
  const notFound = classifyHttpSourceStatus(404, { message: 'missing' });
  const rateLimited = classifyHttpSourceStatus(429, { error: 'slow down' });

  assert.equal(missing.status, 'missing_credentials');
  assert.equal(banned.status, 'quarantined_or_restricted');
  assert.equal(notFound.status, 'source_not_found_or_inaccessible');
  assert.equal(rateLimited.status, 'rate_limited');
});

test('stocktwits and polygon sources degrade safely on missing credentials and rate limits', async () => {
  const missing = await fetchStocktwitsSignals({
    env: {},
    fetchImpl: async () => { throw new Error('should not be called'); },
    symbols: ['SPCX'],
    timeoutMs: 10,
  });
  assert.equal(missing.sourceStatus.status, 'missing_credentials');
  assert.equal(missing.sourceStatus.blockedReason, 'missing_credentials');

  const timeout = await fetchStocktwitsSignals({
    env: { STOCKTWITS_API_KEY: 'key' },
    fetchImpl: async (_url, { signal } = {}) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => {
        const error = new Error('timed out');
        error.name = 'AbortError';
        reject(error);
      });
    }),
    symbols: ['SPCX'],
    timeoutMs: 5,
  });
  assert.equal(timeout.sourceStatus.status, 'timeout');

  const rateLimited = await fetchPolygonMarketSignals({
    env: { POLYGON_API_KEY: 'key' },
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      async text() {
        return JSON.stringify({ error: 'rate limited' });
      },
    }),
    symbols: ['SPCX'],
    timeoutMs: 10,
  });
  assert.equal(rateLimited.sourceStatus.status, 'rate_limited');
  assert.equal(rateLimited.sourceStatus.blockedReason, 'rate_limited');
});
