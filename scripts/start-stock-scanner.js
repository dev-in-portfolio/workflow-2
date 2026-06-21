const { createStockScanner } = require('../src/stock-scanner');
const { loadRuntimeEnv } = require('../src/runtime-env');
const { nowIso } = require('../src/util');
const { resolveRotatingStockSymbols } = require('../src/volatile-stock-universe');

function resolveLocalBaseUrl(env = process.env) {
  return String(env.STOCK_SCANNER_LOCAL_BASE_URL || env.LOCAL_BASE_URL || `http://127.0.0.1:${env.PORT || env.SERVER_PORT || 3000}`).trim();
}

function main(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  const localBaseUrl = resolveLocalBaseUrl(runtimeEnv);
  const stockSymbols = resolveRotatingStockSymbols(runtimeEnv.STOCK_SCANNER_SYMBOLS || env.STOCK_SCANNER_SYMBOLS);
  const scanner = createStockScanner({
    env: runtimeEnv,
    localBaseUrl,
    enabled: true,
    keepAlive: true,
    runtimeStateEnabled: true,
    recentSymbolsEnabled: true,
    symbols: stockSymbols,
    intervalMs: 30_000,
    cooldownMs: 4 * 60_000,
    minMovePct: 0.35,
    maxSpreadPct: 1.5,
    maxCandidatesPerRun: 8,
    notional: Number(runtimeEnv.BUY_NOTIONAL_TARGET || 200),
    allowContrarianEntries: true,
  });
  scanner.start();
  process.stdout.write(`${JSON.stringify({
    status: 'listening',
    service: 'stock-scanner',
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
