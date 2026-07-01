const path = require('path');
const { resolveMemeSocialSourceConfig } = require('./social-source-config');
const { saveMemeMonitorStatus } = require('./meme-monitor-status');
const { resolveMemeMonitorStatusPath } = require('./meme-monitor-status');
const { nowIso } = require('../util');
const {
  buildSourceStatus,
  classifyHttpSourceStatus,
  fetchJsonWithTimeout,
  normalizeCacheMeta,
  redactSourceMessage,
  stableCacheKey,
} = require('../source-fetch');
const { URLSearchParams } = require('url');

function createRedditCollector(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('Reddit collector requires fetch support');
  }

  let accessToken = null;
  let tokenExpiresAt = 0;

  async function collectSources(input = {}) {
    const env = input.env || options.env || process.env;
    const config = resolveMemeSocialSourceConfig(env, input.runtimeState || null);
    const statusPath = options.statusPath || input.statusPath || resolveMemeMonitorStatusPath({ dataDir: input.dataDir || options.dataDir, repoRoot: input.repoRoot || options.repoRoot, filePath: options.statusPath });
    const sourceStates = [];
    const collected = [];
    const rejected = [];
    const seenRecords = new Set();

    const redditClientId = config.redditClientId || config.REDDIT_CLIENT_ID || '';
    const redditClientSecret = config.redditClientSecret || config.REDDIT_CLIENT_SECRET || '';
    const redditUserAgent = config.redditUserAgent || config.REDDIT_USER_AGENT || 'workflow-2-meme-monitor';
    const sourceRuntime = {
      ...config,
      redditUserAgent,
      repoRoot: input.repoRoot || options.repoRoot || process.cwd(),
      dataDir: input.dataDir || options.dataDir || path.resolve(process.cwd(), 'data'),
      redditSourceCacheSeconds: resolveEnvNumber(env.MEME_REDDIT_SOURCE_CACHE_SECONDS, 60),
      redditValidationCacheSeconds: resolveEnvNumber(env.MEME_REDDIT_VALIDATION_CACHE_SECONDS, 300),
      redditRateLimitCooldownSeconds: resolveEnvNumber(env.MEME_REDDIT_RATE_LIMIT_COOLDOWN_SECONDS, 120),
      redditTimeoutMs: Math.max(1000, resolveEnvNumber(env.MEME_REDDIT_SOURCE_TIMEOUT_MS, Number(options.timeoutMs || 5000) || 5000)),
    };

    if (!redditClientId || !redditClientSecret) {
      for (const source of config.sourceDefinitions) {
        sourceStates.push(buildInactiveSourceState(source, 'missing_credentials', 'Unable to validate subreddit', 'missing_credentials'));
      }
      const payload = {
        ok: false,
        status: 'missing_credentials',
        mode: 'reddit-oauth',
        sources: sourceStates,
        records: [],
        rejected: [],
        symbolsDetected: 0,
        rejectedTokens: 0,
        message: 'Reddit credentials are missing',
      };
      persistSourceStatus(statusPath, payload, input);
      return payload;
    }

    const tokenResult = await getAccessToken({ ...sourceRuntime, redditClientId, redditClientSecret }, fetchImpl);
    if (!tokenResult.ok) {
      const sourceStatus = tokenResult.status || (tokenResult.error === 'reddit_auth_failed' ? 'error' : 'inactive');
      for (const source of config.sourceDefinitions) {
        sourceStates.push(buildInactiveSourceState(
          source,
          sourceStatus,
          tokenResult.message || tokenResult.error || 'Unable to validate subreddit',
          sourceStatus,
        ));
      }
      const payload = {
        ok: false,
        status: tokenResult.status || (tokenResult.error === 'reddit_auth_failed' ? 'error' : 'inactive'),
        error: tokenResult.error || 'reddit_auth_failed',
        message: tokenResult.message || 'Unable to authenticate with Reddit',
        mode: 'reddit-oauth',
        sources: sourceStates,
        records: [],
        rejected: [],
        symbolsDetected: 0,
        rejectedTokens: 0,
      };
      persistSourceStatus(statusPath, payload, input);
      return payload;
    }

    for (const source of config.sourceDefinitions) {
      const validation = await validateSource(source, sourceRuntime, tokenResult.accessToken, fetchImpl);
      sourceStates.push(validation.sourceState);
      if (validation.sourceState.status !== 'active') {
        continue;
      }
      const result = await collectSourceListing(validation.sourceState, sourceRuntime, tokenResult.accessToken, fetchImpl);
      if (result.sourceState) {
        sourceStates[sourceStates.length - 1] = result.sourceState;
      }
      for (const record of result.records) {
        const recordKey = buildRecordKey(record);
        if (recordKey && seenRecords.has(recordKey)) continue;
        if (recordKey) seenRecords.add(recordKey);
        collected.push(record);
      }
      rejected.push(...result.rejected);
      if (sourceStates[sourceStates.length - 1]?.status === 'active') {
        sourceStates[sourceStates.length - 1] = {
          ...sourceStates[sourceStates.length - 1],
          symbolsDetected: result.records.length,
          rejectedTokens: result.rejected.length,
          lastScanAt: result.records.length ? result.records[0]?.createdAt || nowIso() : validation.sourceState.lastScanAt || nowIso(),
        };
      }
    }

    const payload = {
      ok: true,
      status: 'ok',
      mode: 'reddit-oauth',
      sources: sourceStates,
      records: collected,
      rejected,
      symbolsDetected: collected.length,
      rejectedTokens: rejected.length,
    };
    persistSourceStatus(statusPath, payload, input);
    return payload;
  }

  async function getAccessToken(config, fetchImpl) {
    if (accessToken && Date.now() < tokenExpiresAt) {
      return { ok: true, accessToken };
    }

    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    const auth = Buffer.from(`${config.redditClientId}:${config.redditClientSecret}`).toString('base64');
    try {
      const result = await fetchJsonWithTimeout(fetchImpl, 'https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        timeoutMs: config.redditTimeoutMs || 5000,
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': config.redditUserAgent,
        },
        body,
      });
      const { response, body: payload } = result;
      if (!response.ok) {
        const classified = classifyHttpSourceStatus(response.status, payload, 'source_not_found_or_inaccessible');
        return {
          ok: false,
          status: classified.status || 'error',
          error: 'reddit_auth_failed',
          message: redactSourceMessage(classified.lastError || payload?.error || payload?.message || `HTTP ${response.status}`),
        };
      }
      accessToken = payload?.access_token || null;
      tokenExpiresAt = Date.now() + Math.max(60, Number(payload?.expires_in || 300) - 30) * 1000;
      if (!accessToken) {
        return {
          ok: false,
          status: 'error',
          error: 'reddit_auth_failed',
          message: 'Reddit auth did not return an access token',
        };
      }
      return { ok: true, accessToken };
    } catch (error) {
      return {
        ok: false,
        status: 'timeout',
        error: 'reddit_auth_timeout',
        message: redactSourceMessage(error?.message || 'Reddit auth timed out'),
      };
    }
  }

  async function collectSourceListing(source, config, token, fetchImpl) {
    const records = [];
    const rejected = [];
    const listings = resolveListingModes(config.redditListings);
    const seenKeys = new Set();
    let lastCache = null;

    for (const listing of listings) {
      const listingUrl = `https://oauth.reddit.com/r/${encodeURIComponent(source.source)}/${encodeURIComponent(listing)}?limit=${config.maxPostsPerSource}&raw_json=1`;
      try {
        const result = await fetchJsonWithTimeout(fetchImpl, listingUrl, {
          timeoutMs: config.redditTimeoutMs || 5000,
          headers: {
            authorization: `Bearer ${token}`,
            'user-agent': config.redditUserAgent,
          },
          cache: sourceCacheOptions({
            env: config,
            repoRoot: config.repoRoot,
            dataDir: config.dataDir,
          }, source.source, 'reddit/listing', config.redditSourceCacheSeconds, {
            listing,
            maxPostsPerSource: config.maxPostsPerSource,
            maxCommentsPerPost: config.maxCommentsPerPost,
          }),
        });
        lastCache = result.cache || lastCache;
        const { response, body } = result;
        if (!response.ok) {
          const inactive = classifyInactiveSource(source, response.status, body, result.cache, listing, config);
          return {
            records,
            rejected: rejected.concat([{ source: source.source, reason: redactSourceMessage(body?.error || body?.message || `HTTP ${response.status}`), listing }]),
            sourceState: inactive,
          };
        }
        const posts = body?.data?.children || [];
        for (const child of posts.slice(0, config.maxPostsPerSource)) {
          const post = child?.data || {};
          addRedditRecord(records, seenKeys, normalizeRedditPost(post, source, listing));
          if (config.maxCommentsPerPost > 0 && post?.num_comments) {
            const commentsResult = await collectCommentsForPost(post, source, token, config, fetchImpl, listing, seenKeys);
            if (commentsResult.sourceState && commentsResult.sourceState.status !== 'active') {
              return {
                records,
                rejected: rejected.concat(commentsResult.rejected || []),
                sourceState: commentsResult.sourceState,
              };
            }
            records.push(...commentsResult.records);
            rejected.push(...commentsResult.rejected);
          }
        }
      } catch (error) {
        return {
          records,
          rejected: rejected.concat([{ source: source.source, reason: redactSourceMessage(error?.message || 'Reddit listing timed out'), listing }]),
          sourceState: buildInactiveSourceState(source, 'timeout', redactSourceMessage(error?.message || 'Reddit listing timed out'), 'timeout', lastCache, listing),
        };
      }
    }

    return {
      records,
      rejected,
      sourceState: buildActiveSourceState(source, records, rejected, listings, lastCache),
    };
  }

  async function collectCommentsForPost(post, source, token, config, fetchImpl, listing, seenKeys = new Set()) {
    const permalink = post?.permalink;
    if (!permalink) return { records: [], rejected: [] };
    const maxCommentsPerPost = Math.max(0, Number(config.maxCommentsPerPost || 0));
    const commentsUrl = `https://oauth.reddit.com${permalink}.json?limit=${maxCommentsPerPost}&raw_json=1`;
    try {
      const result = await fetchJsonWithTimeout(fetchImpl, commentsUrl, {
        timeoutMs: config.redditTimeoutMs || 5000,
        headers: {
          authorization: `Bearer ${token}`,
          'user-agent': 'workflow-2-meme-monitor',
        },
        cache: sourceCacheOptions({
          env: config,
          repoRoot: config.repoRoot,
          dataDir: config.dataDir,
        }, source.source, 'reddit/comments', config.redditSourceCacheSeconds, {
          listing,
          postId: post.id || post.name || post.fullname || null,
          maxCommentsPerPost,
        }),
      });
      const { response, body } = result;
      if (!response.ok || !Array.isArray(body)) {
        return {
          records: [],
          rejected: [{ source: source.source, reason: redactSourceMessage(body?.error || body?.message || `HTTP ${response.status}`), listing }],
      sourceState: classifyInactiveSource(source, response.status, body, result.cache, listing, config),
        };
      }
      const commentListing = body[1]?.data?.children || [];
      const records = [];
      const rejected = [];
      for (const child of commentListing.slice(0, maxCommentsPerPost)) {
        const comment = child?.data || {};
        if (!comment?.body) continue;
        addRedditRecord(records, seenKeys, normalizeRedditComment(comment, source, post, listing));
      }
      return { records, rejected };
    } catch (error) {
      return {
        records: [],
        rejected: [{ source: source.source, reason: redactSourceMessage(error?.message || 'Reddit comments timed out'), listing }],
        sourceState: buildInactiveSourceState(source, 'timeout', error?.message || 'Reddit comments timed out', 'timeout', null, listing),
      };
    }
  }

  return {
    collectSources,
  };
}

