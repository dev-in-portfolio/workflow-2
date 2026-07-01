const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchAlpacaMarketSignals,
  fetchAlpacaAssetSignals,
  fetchNasdaqHaltsSignals,
  fetchSecEdgarSignals,
  resolvePhaseASourceRuntime,
  runPhaseASources,
} = require('../src/meme-monitor/phase-a-source-runner');

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function textResponse(text, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return text;
    },
  };
}

test('phase A adapters surface market, tradability, halt, and SEC signals', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/v2/stocks/snapshots')) {
      return jsonResponse({
        snapshots: {
          GME: {
            latestTrade: { p: 28.12, s: 1200 },
            latestQuote: { ap: 28.2, bp: 28.05 },
            dailyBar: { o: 26.5, c: 27.8, v: 1823000 },
            previousDailyBar: { c: 25.8, v: 1542000 },
          },
        },
      });
    }
    if (String(url).endsWith('/v2/assets')) {
      return jsonResponse([
        { symbol: 'GME', tradable: false, status: 'inactive', asset_class: 'us_equity', exchange: 'NYSE' },
      ]);
    }
    if (String(url).includes('TradeHaltRSS')) {
      return textResponse('<rss><symbol>GME</symbol></rss>');
    }
    if (String(url).includes('company_tickers.json')) {
      return jsonResponse({
        0: { ticker: 'GME', cik_str: 1326380 },
      });
    }
    if (String(url).includes('CIK0001326380.json')) {
      return jsonResponse({
        filings: {
          recent: {
            form: ['8-K', 'S-1'],
            filingDate: ['2026-06-29', '2026-06-28'],
            reportDate: ['2026-06-29', '2026-06-28'],
            accessionNumber: ['0001', '0002'],
          },
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const market = await fetchAlpacaMarketSignals({
    env: {
      ALPACA_API_KEY_ID: 'key',
      ALPACA_API_SECRET_KEY: 'secret',
      MEME_MARKET_CONFIRMATION_MIN_SCORE: '70',
    },
    fetchImpl,
    symbols: ['GME'],
  });
  assert.equal(market.sourceStatus.status, 'active');
  assert.equal(market.symbols[0].symbol, 'GME');
  assert.equal(market.symbols[0].available, true);
  assert.equal(market.symbols[0].details.currentPrice, 28.12);

  const assets = await fetchAlpacaAssetSignals({
    env: {
      ALPACA_API_KEY_ID: 'key',
      ALPACA_API_SECRET_KEY: 'secret',
    },
    fetchImpl,
    symbols: ['GME'],
  });
  assert.equal(assets.sourceStatus.status, 'active');
  assert.equal(assets.symbols[0].tradableStatus, 'blocked');
  assert.equal(assets.symbols[0].marketContext.excluded, true);

  const halts = await fetchNasdaqHaltsSignals({ env: {}, fetchImpl, symbols: ['GME'] });
  assert.equal(halts.sourceStatus.status, 'active');
  assert.equal(halts.symbols[0].haltStatus, 'halted');

  const sec = await fetchSecEdgarSignals({ env: { MEME_SEC_EDGAR_LOOKBACK_DAYS: '5' }, fetchImpl, symbols: ['GME'] });
  assert.equal(sec.sourceStatus.status, 'active');
  assert.equal(sec.symbols[0].catalystScore > 0, true);
  assert(sec.symbols[0].riskWarnings.includes('sec_offering_risk_detected'));
});

test('phase A alpaca market reports missing credentials before scanning', async () => {
  const market = await fetchAlpacaMarketSignals({
    env: {},
    fetchImpl: async () => {
      throw new Error('should not fetch without credentials');
    },
    symbols: ['GME'],
  });
  assert.equal(market.sourceStatus.status, 'missing_credentials');
  assert.equal(market.symbols.length, 0);
});

test('phase A runtime marks inactive sources without crashing when feature flags are off', async () => {
  const phaseA = await runPhaseASources({
    env: {
      MEME_SOURCE_REDDIT_ENABLED: 'false',
      MEME_SOURCE_ALPACA_MARKET_ENABLED: 'false',
      MEME_SOURCE_ALPACA_ASSETS_ENABLED: 'false',
      MEME_SOURCE_NASDAQ_HALTS_ENABLED: 'false',
      MEME_SOURCE_SEC_EDGAR_ENABLED: 'false',
    },
    fetchImpl: async () => {
      throw new Error('should not be called');
    },
    runtimeState: {
      features: {},
    },
  });

  assert.equal(resolvePhaseASourceRuntime({
    MEME_SOURCE_REDDIT_ENABLED: 'false',
    MEME_SOURCE_ALPACA_MARKET_ENABLED: 'false',
    MEME_SOURCE_ALPACA_ASSETS_ENABLED: 'false',
    MEME_SOURCE_NASDAQ_HALTS_ENABLED: 'false',
    MEME_SOURCE_SEC_EDGAR_ENABLED: 'false',
  }, { features: {} }).reddit, false);
  assert.equal(phaseA.phaseA.status, 'active');
  assert.equal(phaseA.phaseA.sources.reddit.status, 'inactive');
  assert.equal(phaseA.phaseA.sources.reddit.blockedReason, 'source_disabled');
  assert.equal(Array.isArray(phaseA.phaseA.symbols), true);
});
