const assert = require('node:assert/strict');
const test = require('node:test');
const { AlpacaTradeAdapter } = require('../src/alpaca-adapter');

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function orderRequest(overrides = {}) {
  return {
    request_id: 'req-idem-1',
    symbol: 'NVDA',
    side: 'buy',
    order_type: 'market',
    time_in_force: 'day',
    notional: 100,
    ...overrides,
  };
}

test('Alpaca submit reuses an existing client order id', async () => {
  const calls = [];
  const adapter = new AlpacaTradeAdapter({
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    fetch: async (url, init) => {
      calls.push({ url, method: init?.method });
      if (String(url).includes('orders:by_client_order_id')) {
        return response({ id: 'existing-1', status: 'accepted', client_order_id: 'req-idem-1' });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });

  const result = await adapter.submitOrder(orderRequest());

  assert.equal(result.order_id, 'existing-1');
  assert.equal(result.existing_order_reused, true);
  assert.equal(result.idempotency_status, 'existing_order_reused');
  assert.equal(calls.length, 1);
});

test('Alpaca duplicate client-order response looks up and reuses the existing order', async () => {
  let postCount = 0;
  const adapter = new AlpacaTradeAdapter({
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    fetch: async (url, init) => {
      if (String(url).includes('orders:by_client_order_id') && postCount === 0) {
        return response({ message: 'not found' }, 404);
      }
      if (String(url).includes('/v2/orders?status=open')) return response([]);
      if (String(url).endsWith('/v2/orders')) {
        postCount += 1;
        return response({ message: 'client order id already exists' }, 422);
      }
      if (String(url).includes('orders:by_client_order_id')) {
        return response({ id: 'existing-after-dup', status: 'new', client_order_id: 'req-idem-1' });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });

  const result = await adapter.submitOrder(orderRequest());

  assert.equal(result.order_id, 'existing-after-dup');
  assert.equal(result.existing_order_reused, true);
  assert.equal(result.idempotency_status, 'existing_order_reused_after_duplicate');
});

test('Alpaca submits normally without a client id', async () => {
  const adapter = new AlpacaTradeAdapter({
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    fetch: async (url) => {
      assert(String(url).endsWith('/v2/orders'));
      return response({ id: 'new-order', status: 'accepted' });
    },
  });

  const result = await adapter.submitOrder(orderRequest({ request_id: null, signal_id: null, client_order_id: null }));

  assert.equal(result.order_id, 'new-order');
  assert.equal(result.idempotency_status, 'not_requested');
  assert.equal(result.idempotency_checked, false);
});

test('required Alpaca idempotency lookup failure fails safely', async () => {
  const adapter = new AlpacaTradeAdapter({
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    fetch: async (url) => {
      if (String(url).includes('orders:by_client_order_id')) throw new Error('lookup offline');
      throw new Error(`Unexpected request ${url}`);
    },
  });

  await assert.rejects(
    () => adapter.submitOrder(orderRequest({ require_idempotency: true })),
    /lookup offline/,
  );
});
