const assert = require('node:assert/strict');
const test = require('node:test');
const { scoreMarketConfirmation } = require('../src/meme-monitor/market-confirmation-score');

test('market confirmation reason codes distinguish halted, not halted, and unknown states', () => {
  const halted = scoreMarketConfirmation('GME', {
    currentPrice: 28.12,
    previousClose: 25.8,
    volume: 1_200_000,
    averageVolume: 1_000_000,
    bid: 28.05,
    ask: 28.2,
    halted: true,
  });
  assert.equal(halted.reasonCodes.includes('possible_halt_risk'), true);
  assert.equal(halted.riskWarnings.includes('possible_halt_risk'), true);

  const notHalted = scoreMarketConfirmation('GME', {
    currentPrice: 28.12,
    previousClose: 25.8,
    volume: 1_200_000,
    averageVolume: 1_000_000,
    bid: 28.05,
    ask: 28.2,
    halted: false,
  });
  assert.equal(notHalted.reasonCodes.includes('not_halted'), true);
  assert.equal(notHalted.reasonCodes.includes('halt_status_unknown'), false);

  const unknown = scoreMarketConfirmation('GME', {
    currentPrice: 28.12,
    previousClose: 25.8,
    volume: 1_200_000,
    averageVolume: 1_000_000,
    bid: 28.05,
    ask: 28.2,
  });
  assert.equal(unknown.reasonCodes.includes('halt_status_unknown'), true);
});
