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

test('allocateBuyNotional with dynamic sizing utilizes ~50% of available cash when 0 positions open (2 slots remaining)', () => {
  const allocation = allocateBuyNotional({
    minBuyNotional: 20,
    dynamicSizing: true,
    portfolio: {
      buying_power: 300,
      cash: 300,
      remaining_position_slots: 2,
    },
  });

  assert.equal(allocation.accepted, true);
  assert.equal(allocation.dynamic_sizing, true);
  assert.equal(allocation.remaining_slots, 2);
  // 300 * 0.99 = 297 spendable / 2 slots = 148.50 (~50% of available balance)
  assert.equal(allocation.notional, 148.50);
  assert.equal(allocation.slot_budget, 148.50);
});

test('allocateBuyNotional with dynamic sizing utilizes ~100% of remaining cash when 1 position open (1 slot remaining)', () => {
  const allocation = allocateBuyNotional({
    minBuyNotional: 20,
    dynamicSizing: true,
    portfolio: {
      buying_power: 151.50,
      cash: 151.50,
      remaining_position_slots: 1,
    },
  });

  assert.equal(allocation.accepted, true);
  assert.equal(allocation.dynamic_sizing, true);
  assert.equal(allocation.remaining_slots, 1);
  // 151.50 * 0.99 = 149.985 -> 149.98 (~100% of remaining available cash)
  assert.equal(allocation.notional, 149.98);
  assert.equal(allocation.slot_budget, 149.98);
});

test('allocateBuyNotional with dynamic sizing rejects when 2 positions open (0 slots remaining)', () => {
  const allocation = allocateBuyNotional({
    minBuyNotional: 20,
    dynamicSizing: true,
    portfolio: {
      buying_power: 300,
      cash: 300,
      remaining_position_slots: 0,
    },
  });

  assert.equal(allocation.accepted, false);
  assert.equal(allocation.reason, 'MAX_POSITION_SLOTS_FILLED');
});

test('allocateBuyNotional with dynamic sizing respects maxBuyNotional ceiling when configured', () => {
  const allocation = allocateBuyNotional({
    minBuyNotional: 20,
    maxBuyNotional: 200,
    dynamicSizing: true,
    portfolio: {
      buying_power: 1000,
      cash: 1000,
      remaining_position_slots: 1,
    },
  });

  assert.equal(allocation.accepted, true);
  assert.equal(allocation.notional, 200);
});

test('allocateBuyNotional with dynamic sizing rejects when cash per slot is below floor', () => {
  const allocation = allocateBuyNotional({
    minBuyNotional: 25,
    dynamicSizing: true,
    portfolio: {
      buying_power: 30,
      cash: 30,
      remaining_position_slots: 2,
    },
  });

  assert.equal(allocation.accepted, false);
  assert.equal(allocation.reason, 'CASH_TOO_LOW_FOR_TARGET_SIZE');
});

