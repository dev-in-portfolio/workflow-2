#!/usr/bin/env node
const path = require('path');
const { AlpacaTradeAdapter, loadRuntimeEnv, reconcileBrokerLocalState } = require('../src');

function redactSecrets(text) {
  return String(text || '')
    .replace(/A(K|P)A[A-Z0-9]+/g, '[REDACTED]')
    .replace(/(secret|token|key)(["'=: ]+)[A-Za-z0-9_./+=-]+/gi, '$1$2[REDACTED]');
}

function formatReconciliationResult(result = {}) {
  const lines = [];
  lines.push('Broker / Local Reconciliation');
  lines.push(`Status: ${result.status || 'UNKNOWN'}`);
  lines.push(`Checked: ${result.checked_at || 'unknown'}`);
  lines.push('');
  lines.push(`Account visible: ${yesNo(result.account_available)}`);
  lines.push(`Positions visible: ${yesNo(result.positions_available)} (${result.alpaca_positions?.length ?? 0})`);
  lines.push(`Open orders visible: ${yesNo(result.open_orders_available)} (${result.alpaca_open_orders?.length ?? 0})`);
  lines.push(`Mismatches: ${result.mismatches?.length ?? 0}`);
  lines.push(`Critical: ${result.critical_failures?.length ?? 0}`);
  if (result.warnings?.length) lines.push(`Warnings: ${result.warnings.join(', ')}`);
  if (result.recommended_actions?.length) {
    lines.push('');
    lines.push('Recommended actions:');
    for (const action of result.recommended_actions) lines.push(`- ${action}`);
  }
  return redactSecrets(lines.join('\n'));
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const env = loadRuntimeEnv({ cwd: repoRoot });
  const adapter = new AlpacaTradeAdapter({
    apiKeyId: env.ALPACA_API_KEY_ID,
    apiSecretKey: env.ALPACA_API_SECRET_KEY,
    baseUrl: env.ALPACA_API_BASE_URL,
    paperTrading: String(env.ALPACA_PAPER_TRADING || '').toLowerCase() !== 'false',
  });
  const result = await reconcileBrokerLocalState({ repoRoot, dataDir: path.join(repoRoot, 'data'), env, executionAdapter: adapter });
  process.stdout.write(`${formatReconciliationResult(result)}\n`);
  process.exitCode = result.status === 'CRITICAL' ? 2 : 0;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${redactSecrets(error?.message || String(error))}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  formatReconciliationResult,
  redactSecrets,
};
