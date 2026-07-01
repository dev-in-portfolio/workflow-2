const REGULAR_WATCH_REASON_CODES = {
  CONFIG_DISABLED: 'regular_watch_disabled_in_config',
  DEPENDENCY_BLOCKED: 'dependency_blocked',
  MASTER_DISABLED: 'REGULAR_WATCH_INTELLIGENCE_ENABLED is off',
  PRIORITY_BLOCKED: 'REGULAR_WATCH_PRIORITY_SCORING_ENABLED is off',
  LOCKED_NOT_IMPLEMENTED: 'not_implemented',
  LOCKED_FEATURE: 'feature_locked',
  CORRUPT_STATE: 'regular_watch_state_corrupt',
  HALTED: 'halted',
  NOT_TRADABLE: 'not_tradable',
  STALE_DATA: 'stale_market_data',
  WIDE_SPREAD: 'wide_spread',
  SOURCE_UNAVAILABLE: 'source_not_found_or_inaccessible',
  MISSING_CREDENTIALS: 'missing_credentials',
};

module.exports = {
  REGULAR_WATCH_REASON_CODES,
};
