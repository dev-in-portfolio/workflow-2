const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveRepoRoot } = require('../src/util');

const repoRoot = resolveRepoRoot();
const testDir = path.join(repoRoot, 'test');
const tests = fs.readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join('test', name));

if (!tests.length) {
  process.stderr.write('No test files were discovered.\n');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}