function normalizeRedditPost(post = {}, source, listing = null) {
  return {
    kind: 'post',
    source: `reddit:${source.source}`,
    sourceMeta: {
      source: source.source,
      tier: source.tier,
      weight: source.tierWeight,
      status: source.status,
      listing,
      listingWeight: resolveListingWeight(listing),
    },
    sourceTier: source.tier,
    sourceWeight: source.tierWeight,
    sourceStatus: source.status,
    sourceId: post.id || post.name || post.fullname || null,
    threadId: post.id || post.name || null,
    author: post.author || null,
    createdAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
    engagement: Number(post.score || 0) + Number(post.num_comments || 0),
    title: post.title || null,
    body: post.selftext || '',
    text: post.title || post.selftext || '',
    commentCount: Number(post.num_comments || 0),
    url: post.permalink ? `https://www.reddit.com${post.permalink}` : null,
    listing,
    listingWeight: resolveListingWeight(listing),
  };
}

function normalizeRedditComment(comment = {}, source, post = {}, listing = null) {
  return {
    kind: 'comment',
    source: `reddit:${source.source}`,
    sourceMeta: {
      source: source.source,
      tier: source.tier,
      weight: source.tierWeight,
      status: source.status,
      listing,
      listingWeight: resolveListingWeight(listing),
    },
    sourceTier: source.tier,
    sourceWeight: source.tierWeight,
    sourceStatus: source.status,
    sourceId: comment.id || comment.name || null,
    threadId: post.id || post.name || comment.link_id || null,
    author: comment.author || null,
    createdAt: comment.created_utc ? new Date(comment.created_utc * 1000).toISOString() : null,
    engagement: Number(comment.score || 0),
    body: comment.body || '',
    text: comment.body || '',
    commentCount: 1,
    url: comment.permalink ? `https://www.reddit.com${comment.permalink}` : (post.permalink ? `https://www.reddit.com${post.permalink}` : null),
    listing,
    listingWeight: resolveListingWeight(listing),
  };
}

