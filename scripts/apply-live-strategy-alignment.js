const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function write(relativePath, content) {
  fs.writeFileSync(path.join(root, relativePath), content, 'utf8');
}

function replaceOnce(relativePath, search, replacement) {
  const content = read(relativePath);
  const first = content.indexOf(search);
  if (first < 0) throw new Error(`Patch target not found in ${relativePath}: ${search.slice(0, 120)}`);
  if (content.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Patch target is not unique in ${relativePath}: ${search.slice(0, 120)}`);
  }
  write(relativePath, `${content.slice(0, first)}${replacement}${content.slice(first + search.length)}`);
}

function appendOnce(relativePath, marker, addition) {
  const content = read(relativePath);
  if (content.includes(marker)) return;
  write(relativePath, `${content.trimEnd()}\n\n${addition.trim()}\n`);
}

replaceOnce(
  'src/live-stock-policy.js',
  `  minRecentCloseLocationPct: 65,\n  sellNetProfitFloorDollars: 0.35,`,
  `  minRecentCloseLocationPct: 65,\n  allowContrarianEntries: false,\n  minAdjustedRankScore: 8,\n  scannerSelectionV2AuthorityEnabled: true,\n  positionStopLossDollars: 0.75,\n  positionStopLossNotionalPct: 0.75,\n  positionStopLossMaxDollars: 1.5,\n  sellNetProfitFloorDollars: 0.35,`,
);

replaceOnce(
  'src/live-stock-policy.js',
  `    minRecentCloseLocationPct: Math.max(0, Math.min(100, safeNumber(input.minRecentCloseLocationPct, LIVE_STOCK_POLICY_DEFAULTS.minRecentCloseLocationPct))),\n    sellNetProfitFloorDollars: Math.max(0, safeNumber(input.sellNetProfitFloorDollars, LIVE_STOCK_POLICY_DEFAULTS.sellNetProfitFloorDollars)),`,
  `    minRecentCloseLocationPct: Math.max(0, Math.min(100, safeNumber(input.minRecentCloseLocationPct, LIVE_STOCK_POLICY_DEFAULTS.minRecentCloseLocationPct))),\n    allowContrarianEntries: input.allowContrarianEntries ?? LIVE_STOCK_POLICY_DEFAULTS.allowContrarianEntries,\n    minAdjustedRankScore: safeNumber(input.minAdjustedRankScore, LIVE_STOCK_POLICY_DEFAULTS.minAdjustedRankScore),\n    scannerSelectionV2AuthorityEnabled: input.scannerSelectionV2AuthorityEnabled ?? LIVE_STOCK_POLICY_DEFAULTS.scannerSelectionV2AuthorityEnabled,\n    positionStopLossDollars: Math.max(0.01, safeNumber(input.positionStopLossDollars, LIVE_STOCK_POLICY_DEFAULTS.positionStopLossDollars)),\n    positionStopLossNotionalPct: Math.max(0, safeNumber(input.positionStopLossNotionalPct, LIVE_STOCK_POLICY_DEFAULTS.positionStopLossNotionalPct)),\n    positionStopLossMaxDollars: Math.max(\n      0.01,\n      Math.min(\n        LIVE_STOCK_POLICY_DEFAULTS.positionStopLossMaxDollars,\n        safeNumber(input.positionStopLossMaxDollars, LIVE_STOCK_POLICY_DEFAULTS.positionStopLossMaxDollars),\n      ),\n    ),\n    sellNetProfitFloorDollars: Math.max(0, safeNumber(input.sellNetProfitFloorDollars, LIVE_STOCK_POLICY_DEFAULTS.sellNetProfitFloorDollars)),`,
);

replaceOnce(
  'scripts/start-stock-scanner.js',
  `function buildPolicyExitOverrides(policy = {}) {\n  const map = {`,
  `function buildPolicyExitOverrides(policy = {}) {\n  policy = policy && typeof policy === 'object' ? policy : {};\n  const map = {`,
);

replaceOnce(
  'scripts/start-stock-scanner.js',
  `    minRecentCloseLocationPct: Math.max(LIVE_STOCK_POLICY_DEFAULTS.minRecentCloseLocationPct, normalized.minRecentCloseLocationPct, Number.isFinite(envMinRecentCloseLocationPct) ? envMinRecentCloseLocationPct : 0),\n  };\n}\n\nfunction buildLiveExitOverrides`,
  `    minRecentCloseLocationPct: Math.max(LIVE_STOCK_POLICY_DEFAULTS.minRecentCloseLocationPct, normalized.minRecentCloseLocationPct, Number.isFinite(envMinRecentCloseLocationPct) ? envMinRecentCloseLocationPct : 0),\n    allowContrarianEntries: normalized.allowContrarianEntries,\n    minAdjustedRankScore: Math.max(LIVE_STOCK_POLICY_DEFAULTS.minAdjustedRankScore, normalized.minAdjustedRankScore),\n    scannerSelectionV2ShadowEnabled: true,\n    scannerSelectionV2AuthorityEnabled: normalized.scannerSelectionV2AuthorityEnabled,\n  };\n}\n\nfunction buildLiveRiskOverrides(policy = {}) {\n  const normalized = normalizeLiveStockPolicy(policy);\n  return {\n    stopLossDollars: normalized.positionStopLossDollars,\n    stopLossNotionalPct: normalized.positionStopLossNotionalPct,\n    stopLossMaxDollars: normalized.positionStopLossMaxDollars,\n  };\n}\n\nfunction buildLiveExitOverrides`,
);

replaceOnce(
  'scripts/start-stock-scanner.js',
  `  const policyExitOverrides = buildPolicyExitOverrides(livePolicy);\n  const liveExitOverrides = buildLiveExitOverrides(livePolicy || {});`,
  `  const policyExitOverrides = buildPolicyExitOverrides(livePolicy);\n  const liveRiskOverrides = buildLiveRiskOverrides(livePolicy || {});\n  const liveExitOverrides = buildLiveExitOverrides(livePolicy || {});`,
);

replaceOnce(
  'scripts/start-stock-scanner.js',
  `    notional: Number(runtimeEnv.BUY_NOTIONAL_TARGET || 150),\n    allowContrarianEntries: true,\n    ...liveEntryOverrides,\n    ...liveExitOverrides,\n    ...policyExitOverrides,`,
  `    notional: Number(runtimeEnv.BUY_NOTIONAL_TARGET || 150),\n    ...liveEntryOverrides,\n    ...liveExitOverrides,\n    ...policyExitOverrides,\n    ...liveRiskOverrides,`,
);

replaceOnce(
  'scripts/start-stock-scanner.js',
  `    live_entry_overrides: liveEntryOverrides,\n    live_exit_overrides: liveExitOverrides,`,
  `    live_entry_overrides: liveEntryOverrides,\n    live_risk_overrides: liveRiskOverrides,\n    live_exit_overrides: liveExitOverrides,`,
);

replaceOnce(
  'scripts/start-stock-scanner.js',
  `  buildLiveEntryOverrides,\n  buildLiveExitOverrides,`,
  `  buildLiveEntryOverrides,\n  buildLiveRiskOverrides,\n  buildLiveExitOverrides,`,
);

replaceOnce(
  'src/scanner-config.js',
  `    allowContrarianEntries: true,`,
  `    allowContrarianEntries: parseBool(env.STOCK_SCANNER_ALLOW_CONTRARIAN_ENTRIES, !stricterLiveEntryDefaults),`,
);

replaceOnce(
  'src/stock-scanner.js',
  `  const allowContrarianEntries = options.allowContrarianEntries ?? true;`,
  `  const allowContrarianEntries = options.allowContrarianEntries\n    ?? parseBool(env.STOCK_SCANNER_ALLOW_CONTRARIAN_ENTRIES, !stricterLiveEntryDefaults);`,
);

replaceOnce(
  'src/stock-scanner.js',
  `  const base = Math.abs(safeNumber(baseStopLossDollars, 1));\n  const quantity = Math.abs(safeNumber(positionQuantity, NaN));\n  const quantityMultiplier = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;\n  const basePositionStop = roundCurrency(base * quantityMultiplier);\n  const maxStop = Math.max(basePositionStop, Math.abs(safeNumber(stopLossMaxDollars, base)) * quantityMultiplier);\n  const notionalPct = Math.max(0, safeNumber(stopLossNotionalPct, 0));\n  const marketValue = Math.abs(safeNumber(positionMarketValue, NaN));\n  const notionalStop = Number.isFinite(marketValue) && marketValue > 0 && notionalPct > 0\n    ? marketValue * (notionalPct / 100)\n    : basePositionStop;\n  return roundCurrency(Math.min(maxStop, Math.max(basePositionStop, notionalStop)));`,
  `  const basePositionStop = Math.abs(safeNumber(baseStopLossDollars, 1));\n  const maxStop = Math.max(basePositionStop, Math.abs(safeNumber(stopLossMaxDollars, basePositionStop)));\n  const notionalPct = Math.max(0, safeNumber(stopLossNotionalPct, 0));\n  const marketValue = Math.abs(safeNumber(positionMarketValue, NaN));\n  const notionalStop = Number.isFinite(marketValue) && marketValue > 0 && notionalPct > 0\n    ? marketValue * (notionalPct / 100)\n    : basePositionStop;\n  return roundCurrency(Math.min(maxStop, Math.max(basePositionStop, notionalStop)));`,
);

replaceOnce(
  'src/stock-scanner.js',
  `  const baseRankScore = Math.abs(movePct) * 10 + volumeScore - (spreadPct * 3);`,
  `  const directionalMovePct = options.allowContrarianEntries === true ? Math.abs(movePct) : Math.max(0, movePct);\n  const baseRankScore = directionalMovePct * 10 + volumeScore - (spreadPct * 3);`,
);

replaceOnce(
  'src/stock-scanner.js',
  `      const selectionV2 = options.scannerSelectionV2ShadowEnabled\n        ? buildSelectionV2Score({`,
  `      const selectionV2 = (options.scannerSelectionV2ShadowEnabled || options.scannerSelectionV2AuthorityEnabled)\n        ? buildSelectionV2Score({`,
);

replaceOnce(
  'src/stock-scanner.js',
  `      scannerContext.selection_v2_shadow_only = Boolean(selectionV2);\n      scannerContext.selection_v2_authoritative = false;`,
  `      scannerContext.selection_v2_shadow_only = Boolean(selectionV2 && !options.scannerSelectionV2AuthorityEnabled);\n      scannerContext.selection_v2_authoritative = Boolean(selectionV2 && options.scannerSelectionV2AuthorityEnabled);`,
);

replaceOnce(
  'src/stock-scanner.js',
  `      if (isPriorityOverrideApplied) {\n        candidate.priorityOverrideBonus = priorityOverrideBonus;\n        candidate.priorityOverrideSortScore = candidate.rankScore + priorityOverrideBonus;\n        candidate.regularWatchSortScore = Math.max(candidate.regularWatchSortScore, candidate.priorityOverrideSortScore);\n      }\n    }\n    if (candidate?.payload?.side === 'sell') {`,
  `      if (isPriorityOverrideApplied) {\n        candidate.priorityOverrideBonus = priorityOverrideBonus;\n        candidate.priorityOverrideSortScore = candidate.rankScore + priorityOverrideBonus;\n        candidate.regularWatchSortScore = Math.max(candidate.regularWatchSortScore, candidate.priorityOverrideSortScore);\n      }\n      if (candidate.payload.side === 'buy' && options.scannerSelectionV2AuthorityEnabled && !selectionV2?.qualified) {\n        options.skipTracker?.record?.(selectionV2?.reason_codes?.[0] || 'SELECTION_V2_NOT_QUALIFIED', {\n          symbol,\n          selection_v2: selectionV2 || null,\n        });\n        continue;\n      }\n    }\n    if (candidate?.payload?.side === 'sell') {`,
);

replaceOnce(
  'src/stock-scanner.js',
  `  buyEntries.sort((a, b) => {\n    const aScore = Number.isFinite(Number(a.regularWatchSortScore))\n      ? Number(a.regularWatchSortScore)\n      : (Number.isFinite(Number(a.priorityOverrideSortScore)) ? Number(a.priorityOverrideSortScore) : Number(a.rankScore || 0));\n    const bScore = Number.isFinite(Number(b.regularWatchSortScore))\n      ? Number(b.regularWatchSortScore)\n      : (Number.isFinite(Number(b.priorityOverrideSortScore)) ? Number(b.priorityOverrideSortScore) : Number(b.rankScore || 0));`,
  `  const selectionV2Authoritative = Boolean(options.scannerSelectionV2AuthorityEnabled);\n  buyEntries.sort((a, b) => {\n    const aLegacyScore = Number.isFinite(Number(a.regularWatchSortScore))\n      ? Number(a.regularWatchSortScore)\n      : (Number.isFinite(Number(a.priorityOverrideSortScore)) ? Number(a.priorityOverrideSortScore) : Number(a.rankScore || 0));\n    const bLegacyScore = Number.isFinite(Number(b.regularWatchSortScore))\n      ? Number(b.regularWatchSortScore)\n      : (Number.isFinite(Number(b.priorityOverrideSortScore)) ? Number(b.priorityOverrideSortScore) : Number(b.rankScore || 0));\n    const aScore = selectionV2Authoritative && Number.isFinite(Number(a.selectionV2SortScore))\n      ? Number(a.selectionV2SortScore)\n      : aLegacyScore;\n    const bScore = selectionV2Authoritative && Number.isFinite(Number(b.selectionV2SortScore))\n      ? Number(b.selectionV2SortScore)\n      : bLegacyScore;`,
);

replaceOnce(
  'src/feedback-loop.js',
  `      positionStopLossDollars: 1,\n      positionStopLossNotionalPct: 0.75,\n      positionStopLossMaxDollars: 2.5,\n      trailingProfitStartDollars: LIVE_STOCK_POLICY_DEFAULTS.trailingProfitStartDollars,`,
  `      positionStopLossDollars: LIVE_STOCK_POLICY_DEFAULTS.positionStopLossDollars,\n      positionStopLossNotionalPct: LIVE_STOCK_POLICY_DEFAULTS.positionStopLossNotionalPct,\n      positionStopLossMaxDollars: LIVE_STOCK_POLICY_DEFAULTS.positionStopLossMaxDollars,\n      minMovePct: LIVE_STOCK_POLICY_DEFAULTS.minMovePct,\n      requireRecentMomentum: LIVE_STOCK_POLICY_DEFAULTS.requireRecentMomentum,\n      minRecentMovePct: LIVE_STOCK_POLICY_DEFAULTS.minRecentMovePct,\n      minRecentRangePct: LIVE_STOCK_POLICY_DEFAULTS.minRecentRangePct,\n      minRecentCloseLocationPct: LIVE_STOCK_POLICY_DEFAULTS.minRecentCloseLocationPct,\n      allowContrarianEntries: LIVE_STOCK_POLICY_DEFAULTS.allowContrarianEntries,\n      minAdjustedRankScore: LIVE_STOCK_POLICY_DEFAULTS.minAdjustedRankScore,\n      scannerSelectionV2AuthorityEnabled: LIVE_STOCK_POLICY_DEFAULTS.scannerSelectionV2AuthorityEnabled,\n      stalePositionExitEnabled: LIVE_STOCK_POLICY_DEFAULTS.stalePositionExitEnabled,\n      stalePositionMaxHoldMinutes: LIVE_STOCK_POLICY_DEFAULTS.stalePositionMaxHoldMinutes,\n      stalePositionMinPeakProfitDollars: LIVE_STOCK_POLICY_DEFAULTS.stalePositionMinPeakProfitDollars,\n      stalePositionMaxExitPnlDollars: LIVE_STOCK_POLICY_DEFAULTS.stalePositionMaxExitPnlDollars,\n      stalledWinnerExitEnabled: LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerExitEnabled,\n      stalledWinnerMaxHoldMinutes: LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMaxHoldMinutes,\n      stalledWinnerMaxMinutesSincePeak: LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMaxMinutesSincePeak,\n      stalledWinnerMinProfitDollars: LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMinProfitDollars,\n      trailingProfitStartDollars: LIVE_STOCK_POLICY_DEFAULTS.trailingProfitStartDollars,`,
);

replaceOnce(
  'src/feedback-loop.js',
  `      buyNotionalTarget: safeNumber(policy.buyNotionalTarget ?? 25, 25),\n      approvedSymbols: normalizeApprovedSymbols(policy.approvedSymbols),\n      minBuyNotional: safeNumber(policy.minBuyNotional ?? 10, 10),\n      positionStopLossDollars: safeNumber(policy.positionStopLossDollars ?? 1, 1),\n      positionStopLossNotionalPct: safeNumber(policy.positionStopLossNotionalPct ?? 0.75, 0.75),\n      positionStopLossMaxDollars: safeNumber(policy.positionStopLossMaxDollars ?? 2.5, 2.5),\n      trailingProfitStartDollars: safeNumber(policy.trailingProfitStartDollars ?? LIVE_STOCK_POLICY_DEFAULTS.trailingProfitStartDollars, LIVE_STOCK_POLICY_DEFAULTS.trailingProfitStartDollars),`,
  `      buyNotionalTarget: safeNumber(policy.buyNotionalTarget ?? 150, 150),\n      approvedSymbols: normalizeApprovedSymbols(policy.approvedSymbols),\n      minBuyNotional: safeNumber(policy.minBuyNotional ?? 25, 25),\n      positionStopLossDollars: safeNumber(policy.positionStopLossDollars ?? LIVE_STOCK_POLICY_DEFAULTS.positionStopLossDollars, LIVE_STOCK_POLICY_DEFAULTS.positionStopLossDollars),\n      positionStopLossNotionalPct: safeNumber(policy.positionStopLossNotionalPct ?? LIVE_STOCK_POLICY_DEFAULTS.positionStopLossNotionalPct, LIVE_STOCK_POLICY_DEFAULTS.positionStopLossNotionalPct),\n      positionStopLossMaxDollars: Math.min(\n        LIVE_STOCK_POLICY_DEFAULTS.positionStopLossMaxDollars,\n        safeNumber(policy.positionStopLossMaxDollars ?? LIVE_STOCK_POLICY_DEFAULTS.positionStopLossMaxDollars, LIVE_STOCK_POLICY_DEFAULTS.positionStopLossMaxDollars),\n      ),\n      minMovePct: safeNumber(policy.minMovePct ?? LIVE_STOCK_POLICY_DEFAULTS.minMovePct, LIVE_STOCK_POLICY_DEFAULTS.minMovePct),\n      requireRecentMomentum: policy.requireRecentMomentum ?? LIVE_STOCK_POLICY_DEFAULTS.requireRecentMomentum,\n      minRecentMovePct: safeNumber(policy.minRecentMovePct ?? LIVE_STOCK_POLICY_DEFAULTS.minRecentMovePct, LIVE_STOCK_POLICY_DEFAULTS.minRecentMovePct),\n      minRecentRangePct: safeNumber(policy.minRecentRangePct ?? LIVE_STOCK_POLICY_DEFAULTS.minRecentRangePct, LIVE_STOCK_POLICY_DEFAULTS.minRecentRangePct),\n      minRecentCloseLocationPct: safeNumber(policy.minRecentCloseLocationPct ?? LIVE_STOCK_POLICY_DEFAULTS.minRecentCloseLocationPct, LIVE_STOCK_POLICY_DEFAULTS.minRecentCloseLocationPct),\n      allowContrarianEntries: policy.allowContrarianEntries ?? LIVE_STOCK_POLICY_DEFAULTS.allowContrarianEntries,\n      minAdjustedRankScore: safeNumber(policy.minAdjustedRankScore ?? LIVE_STOCK_POLICY_DEFAULTS.minAdjustedRankScore, LIVE_STOCK_POLICY_DEFAULTS.minAdjustedRankScore),\n      scannerSelectionV2AuthorityEnabled: policy.scannerSelectionV2AuthorityEnabled ?? LIVE_STOCK_POLICY_DEFAULTS.scannerSelectionV2AuthorityEnabled,\n      stalePositionExitEnabled: policy.stalePositionExitEnabled ?? LIVE_STOCK_POLICY_DEFAULTS.stalePositionExitEnabled,\n      stalePositionMaxHoldMinutes: safeNumber(policy.stalePositionMaxHoldMinutes ?? LIVE_STOCK_POLICY_DEFAULTS.stalePositionMaxHoldMinutes, LIVE_STOCK_POLICY_DEFAULTS.stalePositionMaxHoldMinutes),\n      stalePositionMinPeakProfitDollars: safeNumber(policy.stalePositionMinPeakProfitDollars ?? LIVE_STOCK_POLICY_DEFAULTS.stalePositionMinPeakProfitDollars, LIVE_STOCK_POLICY_DEFAULTS.stalePositionMinPeakProfitDollars),\n      stalePositionMaxExitPnlDollars: safeNumber(policy.stalePositionMaxExitPnlDollars ?? LIVE_STOCK_POLICY_DEFAULTS.stalePositionMaxExitPnlDollars, LIVE_STOCK_POLICY_DEFAULTS.stalePositionMaxExitPnlDollars),\n      stalledWinnerExitEnabled: policy.stalledWinnerExitEnabled ?? LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerExitEnabled,\n      stalledWinnerMaxHoldMinutes: safeNumber(policy.stalledWinnerMaxHoldMinutes ?? LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMaxHoldMinutes, LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMaxHoldMinutes),\n      stalledWinnerMaxMinutesSincePeak: safeNumber(policy.stalledWinnerMaxMinutesSincePeak ?? LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMaxMinutesSincePeak, LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMaxMinutesSincePeak),\n      stalledWinnerMinProfitDollars: safeNumber(policy.stalledWinnerMinProfitDollars ?? LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMinProfitDollars, LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMinProfitDollars),\n      trailingProfitStartDollars: safeNumber(policy.trailingProfitStartDollars ?? LIVE_STOCK_POLICY_DEFAULTS.trailingProfitStartDollars, LIVE_STOCK_POLICY_DEFAULTS.trailingProfitStartDollars),`,
);

replaceOnce(
  'test/stock-scanner.test.js',
  `  assert.equal(liveConfig.requireRecentMomentum, true);\n  assert.equal(liveConfig.minMovePct, 0.25);`,
  `  assert.equal(liveConfig.requireRecentMomentum, true);\n  assert.equal(liveConfig.allowContrarianEntries, false);\n  assert.equal(liveConfig.minMovePct, 0.25);`,
);

appendOnce(
  'test/stock-scanner.test.js',
  "position stop loss is capped in total dollars",
  `test('position stop loss is capped in total dollars instead of multiplying by share count', () => {\n  const oneShare = calculateEffectiveStopLossDollars({\n    baseStopLossDollars: 0.75,\n    stopLossNotionalPct: 0.75,\n    stopLossMaxDollars: 1.5,\n    positionMarketValue: 150,\n    positionQuantity: 1,\n  });\n  const thirtyShares = calculateEffectiveStopLossDollars({\n    baseStopLossDollars: 0.75,\n    stopLossNotionalPct: 0.75,\n    stopLossMaxDollars: 1.5,\n    positionMarketValue: 150,\n    positionQuantity: 30,\n  });\n\n  assert.equal(oneShare, 1.13);\n  assert.equal(thirtyShares, 1.13);\n});`,
);

replaceOnce(
  'test/stock-scanner-launcher.test.js',
  `const { buildLiveEntryOverrides, buildLiveExitOverrides, buildPolicyExitOverrides } = require('../scripts/start-stock-scanner');`,
  `const { buildLiveEntryOverrides, buildLiveRiskOverrides, buildLiveExitOverrides, buildPolicyExitOverrides } = require('../scripts/start-stock-scanner');`,
);

replaceOnce(
  'test/stock-scanner-launcher.test.js',
  `  assert.deepEqual(overrides, {\n    minMovePct: 0.25,\n    requireRecentMomentum: false,\n    minRecentMovePct: 0.15,\n    minRecentRangePct: 0.15,\n    minRecentCloseLocationPct: 65,\n  });`,
  `  assert.deepEqual(overrides, {\n    minMovePct: 0.25,\n    requireRecentMomentum: false,\n    minRecentMovePct: 0.15,\n    minRecentRangePct: 0.15,\n    minRecentCloseLocationPct: 65,\n    allowContrarianEntries: false,\n    minAdjustedRankScore: 8,\n    scannerSelectionV2ShadowEnabled: true,\n    scannerSelectionV2AuthorityEnabled: true,\n  });`,
);

appendOnce(
  'test/stock-scanner-launcher.test.js',
  "launcher keeps total-position loss capped",
  `test('stock scanner launcher keeps total-position loss capped for live trading', () => {\n  const overrides = buildLiveRiskOverrides({\n    positionStopLossDollars: 1,\n    positionStopLossNotionalPct: 0.75,\n    positionStopLossMaxDollars: 2.5,\n  });\n\n  assert.deepEqual(overrides, {\n    stopLossDollars: 1,\n    stopLossNotionalPct: 0.75,\n    stopLossMaxDollars: 1.5,\n  });\n});\n\ntest('policy exit override builder safely handles a missing policy file', () => {\n  assert.deepEqual(buildPolicyExitOverrides(null), {});\n});`,
);

for (const key of ['test', 'ci']) {
  const packageJson = JSON.parse(read('package.json'));
  const additions = [
    'test/anti-churn-engine.test.js',
    'test/feedback-loop.test.js',
    'test/dashboard-summary-routes.test.js',
    'test/trading-pipeline.test.js',
  ];
  for (const file of additions) {
    if (!packageJson.scripts[key].includes(file)) packageJson.scripts[key] += ` ${file}`;
  }
  write('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
}

fs.rmSync(path.join(root, 'scripts', 'apply-live-strategy-alignment.js'));
fs.rmSync(path.join(root, '.github', 'workflows', 'apply-live-strategy-alignment.yml'));

process.stdout.write('Live strategy alignment patch applied.\n');
