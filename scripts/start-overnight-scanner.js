const { createMarketAwareScanner } = require('../src/market-aware-scanner');
const { loadRuntimeEnv } = require('../src/runtime-env');
const { nowIso } = require('../src/util');

function resolveLocalBaseUrl(env = process.env) {
  return String(env.OVERNIGHT_SCANNER_LOCAL_BASE_URL || env.LOCAL_BASE_URL || `http://127.0.0.1:${env.PORT || env.SERVER_PORT || 3000}`).trim();
}

function main(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  const localBaseUrl = resolveLocalBaseUrl(runtimeEnv);
  const scanner = createMarketAwareScanner({
    env: runtimeEnv,
    localBaseUrl,
    enabled: true,
    keepAlive: true,
    runtimeStateEnabled: true,
    recentSymbolsEnabled: true,
  });
  scanner.start();
  process.stdout.write(`${JSON.stringify({
    status: 'listening',
    service: 'market-aware-scanner',
    local_base_url: localBaseUrl,
    regime: scanner.state.activeRegime,
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
