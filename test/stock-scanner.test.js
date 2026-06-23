const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  buildStockCandidateForSymbol,
  calculateEffectiveStopLossDollars,
  createStockScanner,
  normalizeRecentTradePenaltyMap,
} = require('../src');
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
  assert.equal(candidate.payload.supports_fractional_shares, true);
});

test('stock scanner still builds candidates when the move is tiny and the spread is wide', () => {
  const candidate = buildStockCandidateForSymbol('NVDA', {
    latestQuote: {
      bp: 17.00,
      ap: 18.50,
      t: '2026-06-16T20:00:00.000Z',
    },
    latestTrade: {
      p: 17.75,
      t: '2026-06-16T20:00:00.000Z',
    },
    minuteBar: {
      v: 42,
      h: 18.0,
      l: 17.0,
      t: '2026-06-16T20:00:00.000Z',
    },
    prevDailyBar: {
      c: 17.74,
      v: 200000,
    },
  }, {
    bp: 17.00,
    ap: 18.50,
    t: '2026-06-16T20:00:00.000Z',
  }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    minMovePct: 999,
    maxSpreadPct: 0.01,
    notional: 150,
    runId: 'stock-test-wide',
    assetType: 'stock',
    allowContrarianEntries: true,
  });

  assert(candidate);
  assert.equal(candidate.payload.symbol, 'NVDA');
  assert.equal(candidate.payload.action_candidate, 'paper_buy');
});

test('stock scanner allows fractional stock buys when the budget is below one share', () => {
  const candidate = buildStockCandidateForSymbol('INTC', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    notional: 65.76,
    minMovePct: 0.25,
    allowContrarianEntries: true,
  });

  assert(candidate);
  assert.equal(candidate.payload.supports_fractional_shares, true);
});

test('stock scanner applies a 20 point rank penalty to a recent sell symbol', () => {
  const plain = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
  });
  const penalized = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
    recentTradePenalty: {
      symbol: 'NVDA',
      last_traded_at: '2026-06-16T19:58:01.000Z',
      penalty: 20,
      reason: 'compound_recent_sell',
    },
  });

  assert(plain);
  assert(penalized);
  assert.equal(Number((plain.rankScore - penalized.rankScore).toFixed(6)), 20);
  assert.equal(penalized.recentTradeRankPenalty, 20);
  assert.equal(penalized.payload.market_context.scanner.recent_trade_rank_penalty, 20);
  assert.equal(penalized.payload.market_context.scanner.recent_trade_penalty_reason, 'compound_recent_sell');
});

test('stock scanner compounds recent sell timers and ignores buys', () => {
  const penalties = normalizeRecentTradePenaltyMap([
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'buy',
        paper_result: {
          status: 'filled',
          filled_at: '2026-06-16T19:59:01.000Z',
          order_id: 'recent-buy-mu',
        },
      },
    },
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'sell',
        paper_result: {
          status: 'filled',
          filled_at: '2026-06-16T19:58:01.000Z',
          order_id: 'recent-sell-mu-1',
        },
      },
    },
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'sell',
        paper_result: {
          status: 'filled',
          filled_at: '2026-06-16T19:50:01.000Z',
          order_id: 'recent-sell-mu-2',
        },
      },
    },
  ], {
    now: '2026-06-16T20:00:01.000Z',
    windowMinutes: 15,
    penalty: 20,
    lossWindowMinutes: 10,
    lossPenalty: 60,
  });

  const penalty = penalties.get('MU');
  assert(penalty);
  assert.equal(penalty.penalty, 40);
  assert.equal(penalty.reason, 'compound_recent_sell');
  assert.equal(penalty.components.length, 2);
  assert.deepEqual(penalty.components.map((component) => component.remaining_seconds).sort((a, b) => b - a), [780, 300]);
});