function resolveListingWeight(listing = '') {
  const normalized = String(listing || '').trim().toLowerCase();
  if (normalized === 'rising') return 1.25;
  if (normalized === 'hot') return 1;
  if (normalized === 'new') return 0.75;
  return 1;
}

function buildThreadKey(source, threadId) {
  const id = String(threadId || '').trim();
  if (!id) return null;
  return `${String(source || '').trim().toLowerCase()}::thread::${id}`;
}

function buildRecordKey(record = {}) {
  const source = String(record.source || '').trim().toLowerCase();
  const sourceId = String(record.sourceId || '').trim();
  const threadId = String(record.threadId || '').trim();
  const kind = String(record.kind || '').trim().toLowerCase();
  if (source && sourceId) return `${source}::${kind || 'record'}::${sourceId}`;
  if (source && threadId) return `${source}::thread::${threadId}::${kind || 'record'}`;
  return null;
}

function buildActiveSourceState(source, records, rejected, listings, cache = null) {
  const lastScanAt = records.length ? records[0]?.createdAt || nowIso() : nowIso();
  return buildSourceStatus({
    source: source.source,
    enabled: true,
    available: true,
    status: 'active',
    lastRunAt: lastScanAt,
    lastScanAt,
    lastError: null,
    blockedReason: null,
    cache,
    tier: source.tier,
    listing: Array.isArray(listings) ? listings[0] || null : null,
    listings: Array.isArray(listings) ? listings.slice() : [],
    symbolsDetected: records.length,
    rejectedTokens: rejected.length,
    tierWeight: source.tierWeight,
  });
}

