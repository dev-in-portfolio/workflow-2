const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { buildStockCandidateForSymbol, createStockScanner } = require('../src');
const { APPROVED_LIVE_MARKET_SYMBOLS } = require('../src/volatile-stock-universe');

test('stock scanner builds real buy candidates from fresh bullish Alpaca data', () => {
  const candidate = buildStockCandidateForSymbol('NVDA', {
    latestQuote: {
      bp: 17.60,
      ap: 17.66,
      t: '2026-06-16T20:00:00.000Z',
    },
    latestTrade: {
      p: 17.63,
      t: '2026-06-16T20:00:00.000Z',
    },
    minuteBar: {
      v: 42,
      h: 17.72,
      l: 17.55,
      t: '2026-06-16T20:00:00.000Z',
    },
    prevDailyBar: {
      c: 17.40,
      v: 200000,
    },
  }, {
    bp: 17.60,
    ap: 17.66,
    t: '2026-06-16T20:00:00.000Z',
  }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    minMovePct: 0.25,
    maxSpreadPct: 0.8,
    notional: 150,
    runId: 'stock-test-run',
    assetType: 'stock',
  });

  assert(candidate);
  assert.equal(candidate.payload.action_candidate, 'paper_buy');
  assert.equal(candidate.payload.market_context.scanner.run_id, 'stock-test-run');
  assert.equal(candidate.payload.symbol, 'NVDA');
  assert.equal(candidate.payload.asset_type, 'stock');
});

test('stock scanner defaults to simplified live-market rules', () => {
  const scanner = createStockScanner({
    enabled: true,
    env: {},
    localBaseUrl: 'http://127.0.0.1:65535',
    marketFetch: async () => buildResponse({ snapshots: {} }),
    localFetch: async () => buildResponse({}),
  });

  assert.deepEqual(scanner.config.symbols, APPROVED_LIVE_MARKET_SYMBOLS);
  assert.equal(scanner.config.notional, 150);
  assert.equal(scanner.config.maxOpenPositions, 2);
  assert.equal(scanner.config.stopLossDollars, 10);
  assert.equal(scanner.config.trailingProfitStartDollars, 5);
  assert.equal(scanner.config.trailingProfitGivebackDollars, 3);
  scanner.stop();
});

test('stock scanner posts candidates to the local paper order endpoint', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
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

  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    twelveDataApiKey: 'twelve-key',
    twelveDataBaseUrl: 'https://api.twelvedata.com',
    localBaseUrl: `http://127.0.0.1:${localPort}`,
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['SOFI'],
    intervalMs: 60_000,
    cooldownMs: 60_000,
    minMovePct: 0.25,
    maxSpreadPct: 0.8,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse([]);
      }
      if (url.includes('/v2/orders?status=open')) {
        return buildResponse([]);
      }
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            SOFI: {
              latestQuote: { bp: 17.60, ap: 17.66, t: alpacaTimestamp },
              latestTrade: { p: 17.63, t: alpacaTimestamp },
              minuteBar: { v: 50, h: 17.72, l: 17.55, t: alpacaTimestamp },
              prevDailyBar: { c: 17.40, v: 100000 },
            },
          },
        });
      }
      if (url.includes('api.twelvedata.com/quote?')) {
        return buildResponse({
          data: [
            {
              symbol: 'SOFI',
              price: 17.65,
              datetime: alpacaTimestamp,
              volume: 1200,
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: global.fetch,
  });

  const result = await scanner.runOnce({ runId: 'stock-test-scan' });
  scanner.stop();
  await new Promise((resolve) => localServer.close(resolve));

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/paper-order');
  assert.equal(requests[0].body.action_candidate, 'paper_buy');
  assert.equal(requests[0].body.symbol, 'SOFI');
  assert.equal(requests[0].body.market_context.scanner.run_id, 'stock-test-scan');
});

test('stock scanner honors the configured approved rotation without fallback expansion', () => {
  const scanner = createStockScanner({
    enabled: false,
    env: {
      STOCK_SCANNER_SYMBOLS: 'SOFI,AAPL,AMD,INTC,MSFT,NVDA,AMZN,META,TSLA,GOOGL,PLTR,CRM',
    },
    marketFetch: async () => buildResponse({}),
    localFetch: async () => buildResponse({}),
  });

  assert.deepEqual(scanner.config.symbols, ['SOFI', 'AAPL', 'AMD', 'INTC', 'MSFT', 'NVDA', 'AMZN', 'META', 'TSLA', 'GOOGL', 'PLTR', 'CRM']);
  scanner.stop();
});

test('stock scanner creates a full-position sell at the dollar stop', () => {
  const candidate = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80', unrealized_pl: '-10.25' },
    stopLossDollars: 10,
    trailingProfitStartDollars: 5,
    trailingProfitGivebackDollars: 3,
    trailingState: { positions: {} },
  });

  assert(candidate);
  assert.equal(candidate.payload.side, 'sell');
  assert.equal(candidate.payload.quantity, 2);
  assert.equal(candidate.exitState.exit_reason, 'STOP_LOSS_DOLLARS');
});

