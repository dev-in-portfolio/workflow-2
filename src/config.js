const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  TRADING_MODE: 'paper',
  LIVE_TRADING_ENABLED: false,
  REQUIRE_HUMAN_APPROVAL: true,
  KILL_SWITCH: true,
  MAX_DAILY_LOSS: 250,
  MAX_POSITION_NOTIONAL: 1000,
  MAX_OPEN_POSITIONS: 2,
  MAX_TRADES_PER_DAY: 8,
  AUTO_POLICY_REFRESH: false,
  AUTO_POLICY_REFRESH_MIN_BLOCKED_COUNT: 2,
  AUTO_POLICY_REFRESH_MIN_REJECTION_PRESSURE_SCORE: 50,
  AUTO_POLICY_REFRESH_MIN_PAPER_OUTCOMES: 1,
  MIN_CONFIDENCE_FOR_PAPER: 72,
  MIN_LIQUIDITY_SCORE: 40,
  MIN_PROVIDER_CONFIRMATION_SCORE: 70,
  MIN_CRYPTO_PROVIDER_CONFIRMATION_SCORE: 35,
  MIN_SELL_PROVIDER_CONFIRMATION_SCORE: 60,
  SELL_MAX_PROVIDER_PRICE_DIFF_PCT: 0.75,
  MAX_SPREAD_SLIPPAGE_PCT: 7,
  MIN_EDGE_SCORE: 60,
  MIN_VOLUME: 1000,
  BUY_NOTIONAL_TARGET: 150,
  MIN_BUY_NOTIONAL: 25,
  POSITION_STOP_LOSS_DOLLARS: 1,
  POSITION_STOP_LOSS_NOTIONAL_PCT: 0.75,
  POSITION_STOP_LOSS_MAX_DOLLARS: 2.5,
  RISK_BUDGET_SIZING_ENABLED: false,
  MAX_RISK_PER_TRADE_DOLLARS: 0,
  MAX_RISK_PER_TRADE_PCT_EQUITY: 0,
  MAX_TRADE_NOTIONAL: 0,
  MIN_STOP_DISTANCE_DOLLARS: 0.01,
  MAX_STOP_DISTANCE_DOLLARS: 0,
  ALLOW_RISK_BUDGET_FRACTIONAL_SHARES: false,
  RISK_BUDGET_REQUIRE_BROKER_EQUITY: true,
  TRAILING_PROFIT_START_DOLLARS: 0.5,
  TRAILING_PROFIT_GIVEBACK_DOLLARS: 0.3,
  BLOCKED_BUY_CALIBRATION_BUCKETS: [],
  BLOCK_BUYS: false,
  MAX_STALENESS_SECONDS: 60,
  DATA_PROVIDER_PRIMARY: 'alpaca',
  DATA_PROVIDER_SECONDARY: 'finnhub',
  DATA_PROVIDER_FALLBACK: 'fmp',
  AUDIT_LOG_ENABLED: true,
  PAPER_ADAPTER_ENABLED: true,
  REPLAY_MODE: false,
  ALPACA_EXECUTION_ENABLED: false,
  ALPACA_API_KEY_ID: '',
  ALPACA_API_SECRET_KEY: '',
  ALPACA_API_BASE_URL: '',
};

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsvList(value, fallback = []) {
  if (value === undefined || value === null || value === '') return Array.isArray(fallback) ? fallback.slice() : [];
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

const CONFIG_SCHEMA = [
  ['TRADING_MODE', 'string', 'paper', { enum: ['paper', 'live', 'replay'], lower: true }],
  ['LIVE_TRADING_ENABLED', 'bool', false],
  ['REQUIRE_HUMAN_APPROVAL', 'bool', true],
  ['KILL_SWITCH', 'bool', true],
  ['MAX_DAILY_LOSS', 'number', 250],
  ['MAX_POSITION_NOTIONAL', 'number', 1000],
  ['MAX_OPEN_POSITIONS', 'number', 2, { positive: true }],
  ['MAX_TRADES_PER_DAY', 'number', 8],
  ['AUTO_POLICY_REFRESH', 'bool', false],
  ['AUTO_POLICY_REFRESH_MIN_BLOCKED_COUNT', 'number', 2, { positive: true }],
  ['AUTO_POLICY_REFRESH_MIN_REJECTION_PRESSURE_SCORE', 'number', 50, { range: [0, 100] }],
  ['AUTO_POLICY_REFRESH_MIN_PAPER_OUTCOMES', 'number', 1, { positive: true }],
  ['MIN_CONFIDENCE_FOR_PAPER', 'number', 72, { range: [0, 100] }],
  ['MIN_LIQUIDITY_SCORE', 'number', 40, { range: [0, 100] }],
  ['MIN_PROVIDER_CONFIRMATION_SCORE', 'number', 70, { range: [0, 100] }],
  ['MIN_CRYPTO_PROVIDER_CONFIRMATION_SCORE', 'number', 35, { range: [0, 100] }],
  ['MIN_SELL_PROVIDER_CONFIRMATION_SCORE', 'number', 60, { range: [0, 100] }],
  ['SELL_MAX_PROVIDER_PRICE_DIFF_PCT', 'number', 0.75, { range: [0, 100] }],
  ['MAX_SPREAD_SLIPPAGE_PCT', 'number', 7, { range: [0, 100] }],
  ['MIN_EDGE_SCORE', 'number', 60, { range: [0, 100] }],
  ['MIN_VOLUME', 'number', 1000, { positive: true }],
  ['BUY_NOTIONAL_TARGET', 'number', 150, { positive: true }],
  ['MIN_BUY_NOTIONAL', 'number', 25, { positive: true }],
  ['POSITION_STOP_LOSS_DOLLARS', 'number', 1, { positive: true }],
  ['POSITION_STOP_LOSS_NOTIONAL_PCT', 'number', 0.75, { range: [0, 100] }],
  ['POSITION_STOP_LOSS_MAX_DOLLARS', 'number', 2.5],
  ['RISK_BUDGET_SIZING_ENABLED', 'bool', false],
  ['MAX_RISK_PER_TRADE_DOLLARS', 'number', 0, { nonNegative: true }],
  ['MAX_RISK_PER_TRADE_PCT_EQUITY', 'number', 0, { range: [0, 100] }],
  ['MAX_TRADE_NOTIONAL', 'number', 0, { nonNegative: true }],
  ['MIN_STOP_DISTANCE_DOLLARS', 'number', 0.01, { positive: true }],
  ['MAX_STOP_DISTANCE_DOLLARS', 'number', 0, { nonNegative: true }],
  ['ALLOW_RISK_BUDGET_FRACTIONAL_SHARES', 'bool', false],
  ['RISK_BUDGET_REQUIRE_BROKER_EQUITY', 'bool', true],
  ['TRAILING_PROFIT_START_DOLLARS', 'number', 0.5, { positive: true }],
  ['TRAILING_PROFIT_GIVEBACK_DOLLARS', 'number', 0.3, { positive: true }],
  ['BLOCKED_BUY_CALIBRATION_BUCKETS', 'csv'],
  ['BLOCK_BUYS', 'bool', false],
  ['MAX_STALENESS_SECONDS', 'number', 60, { positive: true }],
  ['DATA_PROVIDER_PRIMARY', 'string', 'alpaca'],
  ['DATA_PROVIDER_SECONDARY', 'string', 'finnhub'],
  ['DATA_PROVIDER_FALLBACK', 'string', 'fmp'],
  ['AUDIT_LOG_ENABLED', 'bool', true],
  ['PAPER_ADAPTER_ENABLED', 'bool', true],
  ['REPLAY_MODE', 'bool', false],
  ['ALPACA_EXECUTION_ENABLED', 'bool', false],
  ['ALPACA_API_KEY_ID', 'string', ''],
  ['ALPACA_API_SECRET_KEY', 'string', ''],
  ['ALPACA_API_BASE_URL', 'string', ''],
  ['LIVE_TRADING_CONFIRMATION_PHRASE', 'string', ''],
];

function loadConfig(env = process.env) {
  const config = {};
  const issues = [];

  for (const entry of CONFIG_SCHEMA) {
    const [key, type, defaultVal, opts = {}] = entry;
    const raw = env[key];
    let parsed;

    switch (type) {
      case 'bool':
        parsed = parseBool(raw, defaultVal);
        break;
      case 'number':
        parsed = parseNumber(raw, defaultVal);
        break;
      case 'csv':
        parsed = parseCsvList(raw, defaultVal);
        break;
      case 'string':
        if (raw !== undefined && raw !== null && raw !== '') {
          parsed = opts.lower ? String(raw).toLowerCase() : String(raw);
        } else {
          parsed = defaultVal;
        }
        break;
    }

    config[key] = parsed;

    if (opts.enum && !opts.enum.includes(parsed)) issues.push(`${key}_INVALID`);
    if (opts.range) {
      const [lo, hi] = opts.range;
      if (parsed < lo || parsed > hi) issues.push(`${key}_OUT_OF_RANGE`);
    }
    if (opts.positive && parsed <= 0) issues.push(`${key}_INVALID`);
    if (opts.nonNegative && parsed < 0) issues.push(`${key}_INVALID`);
  }

  if (config.LIVE_TRADING_ENABLED) {
    if (config.TRADING_MODE !== 'live') issues.push('LIVE_TRADING_REQUIRES_LIVE_MODE');
    if (!config.REQUIRE_HUMAN_APPROVAL) issues.push('LIVE_TRADING_REQUIRES_HUMAN_APPROVAL');
    if (!config.LIVE_TRADING_CONFIRMATION_PHRASE) issues.push('LIVE_TRADING_CONFIRMATION_PHRASE_REQUIRED');
    if (!config.AUDIT_LOG_ENABLED) issues.push('LIVE_TRADING_REQUIRES_AUDIT_LOG');
    if (!config.PAPER_ADAPTER_ENABLED) issues.push('LIVE_TRADING_REQUIRES_ADAPTER');
  }
  if (config.ALPACA_EXECUTION_ENABLED) {
    if (!config.ALPACA_API_KEY_ID) issues.push('ALPACA_API_KEY_ID_REQUIRED');
    if (!config.ALPACA_API_SECRET_KEY) issues.push('ALPACA_API_SECRET_KEY_REQUIRED');
    if (!config.ALPACA_API_BASE_URL) issues.push('ALPACA_API_BASE_URL_REQUIRED');
  }
  if (config.TRADING_MODE === 'live' && !config.LIVE_TRADING_ENABLED) {
    issues.push('LIVE_MODE_REQUIRES_LIVE_TRADING_ENABLED');
  }
  if (config.POSITION_STOP_LOSS_MAX_DOLLARS < config.POSITION_STOP_LOSS_DOLLARS) {
    issues.push('POSITION_STOP_LOSS_MAX_DOLLARS_INVALID');
  }
  if (config.MAX_STOP_DISTANCE_DOLLARS > 0 && config.MAX_STOP_DISTANCE_DOLLARS < config.MIN_STOP_DISTANCE_DOLLARS) {
    issues.push('MAX_STOP_DISTANCE_DOLLARS_INVALID');
  }
  if (!Array.isArray(config.BLOCKED_BUY_CALIBRATION_BUCKETS)) {
    issues.push('BLOCKED_BUY_CALIBRATION_BUCKETS_INVALID');
  }

  config.configVersion = '2026-06-14.paper-first.1';

  if (issues.length) {
    const error = new Error(`Unsafe or invalid startup config: ${issues.join(', ')}`);
    error.issues = issues;
    throw error;
  }

  return config;
}

function validateStartupConfig(config) {
  const issues = [];
  if (config.LIVE_TRADING_ENABLED) {
    if (config.TRADING_MODE !== 'live') issues.push('LIVE_TRADING_REQUIRES_LIVE_MODE');
    if (!config.REQUIRE_HUMAN_APPROVAL) issues.push('LIVE_TRADING_REQUIRES_HUMAN_APPROVAL');
    if (!config.LIVE_TRADING_CONFIRMATION_PHRASE) issues.push('LIVE_TRADING_CONFIRMATION_PHRASE_REQUIRED');
    if (!config.AUDIT_LOG_ENABLED) issues.push('LIVE_TRADING_REQUIRES_AUDIT_LOG');
    if (!config.PAPER_ADAPTER_ENABLED) issues.push('LIVE_TRADING_REQUIRES_ADAPTER');
  }
  if (config.ALPACA_EXECUTION_ENABLED) {
    if (!config.ALPACA_API_KEY_ID) issues.push('ALPACA_API_KEY_ID_REQUIRED');
    if (!config.ALPACA_API_SECRET_KEY) issues.push('ALPACA_API_SECRET_KEY_REQUIRED');
    if (!config.ALPACA_API_BASE_URL) issues.push('ALPACA_API_BASE_URL_REQUIRED');
  }
  if (config.TRADING_MODE === 'live' && !config.LIVE_TRADING_ENABLED) {
    issues.push('LIVE_MODE_REQUIRES_LIVE_TRADING_ENABLED');
  }
  if (issues.length) {
    const error = new Error(`Unsafe or invalid startup config: ${issues.join(', ')}`);
    error.issues = issues;
    throw error;
  }
}

function loadJsonConfig(relativePath) {
  const absolutePath = path.resolve(relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

module.exports = {
  DEFAULTS,
  loadConfig,
  loadJsonConfig,
  parseBool,
  parseNumber,
  parseCsvList,
  validateStartupConfig,
};
