const { createStockScanner } = require('../src/stock-scanner');
const { buildScannerConfig } = require('../src/scanner-config');
const { loadRuntimeEnv } = require('../src/runtime-env');
const { nowIso } = require('../src/util');
const { APPROVED_LIVE_MARKET_SYMBOLS, parseSymbolList } = require('../src/volatile-stock-universe');

function resolveLocalBaseUrl(env = process.env) {
  return String(env.STOCK_SCANNER_LOCAL_BASE_URL || env.LOCAL_BASE_URL || `http://127.0.0.1:${env.PORT || env.SERVER_PORT || 3000}`).trim();
}

function main(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  const localBaseUrl = resolveLocalBaseUrl(runtimeEnv);
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
    requireMultiSourceConfirmation: false,
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
