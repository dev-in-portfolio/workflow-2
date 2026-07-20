const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCandidateForSymbol, createOvernightScanner } = require('../src');

test('overnight scanner builds real buy candidates from fresh bullish Alpaca data', () => {
  const candidate = buildCandidateForSymbol('BTC/USD', {
    latestQuote: {
      bp: 60000,
      ap: 60012,
      t: '2026-06-15T00:00:00.000Z',
    },
    latestTrade: {
      p: 60008,
      t: '2026-06-15T00:00:00.000Z',
    },
    minuteBar: {
      v: 42,
      h: 60020,
      l: 59950,
      t: '2026-06-15T00:00:00.000Z',
    },
    prevDailyBar: {
      c: 59400,
      v: 200000,
    },
  }, {
    bp: 60000,
    ap: 60012,
    t: '2026-06-15T00:00:00.000Z',
  }, {
    receivedAt: '2026-06-15T00:00:01.000Z',
    minMovePct: 0.5,
    maxSpreadPct: 0.5,
    notional: 25,
    runId: 'test-run',
  });

  assert(candidate);
  assert.equal(candidate.payload.action_candidate, 'paper_buy');
  assert(candidate.movePct > 0.5);
  assert.equal(candidate.payload.market_context.scanner.run_id, 'test-run');
  assert.equal(candidate.payload.market_data.symbol, 'BTC/USD');
  assert(candidate.payload.market_context.secondary_quote);
});

test('overnight scanner posts candidates to the local paper order endpoint', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const twelveTimestamp = new Date(Date.now() - 1000).toISOString();
  const localServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ accepted: true, final_decision: 'approved_for_paper' }));
    });
  });
  await new Promise((resolve) => localServer.listen(0, resolve));
  const localPort = localServer.address().port;

  const scanner = createOvernightScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    twelveDataApiKey: 'twelve-key',
    twelveDataEnabled: true,
    twelveDataBaseUrl: 'https://api.twelvedata.com',
    localBaseUrl: `http://127.0.0.1:${localPort}`,
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['BTC/USD'],
    intervalMs: 60_000,
    cooldownMs: 60_000,
    minMovePct: 0.5,
    maxSpreadPct: 0.5,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse([
          {
            symbol: 'BTC/USD',
            qty_available: '0.5',
            avg_entry_price: '50000',
          },
        ]);
      }
      if (url.includes('/v2/orders?status=open')) {
        return buildResponse([]);
      }
      if (url.includes('/snapshots?')) {
        return buildResponse({
          snapshots: {
            'BTC/USD': {
              latestQuote: { bp: 60000, ap: 60010, t: alpacaTimestamp },
              latestTrade: { p: 60005, t: alpacaTimestamp },
              minuteBar: { v: 50, h: 60020, l: 59990, t: alpacaTimestamp },
              prevDailyBar: { c: 59500, v: 100000 },
            },
          },
        });
      }
      if (url.includes('/latest/quotes?')) {
        return buildResponse({
          quotes: {
            'BTC/USD': { bp: 60000, ap: 60010, t: alpacaTimestamp },
          },
        });
      }
      if (url.includes('api.twelvedata.com/quote?')) {
        return buildResponse({
          data: [
            {
              symbol: 'BTC/USD',
              price: 60005,
              datetime: twelveTimestamp,
              volume: 1200,
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: global.fetch,
  });

  const result = await scanner.runOnce({ runId: 'test-scan' });
  scanner.stop();
  await new Promise((resolve) => localServer.close(resolve));

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/paper-order');
  assert.equal(requests[0].body.action_candidate, 'paper_sell');
  assert.equal(requests[0].body.market_context.scanner.run_id, 'test-scan');
  assert.equal(requests[0].body.market_context.twelve_data_quote.provider_name, 'twelvedata');
});

test('overnight scanner respects cooldowns for repeated symbols', () => {
  const candidate = buildCandidateForSymbol('BTC/USD', {
    latestQuote: {
      bp: 60000,
      ap: 60012,
      t: '2026-06-15T00:00:00.000Z',
    },
    prevDailyBar: {
      c: 59400,
      v: 200000,
    },
  }, {
    bp: 60000,
    ap: 60012,
    t: '2026-06-15T00:00:00.000Z',
  }, {
    receivedAt: '2026-06-15T00:00:01.000Z',
    minMovePct: 0.5,
    maxSpreadPct: 0.5,
    cooldownMs: 60_000,
    lastSentAt: Date.now(),
  });

  assert.equal(candidate, null);
});

test('overnight scanner reloads recent-symbol cooldown memory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-memory-'));
  const statePath = path.join(tempDir, 'recent.json');
  fs.writeFileSync(statePath, JSON.stringify({
    profiles: {
      'crypto-only': {
        'BTC/USD': Date.now(),
      },
    },
  }));
  const scanner = createOvernightScanner({
    env: {
      SCANNER_RECENT_SYMBOLS_PATH: statePath,
      SCANNER_RECENT_SYMBOLS_ENABLED: 'true',
    },
    fetch: async () => ({ ok: true, async text() { return '{}'; } }),
    localFetch: async () => ({ ok: true, async json() { return { accepted: true }; } }),
    localBaseUrl: 'http://127.0.0.1:3001',
    cooldownMs: 60_000,
  });
  assert.equal(scanner.state.lastSentAtBySymbol.has('BTC/USD'), true);
});

