const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateLivePolicyFile } = require('../src/live-policy-file');
const { computePaperOutcome } = require('../src/paper-outcomes');
const { buildPaperResultFromOrder } = require('../src/trading/execution-orchestrator');
const { recordPaperOutcome } = require('../src/trading-loop');
const { calculateEffectiveStopLossDollars } = require('../src/stock-scanner');
const {
  buildLiveEntryOverrides,
  buildLiveRiskOverrides,
  readLivePolicy,
} = require('../scripts/start-stock-scanner');

function withTempDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-2-pipeline-'));
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('live pipeline migrates an old local policy before deriving scanner controls', () => withTempDirectory((directory) => {
  const policyPath = path.join(directory, 'live-policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    source: 'old-runtime',
    policy: {
      allowContrarianEntries: true,
      scannerSelectionV2AuthorityEnabled: false,
      minAdjustedRankScore: -50,
      positionStopLossDollars: 0.75,
      positionStopLossNotionalPct: 0.75,
      positionStopLossMaxDollars: 6,
      buyNotionalTarget: 150,
      minBuyNotional: 25,
      approvedSymbols: ['NVDA'],
    },
  }));

  const migration = migrateLivePolicyFile(policyPath, { now: new Date('2026-07-09T23:00:00.000Z') });
  const loaded = readLivePolicy(policyPath);
  const entry = buildLiveEntryOverrides(loaded);
  const risk = buildLiveRiskOverrides(loaded);

  assert.equal(migration.status, 'migrated');
  assert.equal(entry.allowContrarianEntries, false);
  assert.equal(entry.scannerSelectionV2AuthorityEnabled, true);
  assert.equal(entry.minAdjustedRankScore, 8);
  assert.equal(risk.stopLossMaxDollars, 1.5);
  assert.deepEqual(loaded.approvedSymbols, ['NVDA']);
}));

test('total-position risk is invariant to share quantity', () => {
  const oneShare = calculateEffectiveStopLossDollars({
    baseStopLossDollars: 0.75,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 1.5,
    positionMarketValue: 150,
    positionQuantity: 1,
  });
  const fortyShares = calculateEffectiveStopLossDollars({
    baseStopLossDollars: 0.75,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 1.5,
    positionMarketValue: 150,
    positionQuantity: 40,
  });

  assert.equal(oneShare, 1.125);
  assert.equal(fortyShares, oneShare);
});

test('completed trade outcomes retain duration and exit telemetry', () => {
  const outcome = computePaperOutcome({
    original_signal: {
      signal_id: 'stock_nvda_entry',
      confidence_score: 86,
      created_at: '2026-07-09T14:30:00.000Z',
    },
    paper_result: {
      status: 'filled',
      average_fill_price: 100.01,
      average_exit_price: 100.48,
      estimated_fees: 0.02,
      filled_at: '2026-07-09T14:42:00.000Z',
    },
    entry_price: 100,
    exit_price: 100.5,
    high_price: 100.8,
    low_price: 99.9,
    quantity: 2,
    entry_at: '2026-07-09T14:30:00.000Z',
    exit_at: '2026-07-09T14:42:00.000Z',
    holding_period_seconds: 720,
    trade_duration_seconds: 720,
    exit_reason: 'TRAILING_PROFIT_GIVEBACK',
    exit_state: {
      peak_profit_dollars: 1.6,
      trailing_profit_giveback_dollars: 0.1,
    },
  });

  assert.equal(outcome.status, 'filled');
  assert.equal(outcome.holding_period_seconds, 720);
  assert.equal(outcome.trade_duration_seconds, 720);
  assert.equal(outcome.exit_reason, 'TRAILING_PROFIT_GIVEBACK');
  assert.equal(outcome.exit_state.peak_profit_dollars, 1.6);
  assert.equal(outcome.calibration_bucket, '80-89');
  assert.equal(outcome.win_loss, 'win');
  assert.equal(outcome.net_pnl > 0, true);
});

test('live broker fill price overrides the scanner midpoint for realized pnl', () => {
  const signal = {
    signal_id: 'stock_qttb_sell', symbol: 'QTTB', side: 'sell', entry_price: 22.605,
    position_avg_entry_price: 20.96, quantity: 4,
    market_context: { exit_state: { entry_price: 20.96, sell_price: 22.605, quantity: 4 } },
  };
  const paperResult = buildPaperResultFromOrder({
    signal,
    paperOrderRequest: { request_id: signal.signal_id, entry_price: 22.605, quantity: 4, execution_mode: 'live' },
    paperOrder: { order_id: 'qttb-order', execution_mode: 'live' },
    confirmation: { order: { id: 'qttb-order', status: 'filled', filled_avg_price: '21.20', filled_qty: '4', qty: '4', filled_at: '2026-07-13T19:48:09.359Z' } },
  });
  let recorded = null;
  const outcome = recordPaperOutcome({ recordPaperOutcome(value) { recorded = value; return value; } }, signal, paperResult);
  assert.equal(paperResult.average_fill_price, 21.2);
  assert.equal(paperResult.fill_price_source, 'broker_order');
  assert.equal(outcome.accounting_valid, true);
  assert.equal(outcome.entry_price_source, 'broker_position_avg_entry_price');
  assert.equal(Number(outcome.gross_pnl.toFixed(2)), 0.96);
  assert.equal(recorded.gross_pnl, outcome.gross_pnl);
});

test('live filled order without a broker fill price is excluded from pnl', () => {
  const signal = { signal_id: 'missing-fill', symbol: 'TEST', side: 'sell', entry_price: 25, position_avg_entry_price: 20, quantity: 2 };
  const paperResult = buildPaperResultFromOrder({
    signal,
    paperOrderRequest: { request_id: signal.signal_id, entry_price: 25, quantity: 2, execution_mode: 'live' },
    paperOrder: { order_id: 'missing-fill-order', execution_mode: 'live' },
    confirmation: { order: { id: 'missing-fill-order', status: 'filled', filled_qty: '2', qty: '2' } },
  });
  const outcome = recordPaperOutcome({ recordPaperOutcome(value) { return value; } }, signal, paperResult);
  assert.equal(paperResult.average_fill_price, null);
  assert.equal(outcome.accounting_valid, false);
  assert.deepEqual(outcome.accounting_reason_codes, ['BROKER_FILL_PRICE_UNCONFIRMED']);
  assert.equal(outcome.gross_pnl, null);
  assert.equal(outcome.net_pnl, null);
  assert.equal(outcome.win_loss, 'unknown');
});

test('missing local policy reads as canonical safe defaults', () => withTempDirectory((directory) => {
  const policy = readLivePolicy(path.join(directory, 'does-not-exist.json'));
  const entry = buildLiveEntryOverrides(policy);
  const risk = buildLiveRiskOverrides(policy);

  assert.equal(entry.allowContrarianEntries, false);
  assert.equal(entry.scannerSelectionV2AuthorityEnabled, true);
  assert.equal(entry.minAdjustedRankScore, 8);
  assert.equal(risk.stopLossMaxDollars, 1.5);
}));