test('stock scanner lets stacked sell timers decay as older timers expire', () => {
  const records = [
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'sell',
        paper_result: {
          status: 'filled',
          filled_at: '2026-06-16T19:58:01.000Z',
          order_id: 'recent-sell-mu-1',
        },
      },
    },
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'sell',
        paper_result: {
          status: 'filled',
          filled_at: '2026-06-16T19:50:01.000Z',
          order_id: 'recent-sell-mu-2',
        },
      },
    },
  ];
  const stacked = normalizeRecentTradePenaltyMap(records, {
    now: '2026-06-16T20:00:01.000Z',
    windowMinutes: 15,
    penalty: 20,
    lossWindowMinutes: 10,
    lossPenalty: 60,
  });
  const decayed = normalizeRecentTradePenaltyMap(records, {
    now: '2026-06-16T20:06:01.000Z',
    windowMinutes: 15,
    penalty: 20,
    lossWindowMinutes: 10,
    lossPenalty: 60,
  });

  assert.equal(stacked.get('MU').penalty, 40);
  assert.equal(decayed.get('MU').penalty, 20);
  assert.equal(decayed.get('MU').components.length, 1);
});

test('stock scanner stacks losing sell penalty with the normal recent sell timer', () => {
  const penalties = normalizeRecentTradePenaltyMap([
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'sell',
        pnl: -1.12,
        paper_result: {
          status: 'filled',
          filled_at: '2026-06-16T19:58:01.000Z',
          order_id: 'loss-exit-mu',
        },
        original_signal: {
          market_context: {
            exit_state: {
              exit_reason: 'STOP_LOSS_DOLLARS',
              unrealized_pl: -1.12,
            },
          },
        },
      },
    },
  ], {
    now: '2026-06-16T20:00:01.000Z',
    windowMinutes: 15,
    penalty: 20,
    lossWindowMinutes: 10,
    lossPenalty: 60,
  });

  const penalty = penalties.get('MU');
  assert(penalty);
  assert.equal(penalty.penalty, 80);
  assert.equal(penalty.reason, 'compound_recent_sell_and_loss');
  assert.equal(penalty.loss_exit, true);
  assert.equal(penalty.exit_reason, 'STOP_LOSS_DOLLARS');
  assert.deepEqual(penalty.components.map((component) => component.reason).sort(), ['recent_loss_exit', 'recent_sell']);
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
  assert.equal(scanner.config.stopLossDollars, 1);
  assert.equal(scanner.config.stopLossNotionalPct, 0.75);
  assert.equal(scanner.config.stopLossMaxDollars, 2.5);
  assert.equal(scanner.config.trailingProfitStartDollars, 0.5);
  assert.equal(scanner.config.trailingProfitGivebackDollars, 0.3);
  assert.equal(scanner.config.recentTradePenaltyMinutes, 15);
  assert.equal(scanner.config.recentTradeRankPenalty, 20);
  assert.equal(scanner.config.recentLossPenaltyMinutes, 10);
  assert.equal(scanner.config.recentLossRankPenalty, 60);
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
    marketOpen: true,
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
  assert.equal(requests[0].body.supports_fractional_shares, true);
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
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80.75', unrealized_pl: '-1.25' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: {} },
  });

  assert(candidate);
  assert.equal(candidate.payload.side, 'sell');
  assert.equal(candidate.payload.quantity, 2);
  assert.equal(candidate.exitState.exit_reason, 'STOP_LOSS_DOLLARS');
  assert.equal(candidate.exitState.gross_pnl, -1.5);
  assert.equal(candidate.exitState.execution_drag, 0);
  assert.equal(candidate.exitState.net_pnl, -1.5);
  assert.equal(candidate.exitState.real_gain, false);
});

test('stock scanner widens the hard stop by position notional with a cap', () => {
  assert.equal(calculateEffectiveStopLossDollars({
    baseStopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    positionMarketValue: 260,
  }), 1.95);
  assert.equal(calculateEffectiveStopLossDollars({
    baseStopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    positionMarketValue: 1000,
  }), 2.5);

  const normalWiggle = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80.75', market_value: '260', unrealized_pl: '-1.25' },
    stopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: {} },
  });
  assert.equal(normalWiggle, null);

  const breach = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80.75', market_value: '260', unrealized_pl: '-2.05' },
    stopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: {} },
  });
  assert(breach);
  assert.equal(breach.payload.side, 'sell');
  assert.equal(breach.exitState.exit_reason, 'STOP_LOSS_DOLLARS');
  assert.equal(breach.exitState.stop_loss_dollars, 1.95);
  assert.equal(breach.exitState.base_stop_loss_dollars, 1);
  assert.equal(breach.exitState.distance_to_stop_dollars, -0.1);
});

