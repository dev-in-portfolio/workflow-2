const test = require('node:test');
const assert = require('node:assert/strict');
const { createTradingControlServer } = require('../src');

test('trading control server returns invalid_json for malformed payloads', async () => {
  const server = createTradingControlServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/risk-policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.error, 'invalid_json');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
