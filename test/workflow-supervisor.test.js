const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WORKFLOW_SCANNER_PROFILE, normalizeState, isFresh } = require('../src/workflow-supervisor');

test('workflow 2 is permanently stock-only', () => {
  assert.equal(WORKFLOW_SCANNER_PROFILE, 'live-market');
});

test('workflow supervisor state represents all core services as one unit', () => {
  const state = normalizeState(null, { maxAttempts: 3 });
  assert.equal(state.status, 'stopped');
  assert.equal(state.max_attempts, 3);
  assert.deepEqual(Object.keys(state.services), ['trader', 'scanner', 'dashboard']);
  assert.equal(Object.values(state.services).every((service) => service.status === 'stopped'), true);
});

test('workflow supervisor detects fresh and stale scanner heartbeats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-supervisor-'));
  const file = path.join(dir, 'scanner-runtime.json');
  fs.writeFileSync(file, '{}');
  assert.equal(isFresh(file, 5_000), true);
  fs.utimesSync(file, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
  assert.equal(isFresh(file, 5_000), false);
});
