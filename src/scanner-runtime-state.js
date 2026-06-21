const fs = require('fs');
const path = require('path');
const { nowIso } = require('./util');
const { appendOperatorTimelineEvent } = require('./operator-timeline');

function resolveScannerRuntimePath(env = process.env, repoRoot = process.cwd()) {
  return path.resolve(env.SCANNER_RUNTIME_STATE_PATH || path.join(repoRoot, 'data', 'logs', 'scanner-runtime.json'));
}

function writeScannerRuntimeState(snapshot = {}, options = {}) {
  const filePath = options.filePath || resolveScannerRuntimePath(options.env || process.env, options.repoRoot || process.cwd());
  const payload = {
    updated_at: nowIso(),
    ...snapshot,
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
    appendOperatorTimelineEvent({
      timestamp: payload.last_scan_time || payload.updated_at,
      event_type: 'scanner.scan',
      source: payload.scanner || 'scanner',
      title: `${payload.mode || payload.loaded_mode || 'scanner'} scan`,
      message: payload.last_scan_error
        ? `Scan error: ${payload.last_scan_error}`
        : `Posted ${payload.posted_count ?? 0}, approved ${payload.approved_count ?? 0}, rejected ${payload.rejected_count ?? 0}`,
      severity: payload.last_scan_error ? 'warning' : 'info',
      details: {
        mode: payload.mode || payload.loaded_mode || null,
        candidate_count: payload.candidate_count ?? null,
        posted_count: payload.posted_count ?? null,
        approved_count: payload.approved_count ?? null,
        rejected_count: payload.rejected_count ?? null,
        allocation: payload.allocation || null,
        portfolio: payload.portfolio || null,
      },
    }, options);
  } catch {
    // Telemetry is read-only for operators; scanner execution should not fail if it cannot be written.
  }
  return payload;
}

module.exports = {
  resolveScannerRuntimePath,
  writeScannerRuntimeState,
};
