function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function combineConfidenceScores(entries = [], options = {}) {
  const normalized = (Array.isArray(entries) ? entries : []).filter(Boolean).map((entry) => ({
    key: entry.key || entry.source || entry.name || 'unknown',
    score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : Number(entry.confidence) * 100,
    weight: Math.max(0, Number(entry.weight ?? 1) || 0),
    available: entry.available !== false,
    reasonCodes: Array.isArray(entry.reasonCodes) ? entry.reasonCodes.slice() : [],
    riskWarnings: Array.isArray(entry.riskWarnings) ? entry.riskWarnings.slice() : [],
    details: entry.details || null,
    status: entry.status || null,
  }));

  const usable = normalized.filter((entry) => entry.available && entry.weight > 0);
  if (!usable.length) {
    return {
      score: null,
      available: false,
      reasonCodes: ['provider_confirmation_unavailable'],
      riskWarnings: ['provider_confirmation_unavailable'],
      components: normalized,
    };
  }

  const weightTotal = usable.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  const rawScore = usable.reduce((sum, entry) => sum + clampScore(entry.score) * entry.weight, 0) / weightTotal;
  const reasonCodes = new Set();
  const riskWarnings = new Set();
  for (const entry of usable) {
    for (const code of entry.reasonCodes) reasonCodes.add(code);
    for (const warning of entry.riskWarnings) riskWarnings.add(warning);
  }
  return {
    score: clampScore(rawScore),
    available: true,
    reasonCodes: [...reasonCodes],
    riskWarnings: [...riskWarnings],
    components: normalized,
  };
}

module.exports = {
  clampScore,
  combineConfidenceScores,
};
