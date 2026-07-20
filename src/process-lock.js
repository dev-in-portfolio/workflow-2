const fs = require('fs');
const path = require('path');
const { nowIso, resolveRepoRoot } = require('./util');

const DEFAULT_STALE_MS = 10 * 60 * 1000;

function lockPathFor(repoRoot = resolveRepoRoot(), name) {
  return path.resolve(repoRoot, 'data', 'locks', `${name}.lock.json`);
}

function readProcessLock({ repoRoot = resolveRepoRoot(), name } = {}) {
  const filePath = lockPathFor(repoRoot, name);
  try {
    return { path: filePath, exists: true, lock: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch {
    return { path: filePath, exists: false, lock: null };
  }
}

function acquireProcessLock({ repoRoot = resolveRepoRoot(), name, owner = 'unknown', pid = process.pid, metadata = {}, staleMs = DEFAULT_STALE_MS } = {}) {
  if (!name) throw new Error('Process lock requires a name');
  const filePath = lockPathFor(repoRoot, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = readProcessLock({ repoRoot, name });
  if (existing.lock && !isStaleProcessLock(existing.lock, staleMs)) {
    return {
      acquired: false,
      path: filePath,
      existing: existing.lock,
      reason: 'LOCK_ALREADY_HELD',
    };
  }
  const lock = {
    name,
    owner,
    pid,
    acquired_at: nowIso(),
    updated_at: nowIso(),
    hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || null,
    metadata,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(lock, null, 2)}\n`);
  return { acquired: true, path: filePath, lock, replaced_stale: Boolean(existing.lock) };
}

function releaseProcessLock({ repoRoot = resolveRepoRoot(), name, pid = null } = {}) {
  const current = readProcessLock({ repoRoot, name });
  if (!current.exists) return { released: false, reason: 'LOCK_NOT_FOUND', path: current.path };
  if (pid !== null && current.lock?.pid && Number(current.lock.pid) !== Number(pid)) {
    return { released: false, reason: 'LOCK_OWNED_BY_OTHER_PID', path: current.path, existing: current.lock };
  }
  try {
    fs.unlinkSync(current.path);
    return { released: true, path: current.path };
  } catch (error) {
    return { released: false, reason: 'LOCK_REMOVE_FAILED', path: current.path, error: error.message };
  }
}

function listProcessLocks({ repoRoot = resolveRepoRoot() } = {}) {
  const dir = path.resolve(repoRoot, 'data', 'locks');
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.lock.json'))
      .map((fileName) => {
        const name = fileName.replace(/\.lock\.json$/, '');
        return readProcessLock({ repoRoot, name });
      });
  } catch {
    return [];
  }
}

function isStaleProcessLock(lock = {}, staleMs = DEFAULT_STALE_MS) {
  if (lock.pid) return !isPidAlive(lock.pid);
  const updatedAt = new Date(lock.updated_at || lock.acquired_at || 0).getTime();
  if (!Number.isFinite(updatedAt)) return true;
  return Date.now() - updatedAt > staleMs;
}

function isPidAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  acquireProcessLock,
  isPidAlive,
  isStaleProcessLock,
  listProcessLocks,
  lockPathFor,
  readProcessLock,
  releaseProcessLock,
};
