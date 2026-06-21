const fs = require('fs');
const path = require('path');
const { loadRuntimeEnv } = require('../src/runtime-env');

function resolveStatusSnapshotPath(env = process.env) {
  const configuredPath = String(env.OVERNIGHT_STATUS_PATH || env.STATUS_SNAPSHOT_PATH || '').trim();
  return configuredPath ? path.resolve(configuredPath) : path.resolve('data', 'logs', 'overnight-status.json');
}

function readOvernightStatus(env = process.env) {
  const runtimeEnv = env === process.env ? loadRuntimeEnv(env) : env;
  const statusSnapshotPath = resolveStatusSnapshotPath(runtimeEnv);
  const maxAgeMinutes = resolveMaxAgeMinutes(runtimeEnv);
  if (!fs.existsSync(statusSnapshotPath)) {
    const payload = {
      accepted: false,
      error: 'status_snapshot_missing',
      status_snapshot_path: statusSnapshotPath,
      snapshot_fresh: false,
      stale: true,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 2;
    return payload;
  }

  const payload = JSON.parse(fs.readFileSync(statusSnapshotPath, 'utf8'));
  const ageMinutes = calculateSnapshotAgeMinutes(payload, statusSnapshotPath);
  const stale = Number.isFinite(maxAgeMinutes) ? ageMinutes > maxAgeMinutes : false;
  const output = {
    accepted: true,
    status_snapshot_path: statusSnapshotPath,
    snapshot_fresh: !stale,
    stale,
    age_minutes: ageMinutes,
    max_age_minutes: maxAgeMinutes,
    uptime_minutes: Number.isFinite(Number(payload?.uptime_minutes)) ? Number(payload.uptime_minutes) : null,
    started_at: payload?.started_at || null,
    request_count: Number.isFinite(Number(payload?.request_count)) ? Number(payload.request_count) : null,
    heartbeat_count: Number.isFinite(Number(payload?.heartbeat_count)) ? Number(payload.heartbeat_count) : null,
    last_request_at: payload?.last_request_at || null,
    payload,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = stale ? 2 : 0;
  return output;
}

function resolveMaxAgeMinutes(env = process.env) {
  const raw = Number(env.OVERNIGHT_STATUS_MAX_AGE_MINUTES ?? env.STATUS_MAX_AGE_MINUTES ?? 15);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15;
}

function calculateSnapshotAgeMinutes(payload, statusSnapshotPath) {
  const candidate = payload?.timestamp || payload?.payload?.timestamp || null;
  const timestamp = candidate ? new Date(candidate) : null;
  if (timestamp && !Number.isNaN(timestamp.getTime())) {
    return Math.max(0, (Date.now() - timestamp.getTime()) / 60000);
  }
  try {
    const stats = fs.statSync(statusSnapshotPath);
    return Math.max(0, (Date.now() - stats.mtimeMs) / 60000);
  } catch {
    return Infinity;
  }
}

if (require.main === module) {
  readOvernightStatus();
}

module.exports = {
  calculateSnapshotAgeMinutes,
  readOvernightStatus,
  resolveMaxAgeMinutes,
  resolveStatusSnapshotPath,
};
