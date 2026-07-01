const test = require('node:test');
const assert = require('node:assert/strict');
const { createRedditCollector } = require('../src/meme-monitor/reddit-collector');

test('reddit collector degrades safely on missing credentials and validates source status', async () => {
  const collector = createRedditCollector({
    fetchImpl: async () => {
      throw new Error('should not fetch without credentials');
    },
  });

  const result = await collector.collectSources({
    env: {
      REDDIT_CLIENT_ID: 'client',
      REDDIT_USER_AGENT: 'workflow-2-meme-monitor-test',
      MEME_REDDIT_SOURCES_TIER_1: 'wallstreetbets',
      MEME_REDDIT_SOURCES_TIER_2: ' ',
      MEME_REDDIT_SOURCES_TIER_3: ' ',
      MEME_REDDIT_SOURCES_TICKER_SPECIFIC: ' ',
      MEME_REDDIT_SOURCES_OPTIONAL_HIGH_NOISE: ' ',
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'missing_credentials');
  assert.equal(result.sources[0].status, 'missing_credentials');
});

