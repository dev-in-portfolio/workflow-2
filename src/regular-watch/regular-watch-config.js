const { loadConfig } = require('../config');

function resolveRegularWatchConfig(env = process.env) {
  const config = loadConfig(env);
  return {
    enabled: Boolean(config.REGULAR_WATCH_INTELLIGENCE_ENABLED),
    marketConfirmationEnabled: Boolean(config.REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED),
    assetValidationEnabled: Boolean(config.REGULAR_WATCH_ASSET_VALIDATION_ENABLED),
    haltCheckEnabled: Boolean(config.REGULAR_WATCH_HALT_CHECK_ENABLED),
    secRiskCheckEnabled: Boolean(config.REGULAR_WATCH_SEC_RISK_CHECK_ENABLED),
    newsCatalystEnabled: Boolean(config.REGULAR_WATCH_NEWS_CATALYST_ENABLED),
    priorityScoringEnabled: Boolean(config.REGULAR_WATCH_PRIORITY_SCORING_ENABLED),
    scannerRankingEnabled: Boolean(config.REGULAR_WATCH_SCANNER_RANKING_ENABLED),
    positionAwarenessEnabled: Boolean(config.REGULAR_WATCH_POSITION_AWARENESS_ENABLED),
    polygonConfirmationEnabled: Boolean(config.REGULAR_WATCH_POLYGON_CONFIRMATION_ENABLED),
    alphaVantageConfirmationEnabled: Boolean(config.REGULAR_WATCH_ALPHA_VANTAGE_CONFIRMATION_ENABLED),
    socialContextEnabled: Boolean(config.REGULAR_WATCH_SOCIAL_CONTEXT_ENABLED),
    optionsContextEnabled: Boolean(config.REGULAR_WATCH_OPTIONS_CONTEXT_ENABLED),
    refreshSeconds: Number(config.REGULAR_WATCH_REFRESH_SECONDS || 30),
    sourceTimeoutMs: Number(config.REGULAR_WATCH_SOURCE_TIMEOUT_MS || 5000),
    staleAfterSeconds: Number(config.REGULAR_WATCH_STALE_AFTER_SECONDS || 90),
    maxSymbolsPerRun: Number(config.REGULAR_WATCH_MAX_SYMBOLS_PER_RUN || 100),
  };
}

module.exports = {
  resolveRegularWatchConfig,
};
