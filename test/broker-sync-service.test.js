const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { syncLocalStateFromBroker } = require('../src/broker-sync-service');
const { loadCandidateLifecycleState, saveCandidateLifecycleState } = require('../src/candidate-lifecycle-state');
const { loadTrailingState, saveTrailingState } = require('../src/position-trailing-state');

function tempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-sync-'));
  fs.mkdirSync(path.join(repoRoot, 'data', 'state'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'data', 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'data', 'logs'), { recursive: true });
  return repoRoot;
}

function adapter(overrides = {}) {
  return {
    getAccount: async () => ({ buying_power: '500', cash: '500' }),
    getPositions: async () => [],
    getOpenOrders: async () => [],
    ...overrides,
  };
}

function controlState() {
  return {
    scanner: { status: 'running', pid: 101 },
    trader: { status: 'running', pid: 202 },
  };
}

test('broker sync removes externally closed position state without clearing candidate queue', async () => {
  const repoRoot = tempRepo();
  const env = {};
  saveTrailingState({
    positions: {
      VRM: { symbol: 'VRM', current_unrealized_pl: 1.25, quantity: 25 },
    },
  }, { env, repoRoot });
  saveCandidateLifecycleState({
    queue_enabled: true,
    candidates: {
      RGNX: { symbol: 'RGNX', latest_rank: 44, status: 'eligible', scans_seen: 3 },
    },
  }, { env, repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'data', 'state', 'scanner-runtime.json'), JSON.stringify({
    mode: 'monitor',
    dynamic_top_symbols: [{ symbol: 'RGNX', score: 44 }],
    execution_mode: 'live',
  }));

  const result = await syncLocalStateFromBroker({
    repoRoot,
    env,
    executionAdapter: adapter(),
    controlState: controlState(),
    maxOpenPositions: 1,
    now: '2026-07-07T14:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.positions_after, 0);
  assert.equal(result.available_position_slots_after, 1);
  assert(result.reason_codes.includes('BROKER_SYNC_POSITION_REMOVED'));
  assert.equal(result.preserved.scanner_process, true);
  assert.equal(result.preserved.trader_process, true);
  assert.equal(result.preserved.candidate_queue, true);
  assert.equal(loadTrailingState({ env, repoRoot }).positions.VRM, undefined);
  assert.equal(loadCandidateLifecycleState({ env, repoRoot }).candidates.RGNX.symbol, 'RGNX');
});

test('broker sync is idempotent after stale state is already repaired', async () => {
  const repoRoot = tempRepo();
  const env = {};
  saveTrailingState({ positions: { VRM: { symbol: 'VRM', quantity: 25 } } }, { env, repoRoot });
  saveCandidateLifecycleState({ queue_enabled: true, candidates: { RGNX: { symbol: 'RGNX', latest_rank: 44 } } }, { env, repoRoot });

  await syncLocalStateFromBroker({
    repoRoot,
    env,
    executionAdapter: adapter(),
    controlState: controlState(),
    maxOpenPositions: 1,
    now: '2026-07-07T14:00:00.000Z',
  });
  const second = await syncLocalStateFromBroker({
    repoRoot,
    env,
    executionAdapter: adapter(),
    controlState: controlState(),
    maxOpenPositions: 1,
    now: '2026-07-07T14:01:00.000Z',
  });

  assert.equal(second.ok, true);
  assert.equal(second.repaired_local_state.length, 0);
  assert(second.reason_codes.includes('BROKER_SYNC_NO_REPAIR_NEEDED'));
  assert.equal(second.preserved.candidate_queue, true);
});

test('broker sync fails closed when Alpaca visibility is unavailable', async () => {
  const repoRoot = tempRepo();
  const env = {};
  saveTrailingState({ positions: { VRM: { symbol: 'VRM', quantity: 25 } } }, { env, repoRoot });

  const result = await syncLocalStateFromBroker({
    repoRoot,
    env,
    executionAdapter: adapter({
      getPositions: async () => { throw new Error('alpaca down'); },
    }),
    controlState: controlState(),
    maxOpenPositions: 1,
    now: '2026-07-07T14:00:00.000Z',
  });

  assert.equal(result.ok, false);
  assert(result.reason_codes.includes('BROKER_SYNC_FAILED_BROKER_UNAVAILABLE'));
  assert.equal(loadTrailingState({ env, repoRoot }).positions.VRM.symbol, 'VRM');
});

test('broker sync does not release buy capacity while an open sell order remains', async () => {
  const repoRoot = tempRepo();
  const env = {};
  saveTrailingState({ positions: { VRM: { symbol: 'VRM', quantity: 25 } } }, { env, repoRoot });

  const result = await syncLocalStateFromBroker({
    repoRoot,
    env,
    executionAdapter: adapter({
      getOpenOrders: async () => [{ symbol: 'VRM', side: 'sell', status: 'new', qty: '25' }],
    }),
    controlState: controlState(),
    maxOpenPositions: 1,
    now: '2026-07-07T14:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'warning');
  assert(result.reason_codes.includes('BROKER_SYNC_BUY_BLOCKED_OPEN_ORDER'));
  assert.equal(result.available_position_slots_after, 0);
  assert.equal(loadTrailingState({ env, repoRoot }).positions.VRM.symbol, 'VRM');
});