function buildInactiveSourceState(source, status, lastError, blockedReason = null, cache = null, listing = null) {
  return buildSourceStatus({
    source: source.source,
    enabled: Boolean(source.enabled),
    available: false,
    status,
    blockedReason,
    lastRunAt: null,
    lastScanAt: null,
    lastError: redactSourceMessage(lastError || null),
    cache,
    tier: source.tier,
    listing,
    symbolsDetected: 0,
    rejectedTokens: 0,
    tierWeight: source.tierWeight,
  });
}

async function validateSource(source, config, token, fetchImpl) {
  if (!source.enabled) {
    return { sourceState: buildInactiveSourceState(source, 'off', 'Source disabled in config', 'source_disabled', null, null) };
  }

  const aboutUrl = `https://oauth.reddit.com/r/${encodeURIComponent(source.source)}/about.json?raw_json=1`;
  try {
    const result = await fetchJsonWithTimeout(fetchImpl, aboutUrl, {
      timeoutMs: config.redditTimeoutMs || 5000,
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': config.redditUserAgent,
      },
      cache: sourceCacheOptions(config, source.source, 'reddit/subreddit-validation', config.redditValidationCacheSeconds, {
        endpoint: 'about',
      }),
    });
    const { response, body } = result;
    if (!response.ok) {
      return { sourceState: classifyInactiveSource(source, response.status, body, result.cache, null) };
    }
    const about = body?.data || body || {};
    const subredditType = String(about?.subreddit_type || '').toLowerCase();
    if (about?.quarantine || about?.quarantined || /quarant|restrict/.test(String(about?.reason_text || about?.message || '').toLowerCase())) {
      return { sourceState: buildInactiveSourceState(source, 'quarantined_or_restricted', 'Subreddit is quarantined or restricted', 'quarantined_or_restricted', result.cache) };
    }
    if (subredditType === 'private' || subredditType === 'banned') {
      return { sourceState: buildInactiveSourceState(source, 'source_private_or_banned', `Subreddit is ${subredditType}`, 'source_private_or_banned', result.cache) };
    }
    return {
      sourceState: buildSourceStatus({
        source: source.source,
        enabled: true,
        available: true,
        status: 'active',
        lastRunAt: nowIso(),
        lastScanAt: nowIso(),
        lastError: null,
        blockedReason: null,
        cache: result.cache,
        tier: source.tier,
        listing: null,
        symbolsDetected: 0,
        rejectedTokens: 0,
        tierWeight: source.tierWeight,
      }),
    };
  } catch (error) {
    return {
      sourceState: buildInactiveSourceState(source, 'timeout', error?.message || 'Unable to validate subreddit', 'source_not_found_or_inaccessible', null, null),
    };
  }
}

