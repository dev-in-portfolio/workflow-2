#!/usr/bin/env node
const { runLivePreflight } = require('../src/live-preflight');

function formatPreflightResult(result = {}) {
  const lines = [];
  lines.push('Live Ops Preflight');
  lines.push(`Checked: ${result.checked_at || '-'}`);
  lines.push(`Status: ${result.status || 'UNKNOWN'}`);
  lines.push('');
  lines.push('Broker');
  lines.push(`  Account: ${yesNo(result.broker?.account_available)}`);
  lines.push(`  Positions: ${yesNo(result.broker?.positions_available)} (${result.broker?.position_count ?? 0})`);
  lines.push(`  Open orders: ${yesNo(result.broker?.open_orders_available)} (${result.broker?.open_order_count ?? 0})`);
  lines.push(`  Buying power: ${result.broker?.account_summary?.buying_power ?? '-'}`);
  lines.push('');
  lines.push('Config');
  lines.push(`  Loaded: ${yesNo(result.config?.loaded)}`);
  lines.push(`  .env.local: ${result.config?.env_local_exists ? 'present' : 'missing'}`);
  lines.push(`  Changed after start: ${yesNo(result.config?.env_local_changed_after_start)}`);
  lines.push('');
  lines.push('Policy');
  lines.push(`  Available: ${yesNo(result.policy?.available)}`);
  lines.push(`  Stale: ${yesNo(result.policy?.stale)}`);
  lines.push(`  Source: ${result.policy?.source || '-'}`);
  lines.push(`  Scope: ${result.policy?.scope || '-'}`);
  lines.push(`  Approved symbols (${(result.policy?.approved_symbols || []).length}): ${(result.policy?.approved_symbols || []).join(', ') || 'none'}`);
  lines.push(`  Deprecated fields: ${(result.policy?.deprecated_fields || []).join(', ') || 'none'}`);
  lines.push(`  Suspicious fields: ${(result.policy?.suspicious_fields || []).map((item) => item.field || item).join(', ') || 'none'}`);
  lines.push('');
  lines.push('Processes');
  lines.push(`  Trader count: ${result.processes?.trader?.count ?? 0}`);
  lines.push(`  Scanner count: ${result.processes?.scanner?.count ?? 0}`);
  lines.push(`  Dashboard count: ${result.processes?.dashboard?.count ?? 0}`);
  lines.push(`  Duplicate warnings: ${(result.processes?.duplicate_warnings || []).join(', ') || 'none'}`);
  lines.push('');
  appendList(lines, 'Critical failures', result.critical_failures);
  appendList(lines, 'Warnings', result.warnings);
  appendList(lines, 'Recommended actions', result.recommended_actions);
  return redactSecrets(lines.join('\n'));
}

function appendList(lines, title, items = []) {
  lines.push(title);
  if (!items.length) {
    lines.push('  none');
    return;
  }
  for (const item of items) lines.push(`  - ${item}`);
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function redactSecrets(value) {
  return String(value)
    .replace(/A(K|P)A[A-Z0-9]+/g, '[REDACTED]')
    .replace(/(secret|token|key)(["'=: ]+)[A-Za-z0-9_./+=-]+/gi, '$1$2[REDACTED]');
}

async function main() {
  const result = await runLivePreflight();
  process.stdout.write(`${formatPreflightResult(result)}\n`);
  process.exitCode = result.status === 'NO_GO' ? 2 : result.status === 'WARN' ? 1 : 0;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Live preflight failed: ${redactSecrets(error.message)}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  formatPreflightResult,
  redactSecrets,
};
