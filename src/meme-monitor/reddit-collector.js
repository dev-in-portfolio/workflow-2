const { resolveMemeSocialSourceConfig } = require('./social-source-config');
const { saveMemeMonitorStatus } = require('./meme-monitor-status');
const { resolveMemeMonitorStatusPath } = require('./meme-monitor-status');
const { nowIso } = require('../util');
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

    const redditClientId = config.redditClientId || config.REDDIT_CLIENT_ID || '';
    const redditClientSecret = config.redditClientSecret || config.REDDIT_CLIENT_SECRET || '';
    const redditUserAgent = config.redditUserAgent || config.REDDIT_USER_AGENT || 'workflow-2-meme-monitor';

    if (!redditClientId || !redditClientSecret) {
      for (const source of config.sourceDefinitions) {
        sourceStates.push(buildInactiveSourceState(source, 'missing_credentials', 'Unable to validate subreddit'));
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

    const tokenResult = await getAccessToken({ ...config, redditClientId, redditClientSecret, redditUserAgent });
    if (!tokenResult.ok) {
      const sourceStatus = tokenResult.error === 'reddit_auth_failed'
        ? 'error'
        : 'inactive';
      for (const source of config.sourceDefinitions) {
        sourceStates.push(buildInactiveSourceState(source, sourceStatus === 'error' ? 'reddit_auth_failed' : 'source_unavailable', tokenResult.message || tokenResult.error || 'Unable to validate subreddit', sourceStatus));
      }
      const payload = {
        ok: false,
        status: tokenResult.error === 'reddit_auth_failed' ? 'error' : 'inactive',
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
      const validation = await validateSource(source, { ...config, redditUserAgent }, tokenResult.accessToken, fetchImpl);
      sourceStates.push(validation.sourceState);
      if (validation.sourceState.status !== 'active') {
        continue;
      }
      const result = await collectSourceListing(validation.sourceState, { ...config, redditUserAgent }, tokenResult.accessToken, fetchImpl);
      if (result.sourceState) {
        sourceStates[sourceStates.length - 1] = result.sourceState;
      }
      collected.push(...result.records);
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

  async function getAccessToken(config) {
    if (accessToken && Date.now() < tokenExpiresAt) {
      return { ok: true, accessToken };
    }

    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    const auth = Buffer.from(`${config.redditClientId}:${config.redditClientSecret}`).toString('base64');
    const response = await fetchImpl('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': config.redditUserAgent,
      },
      body,
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      return {
        ok: false,
        status: 'error',
        error: 'reddit_auth_failed',
        message: payload?.error || payload?.message || `HTTP ${response.status}`,
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
  }

  async function collectSourceListing(source, config, token, fetchImpl) {
    const listingUrl = `https://oauth.reddit.com/r/${encodeURIComponent(source.source)}/hot?limit=${config.maxPostsPerSource}&raw_json=1`;
    const response = await fetchImpl(listingUrl, {
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': config.redditUserAgent,
      },
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      const blockedReason = classifyInactiveSource(source, response.status, payload);
      return {
        records: [],
        rejected: [{ source, reason: payload?.error || payload?.message || `HTTP ${response.status}` }],
        sourceState: blockedReason,
      };
    }
    const posts = payload?.data?.children || [];
    const records = [];
    const rejected = [];
    for (const child of posts.slice(0, config.maxPostsPerSource)) {
      const post = child?.data || {};
      const postRecord = normalizeRedditPost(post, source);
      records.push(postRecord);
      if (config.maxCommentsPerPost > 0 && post?.num_comments) {
        const commentsResult = await collectCommentsForPost(post, source, token, config.maxCommentsPerPost, fetchImpl);
        records.push(...commentsResult.records);
        rejected.push(...commentsResult.rejected);
      }
    }

    return { records, rejected };
  }

  async function collectCommentsForPost(post, source, token, maxCommentsPerPost, fetchImpl) {
    const permalink = post?.permalink;
    if (!permalink) return { records: [], rejected: [] };
    const commentsUrl = `https://oauth.reddit.com${permalink}.json?limit=${maxCommentsPerPost}&raw_json=1`;
    const response = await fetchImpl(commentsUrl, {
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'workflow-2-meme-monitor',
      },
    });
    const payload = await safeJson(response);
    if (!response.ok || !Array.isArray(payload)) {
      return {
        records: [],
        rejected: [{ source: source.source, reason: payload?.error || payload?.message || `HTTP ${response.status}` }],
      };
    }

    const records = [];
    const rejected = [];
    const commentListing = payload[1]?.data?.children || [];
    for (const child of commentListing.slice(0, maxCommentsPerPost)) {
      const comment = child?.data || {};
      if (!comment?.body) continue;
      records.push(normalizeRedditComment(comment, source, post));
    }
    return { records, rejected };
  }

  return {
    collectSources,
  };
}

function normalizeRedditPost(post = {}, source) {
  return {
    kind: 'post',
    source: `reddit:${source.source}`,
    sourceMeta: {
      source: source.source,
      tier: source.tier,
      weight: source.tierWeight,
      status: source.status,
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
  };
}

function normalizeRedditComment(comment = {}, source, post = {}) {
  return {
    kind: 'comment',
    source: `reddit:${source.source}`,
    sourceMeta: {
      source: source.source,
      tier: source.tier,
      weight: source.tierWeight,
      status: source.status,
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
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function validateSource(source, config, token, fetchImpl) {
  if (!source.enabled) {
    return { sourceState: buildInactiveSourceState(source, 'disabled', 'Source disabled in config', 'disabled') };
  }

  const aboutUrl = `https://oauth.reddit.com/r/${encodeURIComponent(source.source)}/about.json?raw_json=1`;
  try {
    const response = await fetchImpl(aboutUrl, {
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': config.redditUserAgent,
      },
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      return { sourceState: classifyInactiveSource(source, response.status, payload) };
    }
    const about = payload?.data || payload || {};
    if (about?.quarantine || about?.quarantined) {
      return { sourceState: buildInactiveSourceState(source, 'quarantined', 'Subreddit is quarantined', 'inactive') };
    }
    if (String(about?.subreddit_type || '').toLowerCase() === 'private') {
      return { sourceState: buildInactiveSourceState(source, 'private', 'Subreddit is private', 'inactive') };
    }
    if (String(about?.subreddit_type || '').toLowerCase() === 'banned') {
      return { sourceState: buildInactiveSourceState(source, 'banned', 'Subreddit is banned', 'inactive') };
    }
    return {
      sourceState: {
        source: source.source,
        tier: source.tier,
        status: 'active',
        blockedReason: null,
        lastScanAt: nowIso(),
        lastError: null,
        symbolsDetected: 0,
        rejectedTokens: 0,
        tierWeight: source.tierWeight,
      },
    };
  } catch (error) {
    return { sourceState: buildInactiveSourceState(source, 'inaccessible', error.message || 'Unable to validate subreddit', 'error') };
  }
}

function classifyInactiveSource(source, statusCode, payload = null) {
  if (statusCode === 429) {
    return buildInactiveSourceState(source, 'rate_limited', payload?.message || payload?.error || 'Reddit rate limited the request', 'error');
  }
  if (statusCode === 404) {
    return buildInactiveSourceState(source, 'source_not_found_or_inaccessible', payload?.message || payload?.error || 'Source not found or inaccessible', 'inactive');
  }
  if (statusCode === 403) {
    return buildInactiveSourceState(source, 'source_private_or_banned', payload?.message || payload?.error || 'Source is private, banned, or inaccessible', 'inactive');
  }
  if (statusCode === 401) {
    return buildInactiveSourceState(source, 'missing_credentials', payload?.message || payload?.error || 'Credentials rejected by Reddit', 'error');
  }
  return buildInactiveSourceState(source, 'source_not_found_or_inaccessible', payload?.message || payload?.error || `HTTP ${statusCode}`, 'inactive');
}

function buildInactiveSourceState(source, blockedReason, lastError, status = 'inactive') {
  return {
    source: source.source,
    tier: source.tier,
    status,
    blockedReason,
    lastScanAt: null,
    lastError,
    symbolsDetected: 0,
    rejectedTokens: 0,
    tierWeight: source.tierWeight,
  };
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