function classifyInactiveSource(source, statusCode, payload = null, cache = null, listing = null, config = {}) {
  const classified = classifyHttpSourceStatus(statusCode, payload);
  const status = classified.status || 'source_not_found_or_inaccessible';
  const blockedReason = classified.blockedReason || status;
  return buildInactiveSourceState(
    source,
    status,
    classified.lastError || payload?.message || payload?.error || `HTTP ${statusCode}`,
    blockedReason,
    buildInactiveSourceCache(cache, config, statusCode),
    listing,
  );
}

function buildInactiveSourceCache(cache = null, config = {}, statusCode = null) {
  const normalized = normalizeCacheMeta(cache);
  const rateLimitCooldown = Math.max(0, Number(config?.redditRateLimitCooldownSeconds || 0) || 0);
  if (Number(statusCode) === 429 && rateLimitCooldown > 0) {
    return {
      ...normalized,
      ttlSeconds: rateLimitCooldown,
    };
  }
  return normalized;
}

function addRedditRecord(records, seenKeys, record) {
  if (!record) return false;
  const key = buildRecordKey(record);
  if (key && seenKeys.has(key)) return false;
  if (key) seenKeys.add(key);
  records.push(record);
  return true;
}

function resolveListingModes(value) {
  const validModes = new Set(['hot', 'rising', 'new']);
  const modes = (Array.isArray(value) ? value : String(value || '').split(','))
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => validModes.has(entry));
  const deduped = [...new Set(modes)];
  return deduped.length ? deduped : ['hot', 'rising'];
}

function sourceCacheOptions(config = {}, source, category, ttlSeconds, details = {}) {
  const repoRoot = config.repoRoot || process.cwd();
  const dataDir = config.dataDir || path.resolve(repoRoot, 'data');
  const ttl = Math.max(0, Number(ttlSeconds || 0) || 0);
  return {
    cacheDir: path.resolve(dataDir, 'runtime', 'source-cache'),
    source: String(source || '').trim().toLowerCase(),
    category,
    key: stableCacheKey({
      source,
      category,
      details,
      listing: details.listing || null,
      maxPostsPerSource: details.maxPostsPerSource || null,
      maxCommentsPerPost: details.maxCommentsPerPost || null,
      endpoint: details.endpoint || null,
      ttl,
    }),
    ttlSeconds: ttl,
  };
}

function resolveEnvNumber(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return Number(fallback) || 0;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : (Number(fallback) || 0);
}

function persistSourceStatus(statusPath, payload, input = {}) {
  try {
    saveMemeMonitorStatus({
      ...(payload.sourceStatusPayload || {}),
      version: '2026-06-30.meme-monitor-status.1',
      updated_at: nowIso(),
      enabled: true,
      redditScanner: {
        enabled: true,
        status: payload.status === 'ok' ? 'shadow' : payload.status,
        lastRunAt: nowIso(),
        lastError: payload.message || payload.error || null,
        sources: Array.isArray(payload.sources) ? payload.sources.slice() : [],
        symbolsDetected: Number(payload.symbolsDetected || 0),
        rejectedTokens: Number(payload.rejectedTokens || 0),
        mode: 'reddit-oauth',
      },
    }, { dataDir: input.dataDir, repoRoot: input.repoRoot, filePath: statusPath, env: input.env });
  } catch {
    // Keep collection resilient if status persistence fails.
  }
}

module.exports = {
  createRedditCollector,
  normalizeRedditComment,
  normalizeRedditPost,
};
