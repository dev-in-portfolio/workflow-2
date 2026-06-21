const { PaperTradeAdapter } = require('./paper-adapter');
const { runReplay } = require('./replay');
const { buildThresholdProposal } = require('./performance-tuning');
const { PerformanceStore } = require('./feedback-loop');
const { scoreSignal } = require('./signals');

function comparePolicyPerformance(fixtures, options = {}) {
  const baselinePolicy = normalizePolicy(options.baselinePolicy || {});
  const historyStore = options.performanceStore instanceof PerformanceStore ? options.performanceStore : null;
  const resolvedFixtures = resolveFixtures(fixtures, historyStore, options);
  const context = buildWalkForwardContext(resolvedFixtures, options);
  const tuningProposal = options.tuningProposal || buildThresholdProposal({
    currentPolicy: baselinePolicy,
    signals: context.signals,
    paperOutcomes: context.paperOutcomes,
    riskDecisions: context.riskDecisions,
  });
  const tunedPolicy = normalizePolicy({
    ...baselinePolicy,
    ...tuningProposal.proposed_policy,
  });

  const baseline = executeReplay(resolvedFixtures, baselinePolicy, options);
  const tuned = executeReplay(resolvedFixtures, tunedPolicy, options);
  const delta = compareSummaries(baseline.summary, tuned.summary);
  const winner = chooseWinner(baseline.summary, tuned.summary, delta);

  return {
    baseline_policy: baselinePolicy,
    tuned_policy: tunedPolicy,
    tuning_proposal: tuningProposal,
    baseline: baseline.summary,
    tuned: tuned.summary,
    delta,
    winner,
    recommendation: buildRecommendation(winner, delta, tuningProposal),
  };
}

function resolveFixtures(fixtures, historyStore, options) {
  if (Array.isArray(fixtures) && fixtures.length) return fixtures;
  if (historyStore) {
    const exported = historyStore.exportReplayFixtures({
      dateFrom: options.dateFrom || null,
      dateTo: options.dateTo || null,
      limit: options.limit || 1000,
    });
    if (exported.length) return exported;
  }
  return [];
}

function buildWalkForwardContext(fixtures, options) {
  const signals = [];
  const riskDecisions = [];
  const paperOutcomes = [];

  for (const fixture of fixtures) {
    if (fixture.signal) {
      signals.push(scoreSignal(fixture.signal, {
        market_context: fixture.market_context || fixture.signal.market_context || {},
        portfolio_context_available: fixture.portfolio?.available !== false,
      }));
    }
    if (fixture.risk_decision) riskDecisions.push(fixture.risk_decision);
    if (fixture.paper_outcome) paperOutcomes.push(fixture.paper_outcome);
  }

  return {
    signals,
    riskDecisions,
    paperOutcomes,
    date: options.date,
  };
}

function executeReplay(fixtures, riskConfig, options = {}) {
  return runReplay(fixtures, {
    ...options,
    paperAdapter: new PaperTradeAdapter({ dryRun: true }),
    riskConfig,
    date: options.date,
  });
}

function compareSummaries(baseline, tuned) {
  const baselinePnL = Number(baseline.paper_pnl || baseline.realized_paper_pnl || 0);
  const tunedPnL = Number(tuned.paper_pnl || tuned.realized_paper_pnl || 0);
  const baselineDrawdown = Number(baseline.drawdown || baseline.max_drawdown || 0);
  const tunedDrawdown = Number(tuned.drawdown || tuned.max_drawdown || 0);
  const baselineFalsePositives = Number(baseline.false_positives || 0);
  const tunedFalsePositives = Number(tuned.false_positives || 0);
  const baselineBlocked = Number(baseline.blocked_count || baseline.blocked_by_risk || 0);
  const tunedBlocked = Number(tuned.blocked_count || tuned.blocked_by_risk || 0);

  return {
    paper_pnl: tunedPnL - baselinePnL,
    drawdown: tunedDrawdown - baselineDrawdown,
    false_positives: tunedFalsePositives - baselineFalsePositives,
    blocked_count: tunedBlocked - baselineBlocked,
    paper_orders: Number(tuned.paper_orders || 0) - Number(baseline.paper_orders || 0),
    approved_count: Number(tuned.approved_count || tuned.approved_for_paper || 0) - Number(baseline.approved_count || baseline.approved_for_paper || 0),
    baseline_score: scoreSummary(baseline),
    tuned_score: scoreSummary(tuned),
  };
}

function chooseWinner(baseline, tuned, delta) {
  const baselineScore = scoreSummary(baseline);
  const tunedScore = scoreSummary(tuned);
  if (tunedScore > baselineScore) return 'tuned';
  if (baselineScore > tunedScore) return 'baseline';
  if (delta.paper_pnl > 0) return 'tuned';
  if (delta.paper_pnl < 0) return 'baseline';
  return 'tie';
}

function scoreSummary(summary) {
  const pnl = Number(summary.paper_pnl || summary.realized_paper_pnl || 0);
  const drawdown = Number(summary.drawdown || summary.max_drawdown || 0);
  const falsePositives = Number(summary.false_positives || 0);
  const blocked = Number(summary.blocked_count || summary.blocked_by_risk || 0);
  return pnl - (drawdown * 1.25) - (falsePositives * 1.5) - (blocked * 0.2);
}

function buildRecommendation(winner, delta, tuningProposal) {
  if (winner === 'tuned') {
    return 'Adopt the tuned policy in paper mode and keep monitoring the same buckets for degradation.';
  }
  if (winner === 'baseline') {
    return 'Keep the baseline policy; the current tuned proposal does not improve the replayed results.';
  }
  return `Results are tied; use the current proposal as a cautious experiment. Key proposal codes: ${(tuningProposal.reason_codes || []).join(', ') || 'none'}.`;
}

function normalizePolicy(policy) {
  return {
    killSwitch: false,
    paperAdapterEnabled: true,
    requireHumanApproval: true,
    minConfidenceForPaper: 72,
    minFreshnessScore: 55,
    minSourceQualityScore: 40,
    minProviderConfirmationScore: 70,
    minEdgeScore: 60,
    maxContradictionScore: 50,
    maxRiskScore: 70,
    minLiquidityScore: 40,
    minVolume: 50000,
    ...policy,
  };
}

module.exports = {
  buildRecommendation,
  comparePolicyPerformance,
  compareSummaries,
  normalizePolicy,
  resolveFixtures,
  scoreSummary,
};
