const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath, baseEnv = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ...baseEnv };
  }

  const loaded = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...rest] = line.split('=');
    if (!key || !rest.length) continue;
    let value = rest.join('=').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    loaded[key.trim()] = value;
  }

  return { ...loaded, ...baseEnv };
}

function loadRuntimeEnv(baseEnv = process.env, cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const dotEnv = path.join(root, '.env');
  const dotEnvLocal = path.join(root, '.env.local');
  return loadEnvFile(dotEnvLocal, loadEnvFile(dotEnv, baseEnv));
}

module.exports = {
  loadEnvFile,
  loadRuntimeEnv,
};
