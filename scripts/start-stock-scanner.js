const { createStockScanner } = require('../src/stock-scanner');
const { buildScannerConfig } = require('../src/scanner-config');
const { migrateLivePolicyFile } = require('../src/live-policy-file');
const { LIVE_STOCK_POLICY_DEFAULTS, normalizeLiveStockPolicy } = require('../src/live-stock-policy');
const { loadRuntimeEnv } = require('../src/runtime-env');
const { nowIso, resolveRepoRoot } = require('../src/util');
const { parseSymbolList } = require('../src/volatile-stock-universe');
const path = require('path');

function resolveLocalBaseUrl(env = process.env) {
  return String(env.STOCK_SCANNER_LOCAL_BASE_URL || env.LOCAL_BASE_URL || `http://127.0.0.1:${env.PORT || env.SERVER_PORT || 3000}`).trim();
}

function resolvePolicyPath(env = process.env) {
  const configuredPath = String(env.LIVE_POLICY_PATH || '').trim();
  return configuredPath ? path.resolve(resolveRepoRoot(), configuredPath) : path.resolve(resolveRepoRoot(), 'data', 'live-policy.json');
}

function readLivePolicy(policyPath) {
  if (!policyPath) return null;
  return migrateLivePolicyFile(policyPath, { write: false, backup: false }).policy;
}

function buildPolicyExitOverrides(policy = {}) {
  policy = policy && typeof policy === 'object' ? policy : {};
  const map = {
    stopLossDollars: policy.positionStopLossDollars,
    stopLossNotionalPct: policy.positionStopLossNotionalPct,
    stopLossMaxDollars: policy.positionStopLossMaxDollars,
    trailingProfitStartDollars: policy.trailingProfitStartDollars,
    trailingProfitGivebackDollars: policy.trailingProfitGivebackDollars,
    sellNetProfitFloorDollars: policy.sellNetProfitFloorDollars,
    stalePositionExitEnabled: policy.stalePositionExitEnabled,
    stalePositionMaxHoldMinutes: policy.stalePositionMaxHoldMinutes,
    stalePositionMinPeakProfitDollars: policy.stalePositionMinPeakProfitDollars,
    stalePositionMaxExitPnlDollars: policy.stalePositionMaxExitPnlDollars,
    stalledWinnerExitEnabled: policy.stalledWinnerExitEnabled,
    stalledWinnerMaxHoldMinutes: policy.stalledWinnerMaxHoldMinutes,
    stalledWinnerMaxMinutesSincePeak: policy.stalledWinnerMaxMinutesSincePeak,
    stalledWinnerMinProfitDollars: policy.stalledWinnerMinProfitDollars,
  };
  return Object.fromEntries(Object.entries(map).filter(([, value]) => Number.isFinite(Number(value))));
}

function buildLiveEntryOverrides(policy = {}, env = {}) {
  const normalized = normalizeLiveStockPolicy(policy);
  const envMinMovePct = Number(env.STOCK_SCANNER_MIN_MOVE_PCT);
  const envMinRecentMovePct = Number(env.STOCK_SCANNER_MIN_RECENT_MOVE_PCT);
  const envMinRecentRangePct = Number(env.STOCK_SCANNER_MIN_RECENT_RANGE_PCT);
  const envMinRecentCloseLocationPct = Number(env.STOCK_SCANNER_MIN_RECENT_CLOSE_LOCATION_PCT);
  return {
    minMovePct: Math.max(LIVE_STOCK_POLICY_DEFAULTS.minMovePct, normalized.minMovePct, Number.isFinite(envMinMovePct) ? envMinMovePct : 0),
    requireRecentMomentum: normalized.requireRecentMomentum,
    minRecentMovePct: Math.max(LIVE_STOCK_POLICY_DEFAULTS.minRecentMovePct, normalized.minRecentMovePct, Number.isFinite(envMinRecentMovePct) ? envMinRecentMovePct : 0),
    minRecentRangePct: Math.max(LIVE_STOCK_POLICY_DEFAULTS.minRecentRangePct, normalized.minRecentRangePct, Number.isFinite(envMinRecentRangePct) ? envMinRecentRangePct : 0),
    minRecentCloseLocationPct: Math.max(LIVE_STOCK_POLICY_DEFAULTS.minRecentCloseLocationPct, normalized.minRecentCloseLocationPct, Number.isFinite(envMinRecentCloseLocationPct) ? envMinRecentCloseLocationPct : 0),
    allowContrarianEntries: false,
    minAdjustedRankScore: Math.max(LIVE_STOCK_POLICY_DEFAULTS.minAdjustedRankScore, normalized.minAdjustedRankScore),
    scannerSelectionV2ShadowEnabled: true,
    scannerSelectionV2AuthorityEnabled: true,
  };
}

