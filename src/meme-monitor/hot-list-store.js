const fs = require('fs');
const path = require('path');
const { resolveRepoRoot } = require('../util');
const { resolveMemeEscalationPolicy } = require('./meme-escalation-policy');

function resolveDynamicHotListPath(input = {}) {
  if (typeof input === 'string') return path.resolve(input);
  if (input?.filePath) return path.resolve(input.filePath);
  if (input?.path) return path.resolve(input.path);
  if (input?.dataDir) return path.resolve(input.dataDir, 'runtime', 'dynamic-hot-list.json');
  if (input?.repoRoot) return path.resolve(input.repoRoot, 'data', 'runtime', 'dynamic-hot-list.json');
  return path.resolve(resolveRepoRoot(), 'data', 'runtime', 'dynamic-hot-list.json');
}

function loadDynamicHotList(input = {}) {
  const filePath = resolveDynamicHotListPath(input);
  if (!fs.existsSync(filePath)) return null;
  try {
    return normalizeDynamicHotList(JSON.parse(fs.readFileSync(filePath, 'utf8')), input);
  } catch {
    return null;
  }
}

function saveDynamicHotList(payload, input = {}) {
  const filePath = resolveDynamicHotListPath(input);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = normalizeDynamicHotList(payload, input);
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function normalizeDynamicHotList(payload = {}, input = {}) {
  const now = input.now || new Date();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const policy = resolveMemeEscalationPolicy(input.env || process.env);
  const activeDynamic = Array.isArray(payload.dynamicHotList)
    ? payload.dynamicHotList.slice()
    : Array.isArray(payload.symbols)
      ? payload.symbols.slice()
      : [];
  const activeHotHot = Array.isArray(payload.hotHotList)
    ? payload.hotHotList.slice()
    : [];
  const expired = Array.isArray(payload.expired) ? payload.expired.slice() : [];
  const mergedDynamic = [];
  const mergedHotHot = [];

  for (const entry of activeDynamic) {
    const normalized = normalizeEntry(entry, policy, nowMs);
    if (normalized.expired) {
      expired.push(normalized);
      continue;
    }
    mergedDynamic.push(normalized);
  }

  for (const entry of activeHotHot) {
    const normalized = normalizeEntry(entry, policy, nowMs);
    if (normalized.expired) {
      expired.push(normalized);
      continue;
    }
    mergedHotHot.push(normalized);
    if (!mergedDynamic.some((item) => item.symbol === normalized.symbol)) {
      mergedDynamic.push({ ...normalized, status: normalized.status === 'hot_hot' ? 'hot_hot' : normalized.status });
    }
  }

  const lastScoredAt = payload.lastScoredAt || payload.generatedAt || payload.generated_at || null;
  const generatedAt = payload.generatedAt || payload.generated_at || lastScoredAt || null;
  const stale = Boolean(payload.stale)
    || (lastScoredAt ? isOlderThan(lastScoredAt, policy.hotListTtlMinutes, nowMs) : true);

  const normalizedPayload = {
    generatedAt,
    generated_at: generatedAt,
    lastScoredAt,
    last_scored_at: lastScoredAt,
    mode: payload.mode || 'shadow',
    source: payload.source || 'meme-monitor',
    status: payload.status || (stale ? 'stale' : 'shadow'),
    stale,
    enabled: Boolean(payload.enabled ?? true),
    dynamicHotList: mergedDynamic,
    hotHotList: mergedHotHot,
    expired: expired.map((entry) => normalizeEntry(entry, policy, nowMs)).filter(Boolean),
    symbols: mergedDynamic,
    rejected: Array.isArray(payload.rejected) ? payload.rejected.slice() : [],
    summary: {
      dynamicCount: mergedDynamic.length,
      hotHotCount: mergedHotHot.length,
      expiredCount: expired.length,
      stale,
      lastScoredAt,
    },
  };

  return normalizedPayload;
}

function normalizeEntry(entry = {}, policy = resolveMemeEscalationPolicy(process.env), nowMs = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  const expiresAt = entry.expiresAt || entry.expires_at || new Date(nowMs + policy.hotListTtlMinutes * 60_000).toISOString();
  const expired = new Date(expiresAt).getTime() <= nowMs;
  const hasHotHotScore = Number.isFinite(Number(entry.marketConfirmationScore));
  return {
    ...entry,
    symbol: String(entry.symbol || '').toUpperCase(),
    expiresAt,
    expires_at: expiresAt,
    expired,
    status: entry.status || (hasHotHotScore ? 'hot_hot' : 'dynamic_watch'),
    lastDecision: entry.lastDecision || entry.status || (hasHotHotScore ? 'hot_hot' : 'dynamic_watch'),
    memeHeatScore: numberOrNull(entry.memeHeatScore),
    marketConfirmationScore: numberOrNull(entry.marketConfirmationScore),
    marketConfirmationDetails: normalizeMarketConfirmationDetails(entry.marketConfirmationDetails),
    priorityOverrideEligible: Boolean(entry.priorityOverrideEligible),
    rotationEligible: Boolean(entry.rotationEligible),
    reasonCodes: normalizeList(entry.reasonCodes),
    riskWarnings: normalizeList(entry.riskWarnings),
    sources: normalizeList(entry.sources),
    sourceConfirmations: normalizeObject(entry.sourceConfirmations),
    sourceProfile: normalizeObject(entry.sourceProfile),
    phaseA: normalizeObject(entry.phaseA),
    phaseB: normalizeObject(entry.phaseB),
    sourceBreakdown: normalizeObject(entry.sourceBreakdown),
    mentions15m: numberOrNull(entry.mentions15m),
    mentions30m: numberOrNull(entry.mentions30m),
    mentions60m: numberOrNull(entry.mentions60m),
    uniqueUsers: numberOrNull(entry.uniqueUsers),
    sourceCount: numberOrNull(entry.sourceCount),
    topSources: normalizeList(entry.topSources),
    threadCount: numberOrNull(entry.threadCount),
    commentCount: numberOrNull(entry.commentCount),
    engagementScore: numberOrNull(entry.engagementScore),
    freshnessScore: numberOrNull(entry.freshnessScore),
    mentionVelocity: numberOrNull(entry.mentionVelocity),
    spamConcentration: numberOrNull(entry.spamConcentration),
    listing: entry.listing || null,
    listingWeight: numberOrNull(entry.listingWeight),
    generatedAt: entry.generatedAt || entry.generated_at || null,
    lastScoredAt: entry.lastScoredAt || entry.last_scored_at || null,
  };
}

function isOlderThan(timestamp, ttlMinutes, nowMs = Date.now()) {
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return true;
  return (nowMs - parsed) > (Math.max(1, ttlMinutes) * 60_000);
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeList(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null;
}

function normalizeMarketConfirmationDetails(details = null) {
  const source = normalizeObject(details) || {};
  return {
    currentPrice: source.currentPrice ?? null,
    previousClose: source.previousClose ?? null,
    openPrice: source.openPrice ?? null,
    volume: source.volume ?? null,
    averageVolume: source.averageVolume ?? null,
    bid: source.bid ?? null,
    ask: source.ask ?? null,
    spreadPct: source.spreadPct ?? null,
    liquidity: source.liquidity ?? null,
    ageSeconds: source.ageSeconds ?? null,
    stale: Boolean(source.stale),
    tradable: source.tradable ?? null,
    halted: source.halted ?? null,
    excluded: source.excluded ?? null,
  };
}

module.exports = {
  loadDynamicHotList,
  normalizeDynamicHotList,
  resolveDynamicHotListPath,
  saveDynamicHotList,
};
