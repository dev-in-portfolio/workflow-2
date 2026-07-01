const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMemeSocialSourceConfig } = require('../src/meme-monitor/social-source-config');
const { createRedditCollector } = require('../src/meme-monitor/reddit-collector');
const { scoreMentions } = require('../src/meme-monitor/mention-score');
const { classifyHotHotCandidate } = require('../src/meme-monitor/hot-hot-classifier');
const { resolveMemeEscalationPolicy } = require('../src/meme-monitor/meme-escalation-policy');

test('tiered meme source config keeps optional high-noise sources disabled by default', () => {
  const config = resolveMemeSocialSourceConfig({
    REDDIT_CLIENT_ID: 'client',
    REDDIT_CLIENT_SECRET: 'secret',
  });

  assert.equal(config.sourceDefinitions.some((entry) => entry.source === 'wallstreetbets' && entry.tier === 'tier_1' && entry.enabled), true);
  const optionalNoise = config.sourceDefinitions.find((entry) => entry.source === 'CryptoCurrency');
  assert(optionalNoise);
  assert.equal(optionalNoise.enabled, false);
  assert.equal(optionalNoise.status, 'disabled');
  assert.equal(config.sources.some((entry) => entry.source === 'CryptoCurrency'), false);
});

test('optional high-noise sources can be enabled through config', () => {
  const config = resolveMemeSocialSourceConfig({
    REDDIT_CLIENT_ID: 'client',
    REDDIT_CLIENT_SECRET: 'secret',
    MEME_REDDIT_SOURCES_OPTIONAL_HIGH_NOISE_ENABLED: 'true',
    MEME_REDDIT_SOURCES_OPTIONAL_HIGH_NOISE: 'CryptoCurrency,wallstreetbetscrypto',
  });

  assert.equal(config.optionalHighNoiseEnabled, true);
  assert.equal(config.sources.some((entry) => entry.source === 'CryptoCurrency'), true);
  assert.equal(config.sourceDefinitions.find((entry) => entry.source === 'CryptoCurrency')?.status, 'pending');
});

