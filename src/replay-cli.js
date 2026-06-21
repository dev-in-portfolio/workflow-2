const fs = require('fs');
const path = require('path');
const { loadJsonConfig } = require('./config');
const { PaperTradeAdapter } = require('./paper-adapter');
const { resolvePolicyPath } = require('./policy-cli');
const { runReplay } = require('./replay');
const { loadRuntimeEnv } = require('./runtime-env');

function resolveRiskPolicyPath(env = process.env) {
  return resolvePolicyPath(env);
}

function main() {
  const fixturePath = process.argv[2] || path.resolve('examples/replay-fixture.json');
  const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const runtimeEnv = loadRuntimeEnv();
  const riskPolicyPath = resolveRiskPolicyPath(runtimeEnv);
  const riskConfig = { ...loadJsonConfig(riskPolicyPath), killSwitch: false };
  const adapter = new PaperTradeAdapter({ dryRun: true });
  const result = runReplay(fixtures, {
    paperAdapter: adapter,
    riskConfig,
    policySnapshot: riskConfig,
    date: new Date().toISOString().slice(0, 10),
  });
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  resolveRiskPolicyPath,
};
