const fs = require('fs');
const path = require('path');

function rotateJsonlIfNeeded(filePath, options = {}) {
  const maxBytes = Math.max(1024, Number(options.maxBytes || 100 * 1024 * 1024) || 100 * 1024 * 1024);
  const keepArchives = Math.max(1, Math.floor(Number(options.keepArchives || 3) || 3));
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < maxBytes) return { rotated: false };
    const parsed = path.parse(filePath);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(parsed.dir, `${parsed.name}.${stamp}.archive${parsed.ext || '.jsonl'}`);
    fs.renameSync(filePath, archivePath);
    const archives = fs.readdirSync(parsed.dir)
      .filter((name) => name.startsWith(`${parsed.name}.`) && name.includes('.archive'))
      .map((name) => ({ path: path.join(parsed.dir, name), mtime: fs.statSync(path.join(parsed.dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of archives.slice(keepArchives)) fs.unlinkSync(old.path);
    return { rotated: true, archivePath };
  } catch (error) {
    return { rotated: false, error: error.message };
  }
}

module.exports = { rotateJsonlIfNeeded };
