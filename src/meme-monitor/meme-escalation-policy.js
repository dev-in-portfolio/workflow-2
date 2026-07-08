const { parseBool, parseNumber } = require('../config');

function resolveMemeEscalationPolicy(env = process.env) {
  return {
    masterEnabled: parseBool(env.MEME_MONITOR_ENABLED, false),
    redditScannerEnabled: parseBool(env.MEME_REDDIT_SCANNER_ENABLED, false),
    hotListEnabled: parseBool(env.MEME_HOT_LIST_ENABLED, false),
    dynamicWatchlistEnabled: parseBool(env.MEME_DYNAMIC_WATCHLIST_ENABLED, false),
    dynamicMinScore: clampScore(parseNumber(env.MEME_DYNAMIC_MIN_SCORE, 60)),
    hotCandidateMinScore: clampScore(parseNumber(env.MEME_HOT_CANDIDATE_MIN_SCORE, 75)),
    hotHotMinScore: clampScore(parseNumber(env.MEME_HOT_HOT_MIN_SCORE, 90)),
    marketConfirmationMinScore: clampScore(parseNumber(env.MEME_MARKET_CONFIRMATION_MIN_SCORE, 70)),
    hotListTtlMinutes: Math.max(1, parseNumber(env.MEME_HOT_LIST_TTL_MINUTES, 15) || 15),
  };
}

function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function resolveMemeScoreMode(policy = {}) {
  if (!policy.masterEnabled) return 'off';
  if (!policy.hotListEnabled) return 'off';
  if (!policy.dynamicWatchlistEnabled) return 'shadow';
  return 'active';
}

module.exports = {
  resolveMemeEscalationPolicy,
  resolveMemeScoreMode,
};
