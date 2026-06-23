const test = require('node:test');
const assert = require('node:assert/strict');

const { allocateBuyNotional } = require('../src/portfolio-allocation');

test('allocateBuyNotional uses most of the available buying power for the last open slot', () => {
  const allocation = allocateBuyNotional({
    targetNotional: 150,
    minBuyNotional: 25,
    portfolio: {
      buying_power: 132.86,
      cash: 132.86,
      remaining_position_slots: 1,
    },
  });

  assert.equal(allocation.accepted, true);
  assert.equal(allocation.notional, 131.53);
  assert.equal(allocation.slot_budget, 131.53);
  assert.equal(allocation.remaining_slots, 1);
});

test('allocateBuyNotional still honors the target cap when cash is ample', () => {
  const allocation = allocateBuyNotional({
    targetNotional: 150,
    minBuyNotional: 25,
    portfolio: {
      buying_power: 1000,
      cash: 1000,
      remaining_position_slots: 2,
    },
  });

  assert.equal(allocation.accepted, true);
  assert.equal(allocation.notional, 150);
});

test('buildPortfolioSnapshot counts reserved positions as open', () => {
  const { buildPortfolioSnapshot } = require('../src/portfolio-allocation');
  const portfolio = buildPortfolioSnapshot({
    positions: [
      {
        symbol: 'INTC',
        qty: '1',
        qty_available: '0',
      },
    ],
    openOrders: [],
    account: {
      cash: '132.86',
      buying_power: '132.86',
    },
    maxOpenPositions: 2,
  });

  assert.equal(portfolio.open_positions_count, 1);
  assert.equal(portfolio.remaining_position_slots, 1);
});
