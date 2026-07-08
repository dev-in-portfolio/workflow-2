const fs = require('fs');
const path = require('path');
const { resolveRepoRoot } = require('./util');
const { resolveScannerDecisionRecordsPath } = require('./scanner-outcome-shadow');
const { OUTCOME_WINDOWS, resolveScannerCandidateOutcomesPath } = require('./scanner-selection-outcomes');

function summarizeScannerSelectionValidation({ filePath = null, outcomeFilePath = null, env = process.env, repoRoot = resolveRepoRoot() } = {}) {
  const targetPath = filePath || resolveScannerDecisionRecordsPath({ env, repoRoot });
  const outcomesPath = outcomeFilePath || resolveScannerCandidateOutcomesPath({ env, repoRoot });
  const records = readJsonl(targetPath);
  const outcomes = readJsonl(outcomesPath);
  const outcomeMap = new Map(outcomes.map((outcome) => [`${outcome.candidate_id}::${outcome.window}`, outcome]));
  const candidateRows = records.flatMap((record) => (Array.isArray(record.candidates) ? record.candidates : []).map((candidate) => ({
    record,
    candidate,
  })));
  const multiCandidateCycles = records.filter((record) => Array.isArray(record.candidates) && record.candidates.length > 1);
  const oldNewDisagreements = records.filter((record) => (
    record.old_model_top?.symbol
    && record.new_model_top?.symbol
    && record.old_model_top.symbol !== record.new_model_top.symbol
  ));
  const v2Qualified = candidateRows.filter(({ candidate }) => candidate.selection_v2_qualified === true);
  const negativeOldRanked = candidateRows.filter(({ candidate }) => Number(candidate.move_pct) < 0 && Number(candidate.rank_score) > 0);
  const overextended = candidateRows.filter(({ candidate }) => candidate.selection_v2_reason_codes?.includes?.('ENTRY_OVEREXTENDED_FROM_VWAP'));
  const unclassified = candidateRows.filter(({ candidate }) => candidate.setup_classification === 'UNCLASSIFIED');
  const setupCounts = countBy(candidateRows, ({ candidate }) => candidate.setup_classification || 'UNKNOWN');
  const blockReasonCounts = countBy(candidateRows, ({ candidate }) => (candidate.selection_v2_reason_codes || [])[0] || 'NONE');
  const range = records.map((record) => record.decision_at).filter(Boolean).sort();
  const windowMetrics = Object.fromEntries(OUTCOME_WINDOWS.map(({ window }) => [window, calculateWindowMetrics(records, outcomeMap, window)]));
  const completedOutcomeWindows = outcomes.filter((outcome) => outcome.status === 'complete').length;
  const unavailableOutcomeWindows = outcomes.filter((outcome) => outcome.status === 'unavailable').length;
  const evaluatedSymbolCount = records.reduce((sum, record) => sum + Number(record.decision_trace_count || record.decision_traces?.length || 0), 0);
  const noQualifiedCycles = records.filter((record) => !record.new_model_top_qualified).length;

  return {
    dataset_date_range: {
      first: range[0] || null,
      last: range[range.length - 1] || null,
    },
    scanner_cycles: records.length,
    evaluated_symbols: evaluatedSymbolCount,
    candidates: candidateRows.length,
    measurable_candidates: new Set(outcomes.filter((outcome) => outcome.status === 'complete').map((outcome) => outcome.candidate_id)).size,
    completed_outcome_windows: completedOutcomeWindows,
    unavailable_outcome_windows: unavailableOutcomeWindows,
    cycles_with_multiple_candidates: multiCandidateCycles.length,
    old_new_top_pick_disagreements: oldNewDisagreements.length,
    old_model: {
      selected_candidate_count: records.filter((record) => record.old_model_top).length,
      positive_score_negative_move_count: negativeOldRanked.length,
      positive_score_negative_move_pct: pct(negativeOldRanked.length, candidateRows.length),
      metrics_by_window: Object.fromEntries(Object.entries(windowMetrics).map(([window, metrics]) => [window, metrics.old_model])),
    },
    new_model: {
      qualified_count: v2Qualified.length,
      qualified_pct: pct(v2Qualified.length, candidateRows.length),
      no_qualified_candidate_cycles: noQualifiedCycles,
      setup_counts: setupCounts,
      overextended_count: overextended.length,
      unclassified_count: unclassified.length,
      top_reason_counts: Object.fromEntries(Object.entries(blockReasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)),
      metrics_by_window: Object.fromEntries(Object.entries(windowMetrics).map(([window, metrics]) => [window, metrics.new_model])),
    },
    comparisons_by_window: Object.fromEntries(Object.entries(windowMetrics).map(([window, metrics]) => [window, metrics.comparison])),
    funnel_failures: summarizeFunnel(records),
    selection_regret: {
      measurable: Object.values(windowMetrics).some((metrics) => metrics.comparison.measurable_cycles > 0),
      by_window: Object.fromEntries(Object.entries(windowMetrics).map(([window, metrics]) => [window, metrics.regret])),
    },
    recommendation: chooseRecommendation({ records, multiCandidateCycles, completedOutcomeWindows, windowMetrics }),
    data_quality_limitations: [
      ...(!records.length ? ['No scanner decision records found yet.'] : []),
      ...(!completedOutcomeWindows ? ['Future 1m/5m/15m/30m/60m/EOD outcome windows still need observation fills before profitability comparison.'] : []),
      ...(multiCandidateCycles.length ? [] : ['Selection regret requires cycles with multiple eligible candidates.']),
    ],
  };
}

