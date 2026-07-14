const test = require('node:test');
const assert = require('node:assert/strict');
const { isRegularUsMarketHours, resolveMarketRegime } = require('../src/market-hours');
const { createMarketAwareScanner } = require('../src/market-aware-scanner');

test('market-hours helper returns stocks during regular US market hours', () => {
  assert.equal(isRegularUsMarketHours(new Date('2026-06-16T14:00:00Z')), true);
  assert.equal(resolveMarketRegime(new Date('2026-06-16T14:00:00Z')), 'stocks');
});

test('market-hours helper returns crypto outside regular US market hours', () => {
  assert.equal(isRegularUsMarketHours(new Date('2026-06-16T22:00:00Z')), false);
  assert.equal(resolveMarketRegime(new Date('2026-06-16T22:00:00Z')), 'crypto');
});

test('market-aware scanner chooses stock path during market hours and crypto outside', async () => {
  const calls = [];
  const stockScannerFactory = (options) => makeScanner('stocks', options, calls);
  const overnightScannerFactory = (options) => makeScanner('crypto', options, calls);

  const openScanner = createMarketAwareScanner({
    localBaseUrl: 'http://127.0.0.1:65535',
    nowProvider: () => new Date('2026-06-16T14:00:00Z'),
    stockScannerFactory,
    overnightScannerFactory,
  });
  openScanner.start();
  assert.equal(openScanner.state.activeRegime, 'stocks');
  assert.deepEqual(calls.slice(0, 1), ['stocks:start']);
  await openScanner.runOnce({ runId: 'open-hours' });
  assert.equal(openScanner.state.activeRegime, 'stocks');
  openScanner.stop();

  calls.length = 0;
  const closedScanner = createMarketAwareScanner({
    localBaseUrl: 'http://127.0.0.1:65535',
    nowProvider: () => new Date('2026-06-16T22:00:00Z'),
    stockScannerFactory,
    overnightScannerFactory,
  });
  closedScanner.start();
  assert.equal(closedScanner.state.activeRegime, 'crypto');
  assert.deepEqual(calls.slice(0, 1), ['crypto:start']);
  await closedScanner.runOnce({ runId: 'closed-hours' });
  assert.equal(closedScanner.state.activeRegime, 'crypto');
  closedScanner.stop();
});

test('market-aware daytime path uses the same live policy as the dedicated stock launcher', () => {
  let receivedOptions = null;
  const scanner = createMarketAwareScanner({
    env: { BUY_NOTIONAL_TARGET: '1000', MAX_SPREAD_SLIPPAGE_PCT: '7' },
    localBaseUrl: 'http://127.0.0.1:65535',
    nowProvider: () => new Date('2026-06-16T14:00:00Z'),
    livePolicy: {
      buyNotionalTarget: 150,
      minMovePct: 0.25,
      minRecentMovePct: 0.15,
      minRecentRangePct: 0.15,
      minRecentCloseLocationPct: 65,
      requireRecentMomentum: true,
      allowContrarianEntries: false,
      minAdjustedRankScore: 8,
    },
    stockScannerFactory: (options) => {
      receivedOptions = options;
      return makeScanner('stocks', options, []);
    },
  });
  scanner.start();
  scanner.stop();
  assert.equal(receivedOptions.notional, 150);
  assert.equal(receivedOptions.allowContrarianEntries, false);
  assert.equal(receivedOptions.minMovePct, 0.25);
  assert.equal(Object.hasOwn(receivedOptions, 'maxSpreadPct'), false);
});

function makeScanner(name, options, calls) {
  return {
    start() {
      calls.push(`${name}:start`);
      return this;
    },
    stop() {
      calls.push(`${name}:stop`);
    },
    async runOnce(runOptions = {}) {
      calls.push(`${name}:runOnce:${runOptions.runId || ''}`);
      return {
        accepted: true,
        regime: name,
        config: options,
      };
    },
  };
}
