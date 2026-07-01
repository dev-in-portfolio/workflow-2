const DEFAULT_PHASE_B_SOURCE_WEIGHTS = {
  reddit: 1.0,
  stocktwits: 0.9,
  alpacaMarket: 1.0,
  polygon: 0.9,
  alphaVantage: 0.7,
  alpacaAssets: 1.0,
  nasdaqHalts: 1.15,
  secEdgar: 0.85,
};

function resolvePhaseBSourceWeight(source, overrides = {}) {
  const key = String(source || '').trim();
  return Number(overrides[key] ?? DEFAULT_PHASE_B_SOURCE_WEIGHTS[key] ?? 1);
}

module.exports = {
  DEFAULT_PHASE_B_SOURCE_WEIGHTS,
  resolvePhaseBSourceWeight,
};
