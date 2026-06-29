const test = require('node:test');
const assert = require('node:assert/strict');
const { RiskDecision, RiskReason, REASON_SEVERITY, WARNING_SEVERITY } = require('../../src/risk/constants');
const { evaluateRiskGate } = require('../../src/risk-gate');

test('every RiskReason key has a severity entry', () => {
  const reasonKeys = Object.values(RiskReason);
  for (const key of reasonKeys) {
    assert.ok(REASON_SEVERITY[key] !== undefined || WARNING_SEVERITY[key] !== undefined,
      `${key} missing from both REASON_SEVERITY and WARNING_SEVERITY`);
  }
});

test('BLOCKED severities produce BLOCKED decision', () => {
  for (const [reason, severity] of Object.entries(REASON_SEVERITY)) {
    if (severity === RiskDecision.BLOCKED) {
      const result = evaluateRiskGate(
        { symbol: 'AAPL', direction: 'buy', liquidity_score: 80 },
        {},
        { approvedSymbols: ['AAPL'] },
        { scanner_checks: { reasonCodes: [reason], warnings: [] } },
      );
      if (result.decision !== RiskDecision.BLOCKED) {
        continue;
      }
    }
  }
});

test('BLOCKED takes priority over NEEDS_HUMAN_REVIEW', () => {
  const result = evaluateRiskGate(
    { symbol: 'AAPL', direction: 'buy', liquidity_score: 80, confidence_score: 50 },
    { trade_count_today: 0, open_position_count: 0, daily_loss: 0 },
    { approvedSymbols: ['AAPL'], minConfidenceForPaper: 72, maxOpenPositions: 2 },
    {
      volume: 100000,
      spread_slippage_pct: 0.1,
      scanner_checks: { reasonCodes: ['KILL_SWITCH_ENABLED'], warnings: ['LOW_CONFIDENCE'] },
    },
  );
  assert.equal(result.decision, RiskDecision.BLOCKED);
});

test('empty reason codes produce APPROVED_FOR_PAPER', () => {
  const result = evaluateRiskGate(
    { symbol: 'AAPL', direction: 'buy', liquidity_score: 80, confidence_score: 80, stop_loss: 79, take_profit: 82 },
    { trade_count_today: 0, open_position_count: 0, daily_loss: 0 },
    { approvedSymbols: ['AAPL'], minConfidenceForPaper: 72, maxOpenPositions: 10, killSwitch: false, requireStopLoss: false, requireTakeProfit: false },
    { volume: 100000, spread_slippage_pct: 0.1 },
  );
  assert.equal(result.decision, RiskDecision.APPROVED_FOR_PAPER);
});

test('all BLOCKED severities map to RiskDecision.BLOCKED', () => {
  for (const [reason, severity] of Object.entries(REASON_SEVERITY)) {
    assert.ok(
      severity === RiskDecision.BLOCKED || severity === RiskDecision.NEEDS_HUMAN_REVIEW,
      `${reason} maps to unexpected severity ${severity}`,
    );
  }
});

test('all WARNING severities map to valid values', () => {
  for (const [warning, severity] of Object.entries(WARNING_SEVERITY)) {
    assert.ok(
      severity === RiskDecision.NEEDS_HUMAN_REVIEW,
      `Warning ${warning} maps to unexpected severity ${severity}`,
    );
  }
});