function calculateWindowMetrics(records, outcomeMap, window) {
  const rows = [];
  for (const record of records) {
    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    const measurable = candidates
      .map((candidate) => ({ candidate, outcome: outcomeMap.get(`${candidate.candidate_id}::${window}`) }))
      .filter(({ outcome }) => outcome?.status === 'complete' && Number.isFinite(Number(outcome.raw_return_pct)));
    if (measurable.length < 2) continue;
    measurable.sort((a, b) => Number(b.outcome.raw_return_pct) - Number(a.outcome.raw_return_pct));
    const oldCandidate = record.old_model_top;
    const newCandidate = record.new_model_top_qualified;
    const oldOutcome = oldCandidate ? outcomeMap.get(`${oldCandidate.candidate_id}::${window}`) : null;
    const newOutcome = newCandidate ? outcomeMap.get(`${newCandidate.candidate_id}::${window}`) : null;
    if (oldOutcome?.status !== 'complete' || newOutcome?.status !== 'complete') continue;
    const bestReturn = Number(measurable[0].outcome.raw_return_pct);
    const medianReturn = Number(measurable[Math.floor(measurable.length / 2)].outcome.raw_return_pct);
    const oldReturn = Number(oldOutcome.raw_return_pct);
    const newReturn = Number(newOutcome.raw_return_pct);
    rows.push({
      old_return: oldReturn,
      new_return: newReturn,
      best_return: bestReturn,
      median_return: medianReturn,
      old_regret: bestReturn - oldReturn,
      new_regret: bestReturn - newReturn,
      old_rank: measurable.findIndex(({ candidate }) => candidate.candidate_id === oldCandidate.candidate_id) + 1,
      new_rank: measurable.findIndex(({ candidate }) => candidate.candidate_id === newCandidate.candidate_id) + 1,
      old_top_three_hit: measurable.slice(0, 3).some(({ candidate }) => candidate.candidate_id === oldCandidate.candidate_id),
      new_top_three_hit: measurable.slice(0, 3).some(({ candidate }) => candidate.candidate_id === newCandidate.candidate_id),
      old_stop_first: oldOutcome.simulated_trade_result === 'STOP_FIRST',
      new_stop_first: newOutcome.simulated_trade_result === 'STOP_FIRST',
      old_target_first: oldOutcome.simulated_trade_result === 'TARGET_FIRST',
      new_target_first: newOutcome.simulated_trade_result === 'TARGET_FIRST',
      old_mfe: Number(oldOutcome.maximum_favorable_excursion_pct),
      old_mae: Number(oldOutcome.maximum_adverse_excursion_pct),
      new_mfe: Number(newOutcome.maximum_favorable_excursion_pct),
      new_mae: Number(newOutcome.maximum_adverse_excursion_pct),
    });
  }
  return {
    old_model: summarizeOutcomeRows(rows, 'old'),
    new_model: summarizeOutcomeRows(rows, 'new'),
    regret: {
      measurable_cycles: rows.length,
      old_model_average_regret: avg(rows.map((row) => row.old_regret)),
      new_model_average_regret: avg(rows.map((row) => row.new_regret)),
      old_model_median_regret: median(rows.map((row) => row.old_regret)),
      new_model_median_regret: median(rows.map((row) => row.new_regret)),
    },
    comparison: {
      measurable_cycles: rows.length,
      v2_outperform_count: rows.filter((row) => row.new_return > row.old_return).length,
      old_outperform_count: rows.filter((row) => row.old_return > row.new_return).length,
      ties: rows.filter((row) => row.old_return === row.new_return).length,
      average_regret_improvement: avg(rows.map((row) => row.old_regret - row.new_regret)),
    },
  };
}

