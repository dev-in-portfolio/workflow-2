const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { buildWorkflowPulse, writeWorkflowPulse } = require('../src/workflow-pulse');

function scannerFixture() {
  return {
    updated_at: '2026-07-16T19:00:00.000Z',
    mode: 'live-market',
    portfolio: { cash: 100, buying_power: 100, open_positions_count: 1, remaining_position_slots: 1, open_buy_order_count: 0 },
    broker_state: { available: true, strict_buy_blocked: false },
    trailing_state: {
      positions: {
        NEW: { symbol: 'NEW', opened_at: '2026-07-16T18:59:00.000Z', current_unrealized_pl: 0.2, peak_unrealized_pl: 0.3, trailing_active: false },
      },
    },
    candidate_count: 0,
    waiting_for_buy: { reason_code: 'RECENT_UPWARD_MOMENTUM_WEAK', message: 'Waiting for momentum.' },
    skip_summary: { RECENT_UPWARD_MOMENTUM_WEAK: 5 },
    session_guards: { status: 'CLEAR', buy_blocked: false },
    momentum_entry: { require_recent_move: true, min_recent_move_pct: 0.15 },
    sources: [{ source: 'alpaca', enabled: true, available: true, status: 'active' }],
  };
}

test('workflow pulse consolidates current trading metrics and rejects stale position context', () => {
  const pulse = buildWorkflowPulse({
    now: '2026-07-16T19:00:10.000Z',
    priorPulse: { activity: {} },
    scannerRuntime: scannerFixture(),
    supervisor: { status: 'healthy', updated_at: '2026-07-16T19:00:09.000Z', services: {} },
    regularWatch: { status: 'ok', updated_at: '2026-07-16T19:00:08.000Z', regularWatchMovers: [{ symbol: 'FAST', movePct: 5, relativeVolume: 2 }] },
    reconciliation: { status: 'OK', checked_at: '2026-07-16T18:50:00.000Z', alpaca_positions: [{ symbol: 'OLD' }] },
    performanceRows: [
      { entry_type: 'execution_outcome', record: { recorded_at: '2026-07-16T18:59:00.000Z', symbol: 'NEW', execution_mode: 'live', status: 'filled', quantity: 4, entry_price: 10, original_signal: { side: 'buy', candidate_lifecycle: { first_seen_at: '2026-07-16T18:58:40.000Z', confirmation_path: 'normal' }, structure_stop: { stop_price: 9.75, stop_distance: 0.25 }, market_context: { alpaca_quote: { provider_name: 'alpaca', timestamp: '2026-07-16T18:58:59.000Z', stale: false }, scanner: { spread_pct: 0.1, selection_v2: { setup_classification: 'MOMENTUM_CONTINUATION', final_opportunity_score: 88, features: { one_minute_return_pct: 0.3, relative_volume: 2 } } } } } } },
      { entry_type: 'execution_outcome', record: { recorded_at: '2026-07-16T19:00:00.000Z', symbol: 'NEW', execution_mode: 'live', status: 'filled', accounting_version: '2026-07-13.broker-fill.1', gross_pnl: -0.4, adjusted_pnl: -0.5, fees: 0, exit_reason: 'STOP_LOSS_DOLLARS', exit_state: { stop_loss_dollars: 0.35, trailing_peak_unrealized_pl: 0.2 }, original_signal: { side: 'sell' } } },
      { entry_type: 'risk_decision', record: { timestamp: '2026-07-16T18:58:59.000Z', decision: 'APPROVED_FOR_EXECUTION', reason_codes: [] } },
    ],
  });

  assert.equal(pulse.overall_status, 'healthy');
  assert.equal(pulse.broker.positions.length, 1);
  assert.equal(pulse.broker.positions[0].symbol, 'NEW');
  assert.equal(pulse.broker.positions[0].quantity, 4);
  assert.equal(pulse.broker.positions[0].current_price, 10.05);
  assert.equal(pulse.broker.reconciliation.stale, true);
  assert.equal(pulse.activity.session.buy_count, 1);
  assert.equal(pulse.activity.session.exit_count, 1);
  assert.equal(pulse.activity.session.realized_pnl, -0.4);
  assert.equal(pulse.activity.recent_executions.find((item) => item.side === 'sell').accounting_correction_applied, true);
  assert.equal(pulse.activity.recent_executions.find((item) => item.symbol === 'NEW').one_minute_return_pct, 0.3);
  assert.equal(pulse.regular_watch.top_movers[0].symbol, 'FAST');
  assert.equal(pulse.activity.recent_round_trips[0].exit_reason, 'STOP_LOSS_DOLLARS');
  assert.equal(pulse.activity.exit_quality.trigger_counts.STOP_LOSS_DOLLARS, 1);
  assert.equal(pulse.activity.decision_timing.discovery_to_entry_seconds.average, 20);
  assert.equal(pulse.diagnostics.automatic_diagnosis.generated_from, 'deterministic pulse rules');
  assert.equal(pulse.diagnostics.collection_coverage.adverse_excursion, 'not_historically_recorded');
  assert(pulse.alerts.some((item) => item.code === 'NO_ELIGIBLE_CANDIDATE'));
  assert.equal(JSON.stringify(pulse).includes('api_key'), false);
});

test('workflow pulse writes an atomic local JSON file without secrets', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-pulse-'));
  const filePath = path.join(repoRoot, 'data', 'runtime', 'workflow-pulse.json');
  const pulse = writeWorkflowPulse({
    repoRoot,
    filePath,
    now: '2026-07-16T19:00:10.000Z',
    scannerRuntime: scannerFixture(),
    supervisor: { status: 'healthy', updated_at: '2026-07-16T19:00:09.000Z' },
    regularWatch: {},
    reconciliation: {},
    performanceRows: [],
  });
  const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(written.schema_version, pulse.schema_version);
  assert.equal(fs.readdirSync(path.dirname(filePath)).some((name) => name.endsWith('.tmp')), false);
  assert.equal(JSON.stringify(written).includes('secret'), false);
});
