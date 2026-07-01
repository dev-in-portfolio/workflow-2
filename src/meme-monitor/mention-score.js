const { safeNumber } = require('../util');

function scoreMentions(mentions = [], options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const generatedMs = new Date(generatedAt).getTime();
  const grouped = new Map();

  for (const mention of mentions || []) {
    const symbol = String(mention.symbol || '').toUpperCase();
    if (!symbol) continue;
    const bucket = grouped.get(symbol) || createBucket(symbol);
    bucket.mentions.push(normalizeMention(mention));
    grouped.set(symbol, bucket);
  }

  const results = [];
  for (const bucket of grouped.values()) {
    const scored = finalizeScore(bucket, generatedMs);
    results.push(scored);
  }

  results.sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
    if (b.mentions15m !== a.mentions15m) return b.mentions15m - a.mentions15m;
    return a.symbol.localeCompare(b.symbol);
  });

  return results;
}

function createBucket(symbol) {
  return {
    symbol,
    mentions: [],
  };
}

function normalizeMention(mention = {}) {
  return {
    symbol: String(mention.symbol || '').toUpperCase(),
    source: String(mention.source || 'reddit').trim(),
    sourceTier: String(mention.sourceTier || '').trim() || null,
    sourceWeight: Number.isFinite(Number(mention.sourceWeight)) ? Number(mention.sourceWeight) : 1,
    sourceStatus: String(mention.sourceStatus || '').trim() || null,
    sourceId: mention.sourceId || null,
    threadId: mention.threadId || null,
    author: mention.author || null,
    createdAt: mention.createdAt || null,
    kind: mention.kind || 'post',
    engagement: safeNumber(mention.engagement, 0),
    confidence: safeNumber(mention.confidence, 0),
    cashtag: Boolean(mention.cashtag),
    reasonCodes: Array.isArray(mention.reasonCodes) ? mention.reasonCodes.slice() : [],
    token: mention.token || null,
    title: mention.title || null,
    url: mention.url || null,
  };
}

function finalizeScore(bucket, generatedMs) {
  const mentions = bucket.mentions.slice();
  const last60m = mentions.filter((mention) => withinMinutes(mention.createdAt, generatedMs, 60));
  const last30m = mentions.filter((mention) => withinMinutes(mention.createdAt, generatedMs, 30));
  const last15m = mentions.filter((mention) => withinMinutes(mention.createdAt, generatedMs, 15));
  const uniqueUsers = new Set(mentions.map((mention) => mention.author).filter(Boolean)).size;
  const sourceCounts = countBy(mentions, (mention) => mention.source || 'reddit');
  const topSources = [...sourceCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([source]) => source);
  const threadCount = new Set(mentions.map((mention) => mention.threadId || mention.sourceId || null).filter(Boolean)).size;
  const commentCount = mentions.reduce((sum, mention) => sum + (mention.kind === 'comment' ? 1 : 0), 0);
  const totalEngagement = mentions.reduce((sum, mention) => sum + Math.max(0, Number(mention.engagement) || 0), 0);
  const weightedSourceMentions = mentions.reduce((sum, mention) => sum + Math.max(0, Number(mention.sourceWeight) || 1), 0);
  const freshnessScore = calculateFreshnessScore(last15m.length, last30m.length, last60m.length, generatedMs, mentions);
  const mentionVelocity = last15m.length / 15;
  const spamConcentration = calculateSpamConcentration(sourceCounts, mentions.length);
  const sourceProfile = buildSourceProfile(mentions);
  const reasonCodes = deriveReasonCodes({
    mentions15m: last15m.length,
    mentions30m: last30m.length,
    mentions60m: last60m.length,
    uniqueUsers,
    sourceCount: sourceCounts.size,
    threadCount,
    engagementScore: totalEngagement,
    weightedSourceMentions,
    freshnessScore,
    mentionVelocity,
    spamConcentration,
    mentions,
  });
  const confidenceScore = calculateConfidenceScore({
    mentions15m: last15m.length,
    mentions30m: last30m.length,
    mentions60m: last60m.length,
    uniqueUsers,
    sourceCount: sourceCounts.size,
    threadCount,
    engagementScore: totalEngagement,
    weightedSourceMentions,
    freshnessScore,
    mentionVelocity,
    spamConcentration,
    mentions,
  });

  return {
    symbol: bucket.symbol,
    status: 'dynamic_watch',
    confidenceScore,
    mentions15m: last15m.length,
    mentions30m: last30m.length,
    mentions60m: last60m.length,
    uniqueUsers,
    sourceCount: sourceCounts.size,
    topSources,
    sourceProfile,
    threadCount,
    commentCount,
    engagementScore: Math.round(totalEngagement),
    freshnessScore,
    mentionVelocity: roundMetric(mentionVelocity),
    spamConcentration: roundMetric(spamConcentration),
    reasonCodes,
    riskWarnings: buildRiskWarnings(spamConcentration, mentions.length),
  };
}

