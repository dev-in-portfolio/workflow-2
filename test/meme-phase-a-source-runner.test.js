const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePhaseASourceRuntime, runPhaseASources } = require('../src/meme-monitor/phase-a-source-runner');

test('phase A source runtime keeps sources off by default and falls back safely', async () => {
  const runtime = resolvePhaseASourceRuntime({
    MEME_SOURCE_REDDIT_ENABLED: 'false',
    MEME_SOURCE_ALPACA_MARKET_ENABLED: 'false',
    MEME_SOURCE_ALPACA_ASSETS_ENABLED: 'false',
    MEME_SOURCE_NASDAQ_HALTS_ENABLED: 'false',
    MEME_SOURCE_SEC_EDGAR_ENABLED: 'false',
  }, { features: {} });

  assert.equal(runtime.reddit, false);
  const result = await runPhaseASources({
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
    runtimeState: { features: {} },
  });

  assert.equal(result.phaseA.sources.reddit.status, 'inactive');
});