test('overnight scanner skips symbols that already have open orders', () => {
  const candidate = buildCandidateForSymbol('BTC/USD', {
    latestQuote: {
      bp: 60000,
      ap: 60012,
      t: '2026-06-15T00:00:00.000Z',
    },
    prevDailyBar: {
      c: 59400,
      v: 200000,
    },
  }, {
    bp: 60000,
    ap: 60012,
    t: '2026-06-15T00:00:00.000Z',
  }, {
    receivedAt: '2026-06-15T00:00:01.000Z',
    minMovePct: 0.5,
    maxSpreadPct: 0.5,
    cooldownMs: 60_000,
    openOrder: [{ symbol: 'BTC/USD', side: 'sell', status: 'new' }],
  });

  assert.equal(candidate, null);
});

test('overnight scanner skips buy candidates when buys are blocked', () => {
  const candidate = buildCandidateForSymbol('BTC/USD', {
    latestQuote: {
      bp: 60000,
      ap: 60012,
      t: '2026-06-15T00:00:00.000Z',
    },
    prevDailyBar: {
      c: 59400,
      v: 200000,
    },
  }, {
    bp: 60000,
    ap: 60012,
    t: '2026-06-15T00:00:00.000Z',
  }, {
    receivedAt: '2026-06-15T00:00:01.000Z',
    minMovePct: 0.5,
    maxSpreadPct: 0.5,
    notional: 25,
    blockBuys: true,
  });

  assert.equal(candidate, null);
});

test('overnight scanner emits a sell when a held position is down past the loss-exit threshold', () => {
  const candidate = buildCandidateForSymbol('DOGE/USD', {
    latestQuote: {
      bp: 0.086,
      ap: 0.0862,
      t: '2026-06-15T00:00:00.000Z',
    },
    prevDailyBar: {
      c: 0.089,
      v: 200000,
    },
  }, {
    bp: 0.086,
    ap: 0.0862,
    t: '2026-06-15T00:00:00.000Z',
  }, {
    receivedAt: '2026-06-15T00:00:01.000Z',
    minMovePct: 0.5,
    maxSpreadPct: 0.5,
    position: {
      qty_available: '100',
      avg_entry_price: '0.09',
    },
    sellProfitThresholdPct: 1.0,
    sellLossThresholdPct: 0.75,
  });

  assert(candidate);
  assert.equal(candidate.payload.action_candidate, 'paper_sell');
  assert.equal(candidate.payload.side, 'sell');
});

test('overnight scanner start keeps the polling timer referenced for continuous operation', () => {
  const scanner = createOvernightScanner({
    enabled: true,
    keepAlive: true,
    localBaseUrl: 'http://127.0.0.1:65535',
    marketFetch: async () => buildResponse({
      snapshots: {
        'BTC/USD': {
          latestQuote: { bp: 60000, ap: 60010, t: '2026-06-15T00:00:00.000Z' },
          prevDailyBar: { c: 59400, v: 200000 },
        },
      },
    }),
    localFetch: async () => ({
      ok: true,
      async json() {
        return { accepted: true, final_decision: 'approved_for_paper' };
      },
    }),
    symbols: ['BTC/USD'],
    intervalMs: 60_000,
    cooldownMs: 60_000,
    minMovePct: 0.5,
    maxSpreadPct: 0.5,
  });

  scanner.start();
  assert.equal(typeof scanner.state.timer?.hasRef, 'function');
  assert.equal(scanner.state.timer.hasRef(), true);
  scanner.stop();
});

