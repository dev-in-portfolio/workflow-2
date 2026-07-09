const { safeNumber } = require('./util');

const DEPRECATED_POLICY_FIELDS = [
  'cooldownAfterLossMinutes',
  'cooldownAfterSignalSpamMinutes',
  'duplicateSignalWindowMinutes',
  'volatilityThresholdPct',
];

function evaluatePolicyHealth(options = {}) {
  const snapshot = options.policySnapshot || options.policy || null;
  const runtimeEnv = options.runtimeEnv || {};
  const envLocalMtimeMs = safeNumber(options.envLocalMtimeMs, null);
  const nowMs = new Date(options.now || Date.now()).getTime();
  const policy = snapshot?.policy || snapshot || {};
  const warnings = [];
  const criticalFailures = [];
  const deprecatedFields = [];
  const suspiciousFields = [];
  const drift = [];

  const source = snapshot?.source || null;
  const scope = snapshot?.scope || null;
  const capturedAt = snapshot?.captured_at || snapshot?.capturedAt || null;
  const capturedMs = new Date(capturedAt || 0).getTime();

  if (!snapshot || !Object.keys(snapshot).length) {
    warnings.push('POLICY_MISSING');
  }
  if (!source) warnings.push('POLICY_SOURCE_MISSING');
  if (!scope) warnings.push('POLICY_SCOPE_MISSING');
  if (!capturedAt) warnings.push('POLICY_CAPTURED_AT_MISSING');
  if (Number.isFinite(envLocalMtimeMs) && Number.isFinite(capturedMs) && capturedMs > 0 && capturedMs < envLocalMtimeMs) {
    warnings.push('POLICY_CAPTURED_BEFORE_ENV_LOCAL_CHANGE');
  }
  if (Number.isFinite(nowMs) && Number.isFinite(capturedMs) && capturedMs > 0) {
    const ageHours = (nowMs - capturedMs) / 3_600_000;
    if (ageHours > 24) warnings.push('POLICY_FILE_OLDER_THAN_EXPECTED');
  }

  for (const field of DEPRECATED_POLICY_FIELDS) {
    if (policy[field] !== undefined && policy[field] !== null && policy[field] !== '') {
      deprecatedFields.push(field);
    }
  }

  checkPositiveThreshold(policy, 'minConfidenceForPaper', criticalFailures, suspiciousFields);
  checkPositiveThreshold(policy, 'minProviderConfirmationScore', criticalFailures, suspiciousFields);
  checkPositiveThreshold(policy, 'minEdgeScore', criticalFailures, suspiciousFields);
  checkPositiveThreshold(policy, 'minVolume', criticalFailures, suspiciousFields);

  const maxSpread = safeNumber(policy.maxSpreadSlippagePct, null);
  if (Number.isFinite(maxSpread) && maxSpread > 25) {
    suspiciousFields.push({ field: 'maxSpreadSlippagePct', value: maxSpread, reason: 'OVERLY_PERMISSIVE_SPREAD_THRESHOLD' });
    criticalFailures.push('POLICY_MAX_SPREAD_TOO_PERMISSIVE');
  }

  if (Array.isArray(policy.blockedBuyCalibrationBuckets) && policy.blockedBuyCalibrationBuckets.length) {
    suspiciousFields.push({ field: 'blockedBuyCalibrationBuckets', value: policy.blockedBuyCalibrationBuckets, reason: 'STALE_BUY_BLOCKLIST_ACTIVE' });
    warnings.push('POLICY_STALE_BLOCKLIST_ACTIVE');
  }
  if (policy.blockBuys === true) {
    suspiciousFields.push({ field: 'blockBuys', value: true, reason: 'BUY_SIDE_BLOCKED' });
    warnings.push('POLICY_BUY_SIDE_BLOCKED');
  }
  if (deprecatedFields.length) {
    warnings.push('POLICY_DEPRECATED_FIELDS_PRESENT');
  }

  addDrift(drift, 'maxOpenPositions', policy.maxOpenPositions, runtimeEnv.MAX_OPEN_POSITIONS);
  addDrift(drift, 'buyNotionalTarget', policy.buyNotionalTarget, runtimeEnv.BUY_NOTIONAL_TARGET);
  addDrift(drift, 'minBuyNotional', policy.minBuyNotional, runtimeEnv.MIN_BUY_NOTIONAL);
  addDrift(drift, 'maxSpreadSlippagePct', policy.maxSpreadSlippagePct, runtimeEnv.MAX_SPREAD_SLIPPAGE_PCT);
  addDrift(drift, 'minVolume', policy.minVolume, runtimeEnv.MIN_VOLUME);

  const stale = warnings.some((warning) => [
    'POLICY_MISSING',
    'POLICY_SOURCE_MISSING',
    'POLICY_SCOPE_MISSING',
    'POLICY_CAPTURED_AT_MISSING',
    'POLICY_CAPTURED_BEFORE_ENV_LOCAL_CHANGE',
    'POLICY_FILE_OLDER_THAN_EXPECTED',
  ].includes(warning));

  return {
    healthy: criticalFailures.length === 0 && warnings.length === 0,
    stale,
    source,
    scope,
    captured_at: capturedAt,
    deprecated_fields: deprecatedFields,
    suspicious_fields: suspiciousFields,
    drift,
    warnings: [...new Set(warnings)],
    critical_failures: [...new Set(criticalFailures)],
  };
}

function checkPositiveThreshold(policy, field, criticalFailures, suspiciousFields) {
  const value = safeNumber(policy[field], null);
  if (Number.isFinite(value) && value <= 0) {
    suspiciousFields.push({ field, value, reason: 'ZEROED_SAFETY_THRESHOLD' });
    criticalFailures.push(`POLICY_${field}_ZEROED`);
  }
}

function addDrift(drift, field, activeValue, runtimeValue) {
  if (runtimeValue === undefined || runtimeValue === null || runtimeValue === '') return;
  if (activeValue === undefined || activeValue === null) return;
  const runtimeNumber = Number(runtimeValue);
  const activeNumber = Number(activeValue);
  const equal = Number.isFinite(runtimeNumber) && Number.isFinite(activeNumber)
    ? runtimeNumber === activeNumber
    : String(activeValue) === String(runtimeValue);
  if (!equal) {
    drift.push({ field, active: activeValue, runtime: runtimeValue });
  }
}

module.exports = {
  DEPRECATED_POLICY_FIELDS,
  evaluatePolicyHealth,
};
