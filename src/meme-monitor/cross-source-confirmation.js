const { combineConfidenceScores, clampScore } = require('./provider-confidence-score');

function buildCrossSourceConfirmation({
  symbol,
  phaseAEntry = null,
  stocktwits = null,
  polygon = null,
  alphaVantage = null,
  policy = {},
} = {}) {
  const baseSocial = clampScore(phaseAEntry?.memeHeatScore ?? phaseAEntry?.socialHeatScore ?? 0);
  const redditScore = baseSocial;
  const stocktwitsScore = Number.isFinite(Number(stocktwits?.score)) ? clampScore(stocktwits.score) : null;
  const socialScore = combineConfidenceScores([
    { key: 'reddit', score: redditScore, weight: 1.05, available: redditScore > 0, reasonCodes: phaseAEntry?.reasonCodes || [], riskWarnings: phaseAEntry?.riskWarnings || [] },
    stocktwitsScore === null ? null : { key: 'stocktwits', score: stocktwitsScore, weight: 0.9, available: true, reasonCodes: stocktwits.reasonCodes || [], riskWarnings: stocktwits.riskWarnings || [] },
  ]);

  const alpacaScore = Number.isFinite(Number(phaseAEntry?.marketConfirmationScore)) ? clampScore(phaseAEntry.marketConfirmationScore) : null;
  const polygonScore = Number.isFinite(Number(polygon?.score)) ? clampScore(polygon.score) : null;
  const alphaScore = Number.isFinite(Number(alphaVantage?.score)) ? clampScore(alphaVantage.score) : null;
  const marketScore = combineConfidenceScores([
    alpacaScore === null ? null : { key: 'alpaca', score: alpacaScore, weight: 1.0, available: true, reasonCodes: phaseAEntry?.marketReasonCodes || phaseAEntry?.reasonCodes || [], riskWarnings: phaseAEntry?.riskWarnings || [] },
    polygonScore === null ? null : { key: 'polygon', score: polygonScore, weight: 0.9, available: true, reasonCodes: polygon.reasonCodes || [], riskWarnings: polygon.riskWarnings || [] },
    alphaScore === null ? null : { key: 'alphaVantage', score: alphaScore, weight: 0.7, available: true, reasonCodes: alphaVantage.reasonCodes || [], riskWarnings: alphaVantage.riskWarnings || [] },
  ]);

  const riskDetails = {
    nasdaqHalts: phaseAEntry?.haltStatus || 'unknown',
    alpacaAssets: phaseAEntry?.tradableStatus || 'unknown',
    secEdgar: phaseAEntry?.catalystScore > 0
      ? 'catalyst'
      : (phaseAEntry?.riskBlockScore >= 30 ? 'risk_warning' : 'no_blocking_filing'),
  };
  const hardBlocks = [
    phaseAEntry?.tradableStatus === 'blocked' || phaseAEntry?.tradableStatus === 'not_found',
    phaseAEntry?.haltStatus === 'halted',
    Number(phaseAEntry?.riskBlockScore || 0) >= 50,
    [...(phaseAEntry?.riskWarnings || []), ...(polygon?.riskWarnings || []), ...(alphaVantage?.riskWarnings || [])].includes('possible_halt_risk'),
    [...(phaseAEntry?.riskWarnings || []), ...(polygon?.riskWarnings || []), ...(alphaVantage?.riskWarnings || [])].includes('spread_too_wide'),
  ].some(Boolean);
  const riskScore = hardBlocks ? 0 : clampScore(100 - (Number(phaseAEntry?.riskBlockScore || 0) + [...(phaseAEntry?.riskWarnings || []), ...(polygon?.riskWarnings || []), ...(alphaVantage?.riskWarnings || [])].length * 5));

  const socialScoreValue = socialScore.score === null ? null : socialScore.score;
  const marketScoreValue = marketScore.score === null ? null : marketScore.score;
  const finalMemeScore = clampScore(
    (Number.isFinite(socialScoreValue) ? socialScoreValue * 0.45 : 0)
    + (Number.isFinite(marketScoreValue) ? marketScoreValue * 0.4 : 0)
    + (riskScore * 0.15),
  );
  const phaseBCrossConfirmation = Boolean(stocktwitsScore !== null || polygonScore !== null || alphaScore !== null);
  const borderlineUpgrade = finalMemeScore >= 75 && finalMemeScore < 90 && phaseBCrossConfirmation && !hardBlocks;
  const hotHotEligible = !hardBlocks && (
    finalMemeScore >= 90
    || borderlineUpgrade
    || (Number(phaseAEntry?.memeHeatScore || 0) >= 90 && socialScore.available && marketScore.available)
  );
  const status = hotHotEligible
    ? 'hot_hot'
    : hardBlocks
      ? 'blocked'
    : finalMemeScore >= 75
      ? 'hot_candidate'
      : finalMemeScore >= 60
        ? 'dynamic_watch'
        : finalMemeScore >= 40
          ? 'watch_only'
          : 'ignore';
  const reasonCodes = new Set([
    ...(socialScore.reasonCodes || []),
    ...(marketScore.reasonCodes || []),
    ...(phaseAEntry?.reasonCodes || []),
  ]);
  if (phaseBCrossConfirmation) reasonCodes.add('cross_source_confirmation');
  if (stocktwitsScore !== null) reasonCodes.add('cross_source_social_confirmation');
  if (polygonScore !== null || alphaScore !== null) reasonCodes.add('cross_source_market_confirmation');
  if (borderlineUpgrade) reasonCodes.add('borderline_cross_source_upgrade');
  if (hardBlocks) reasonCodes.add('phase_b_hard_block');

  const riskWarnings = new Set([
    ...(phaseAEntry?.riskWarnings || []),
    ...(socialScore.riskWarnings || []),
    ...(marketScore.riskWarnings || []),
    ...(polygon?.riskWarnings || []),
    ...(alphaVantage?.riskWarnings || []),
  ]);
  if (phaseAEntry?.haltStatus === 'halted') riskWarnings.add('possible_halt_risk');

  return {
    symbol,
    socialConfirmation: {
      reddit: redditScore,
      stocktwits: stocktwitsScore,
      score: socialScoreValue,
      reasonCodes: [...new Set([...(phaseAEntry?.reasonCodes || []), ...(stocktwits?.reasonCodes || [])])],
    },
    marketConfirmation: {
      alpaca: alpacaScore,
      polygon: polygonScore,
      alphaVantage: alphaScore,
      score: marketScoreValue,
      reasonCodes: [...new Set([...(phaseAEntry?.reasonCodes || []), ...(polygon?.reasonCodes || []), ...(alphaVantage?.reasonCodes || [])])],
    },
    riskConfirmation: {
      ...riskDetails,
      score: riskScore,
    },
    finalMemeScore,
    status,
    reasonCodes: [...reasonCodes],
    riskWarnings: [...riskWarnings],
    crossSourceConfirmation: phaseBCrossConfirmation,
    phaseBConfirmation: phaseBCrossConfirmation,
    borderlineUpgrade,
    sourceSignals: {
      stocktwits,
      polygon,
      alphaVantage,
    },
  };
}

module.exports = {
  buildCrossSourceConfirmation,
};