test('overnight scanner can create a fresh contrarian buy when the move is down and activity mode is enabled', () => {
  const candidate = buildCandidateForSymbol('BTC/USD', {
    latestQuote: {
      bp: 59000,
      ap: 59010,
      t: '2026-06-15T00:00:00.000Z',
    },
    prevDailyBar: {
      c: 59400,
      v: 200000,
    },
  }, {
    bp: 59000,
    ap: 59010,
    t: '2026-06-15T00:00:00.000Z',
  }, {
    receivedAt: '2026-06-15T00:00:01.000Z',
    minMovePct: 0.5,
    maxSpreadPct: 0.5,
    allowContrarianEntries: true,
    notional: 25,
    runId: 'contrarian-run',
  });

  assert(candidate);
  assert.equal(candidate.payload.action_candidate, 'paper_buy');
  assert.equal(candidate.payload.side, 'buy');
});

test('overnight scanner reads the symbol list from environment configuration', () => {
  const scanner = createOvernightScanner({
    enabled: true,
    env: {
      OVERNIGHT_SCANNER_SYMBOLS: 'BTC/USD,ETH/USD,SOL/USD,XRP/USD,DOGE/USD,AVAX/USD,LINK/USD,DOT/USD',
    },
    localBaseUrl: 'http://127.0.0.1:65535',
    marketFetch: async () => buildResponse({
      snapshots: {},
    }),
    localFetch: async () => ({
      ok: true,
      async json() {
        return { accepted: true, final_decision: 'approved_for_paper' };
      },
    }),
  });

  assert.deepEqual(scanner.config.symbols, [
    'BTC/USD',
    'ETH/USD',
    'SOL/USD',
    'XRP/USD',
    'DOGE/USD',
    'AVAX/USD',
    'LINK/USD',
    'DOT/USD',
  ]);
  scanner.stop();
});

test('overnight scanner keeps the configured cooldown', () => {
  const scanner = createOvernightScanner({
    enabled: true,
    env: {},
    localBaseUrl: 'http://127.0.0.1:65535',
    marketFetch: async () => buildResponse({
      snapshots: {},
    }),
    localFetch: async () => ({
      ok: true,
      async json() {
        return { accepted: true, final_decision: 'approved_for_paper' };
      },
    }),
    cooldownMs: 90_000,
  });

  assert.equal(scanner.config.cooldownMs, 90_000);
  scanner.stop();
});

test('overnight scanner keeps the configured sell profit threshold', () => {
  const scanner = createOvernightScanner({
    enabled: true,
    env: {},
    localBaseUrl: 'http://127.0.0.1:65535',
    marketFetch: async () => buildResponse({ snapshots: {} }),
    localFetch: async () => ({ ok: true, async json() { return { accepted: true, final_decision: 'approved_for_paper' }; } }),
    sellProfitThresholdPct: 0.75,
  });

  assert.equal(scanner.config.sellProfitThresholdPct, 5.0);
  scanner.stop();
});

test('overnight scanner does not sell on a tiny gain below the exit floor', () => {
  const candidate = buildCandidateForSymbol('BTC/USD', {
    latestQuote: {
      bp: 60000,
      ap: 60012,
      t: '2026-06-15T00:00:00.000Z',
    },
    prevDailyBar: {
      c: 59400,
      v: 200000,
    },
  }, {
    bp: 60000,
    ap: 60012,
    t: '2026-06-15T00:00:00.000Z',
  }, {
    receivedAt: '2026-06-15T00:00:01.000Z',
    minMovePct: 0.5,
    maxSpreadPct: 0.5,
    position: {
      qty_available: '0.5',
      avg_entry_price: '59970',
    },
    sellProfitThresholdPct: 5.0,
    sellLossThresholdPct: 0.75,
  });

  assert.equal(candidate, null);
});

test('overnight scanner raises the sell target when the dollar floor is larger', () => {
  const candidate = buildCandidateForSymbol('BTC/USD', {
    latestQuote: {
      bp: 19.99,
      ap: 20.01,
      t: '2026-06-15T00:00:00.000Z',
    },
    prevDailyBar: {
      c: 19.5,
      v: 200000,
    },
  }, {
    bp: 19.99,
    ap: 20.01,
    t: '2026-06-15T00:00:00.000Z',
  }, {
    receivedAt: '2026-06-15T00:00:01.000Z',
    minMovePct: 0.5,
    maxSpreadPct: 0.5,
    position: {
      qty_available: '0.5',
      avg_entry_price: '10.0',
    },
    sellProfitThresholdPct: 40.0,
    sellNetProfitFloorDollars: 5.0,
    sellLossThresholdPct: 0.75,
  });

  assert(candidate);
  assert.equal(candidate.payload.side, 'sell');
  assert(Math.abs(candidate.payload.take_profit - 10) < 0.01);
});

function buildResponse(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload);
    },
  };
}