test('stock scanner run applies the widened hard stop to live positions', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['NVDA'],
    intervalMs: 60_000,
    maxOpenPositions: 1,
    marketOpen: true,
    stopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse([
          { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80.75', market_value: '260', unrealized_pl: '-1.25' },
        ]);
      }
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '0', buying_power: '0' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            NVDA: {
              latestQuote: { bp: 79.95, ap: 80.05, t: alpacaTimestamp },
              latestTrade: { p: 80, t: alpacaTimestamp },
              minuteBar: { v: 50, h: 80.5, l: 79.5, t: alpacaTimestamp },
              prevDailyBar: { c: 79, v: 100000 },
            },
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (...args) => {
      requests.push(args);
      return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
    },
  });

  const result = await scanner.runOnce({ runId: 'stock-widened-stop-run' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 0);
  assert.equal(result.skip_summary.EXIT_TARGET_NOT_MET, 1);
});

test('stock scanner trails winners after peak profit and sell on giveback', () => {
  const beforeStart = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80', unrealized_pl: '0.49' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 0.49 } } },
  });
  assert.equal(beforeStart, null);

  const risingWinner = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80', unrealized_pl: '0.80' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 0.8 } } },
  });
  assert.equal(risingWinner, null);

  const giveback = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '79.85', unrealized_pl: '0.45', entry_slippage: '0.03', exit_slippage: '0.02', fees: '0.01' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 0.8 } } },
  });
  assert(giveback);
  assert.equal(giveback.payload.side, 'sell');
  assert.equal(giveback.exitState.exit_reason, 'TRAILING_PROFIT_GIVEBACK');
  assert.equal(giveback.exitState.gross_pnl, 0.3);
  assert.equal(giveback.exitState.execution_drag, 0.06);
  assert.equal(giveback.exitState.net_pnl, 0.24);
  assert.equal(giveback.exitState.real_gain, true);
});

test('stock scanner does not apply recent-symbol rank penalties to sell exits', () => {
  const candidate = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80.75', unrealized_pl: '-1.25' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: {} },
    recentTradePenalty: {
      symbol: 'NVDA',
      last_traded_at: '2026-06-16T19:58:01.000Z',
      penalty: 8,
    },
  });

  assert(candidate);
  assert.equal(candidate.payload.side, 'sell');
  assert.equal(candidate.payload.market_context.scanner.recent_trade_rank_penalty, 0);
  assert.equal(candidate.exitState.exit_reason, 'STOP_LOSS_DOLLARS');
});

test('stock scanner can still select a recently traded symbol when its adjusted rank remains highest', async () => {
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
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            MU: rankedSnapshot({ bid: 119.9, ask: 120.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
            WDC: rankedSnapshot({ bid: 104.9, ask: 105.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return buildResponse({ accepted: true, final_decision: 'APPROVED_FOR_PAPER' });
    },
  });

  const result = await scanner.runOnce({ runId: 'recent-symbol-still-best' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].symbol, 'MU');
  assert.equal(requests[0].market_context.scanner.recent_trade_rank_penalty, 20);
  assert(requests[0].market_context.scanner.rank_score > 0);
});

test('stock scanner rotates away from a recent losing exit when another rank is close', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const recentLossAt = new Date(Date.now() - 60_000).toISOString();
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
          pnl: -1.05,
          recorded_at: recentLossAt,
          paper_result: {
            status: 'filled',
            filled_at: recentLossAt,
            order_id: 'recent-loss-mu',
          },
          original_signal: {
            market_context: {
              exit_state: {
                exit_reason: 'STOP_LOSS_DOLLARS',
                unrealized_pl: -1.05,
              },
            },
          },
        },
      },
    ],
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            MU: rankedSnapshot({ bid: 119.9, ask: 120.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
            WDC: rankedSnapshot({ bid: 116.9, ask: 117.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return buildResponse({ accepted: true, final_decision: 'APPROVED_FOR_PAPER' });
    },
  });

  const result = await scanner.runOnce({ runId: 'recent-loss-rotation' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].symbol, 'WDC');
});

