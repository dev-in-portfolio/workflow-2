const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  LIVE_POLICY_SCHEMA_VERSION,
  canonicalizeLivePolicy,
  migrateLivePolicyFile,
} = require('../src/live-policy-file');

function withTempDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-2-live-policy-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('canonical live policy locks momentum selection and total-position risk', () => {
  const policy = canonicalizeLivePolicy({
    allowContrarianEntries: true,
    scannerSelectionV2AuthorityEnabled: false,
    minAdjustedRankScore: -100,
    positionStopLossMaxDollars: 9,
    buyNotionalTarget: 10,
    minBuyNotional: 25,
    approvedSymbols: ['NVDA'],
  });

  assert.equal(policy.allowContrarianEntries, false);
  assert.equal(policy.scannerSelectionV2AuthorityEnabled, true);
  assert.equal(policy.minAdjustedRankScore, 8);
  assert.equal(policy.positionStopLossMaxDollars, 1.5);
  assert.equal(policy.buyNotionalTarget, 25);
  assert.deepEqual(policy.approvedSymbols, ['NVDA']);
});

test('migration backs up and repairs an unsafe local policy', () => withTempDirectory((directory) => {
  const policyPath = path.join(directory, 'live-policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    source: 'old-local-policy',
    policy: {
      allowContrarianEntries: true,
      scannerSelectionV2AuthorityEnabled: false,
      positionStopLossMaxDollars: 7.5,
      buyNotionalTarget: 175,
      minBuyNotional: 25,
      approvedSymbols: ['AAPL', 'NVDA'],
    },
  }, null, 2));

  const result = migrateLivePolicyFile(policyPath, { now: new Date('2026-07-09T22:30:00.000Z') });
  const written = JSON.parse(fs.readFileSync(policyPath, 'utf8'));

  assert.equal(result.status, 'migrated');
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.equal(written.schema_version, LIVE_POLICY_SCHEMA_VERSION);
  assert.equal(written.policy.allowContrarianEntries, false);
  assert.equal(written.policy.scannerSelectionV2AuthorityEnabled, true);
  assert.equal(written.policy.positionStopLossMaxDollars, 1.5);
  assert.equal(written.policy.buyNotionalTarget, 175);
  assert.deepEqual(written.policy.approvedSymbols, ['AAPL', 'NVDA']);
}));

test('migration creates a safe local policy when none exists', () => withTempDirectory((directory) => {
  const policyPath = path.join(directory, 'nested', 'live-policy.json');
  const result = migrateLivePolicyFile(policyPath, { now: new Date('2026-07-09T22:31:00.000Z') });
  const written = JSON.parse(fs.readFileSync(policyPath, 'utf8'));

  assert.equal(result.status, 'created');
  assert.equal(result.backupPath, null);
  assert.equal(written.policy.allowContrarianEntries, false);
  assert.equal(written.policy.scannerSelectionV2AuthorityEnabled, true);
  assert.equal(written.policy.buyNotionalTarget, 150);
  assert.equal(written.policy.minBuyNotional, 25);
}));

test('migration recovers malformed JSON without losing the original text', () => withTempDirectory((directory) => {
  const policyPath = path.join(directory, 'live-policy.json');
  fs.writeFileSync(policyPath, '{ definitely-not-json', 'utf8');

  const result = migrateLivePolicyFile(policyPath, { now: new Date('2026-07-09T22:32:00.000Z') });
  const written = JSON.parse(fs.readFileSync(policyPath, 'utf8'));

  assert.equal(result.status, 'recovered');
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), '{ definitely-not-json');
  assert.equal(written.policy.allowContrarianEntries, false);
  assert.equal(written.policy.positionStopLossMaxDollars, 1.5);
}));

test('an already canonical local policy is left untouched', () => withTempDirectory((directory) => {
  const policyPath = path.join(directory, 'live-policy.json');
  const first = migrateLivePolicyFile(policyPath, { now: new Date('2026-07-09T22:33:00.000Z') });
  const before = fs.readFileSync(policyPath, 'utf8');
  const second = migrateLivePolicyFile(policyPath, { now: new Date('2026-07-09T22:34:00.000Z') });
  const after = fs.readFileSync(policyPath, 'utf8');

  assert.equal(first.status, 'created');
  assert.equal(second.status, 'unchanged');
  assert.equal(second.wrote, false);
  assert.equal(second.backupPath, null);
  assert.equal(after, before);
}));
