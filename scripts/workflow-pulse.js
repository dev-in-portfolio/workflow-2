const { loadRuntimeEnv } = require('../src/runtime-env');
const { resolveRepoRoot } = require('../src/util');
const { resolveWorkflowPulsePath, writeWorkflowPulse } = require('../src/workflow-pulse');

const repoRoot = resolveRepoRoot();
const env = loadRuntimeEnv(process.env, repoRoot);
const pulse = writeWorkflowPulse({ repoRoot, env });
process.stdout.write(`${JSON.stringify({
  ok: true,
  pulse_path: resolveWorkflowPulsePath({ repoRoot, env }),
  generated_at: pulse.generated_at,
  overall_status: pulse.overall_status,
  alert_count: pulse.alerts.length,
}, null, 2)}\n`);
