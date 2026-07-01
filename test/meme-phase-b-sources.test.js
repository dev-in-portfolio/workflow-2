const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchStocktwitsSignals,
} = require('../src/meme-monitor/sources/stocktwits-source');
const {
  fetchPolygonMarketSignals,
} = require('../src/meme-monitor/sources/polygon-market-source');
const {
  fetchAlphaVantageSignals,
} = require('../src/meme-monitor/sources/alpha-vantage-source');
const {
  resolvePhaseBSourceRuntime,
  runPhaseBSources,
} = require('../src/meme-monitor/phase-b-source-runner');

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

test('phase B flags default off and runtime resolves them as disabled', () => {
  const runtime = resolvePhaseBSourceRuntime({
    MEME_SOURCE_STOCKTWITS_ENABLED: 'false',
    MEME_SOURCE_POLYGON_ENABLED: 'false',
    MEME_SOURCE_ALPHA_VANTAGE_ENABLED: 'false',
  }, { features: {} });
  assert.equal(runtime.stocktwits, false);
  assert.equal(runtime.polygon, false);
  assert.equal(runtime.alphaVantage, false);
});

test('phase B sources fail closed on missing credentials', async () => {
  const stocktwits = await fetchStocktwitsSignals({ env: {}, fetchImpl: async () => { throw new Error('no fetch'); }, symbols: ['SOUN'] });
  const polygon = await fetchPolygonMarketSignals({ env: {}, fetchImpl: async () => { throw new Error('no fetch'); }, symbols: ['SOUN'] });
  const alpha = await fetchAlphaVantageSignals({ env: {}, fetchImpl: async () => { throw new Error('no fetch'); }, symbols: ['SOUN'] });
  assert.equal(stocktwits.sourceStatus.status, 'missing_credentials');
  assert.equal(polygon.sourceStatus.status, 'missing_credentials');
  assert.equal(alpha.sourceStatus.status, 'missing_credentials');
});

test('phase B adapters contribute cross-source confirmation when enabled', async () => {
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('stocktwits.com')) {
      return jsonResponse({
        messages: [
          { id: 1, user: { username: 'alpha' }, entities: { sentiment: { basic: 'bullish' } }, body: '$SOUN to the moon' },
          { id: 2, user: { username: 'beta' }, entities: { sentiment: { basic: 'bullish' } }, body: '$SOUN breakout' },
          { id: 3, user: { username: 'gamma' }, entities: { sentiment: { basic: 'mixed' } }, body: '$SOUN watch' },
        ],
      });
    }
    if (href.includes('polygon.io')) {
      return jsonResponse({
        ticker: {
          lastTrade: { p: 23.25 },
          prevDay: { c: 20.1, v: 1200000 },
          day: { o: 21.0, c: 23.1, v: 2400000 },
          lastQuote: { bp: 23.2, ap: 23.3 },
        },
      });
    }
    if (href.includes('alphavantage.co')) {
      return jsonResponse({
        'Time Series (5min)': {
          '2026-06-30 14:05:00': { '4. close': '23.3' },
          '2026-06-30 14:00:00': { '4. close': '22.8' },
        },
        feed: [
          { title: 'SOUN news', summary: '$SOUN sentiment improving', overall_sentiment_score_label: 'Bullish' },
        ],
      });
    }
    throw new Error(`Unexpected url ${href}`);
  };

  const result = await runPhaseBSources({
    env: {
      MEME_SOURCE_STOCKTWITS_ENABLED: 'true',
      MEME_SOURCE_POLYGON_ENABLED: 'true',
      MEME_SOURCE_ALPHA_VANTAGE_ENABLED: 'true',
      STOCKTWITS_API_KEY: 'test',
      POLYGON_API_KEY: 'test',
      ALPHA_VANTAGE_API_KEY: 'test',
      MEME_ALPHA_VANTAGE_USE_INTRADAY: 'true',
      MEME_ALPHA_VANTAGE_USE_NEWS_SENTIMENT: 'true',
    },
    fetchImpl,
    runtimeState: {
      features: {},
    },
    candidateSymbols: ['SOUN'],
    phaseASymbolsBySymbol: {
      SOUN: {
        symbol: 'SOUN',
        memeHeatScore: 88,
        marketConfirmationScore: 81,
        tradableStatus: 'tradable',
        haltStatus: 'not_halted',
        riskBlockScore: 0,
        sourceConfirmations: { reddit: true, alpacaMarket: true, alpacaAssets: true, nasdaqHalts: true, secEdgar: true },
        reasonCodes: ['reddit_tier_1_signal'],
        riskWarnings: [],
      },
    },
  });

  assert.equal(result.phaseB.status, 'active');
  assert.equal(result.phaseB.sources.stocktwits.status, 'active');
  assert.equal(result.phaseB.sources.polygon.status, 'active');
  assert.equal(result.phaseB.sources.alphaVantage.status, 'active');
  assert.equal(result.symbols[0].symbol, 'SOUN');
  assert.equal(result.symbols[0].socialConfirmation.stocktwits > 0, true);
  assert.equal(result.symbols[0].marketConfirmation.polygon > 0, true);
  assert.equal(result.symbols[0].marketConfirmation.alphaVantage > 0, true);
  assert.equal(result.symbols[0].borderlineUpgrade, true);
  assert.equal(result.symbols[0].crossSourceConfirmation, true);
  assert.equal(result.symbols[0].status === 'hot_hot' || result.symbols[0].status === 'hot_candidate', true);
});

test('phase B hard blocks remain blocked even with strong excitement', async () => {
  const result = await runPhaseBSources({
    env: {
      MEME_SOURCE_STOCKTWITS_ENABLED: 'false',
      MEME_SOURCE_POLYGON_ENABLED: 'false',
      MEME_SOURCE_ALPHA_VANTAGE_ENABLED: 'false',
    },
    runtimeState: {
      features: {},
    },
    candidateSymbols: ['XYZ'],
    phaseASymbolsBySymbol: {
      XYZ: {
        symbol: 'XYZ',
        memeHeatScore: 95,
        marketConfirmationScore: 92,
        tradableStatus: 'blocked',
        haltStatus: 'halted',
        riskBlockScore: 80,
        sourceConfirmations: { reddit: true, alpacaMarket: true, alpacaAssets: false, nasdaqHalts: false, secEdgar: false },
        reasonCodes: ['reddit_tier_1_signal'],
        riskWarnings: ['possible_halt_risk'],
      },
    },
  });

  assert.equal(result.symbols[0].status, 'blocked');
  assert.equal(result.symbols[0].riskConfirmation.alpacaAssets, 'blocked');
  assert.equal(result.symbols[0].riskConfirmation.nasdaqHalts, 'halted');
});
