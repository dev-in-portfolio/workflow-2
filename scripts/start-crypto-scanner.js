const { createOvernightScanner } = require('../src/overnight-scanner');
const { loadRuntimeEnv } = require('../src/runtime-env');
const { nowIso } = require('../src/util');

function resolveLocalBaseUrl(env = process.env) {
  return String(env.CRYPTO_SCANNER_LOCAL_BASE_URL || env.OVERNIGHT_SCANNER_LOCAL_BASE_URL || env.LOCAL_BASE_URL || `http://127.0.0.1:${env.PORT || env.SERVER_PORT || 3001}`).trim();
}

function main(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  const localBaseUrl = resolveLocalBaseUrl(runtimeEnv);
  const scanner = createOvernightScanner({
    env: runtimeEnv,
    localBaseUrl,
    enabled: true,
    keepAlive: true,
    runtimeStateEnabled: true,
    recentSymbolsEnabled: true,
    symbols: runtimeEnv.OVERNIGHT_SCANNER_SYMBOLS || env.OVERNIGHT_SCANNER_SYMBOLS,
    notional: Number(runtimeEnv.BUY_NOTIONAL_TARGET || 150),
    sellProfitThresholdPct: Number(runtimeEnv.OVERNIGHT_SCANNER_SELL_PROFIT_THRESHOLD_PCT || 5),
    sellNetProfitFloorDollars: Number(runtimeEnv.SELL_NET_PROFIT_FLOOR_DOLLARS || runtimeEnv.OVERNIGHT_SCANNER_SELL_NET_PROFIT_FLOOR_DOLLARS || 1),
    sellLossThresholdPct: Number(runtimeEnv.OVERNIGHT_SCANNER_SELL_LOSS_EXIT_THRESHOLD_PCT || 0.75),
  });
  scanner.start();
  process.stdout.write(`${JSON.stringify({
    status: 'listening',
    service: 'crypto-only-scanner',
    mode: 'crypto-only',
    local_base_url: localBaseUrl,
    timestamp: nowIso(),
  }, null, 2)}\n`);
  return scanner;
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  resolveLocalBaseUrl,
};