test('stock scanner trails winners after peak profit and sell on giveback', () => {
  const beforeStart = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80', unrealized_pl: '4.50' },
    stopLossDollars: 10,
    trailingProfitStartDollars: 5,
    trailingProfitGivebackDollars: 3,
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 4.5 } } },
  });
  assert.equal(beforeStart, null);

  const risingWinner = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80', unrealized_pl: '12' },
    stopLossDollars: 10,
    trailingProfitStartDollars: 5,
    trailingProfitGivebackDollars: 3,
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 12 } } },
  });
  assert.equal(risingWinner, null);

  const giveback = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80', unrealized_pl: '8.90' },
    stopLossDollars: 10,
    trailingProfitStartDollars: 5,
    trailingProfitGivebackDollars: 3,
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 12 } } },
  });
  assert(giveback);
  assert.equal(giveback.payload.side, 'sell');
  assert.equal(giveback.exitState.exit_reason, 'TRAILING_PROFIT_GIVEBACK');
});

test('stock scanner batches large stock universes into multiple market-data requests', async () => {
  const requestedUrls = [];
  const symbols = Array.from({ length: 26 }, (_, index) => `T${String(index + 1).padStart(2, '0')}`);
  const snapshotPayload = Object.fromEntries(symbols.map((symbol) => ([
    symbol,
    {
      latestQuote: { bp: 10, ap: 10.1, t: '2026-06-16T20:00:00.000Z' },
      latestTrade: { p: 10.05, t: '2026-06-16T20:00:00.000Z' },
      minuteBar: { v: 1000, h: 10.2, l: 9.9, t: '2026-06-16T20:00:00.000Z' },
      prevDailyBar: { c: 10, v: 100000 },
    },
  ])));

  const scanner = createStockScanner({
    enabled: true,
    env: {
      STOCK_SCANNER_SYMBOLS: symbols.join(','),
    },
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    marketFetch: async (url) => {
      requestedUrls.push(url);
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({ snapshots: snapshotPayload });
      }
      return buildResponse({});
    },
    localFetch: async () => buildResponse({ accepted: true, final_decision: 'blocked' }),
    minMovePct: 999,
  });

  const result = await scanner.runOnce({ runId: 'batch-test' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requestedUrls.filter((url) => url.includes('/v2/stocks/snapshots?')).length, 2);
});

test('stock scanner skips buy candidates when buys are blocked', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
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

  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    twelveDataApiKey: 'twelve-key',
    twelveDataBaseUrl: 'https://api.twelvedata.com',
    localBaseUrl: `http://127.0.0.1:${localPort}`,
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['SOFI'],
    intervalMs: 60_000,
    cooldownMs: 60_000,
    minMovePct: 0.25,
    maxSpreadPct: 0.8,
    blockBuys: true,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse([]);
      }
      if (url.includes('/v2/orders?status=open')) {
        return buildResponse([]);
      }
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            SOFI: {
              latestQuote: { bp: 17.60, ap: 17.66, t: alpacaTimestamp },
              latestTrade: { p: 17.63, t: alpacaTimestamp },
              minuteBar: { v: 50, h: 17.72, l: 17.55, t: alpacaTimestamp },
              prevDailyBar: { c: 17.40, v: 100000 },
            },
          },
        });
      }
      if (url.includes('api.twelvedata.com/quote?')) {
        return buildResponse({
          data: [
            {
              symbol: 'SOFI',
              price: 17.65,
              datetime: alpacaTimestamp,
              volume: 1200,
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: global.fetch,
  });

  const result = await scanner.runOnce({ runId: 'stock-buy-block-test' });
  scanner.stop();
  await new Promise((resolve) => localServer.close(resolve));

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 0);
});

function stockSnapshot() {
  return {
    latestQuote: { bp: 79.95, ap: 80.05, t: '2026-06-16T20:00:00.000Z' },
    latestTrade: { p: 80, t: '2026-06-16T20:00:00.000Z' },
    minuteBar: { v: 50, h: 80.5, l: 79.5, t: '2026-06-16T20:00:00.000Z' },
    prevDailyBar: { c: 79, v: 100000 },
  };
}

function stockQuote() {
  return { bp: 79.95, ap: 80.05, t: '2026-06-16T20:00:00.000Z' };
}

function buildResponse(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload);
    },
  };
}
