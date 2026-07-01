const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePhaseBSourceRuntime, runPhaseBSources } = require('../src/meme-monitor/phase-b-source-runner');

test('phase B source runtime keeps market confirmation sources disabled by default', () => {
  const runtime = resolvePhaseBSourceRuntime({
    MEME_SOURCE_STOCKTWITS_ENABLED: 'false',
    MEME_SOURCE_POLYGON_ENABLED: 'false',
    MEME_SOURCE_ALPHA_VANTAGE_ENABLED: 'false',
  }, { features: {} });

  assert.equal(runtime.stocktwits, false);
  assert.equal(runtime.polygon, false);
  assert.equal(runtime.alphaVantage, false);
});

test('phase B source runner degrades safely when sources are off', async () => {
  const result = await runPhaseBSources({
    env: {
      MEME_SOURCE_STOCKTWITS_ENABLED: 'false',
      MEME_SOURCE_POLYGON_ENABLED: 'false',
      MEME_SOURCE_ALPHA_VANTAGE_ENABLED: 'false',
    },
    runtimeState: { features: {} },
    candidateSymbols: ['GME'],
    phaseASymbolsBySymbol: {
      GME: { symbol: 'GME', memeHeatScore: 80, marketConfirmationScore: 80, sourceConfirmations: {} },
    },
  });

  assert.equal(result.phaseB.status, 'off');
  assert.equal(result.sources.stocktwits.status, 'off');
});