test('collector validates each subreddit and marks inaccessible sources inactive', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes('/api/v1/access_token')) {
      return jsonResponse(200, { access_token: 'token', expires_in: 3600 });
    }
    if (String(url).includes('/r/activeSource/about.json')) {
      return jsonResponse(200, { data: { subreddit_type: 'public' } });
    }
    if (String(url).includes('/r/inactiveSource/about.json')) {
      return jsonResponse(404, { message: 'not found' });
    }
    if (String(url).includes('/r/activeSource/hot')) {
      return jsonResponse(200, {
        data: {
          children: [{
            data: {
              id: 'post-1',
              title: 'GME is heating up',
              selftext: '',
              author: 'user1',
              created_utc: 1719756000,
              score: 12,
              num_comments: 0,
              permalink: '/r/activeSource/comments/post-1',
            },
          }],
        },
      });
    }
    if (String(url).includes('/r/activeSource/rising')) {
      return jsonResponse(200, {
        data: {
          children: [],
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const collector = createRedditCollector({ fetchImpl });
  const result = await collector.collectSources({
    env: {
      REDDIT_CLIENT_ID: 'client',
      REDDIT_CLIENT_SECRET: 'secret',
      REDDIT_USER_AGENT: 'workflow-2-meme-monitor-test',
      MEME_REDDIT_SOURCES_TIER_1: 'activeSource,inactiveSource',
      MEME_REDDIT_SOURCES_TIER_2: ' ',
      MEME_REDDIT_SOURCES_TIER_3: ' ',
      MEME_REDDIT_SOURCES_TICKER_SPECIFIC: ' ',
      MEME_REDDIT_SOURCES_OPTIONAL_HIGH_NOISE: ' ',
      MEME_REDDIT_LISTINGS: 'hot',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
  assert.equal(calls.some((url) => String(url).includes('/api/v1/access_token')), true);
  assert.equal(result.sources.find((entry) => entry.source === 'activeSource')?.status, 'active');
  assert.equal(result.sources.find((entry) => entry.source === 'activeSource')?.symbolsDetected, 1);
  assert.equal(result.sources.find((entry) => entry.source === 'inactiveSource')?.status, 'inactive');
  assert.equal(result.sources.find((entry) => entry.source === 'inactiveSource')?.blockedReason, 'source_not_found_or_inaccessible');
});

test('collector honors configured listing modes, dedupes posts, and carries listing weights', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes('/api/v1/access_token')) {
      return jsonResponse(200, { access_token: 'token', expires_in: 3600 });
    }
    if (String(url).includes('/r/activeSource/about.json')) {
      return jsonResponse(200, { data: { subreddit_type: 'public' } });
    }
    if (String(url).includes('/r/activeSource/rising')) {
      return jsonResponse(200, {
        data: {
          children: [{
            data: {
              id: 'post-1',
              title: 'GME is heating up',
              selftext: '',
              author: 'user1',
              created_utc: 1719756000,
              score: 12,
              num_comments: 0,
              permalink: '/r/activeSource/comments/post-1',
            },
          }],
        },
      });
    }
    if (String(url).includes('/r/activeSource/hot')) {
      return jsonResponse(200, {
        data: {
          children: [{
            data: {
              id: 'post-1',
              title: 'Duplicate GME post',
              selftext: '',
              author: 'user1',
              created_utc: 1719756000,
              score: 9,
              num_comments: 0,
              permalink: '/r/activeSource/comments/post-1',
            },
          }],
        },
      });
    }
    if (String(url).includes('/r/activeSource/new')) {
      return jsonResponse(200, { data: { children: [] } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const collector = createRedditCollector({ fetchImpl });
  const result = await collector.collectSources({
    env: {
      REDDIT_CLIENT_ID: 'client',
      REDDIT_CLIENT_SECRET: 'secret',
      REDDIT_USER_AGENT: 'workflow-2-meme-monitor-test',
      MEME_REDDIT_SOURCES_TIER_1: 'activeSource',
      MEME_REDDIT_SOURCES_TIER_2: ' ',
      MEME_REDDIT_SOURCES_TIER_3: ' ',
      MEME_REDDIT_SOURCES_TICKER_SPECIFIC: ' ',
      MEME_REDDIT_SOURCES_OPTIONAL_HIGH_NOISE: ' ',
      MEME_REDDIT_LISTINGS: 'rising,hot,new',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].listing, 'rising');
  assert.equal(result.records[0].listingWeight, 1.25);
  assert.equal(result.sources.find((entry) => entry.source === 'activeSource')?.status, 'active');
  assert.deepEqual(result.sources.find((entry) => entry.source === 'activeSource')?.listings, ['rising', 'hot', 'new']);
  assert.equal(calls.some((url) => String(url).includes('/r/activeSource/rising')), true);
  assert.equal(calls.some((url) => String(url).includes('/r/activeSource/hot')), true);
  assert.equal(calls.some((url) => String(url).includes('/r/activeSource/new')), true);
});

test('collector marks missing credentials as missing_credentials without crashing', async () => {
  const collector = createRedditCollector({
    fetchImpl: async () => {
      throw new Error('should not fetch without credentials');
    },
  });
  const result = await collector.collectSources({
    env: {
      REDDIT_CLIENT_ID: 'client',
      REDDIT_USER_AGENT: 'workflow-2-meme-monitor-test',
      MEME_REDDIT_SOURCES_TIER_1: 'activeSource',
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

test('tier 1 mentions carry more confidence than tier 2 mentions', () => {
  const baseMention = {
    symbol: 'GME',
    author: 'user1',
    createdAt: '2026-06-30T14:00:00.000Z',
    kind: 'post',
    engagement: 0,
  };
  const tier1Score = scoreMentions([
    { ...baseMention, source: 'reddit:wallstreetbets', sourceTier: 'tier_1', sourceWeight: 1.35 },
    { ...baseMention, sourceId: 'p2', source: 'reddit:wallstreetbets', sourceTier: 'tier_1', sourceWeight: 1.35 },
  ], { generatedAt: '2026-06-30T14:05:00.000Z' })[0];

  const tier2Score = scoreMentions([
    { ...baseMention, source: 'reddit:stocks', sourceTier: 'tier_2', sourceWeight: 1.0 },
    { ...baseMention, sourceId: 'p2', source: 'reddit:stocks', sourceTier: 'tier_2', sourceWeight: 1.0 },
  ], { generatedAt: '2026-06-30T14:05:00.000Z' })[0];

  assert(tier1Score.confidenceScore > tier2Score.confidenceScore);
});

test('tier 3 and ticker-specific communities do not auto-promote to hot hot without stronger confirmation', () => {
  const policy = resolveMemeEscalationPolicy({
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'true',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
    MEME_DYNAMIC_MIN_SCORE: '30',
    MEME_HOT_CANDIDATE_MIN_SCORE: '35',
    MEME_HOT_HOT_MIN_SCORE: '45',
    MEME_MARKET_CONFIRMATION_MIN_SCORE: '30',
  });

  const tier3Only = classifyHotHotCandidate({
    symbol: 'GME',
    memeHeatScore: 96,
    marketConfirmation: {
      available: true,
      marketConfirmationScore: 35,
      reasonCodes: ['tradable_confirmed'],
    },
    sourceProfile: {
      tierCounts: { tier_3: 3 },
    },
    policy,
    now: new Date('2026-06-30T14:05:00.000Z'),
  });

  const tickerSpecificOnly = classifyHotHotCandidate({
    symbol: 'BBBY',
    memeHeatScore: 96,
    marketConfirmation: {
      available: true,
      marketConfirmationScore: 35,
      reasonCodes: ['tradable_confirmed'],
    },
    sourceProfile: {
      tierCounts: { ticker_specific: 3 },
    },
    policy,
    now: new Date('2026-06-30T14:05:00.000Z'),
  });

  assert.notEqual(tier3Only.status, 'hot_hot');
  assert(tier3Only.reasonCodes.includes('tier_3_context_only'));
  assert.notEqual(tickerSpecificOnly.status, 'hot_hot');
  assert(tickerSpecificOnly.reasonCodes.includes('ticker_specific_requires_stronger_confirmation'));
});

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}
