const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { startTradingControlServer } = require('../src');

test('server cli falls back to the next free port when the preferred port is occupied', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-port-fallback-'));
  const occupiedServer = http.createServer((_, res) => res.end('busy'));
  await new Promise((resolve) => occupiedServer.listen(0, resolve));
  const occupiedPort = occupiedServer.address().port;

  const server = startTradingControlServer({ PORT: String(occupiedPort) }, {
    performanceHistoryPath: path.join(tempDir, 'history.jsonl'),
    policyPath: path.join(tempDir, 'policy.json'),
    policyHistoryPath: path.join(tempDir, 'policy-history.jsonl'),
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();

  assert.equal(address.port, occupiedPort + 1);

  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => occupiedServer.close(resolve));
});
