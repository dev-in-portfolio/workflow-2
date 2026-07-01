const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMemeSocialSourceConfig } = require('../src/meme-monitor/social-source-config');

test('meme social source config keeps tiered defaults and optional noise disabled', () => {
  const config = resolveMemeSocialSourceConfig({
    REDDIT_CLIENT_ID: 'client',
    REDDIT_CLIENT_SECRET: 'secret',
  });

  assert.equal(config.sourceDefinitions.some((entry) => entry.source === 'wallstreetbets' && entry.tier === 'tier_1' && entry.enabled), true);
  assert.equal(config.sourceDefinitions.some((entry) => entry.source === 'CryptoCurrency' && entry.enabled), false);
  assert.equal(config.optionalHighNoiseEnabled, false);
});