test('stock scanner rotates away from stacked recent sells when another rank is close', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const firstSellAt = new Date(Date.now() - 60_000).toISOString();
  const secondSellAt = new Date(Date.now() - 8 * 60_000).toISOString();
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
          recorded_at: firstSellAt,
          paper_result: {
            status: 'filled',
            filled_at: firstSellAt,
            order_id: 'recent-sell-mu-1',
          },
        },
      },
      {
        entry_type: 'paper_outcome',
        record: {
          symbol: 'MU',
          side: 'sell',
          recorded_at: secondSellAt,
          paper_result: {
            status: 'filled',
            filled_at: secondSellAt,
            order_id: 'recent-sell-mu-2',
          },
        },
      },
    ],
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            MU: rankedSnapshot({ bid: 119.9, ask: 120.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
            WDC: rankedSnapshot({ bid: 116.9, ask: 117.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return buildResponse({ accepted: true, final_decision: 'APPROVED_FOR_PAPER' });
    },
  });

  const result = await scanner.runOnce({ runId: 'stacked-recent-sell-rotation' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].symbol, 'WDC');
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
    marketOpen: true,
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
    marketOpen: true,
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

test('stock scanner blocks stock buys while the US market is closed', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['NVDA'],
    intervalMs: 60_000,
    cooldownMs: 60_000,
    minMovePct: 0.25,
    maxSpreadPct: 0.8,
    marketOpen: false,
    requireMarketOpen: true,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            NVDA: {
              latestQuote: { bp: 17.60, ap: 17.66, t: alpacaTimestamp },
              latestTrade: { p: 17.63, t: alpacaTimestamp },
              minuteBar: { v: 50, h: 17.72, l: 17.55, t: alpacaTimestamp },
              prevDailyBar: { c: 17.40, v: 100000 },
            },
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (...args) => {
      requests.push(args);
      return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
    },
  });

  const result = await scanner.runOnce({ runId: 'stock-market-closed-test' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 0);
  assert.equal(result.skip_summary.MARKET_CLOSED_FOR_STOCKS, 2);
});

test('stock scanner counts all live Alpaca positions against the max-position cap', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['NVDA'],
    intervalMs: 60_000,
    cooldownMs: 60_000,
    minMovePct: 0.25,
    maxSpreadPct: 0.8,
    maxOpenPositions: 2,
    marketOpen: true,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse([
          { symbol: 'AAPL', qty: '1' },
          { symbol: 'MSFT', qty: '1' },
        ]);
      }
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            NVDA: {
              latestQuote: { bp: 17.60, ap: 17.66, t: alpacaTimestamp },
              latestTrade: { p: 17.63, t: alpacaTimestamp },
              minuteBar: { v: 50, h: 17.72, l: 17.55, t: alpacaTimestamp },
              prevDailyBar: { c: 17.40, v: 100000 },
            },
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (...args) => {
      requests.push(args);
      return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
    },
  });

  const result = await scanner.runOnce({ runId: 'stock-max-live-positions-test' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 0);
  assert.equal(result.portfolio.open_positions_count, 2);
  assert.equal(result.skip_summary.MAX_POSITION_SLOTS_FILLED, 2);
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

function rankedSnapshot({ bid, ask, previousClose, volume, timestamp }) {
  const midpoint = (bid + ask) / 2;
  return {
    latestQuote: { bp: bid, ap: ask, t: timestamp },
    latestTrade: { p: midpoint, t: timestamp },
    minuteBar: { v: 50, h: midpoint + 0.5, l: midpoint - 0.5, t: timestamp },
    prevDailyBar: { c: previousClose, v: volume },
  };
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
