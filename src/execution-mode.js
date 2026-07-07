const { safeNumber } = require('./util');

function isLiveModeSelected(config = {}) {
  return String(config.TRADING_MODE || '').trim().toLowerCase() === 'live';
}

function analyzeExecutionIntent(config = {}, runtimeEnv = process.env) {
  const liveModeSelected = isLiveModeSelected(config);
  const liveTradingEnabled = config.LIVE_TRADING_ENABLED === true;
  const alpacaExecutionEnabled = config.ALPACA_EXECUTION_ENABLED === true;
  const hasCredentials = Boolean(config.ALPACA_API_KEY_ID && config.ALPACA_API_SECRET_KEY);
  const hasBaseUrl = Boolean(String(config.ALPACA_API_BASE_URL || '').trim());
  const confirmationPhrasePresent = Boolean(String(runtimeEnv.LIVE_TRADING_CONFIRMATION_PHRASE || config.LIVE_TRADING_CONFIRMATION_PHRASE || '').trim());
  const issues = [];

  if (liveModeSelected && !liveTradingEnabled) issues.push('LIVE_MODE_REQUIRES_LIVE_TRADING_ENABLED');
  if (liveModeSelected && !alpacaExecutionEnabled) issues.push('LIVE_MODE_REQUIRES_ALPACA_EXECUTION_ENABLED');
  if (liveModeSelected && !hasCredentials) issues.push('LIVE_MODE_REQUIRES_ALPACA_CREDENTIALS');
  if (liveModeSelected && !hasBaseUrl) issues.push('LIVE_MODE_REQUIRES_ALPACA_API_BASE_URL');
  if (liveModeSelected && !confirmationPhrasePresent) issues.push('LIVE_MODE_REQUIRES_CONFIRMATION_PHRASE');

  return {
    live_mode_selected: liveModeSelected,
    live_trading_enabled: liveTradingEnabled,
    alpaca_execution_enabled: alpacaExecutionEnabled,
    has_credentials: hasCredentials,
    has_base_url: hasBaseUrl,
    confirmation_phrase_present: confirmationPhrasePresent,
    paper_fallback_risk: liveModeSelected && !alpacaExecutionEnabled,
    issues,
  };
}

function createExecutionIntentError(intent, action = 'start') {
  const issues = Array.isArray(intent?.issues) ? intent.issues : [];
  const message = issues.length
    ? `Live execution blocked for ${action}: ${issues.join(', ')}`
    : `Live execution blocked for ${action}`;
  const error = new Error(message);
  error.code = 'LIVE_EXECUTION_BLOCKED';
  error.reason_codes = issues;
  error.intent = intent;
  return error;
}

function validateExecutionIntent(config = {}, runtimeEnv = process.env, options = {}) {
  const intent = analyzeExecutionIntent(config, runtimeEnv);
  if (intent.live_mode_selected && intent.issues.length) {
    if (options.throwOnError !== false) {
      throw createExecutionIntentError(intent, options.action || 'start');
    }
    return { ok: false, intent, error: createExecutionIntentError(intent, options.action || 'start') };
  }
  return { ok: true, intent };
}

function summarizeLiveStartBlock(result = {}) {
  const reasonCodes = Array.isArray(result?.intent?.issues) ? result.intent.issues : [];
  return {
    ok: false,
    action: result.action || 'start-workflow',
    error: 'live_execution_blocked',
    reason_codes: reasonCodes,
    message: reasonCodes.length
      ? `Live execution blocked: ${reasonCodes.join(', ')}`
      : 'Live execution blocked.',
  };
}

module.exports = {
  analyzeExecutionIntent,
  createExecutionIntentError,
  isLiveModeSelected,
  summarizeLiveStartBlock,
  validateExecutionIntent,
};
