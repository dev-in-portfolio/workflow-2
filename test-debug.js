const { createStockScanner } = require('./src/stock-scanner');
const http = require('http');

const requests = [];
const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
const scanner = createStockScanner({
  enabled: true,
  baseUrl: 'https://data.alpaca.markets',
  localBaseUrl: 'http://127.0.0.1:65535',
  apiKeyId: 'key',
  apiSecretKey: 'secret',
  symbols: ['MU', 'WDC'],
  intervalMs: 60_000,
  maxCandidatesPerRun: 1,
  maxOpenPositions: 1,
  marketOpen: true,
  recentTradePenalties: [
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'sell',
        recorded_at: new Date(Date.now() - 60_000).toISOString(),
        paper_result: {
          status: 'filled',
          filled_at: new Date(Date.now() - 60_000).toISOString(),
          order_id: 'recent-mu',
        },
      },
    },
  ],
  marketFetch: async (url) => {
    if (url.includes('/v2/positions')) return { ok: true, json: async () => [] };
    if (url.includes('/v2/orders?status=open')) return { ok: true, json: async () => [] };
    if (url.includes('/v2/account')) return { ok: true, json: async () => ({ cash: '500', buying_power: '500' }) };
    if (url.includes('/v2/stocks/snapshots?')) {
      return {
        ok: true,
        json: async () => ({
          snapshots: {
            MU: {
              latestQuote: { bp: 119.9, ap: 120.1, t: alpacaTimestamp },
              latestTrade: { p: 120, t: alpacaTimestamp },
              minuteBar: { v: 100000, h: 120.5, l: 119.5, t: alpacaTimestamp },
              prevDailyBar: { c: 100 },
            },
            WDC: {
              latestQuote: { bp: 104.9, ap: 105.1, t: alpacaTimestamp },
              latestTrade: { p: 105, t: alpacaTimestamp },
              minuteBar: { v: 100000, h: 105.5, l: 104.5, t: alpacaTimestamp },
              prevDailyBar: { c: 100 },
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  },
  localFetch: async (url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ accepted: true, final_decision: 'APPROVED_FOR_PAPER' }) };
  },
});

scanner.runOnce({ runId: 'recent-symbol-still-best' }).then((result) => {
  scanner.stop();
  if (!result.accepted) {
    console.error('FAIL: result not accepted');
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  if (requests.length !== 1) {
    console.error('FAIL: expected 1 request, got', requests.length);
    console.error(JSON.stringify({ requests, result }, null, 2));
    process.exit(1);
  }
  const req = requests[0];
  console.log('Symbol:', req.symbol);
  console.log('recent_trade_rank_penalty:', req.market_context?.scanner?.recent_trade_rank_penalty);
  console.log('rank_score:', req.market_context?.scanner?.rank_score);
  console.log('total candidates:', result.candidates?.length);

  if (req.market_context?.scanner?.recent_trade_rank_penalty !== 20) {
    console.error('FAIL: expected recent_trade_rank_penalty=20, got', req.market_context?.scanner?.recent_trade_rank_penalty);
    process.exit(1);
  }
  console.log('PASS');
}).catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