function buildLiveRiskOverrides(policy = {}) {
  const normalized = normalizeLiveStockPolicy(policy);
  return {
    stopLossDollars: normalized.positionStopLossDollars,
    stopLossNotionalPct: normalized.positionStopLossNotionalPct,
    stopLossMaxDollars: Math.min(LIVE_STOCK_POLICY_DEFAULTS.positionStopLossMaxDollars, normalized.positionStopLossMaxDollars),
  };
}

function buildLiveExitOverrides(policy = {}) {
  const normalized = normalizeLiveStockPolicy(policy);
  return {
    stalePositionExitEnabled: normalized.stalePositionExitEnabled,
    stalePositionMaxHoldMinutes: normalized.stalePositionMaxHoldMinutes,
    stalePositionMinPeakProfitDollars: normalized.stalePositionMinPeakProfitDollars,
    stalePositionMaxExitPnlDollars: normalized.stalePositionMaxExitPnlDollars,
    stalledWinnerExitEnabled: normalized.stalledWinnerExitEnabled,
    stalledWinnerMaxHoldMinutes: normalized.stalledWinnerMaxHoldMinutes,
    stalledWinnerMaxMinutesSincePeak: normalized.stalledWinnerMaxMinutesSincePeak,
    stalledWinnerMinProfitDollars: normalized.stalledWinnerMinProfitDollars,
  };
}

function main(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  const scannerEnv = {
    ...runtimeEnv,
    SCANNER_MODE: runtimeEnv.SCANNER_MODE || runtimeEnv.SCANNER_PROFILE || 'live-market',
  };
  const localBaseUrl = resolveLocalBaseUrl(runtimeEnv);
  const policyPath = resolvePolicyPath(scannerEnv);
  const policyMigration = migrateLivePolicyFile(policyPath);
  const livePolicy = policyMigration.policy;
  const policyExitOverrides = buildPolicyExitOverrides(livePolicy);
  const liveRiskOverrides = buildLiveRiskOverrides(livePolicy);
  const liveExitOverrides = buildLiveExitOverrides(livePolicy);
  const liveEntryOverrides = buildLiveEntryOverrides(livePolicy, scannerEnv);
  const stockSymbols = parseSymbolList(
    scannerEnv.STOCK_SCANNER_SYMBOLS || env.STOCK_SCANNER_SYMBOLS,
    [],
  );
  const scanner = createStockScanner({
    env: scannerEnv,
    scannerConfig: buildScannerConfig(scannerEnv),
    scannerMode: 'live-market',
    localBaseUrl,
    enabled: true,
    keepAlive: true,
    runtimeStateEnabled: true,
    symbols: stockSymbols,
    intervalMs: 10_000,
    maxCandidatesPerRun: 8,
    notional: Number(livePolicy.buyNotionalTarget || runtimeEnv.BUY_NOTIONAL_TARGET || 150),
    ...liveEntryOverrides,
    ...liveExitOverrides,
    ...policyExitOverrides,
    ...liveRiskOverrides,
  });
  scanner.start();
  process.stdout.write(`${JSON.stringify({
    status: 'listening',
    service: 'stock-scanner',
    local_base_url: localBaseUrl,
    policy_path: policyPath,
    policy_migration: {
      status: policyMigration.status,
      backup_path: policyMigration.backupPath,
      wrote: policyMigration.wrote,
    },
    live_entry_overrides: liveEntryOverrides,
    live_risk_overrides: liveRiskOverrides,
    live_exit_overrides: liveExitOverrides,
    policy_exit_overrides: policyExitOverrides,
    timestamp: nowIso(),
  }, null, 2)}\n`);
  return scanner;
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  buildPolicyExitOverrides,
  buildLiveEntryOverrides,
  buildLiveRiskOverrides,
  buildLiveExitOverrides,
  readLivePolicy,
  resolvePolicyPath,
  resolveLocalBaseUrl,
};
