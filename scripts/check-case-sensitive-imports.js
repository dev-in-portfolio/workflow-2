const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'data', '.codex-remote-attachments']);
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.json']);

function main() {
  const files = walk(PROJECT_ROOT).filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)) && !file.includes(`${path.sep}scripts${path.sep}check-case-sensitive-imports.js`));
  const errors = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const specifier of extractRelativeSpecifiers(content)) {
      const resolved = resolveRelativeImport(file, specifier);
      if (!resolved.ok) {
        errors.push(`${path.relative(PROJECT_ROOT, file)} -> ${specifier}: ${resolved.error}`);
        continue;
      }
      const caseError = assertExactPathCase(resolved.path);
      if (caseError) {
        errors.push(`${path.relative(PROJECT_ROOT, file)} -> ${specifier}: ${caseError}`);
      }
    }
  }

  if (errors.length) {
    console.error('Case-sensitive import check failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      results.push(...walk(path.join(dir, entry.name)));
    } else {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

function extractRelativeSpecifiers(content) {
  const specifiers = [];
  const patterns = [
    /require\((['"])(\.[^'"]+)\1\)/g,
    /import\s+[^'"]*from\s+(['"])(\.[^'"]+)\1/g,
    /import\((['"])(\.[^'"]+)\1\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      specifiers.push(match[2]);
    }
  }
  return specifiers;
}

function resolveRelativeImport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [];
  candidates.push(base);
  candidates.push(`${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`, `${base}.json`);
  candidates.push(path.join(base, 'index.js'), path.join(base, 'index.cjs'), path.join(base, 'index.mjs'), path.join(base, 'index.ts'), path.join(base, 'index.tsx'));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { ok: true, path: candidate };
    }
  }

  return { ok: false, error: 'unresolved relative import' };
}

function assertExactPathCase(filePath) {
  let current = path.parse(filePath).root;
  const parts = filePath.slice(current.length).split(path.sep).filter(Boolean);

  for (const part of parts) {
    const entries = fs.readdirSync(current || path.sep);
    const actual = entries.find((entry) => entry === part);
    if (!actual) {
      return `case mismatch or missing segment "${part}"`;
    }
    current = path.join(current, actual);
  }

  return null;
}

if (require.main === module) {
  main();
}

module.exports = {
  assertExactPathCase,
  extractRelativeSpecifiers,
  main,
  resolveRelativeImport,
};
