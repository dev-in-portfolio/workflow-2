const path = require('path');
const { nowIso, resolveRepoRoot } = require('./util');
const { JsonFileStore } = require('./storage');
const { appendOperatorTimelineEvent } = require('./operator-timeline');

function resolveScannerRuntimePath(env = process.env, repoRoot = resolveRepoRoot()) {
  return path.resolve(env.SCANNER_RUNTIME_STATE_PATH || path.join(repoRoot, 'data', 'state', 'scanner-runtime.json'));
}

function writeScannerRuntimeState(snapshot = {}, options = {}) {
  const filePath = options.filePath || resolveScannerRuntimePath(options.env || process.env, options.repoRoot || resolveRepoRoot());
  const store = new JsonFileStore(path.dirname(filePath));
  const payload = {
    updated_at: nowIso(),
    ...snapshot,
  };
  try {
    store.write(path.basename(filePath), payload);
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
