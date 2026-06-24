const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { acquireProcessLock, readProcessLock, releaseProcessLock } = require('../src/process-lock');

test('process locks prevent duplicate live starts and release cleanly', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-lock-'));
  const first = acquireProcessLock({ repoRoot, name: 'scanner', owner: 'test', pid: process.pid });
  const second = acquireProcessLock({ repoRoot, name: 'scanner', owner: 'test', pid: process.pid });

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(second.reason, 'LOCK_ALREADY_HELD');

  const released = releaseProcessLock({ repoRoot, name: 'scanner', pid: process.pid });
  assert.equal(released.released, true);
  assert.equal(readProcessLock({ repoRoot, name: 'scanner' }).exists, false);
});

test('stale process locks are replaced', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-lock-'));
  const lockPath = path.join(repoRoot, 'data', 'locks', 'trader.lock.json');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({
    name: 'trader',
    owner: 'old',
    pid: 99999999,
    acquired_at: '2020-01-01T00:00:00.000Z',
    updated_at: '2020-01-01T00:00:00.000Z',
  }));

  const replacement = acquireProcessLock({ repoRoot, name: 'trader', owner: 'test', pid: process.pid, staleMs: 1 });

  assert.equal(replacement.acquired, true);
  assert.equal(replacement.replaced_stale, true);
  assert.equal(readProcessLock({ repoRoot, name: 'trader' }).lock.owner, 'test');
});
