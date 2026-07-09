const { loadRuntimeEnv } = require('../src/runtime-env');
const { migrateLivePolicyFile } = require('../src/live-policy-file');
const { resolvePolicyPath } = require('./start-stock-scanner');

function main(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  const policyPath = resolvePolicyPath(runtimeEnv);
  const result = migrateLivePolicyFile(policyPath);
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    policy_path: result.path,
    backup_path: result.backupPath,
    wrote: result.wrote,
    policy: result.policy,
  }, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
