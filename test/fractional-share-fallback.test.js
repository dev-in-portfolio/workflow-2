const assert = require('node:assert/strict');
const test = require('node:test');
const { executeOrder, isRecoverableFractionalShareError } = require('../src/trading/execution-orchestrator');

function baseSignal(overrides = {}) {
  return {
    signal_id: 'sig-fractional',
    request_id: 'req-fractional',
    symbol: 'MTAL',
    asset_type: 'stock',
    side: 'buy',
    entry_price: 42,
    price: 42,
    notional: 150,
    ...overrides,
  };
}

function baseRequest(overrides = {}) {
  return {
    request_id: 'req-fractional',
    signal_id: 'sig-fractional',
    symbol: 'MTAL',
    asset_type: 'stock',
    side: 'buy',
    order_type: 'market',
    quantity: 3.5714,
    notional: 150,
    entry_price: 42,
    time_in_force: 'day',
    ...overrides,
  };
}

test('fractional compatibility rejection retries once with whole shares', async () => {
  const submitted = [];
  const adapter = {
    findExistingOrderForRequest: async () => null,
    submitOrder: async (request) => {
      submitted.push(request);
      if (submitted.length === 1) {
        const error = new Error('qty must be a whole number for this asset');
        error.status = 422;
        throw error;
      }
      return { order_id: request.request_id, status: 'filled', request };
    },
    getOrder: async (orderId) => ({ id: orderId, status: 'filled', filled_avg_price: '42', qty: '3' }),
  };

  const result = await executeOrder(baseRequest(), baseSignal(), {
    executionAdapter: adapter,
    reconciledMarketContext: { price: 42 },
    savePartialFillState: false,
  });

  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].quantity, 3);
  assert.equal(submitted[1].notional, null);
  assert.equal(submitted[1].request_id, 'req-fractional-whole');
  assert.equal(result.paperOrder.whole_share_fallback.reason_codes.includes('WHOLE_SHARE_FALLBACK_ACCEPTED'), true);
  assert.equal(result.paperResult.submitted_quantity, 3);
});

test('asset metadata can select whole shares before a doomed fractional submit', async () => {
  const submitted = [];
  const adapter = {
    getAsset: async () => ({ symbol: 'MTAL', fractionable: false }),
    findExistingOrderForRequest: async () => null,
    submitOrder: async (request) => {
      submitted.push(request);
      return { order_id: request.request_id, status: 'filled', request };
    },
    getOrder: async (orderId) => ({ id: orderId, status: 'filled', filled_avg_price: '42', qty: '3' }),
  };

  const result = await executeOrder(baseRequest(), baseSignal(), {
    executionAdapter: adapter,
    reconciledMarketContext: { price: 42 },
    savePartialFillState: false,
  });

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].quantity, 3);
  assert.equal(submitted[0].request_id, 'req-fractional-whole');
  assert.equal(result.paperOrder.whole_share_fallback.source, 'asset_metadata');
});

test('whole-share fallback blocks when approved notional cannot buy one share', async () => {
  const adapter = {
    findExistingOrderForRequest: async () => null,
    submitOrder: async () => {
      const error = new Error('fractional orders are not supported');
      error.status = 422;
      throw error;
    },
  };

  await assert.rejects(
    () => executeOrder(baseRequest({ quantity: 0.75, notional: 150, entry_price: 200 }), baseSignal({ notional: 150, price: 200 }), {
      executionAdapter: adapter,
      reconciledMarketContext: { price: 200 },
      savePartialFillState: false,
    }),
    (error) => {
      assert.equal(error.code, 'WHOLE_SHARE_FALLBACK_BELOW_ONE_SHARE');
      assert.equal(error.fallback.calculated_whole_share_quantity, 0);
      return true;
    },
  );
});

test('whole-share fallback rounds down without exceeding approved notional', async () => {
  const submitted = [];
  const adapter = {
    findExistingOrderForRequest: async () => null,
    submitOrder: async (request) => {
      submitted.push(request);
      if (submitted.length === 1) {
        throw new Error('fractional quantity is not supported');
      }
      return { order_id: request.request_id, status: 'filled', request };
    },
    getOrder: async (orderId) => ({ id: orderId, status: 'filled', filled_avg_price: '51', qty: '2' }),
  };

  await executeOrder(baseRequest({ quantity: 2.941, notional: 150, entry_price: 51 }), baseSignal({ notional: 150, price: 51 }), {
    executionAdapter: adapter,
    reconciledMarketContext: { price: 51 },
    savePartialFillState: false,
  });

  assert.equal(submitted[1].quantity, 2);
  assert.equal(submitted[1].whole_share_fallback.estimated_whole_share_notional, 102);
});

test('generic broker rejection does not retry whole-share fallback', async () => {
  const submitted = [];
  const adapter = {
    findExistingOrderForRequest: async () => null,
    submitOrder: async (request) => {
      submitted.push(request);
      throw new Error('asset is halted');
    },
  };

  await assert.rejects(
    () => executeOrder(baseRequest(), baseSignal(), {
      executionAdapter: adapter,
      reconciledMarketContext: { price: 42 },
      savePartialFillState: false,
    }),
    /asset is halted/,
  );
  assert.equal(submitted.length, 1);
  assert.equal(isRecoverableFractionalShareError(new Error('asset is halted')), false);
});