function deriveReasonCodes(metrics) {
  const reasonCodes = [];
  if (metrics.mentions15m > 0 && metrics.mentions15m >= Math.max(3, Math.ceil(metrics.mentions30m * 0.5))) {
    reasonCodes.push('mention_velocity_spike');
  }
  if (metrics.threadCount >= 2) {
    reasonCodes.push('multi_thread_confirmation');
  }
  if (metrics.sourceCount >= 2) {
    reasonCodes.push('multi_source_confirmation');
  }
  if (metrics.uniqueUsers >= 3) {
    reasonCodes.push('unique_user_count_ok');
  }
  if (metrics.engagementScore >= 10) {
    reasonCodes.push('engagement_confirmed');
  }
  if (metrics.freshnessScore >= 70) {
    reasonCodes.push('fresh_recent_mentions');
  }
  if (metrics.spamConcentration >= 0.7) {
    reasonCodes.push('spam_concentration_warning');
  }
  return [...new Set(reasonCodes)];
}

function calculateConfidenceScore(metrics) {
  let score = 35;
  score += Math.min(20, metrics.mentions15m * 2.5);
  score += Math.min(10, metrics.mentions30m * 0.3);
  score += Math.min(10, metrics.uniqueUsers * 1.5);
  score += Math.min(8, metrics.sourceCount * 3);
  score += Math.min(6, metrics.threadCount * 1.5);
  score += Math.min(6, metrics.engagementScore / 25);
  score += Math.min(8, metrics.weightedSourceMentions * 1.5);
  score += Math.min(5, metrics.freshnessScore / 20);
  if (metrics.mentionVelocity >= 1.5) score += 5;
  if (metrics.spamConcentration >= 0.7) score -= 15;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildSourceProfile(mentions = []) {
  const sourceMap = new Map();
  const tierCounts = {
    tier_1: 0,
    tier_2: 0,
    tier_3: 0,
    ticker_specific: 0,
    optional_high_noise: 0,
    unknown: 0,
  };
  for (const mention of mentions) {
    const source = String(mention.source || 'reddit').trim();
    const tier = String(mention.sourceTier || 'unknown').trim() || 'unknown';
    const weight = Math.max(0, Number(mention.sourceWeight) || 1);
    const current = sourceMap.get(source) || {
      source,
      tier,
      weight,
      count: 0,
    };
    current.count += 1;
    current.weight = Math.max(current.weight, weight);
    sourceMap.set(source, current);
    tierCounts[tier] = (tierCounts[tier] || 0) + 1;
  }
  return {
    sourceCount: sourceMap.size,
    tierCounts,
    dominantTier: Object.entries(tierCounts)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null,
    sources: [...sourceMap.values()].sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
  };
}

function calculateFreshnessScore(mentions15m, mentions30m, mentions60m, generatedMs, mentions) {
  const newest = mentions
    .map((mention) => new Date(mention.createdAt || 0).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  if (!Number.isFinite(newest)) {
    return 0;
  }
  const ageMinutes = Math.max(0, (generatedMs - newest) / 60000);
  const recencyScore = Math.max(0, 100 - ageMinutes * 6);
  const coverageBonus = Math.min(10, mentions15m * 3 + mentions30m + mentions60m / 4);
  return Math.max(0, Math.min(100, Math.round(recencyScore + coverageBonus)));
}

function calculateSpamConcentration(sourceCounts, totalMentions) {
  if (!totalMentions) return 0;
  const maxMentions = Math.max(...sourceCounts.values(), 0);
  return maxMentions / totalMentions;
}

function buildRiskWarnings(spamConcentration, totalMentions) {
  const warnings = ['social_signal_only'];
  if (spamConcentration >= 0.7 && totalMentions >= 5) {
    warnings.push('source_concentration_high');
  }
  return warnings;
}

function withinMinutes(timestamp, generatedMs, minutes) {
  if (!timestamp) return false;
  const ts = new Date(timestamp).getTime();
  if (!Number.isFinite(ts)) return false;
  return (generatedMs - ts) <= minutes * 60_000;
}

function countBy(items, mapper) {
  const counts = new Map();
  for (const item of items) {
    const key = String(mapper(item) || '').trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function roundMetric(value) {
  return Math.round(Number(value) * 100) / 100;
}

module.exports = {
  calculateConfidenceScore,
  scoreMentions,
};
