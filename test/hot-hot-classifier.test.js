const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyHotHotCandidate } = require('../src/meme-monitor/hot-hot-classifier');

test('hot hot classifier keeps tier 3 and ticker-specific context gated', () => {
  const commonArgs = {
    symbol: 'GME',
    memeHeatScore: 96,
    marketConfirmation: {
      available: true,
      marketConfirmationScore: 75,
      reasonCodes: ['tradable_confirmed'],
    },
    now: new Date('2026-06-30T14:05:00.000Z'),
  };

  const tier3Only = classifyHotHotCandidate({ ...commonArgs, sourceProfile: { tierCounts: { tier_3: 3 } } });
  const tickerSpecificOnly = classifyHotHotCandidate({ ...commonArgs, sourceProfile: { tierCounts: { ticker_specific: 3 } } });

  assert.notEqual(tier3Only.status, 'hot_hot');
  assert(tier3Only.reasonCodes.includes('tier_3_context_only'));
  assert.notEqual(tickerSpecificOnly.status, 'hot_hot');
  assert(tickerSpecificOnly.reasonCodes.includes('ticker_specific_requires_stronger_confirmation'));
});
