const path = require('path');
const { PerformanceStore } = require('./feedback-loop');
const { nowIso } = require('./util');
const { loadRuntimeEnv } = require('./runtime-env');

function resolveHistoryPath(env = process.env) {
  return path.resolve(String(env.PERFORMANCE_HISTORY_PATH || 'data/performance-history.jsonl'));
}

function resolvePolicyPath(env = process.env) {
  return path.resolve(String(env.LIVE_POLICY_PATH || 'data/live-policy.json'));
}

function resolvePolicyHistoryPath(env = process.env) {
  return path.resolve(String(env.POLICY_HISTORY_PATH || 'data/policy-history.jsonl'));
}

function refreshPolicySnapshot(env = process.env, options = {}) {
  const runtimeEnv = env === process.env ? loadRuntimeEnv(env) : env;
  const historyPath = options.historyPath || resolveHistoryPath(runtimeEnv);
  const policyPath = options.policyPath || resolvePolicyPath(runtimeEnv);
  const policyHistoryPath = options.policyHistoryPath || resolvePolicyHistoryPath(runtimeEnv);
  const store = new PerformanceStore({ historyPath, policyPath, policyHistoryPath });
  const snapshot = store.refreshPolicyFromLearning({
    source: 'tuning',
    reportDate: options.reportDate || undefined,
  });
  process.stdout.write(`${JSON.stringify({
    accepted: true,
    history_path: historyPath,
    policy_path: policyPath,
    policy_history_path: policyHistoryPath,
    policy_snapshot: snapshot,
  }, null, 2)}\n`);
  return snapshot;
}

if (require.main === module) {
  refreshPolicySnapshot(loadRuntimeEnv());
}

module.exports = {
  refreshPolicySnapshot,
  resolveHistoryPath,
  resolvePolicyPath,
  resolvePolicyHistoryPath,
};
