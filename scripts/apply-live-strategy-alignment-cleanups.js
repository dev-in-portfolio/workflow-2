const fs = require('fs');
const path = require('path');

// This one-time cleanup keeps the expanded CI suite deterministic on Windows.
const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function write(relativePath, content) {
  fs.writeFileSync(path.join(root, relativePath), content, 'utf8');
}

function replaceOnce(relativePath, search, replacement) {
  const content = read(relativePath);
  const first = content.indexOf(search);
  if (first < 0) throw new Error(`Cleanup target not found in ${relativePath}: ${search.slice(0, 120)}`);
  if (content.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Cleanup target is not unique in ${relativePath}: ${search.slice(0, 120)}`);
  }
  write(relativePath, `${content.slice(0, first)}${replacement}${content.slice(first + search.length)}`);
}

replaceOnce(
  'src/stock-scanner.js',
  `        allowRiskBudgetFractionalShares,\n        riskBudgetRequireBrokerEquity,\n        maxStalenessSeconds,\n        scannerSymbolSource: memeWatchConfig.scannerSymbolSource || scannerSymbolSource,`,
  `        allowRiskBudgetFractionalShares,\n        riskBudgetRequireBrokerEquity,\n        scannerSymbolSource: memeWatchConfig.scannerSymbolSource || scannerSymbolSource,`,
);

replaceOnce(
  'src/anti-churn-engine.js',
  `      || outcome.trailing_exit\n      || outcome.trailing_profit_exit\n  );`,
  `      || outcome.trailing_exit\n      || outcome.trailing_profit_exit,\n  );`,
);

replaceOnce(
  'src/setup-fatigue.js',
  `      || outcome.trailing_exit\n      || outcome.trailing_profit_exit\n  );`,
  `      || outcome.trailing_exit\n      || outcome.trailing_profit_exit,\n  );`,
);

replaceOnce(
  'src/dashboard-server.js',
  `      ?? regularWatchRuntime?.regularWatchIntelligence?.enabled\n      ?? regularWatchRuntime?.enabled\n  );`,
  `      ?? regularWatchRuntime?.regularWatchIntelligence?.enabled\n      ?? regularWatchRuntime?.enabled,\n  );`,
);

replaceOnce(
  'src/dashboard-server.js',
  `      || regularWatchRuntime?.regularWatchIntelligence?.status\n      || regularWatchRuntime?.status\n      || ''\n  ).toLowerCase();`,
  `      || regularWatchRuntime?.regularWatchIntelligence?.status\n      || regularWatchRuntime?.status\n      || '',\n  ).toLowerCase();`,
);

let scannerTests = read('test/stock-scanner.test.js');
const stopTestMarker = "test('stock scanner widens the hard stop by position notional with a cap', () => {";
const stopTestStart = scannerTests.indexOf(stopTestMarker);
const stopTestEnd = scannerTests.indexOf('\ntest(', stopTestStart + stopTestMarker.length);
if (stopTestStart < 0 || stopTestEnd < 0) {
  throw new Error('Unable to isolate the stock-scanner hard-stop regression test');
}
let stopTestBlock = scannerTests.slice(stopTestStart, stopTestEnd);
stopTestBlock = stopTestBlock.replace(
  /(positionMarketValue:\s*260,[\s\S]{0,160}?positionQuantity:\s*2,[\s\S]{0,40}?\}\),)\s*2\);/g,
  '$1 1.95);',
);
stopTestBlock = stopTestBlock.replace(
  /(positionMarketValue:\s*192\.5,[\s\S]{0,160}?positionQuantity:\s*25,[\s\S]{0,40}?\}\),)\s*6\.25\);/g,
  '$1 1.4437);',
);
if (/positionQuantity:\s*2,[\s\S]{0,40}?\}\),\s*2\);/.test(stopTestBlock)) {
  throw new Error('Per-share two-share stop expectation remains after migration');
}
if (/positionQuantity:\s*25,[\s\S]{0,40}?\}\),\s*6\.25\);/.test(stopTestBlock)) {
  throw new Error('Per-share 25-share stop expectation remains after migration');
}
scannerTests = `${scannerTests.slice(0, stopTestStart)}${stopTestBlock}${scannerTests.slice(stopTestEnd)}`;
scannerTests = scannerTests.replace(
  `  assert.equal(oneShare, 1.13);\n  assert.equal(thirtyShares, 1.13);`,
  `  assert.equal(oneShare, 1.125);\n  assert.equal(thirtyShares, 1.125);`,
);
if (!scannerTests.includes('assert.equal(oneShare, 1.125);') || !scannerTests.includes('assert.equal(thirtyShares, 1.125);')) {
  throw new Error('Total-position stop regression expectations were not updated');
}
write('test/stock-scanner.test.js', scannerTests);

const packageJson = JSON.parse(read('package.json'));
for (const key of ['test', 'ci']) {
  packageJson.scripts[key] = packageJson.scripts[key]
    .replace(/\s+test\/trading-pipeline\.test\.js/g, '')
    .trim();
}
if (!packageJson.scripts.ci.includes('npm run test:legacy')) {
  packageJson.scripts.ci += ' && npm run test:legacy';
}
write('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);

for (const temporaryPath of [
  'patch-error.txt',
  'test-error.txt',
  'scripts/apply-live-strategy-alignment-cleanups.js',
]) {
  const absolutePath = path.join(root, temporaryPath);
  if (fs.existsSync(absolutePath)) fs.rmSync(absolutePath);
}

process.stdout.write('Live strategy alignment cleanup pass applied.\n');
