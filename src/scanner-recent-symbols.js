const path = require('path');
const { nowIso, resolveRepoRoot } = require('./util');
const { JsonFileStore } = require('./storage');

function resolveRecentSymbolsPath(env = process.env, repoRoot = resolveRepoRoot()) {
  return path.resolve(env.SCANNER_RECENT_SYMBOLS_PATH || path.join(repoRoot, 'data', 'state', 'scanner-recent-symbols.json'));
}

function loadRecentSymbolMap({ env = process.env, repoRoot = resolveRepoRoot(), profile = 'default', maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const filePath = resolveRecentSymbolsPath(env, repoRoot);
  const store = new JsonFileStore(path.dirname(filePath));
  try {
    const payload = store.read(path.basename(filePath));
    const entries = payload?.profiles?.[profile] || {};
    const now = Date.now();
    return new Map(Object.entries(entries)
      .map(([symbol, timestamp]) => [symbol, Number(timestamp)])
      .filter(([, timestamp]) => Number.isFinite(timestamp) && now - timestamp <= maxAgeMs));
  } catch {
    return new Map();
  }
}

function saveRecentSymbolMap(map, { env = process.env, repoRoot = resolveRepoRoot(), profile = 'default' } = {}) {
  const filePath = resolveRecentSymbolsPath(env, repoRoot);
  const store = new JsonFileStore(path.dirname(filePath));
  try {
    const current = store.read(path.basename(filePath)) || {};
    const profiles = { ...(current.profiles || {}) };
    profiles[profile] = Object.fromEntries(map.entries());
    store.write(path.basename(filePath), {
      updated_at: nowIso(),
      profiles,
    });
  } catch {
    // Cooldown persistence should never stop scanner execution.
  }
}

module.exports = {
  loadRecentSymbolMap,
  resolveRecentSymbolsPath,
  saveRecentSymbolMap,
};
