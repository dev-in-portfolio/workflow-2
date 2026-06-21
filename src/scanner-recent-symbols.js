const fs = require('fs');
const path = require('path');
const { nowIso } = require('./util');

function resolveRecentSymbolsPath(env = process.env, repoRoot = process.cwd()) {
  return path.resolve(env.SCANNER_RECENT_SYMBOLS_PATH || path.join(repoRoot, 'data', 'logs', 'scanner-recent-symbols.json'));
}

function loadRecentSymbolMap({ env = process.env, repoRoot = process.cwd(), profile = 'default', maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const filePath = resolveRecentSymbolsPath(env, repoRoot);
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entries = payload?.profiles?.[profile] || {};
    const now = Date.now();
    return new Map(Object.entries(entries)
      .map(([symbol, timestamp]) => [symbol, Number(timestamp)])
      .filter(([, timestamp]) => Number.isFinite(timestamp) && now - timestamp <= maxAgeMs));
  } catch {
    return new Map();
  }
}

function saveRecentSymbolMap(map, { env = process.env, repoRoot = process.cwd(), profile = 'default' } = {}) {
  const filePath = resolveRecentSymbolsPath(env, repoRoot);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      current = {};
    }
    const profiles = { ...(current.profiles || {}) };
    profiles[profile] = Object.fromEntries(map.entries());
    fs.writeFileSync(filePath, `${JSON.stringify({
      updated_at: nowIso(),
      profiles,
    }, null, 2)}\n`);
  } catch {
    // Cooldown persistence should never stop scanner execution.
  }
}

module.exports = {
  loadRecentSymbolMap,
  resolveRecentSymbolsPath,
  saveRecentSymbolMap,
};
