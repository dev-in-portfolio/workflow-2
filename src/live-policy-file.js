const fs = require('fs');
const path = require('path');
const { LIVE_STOCK_POLICY_DEFAULTS, normalizeLiveStockPolicy } = require('./live-stock-policy');
const { safeNumber } = require('./util');

const LIVE_POLICY_SCHEMA_VERSION = 2;

function canonicalizeLivePolicy(policy = {}) {
  const source = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
  const normalized = normalizeLiveStockPolicy(source);
  const minBuyNotional = Math.max(1, safeNumber(source.minBuyNotional, 25));
  const buyNotionalTarget = Math.max(minBuyNotional, safeNumber(source.buyNotionalTarget, 150));

  return {
    ...source,
    ...normalized,
    buyNotionalTarget,
    minBuyNotional,
    allowContrarianEntries: false,
    minAdjustedRankScore: Math.max(
      LIVE_STOCK_POLICY_DEFAULTS.minAdjustedRankScore,
      safeNumber(source.minAdjustedRankScore, LIVE_STOCK_POLICY_DEFAULTS.minAdjustedRankScore),
    ),
    scannerSelectionV2AuthorityEnabled: true,
    positionStopLossMaxDollars: Math.min(
      LIVE_STOCK_POLICY_DEFAULTS.positionStopLossMaxDollars,
      Math.max(0.01, safeNumber(source.positionStopLossMaxDollars, LIVE_STOCK_POLICY_DEFAULTS.positionStopLossMaxDollars)),
    ),
  };
}

function normalizeLivePolicyDocument(payload = {}, options = {}) {
  const sourceDocument = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const sourcePolicy = sourceDocument.policy && typeof sourceDocument.policy === 'object'
    ? sourceDocument.policy
    : sourceDocument;
  const policy = canonicalizeLivePolicy(sourcePolicy);
  const timestamp = options.now instanceof Date ? options.now.toISOString() : new Date(options.now || Date.now()).toISOString();
  const wrapped = sourceDocument.policy && typeof sourceDocument.policy === 'object';
  const preservedDocument = wrapped ? sourceDocument : {};

  return {
    ...preservedDocument,
    schema_version: LIVE_POLICY_SCHEMA_VERSION,
    source: preservedDocument.source || 'workflow-2-live-policy',
    migrated_at: timestamp,
    policy,
  };
}

function migrateLivePolicyFile(policyPath, options = {}) {
  if (!policyPath) throw new Error('A live policy path is required');
  const resolvedPath = path.resolve(policyPath);
  const write = options.write !== false;
  const backup = options.backup !== false;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let existingText = null;
  let existingDocument = null;
  let invalidJson = false;

  if (fs.existsSync(resolvedPath)) {
    existingText = fs.readFileSync(resolvedPath, 'utf8');
    try {
      existingDocument = JSON.parse(existingText);
    } catch {
      invalidJson = true;
      existingDocument = {};
    }
  }

  const normalized = normalizeLivePolicyDocument(existingDocument || {}, { now });
  const currentPolicy = existingDocument?.policy && typeof existingDocument.policy === 'object'
    ? existingDocument.policy
    : existingDocument || {};
  const unchanged = !invalidJson
    && existingDocument?.schema_version === LIVE_POLICY_SCHEMA_VERSION
    && JSON.stringify(currentPolicy) === JSON.stringify(normalized.policy);

  if (unchanged) {
    return {
      status: 'unchanged',
      path: resolvedPath,
      backupPath: null,
      policy: normalized.policy,
      document: existingDocument,
      wrote: false,
    };
  }

  let backupPath = null;
  if (write) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    if (existingText !== null && backup) {
      backupPath = `${resolvedPath}.${invalidJson ? 'invalid' : 'backup'}-${stamp}`;
      fs.writeFileSync(backupPath, existingText, 'utf8');
    }
    const tempPath = `${resolvedPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, resolvedPath);
  }

  return {
    status: existingText === null ? 'created' : invalidJson ? 'recovered' : 'migrated',
    path: resolvedPath,
    backupPath,
    policy: normalized.policy,
    document: normalized,
    wrote: write,
  };
}

module.exports = {
  LIVE_POLICY_SCHEMA_VERSION,
  canonicalizeLivePolicy,
  migrateLivePolicyFile,
  normalizeLivePolicyDocument,
};
