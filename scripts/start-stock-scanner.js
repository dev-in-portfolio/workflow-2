const { createStockScanner } = require('../src/stock-scanner');
const { buildScannerConfig } = require('../src/scanner-config');
const { loadRuntimeEnv } = require('../src/runtime-env');
const { nowIso, resolveRepoRoot } = require('../src/util');
const { APPROVED_LIVE_MARKET_SYMBOLS, parseSymbolList } = require('../src/volatile-stock-universe');
const fs = require('fs');
const path = require('path');

function resolveLocalBaseUrl(env = process.env) {
  return String(env.STOCK_SCANNER_LOCAL_BASE_URL || env.LOCAL_BASE_URL || `http://127.0.0.1:${env.PORT || env.SERVER_PORT || 3000}`).trim();
}

function resolvePolicyPath(env = process.env) {
  const configuredPath = String(env.LIVE_POLICY_PATH || '').trim();
  return configuredPath ? path.resolve(resolveRepoRoot(), configuredPath) : path.resolve(resolveRepoRoot(), 'data', 'live-policy.json');
}

function readLivePolicy(policyPath) {
  try {
    if (!policyPath || !fs.existsSync(policyPath)) return null;
    const payload = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    return payload?.policy || null;
  } catch {
    return null;
  }
}

function buildPolicyExitOverrides(policy = {}) {
  const map = {
    stopLossDollars: policy.positionStopLossDollars,
    stopLossNotionalPct: policy.positionStopLossNotionalPct,
    stopLossMaxDollars: policy.positionStopLossMaxDollars,
    trailingProfitStartDollars: policy.trailingProfitStartDollars,
    trailingProfitGivebackDollars: policy.trailingProfitGivebackDollars,
    sellNetProfitFloorDollars: policy.sellNetProfitFloorDollars,
  };
  return Object.fromEntries(Object.entries(map).filter(([, value]) => Number.isFinite(Number(value))));
}

function main(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  const localBaseUrl = resolveLocalBaseUrl(runtimeEnv);
  const policyPath = resolvePolicyPath(runtimeEnv);
  const livePolicy = readLivePolicy(policyPath);
  const policyExitOverrides = buildPolicyExitOverrides(livePolicy);
  const stockSymbols = parseSymbolList(
    runtimeEnv.STOCK_SCANNER_SYMBOLS || env.STOCK_SCANNER_SYMBOLS,
    APPROVED_LIVE_MARKET_SYMBOLS,
  );
  const scanner = createStockScanner({
    env: runtimeEnv,
    scannerConfig: buildScannerConfig(runtimeEnv),
    localBaseUrl,
    enabled: true,
    keepAlive: true,
    runtimeStateEnabled: true,
    symbols: stockSymbols,
    intervalMs: 30_000,
    maxCandidatesPerRun: 8,
    notional: Number(runtimeEnv.BUY_NOTIONAL_TARGET || 150),
    allowContrarianEntries: true,
    ...policyExitOverrides,
  });
  scanner.start();
  process.stdout.write(`${JSON.stringify({
    status: 'listening',
    service: 'stock-scanner',
    local_base_url: localBaseUrl,
    policy_path: policyPath,
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
  readLivePolicy,
  resolvePolicyPath,
  resolveLocalBaseUrl,
};