function summarizeOutcomeRows(rows, prefix) {
  return {
    measurable_cycles: rows.length,
    positive_return_rate: pct(rows.filter((row) => row[`${prefix}_return`] > 0).length, rows.length),
    average_return: avg(rows.map((row) => row[`${prefix}_return`])),
    average_mfe: avg(rows.map((row) => row[`${prefix}_mfe`])),
    average_mae: avg(rows.map((row) => row[`${prefix}_mae`])),
    stop_first_rate: pct(rows.filter((row) => row[`${prefix}_stop_first`]).length, rows.length),
    target_first_rate: pct(rows.filter((row) => row[`${prefix}_target_first`]).length, rows.length),
    top_one_accuracy: pct(rows.filter((row) => row[`${prefix}_rank`] === 1).length, rows.length),
    top_three_inclusion_rate: pct(rows.filter((row) => row[`${prefix}_top_three_hit`]).length, rows.length),
  };
}

function summarizeFunnel(records) {
  const counts = {};
  for (const record of records) {
    for (const trace of Array.isArray(record.decision_traces) ? record.decision_traces : []) {
      const key = mapFunnelFailure(trace);
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

function mapFunnelFailure(trace = {}) {
  const reasons = trace.reason_codes || [];
  if (trace.terminal_stage === 'MARKET_DATA') return 'MARKET_DATA_UNAVAILABLE';
  if (trace.terminal_stage === 'CANDIDATE_CONSTRUCTION') return 'NOT_A_VALID_CANDIDATE';
  if (trace.terminal_stage === 'QUALIFICATION') return 'QUALIFICATION_FAILED';
  if (trace.terminal_stage === 'RANKING') return 'RANKED_TOO_LOW';
  if (trace.terminal_stage === 'LIFECYCLE') return 'LIFECYCLE_NOT_CONFIRMED';
  if (reasons.includes('MAX_POSITION_SLOTS_FILLED')) return 'CAPACITY_BLOCKED';
  if (reasons.some((reason) => String(reason).includes('ANTI_CHURN'))) return 'ANTI_CHURN_BLOCKED';
  if (reasons.some((reason) => String(reason).includes('SETUP_FATIGUE'))) return 'SETUP_FATIGUE_BLOCKED';
  if (reasons.some((reason) => String(reason).includes('SESSION') || String(reason).includes('MARKET_CLOSED'))) return 'SESSION_GUARD_BLOCKED';
  if (trace.terminal_stage === 'RISK_GATE') return 'RISK_GATE_REJECTED';
  if (trace.terminal_stage === 'ORDER_SUBMISSION') return 'ORDER_REJECTED';
  if (reasons.some((reason) => String(reason).includes('BROKER'))) return 'BROKER_STATE_UNAVAILABLE';
  return 'NOT_IN_UNIVERSE';
}

function chooseRecommendation({ records, multiCandidateCycles, completedOutcomeWindows, windowMetrics }) {
  if (!records.length || completedOutcomeWindows < 20 || multiCandidateCycles.length < 10) return 'COLLECT_MORE_DATA';
  const fiveMinute = windowMetrics['5m'];
  if (!fiveMinute || fiveMinute.comparison.measurable_cycles < 10) return 'CONTINUE_SHADOW_TEST';
  if (fiveMinute.comparison.average_regret_improvement > 0) return 'V2_SHOWS_PROMISE_CONTINUE_SHADOW';
  return 'V2_DOES_NOT_OUTPERFORM';
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = String(keyFn(value) || 'UNKNOWN');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function pct(part, total) {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(1));
}

function avg(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (!finite.length) return null;
  return Number((finite.reduce((sum, value) => sum + value, 0) / finite.length).toFixed(4));
}

function median(values) {
  const finite = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  return Number(finite[Math.floor(finite.length / 2)].toFixed(4));
}

if (require.main === module) {
  const fileArg = process.argv.find((arg) => arg.startsWith('--file='));
  const outcomeArg = process.argv.find((arg) => arg.startsWith('--outcomes='));
  const filePath = fileArg ? path.resolve(fileArg.slice('--file='.length)) : null;
  const outcomeFilePath = outcomeArg ? path.resolve(outcomeArg.slice('--outcomes='.length)) : null;
  console.log(JSON.stringify(summarizeScannerSelectionValidation({ filePath, outcomeFilePath }), null, 2));
}

module.exports = {
  summarizeScannerSelectionValidation,
};
