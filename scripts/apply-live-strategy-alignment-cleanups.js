const fs = require('fs');
const path = require('path');

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

for (const temporaryPath of [
  'patch-error.txt',
  'test-error.txt',
  'scripts/apply-live-strategy-alignment-cleanups.js',
]) {
  const absolutePath = path.join(root, temporaryPath);
  if (fs.existsSync(absolutePath)) fs.rmSync(absolutePath);
}

process.stdout.write('Live strategy alignment cleanup pass applied.\n');
