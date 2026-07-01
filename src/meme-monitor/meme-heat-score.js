const { scoreMentions } = require('./mention-score');

function scoreMemeHeat(mentions = [], options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const threshold = clampScore(options.dynamicMinScore ?? 60);
  const scored = scoreMentions(mentions, { generatedAt });
  return scored.map((entry) => {
    const isPass = entry.confidenceScore >= threshold;
    const reasonCodes = [
      ...(entry.reasonCodes || []),
      isPass ? 'social_score_passed' : 'social_score_failed',
    ];
    return {
      ...entry,
      memeHeatScore: entry.confidenceScore,
      confidenceScore: undefined,
      socialScoreBand: classifySocialBand(entry.confidenceScore),
      status: isPass ? bandStatus(entry.confidenceScore, options) : 'ignore',
      reasonCodes: [...new Set(reasonCodes)],
    };
  });
}

function classifySocialBand(score) {
  const value = clampScore(score);
  if (value >= 90) return 'hot_hot_candidate';
  if (value >= 75) return 'hot_candidate';
  if (value >= 60) return 'dynamic_watch';
  if (value >= 40) return 'watch_only';
  return 'ignore';
}

function bandStatus(score, options = {}) {
  const value = clampScore(score);
  if (value >= clampScore(options.hotHotMinScore ?? 90)) return 'hot_hot_candidate';
  if (value >= clampScore(options.hotCandidateMinScore ?? 75)) return 'hot_candidate';
  if (value >= clampScore(options.dynamicMinScore ?? 60)) return 'dynamic_watch';
  if (value >= 40) return 'watch_only';
  return 'ignore';
}

function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

module.exports = {
  classifySocialBand,
  scoreMemeHeat,
};
