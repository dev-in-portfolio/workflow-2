const fs = require('fs');
const path = require('path');
const { resolveRepoRoot } = require('./util');
const { resolveScannerDecisionRecordsPath } = require('./scanner-outcome-shadow');

function summarizeScannerSelectionValidation({ filePath = null, env = process.env, repoRoot = resolveRepoRoot() } = {}) {
  const targetPath = filePath || resolveScannerDecisionRecordsPath({ env, repoRoot });
  const records = readJsonl(targetPath);
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

  return {
    dataset_date_range: {
      first: range[0] || null,
      last: range[range.length - 1] || null,
    },
    scanner_cycles: records.length,
    candidates: candidateRows.length,
    cycles_with_multiple_candidates: multiCandidateCycles.length,
    old_new_top_pick_disagreements: oldNewDisagreements.length,
    old_model: {
      positive_score_negative_move_count: negativeOldRanked.length,
      positive_score_negative_move_pct: pct(negativeOldRanked.length, candidateRows.length),
    },
    new_model: {
      qualified_count: v2Qualified.length,
      qualified_pct: pct(v2Qualified.length, candidateRows.length),
      setup_counts: setupCounts,
      overextended_count: overextended.length,
      unclassified_count: unclassified.length,
      top_reason_counts: Object.fromEntries(Object.entries(blockReasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)),
    },
    selection_regret: {
      measurable: false,
      reason: 'Future price windows are not populated yet; decision records now preserve the candidate sets needed for later regret analysis.',
    },
    recommendation: records.length >= 50 && multiCandidateCycles.length >= 20
      ? 'CONTINUE_SHADOW_TEST'
      : 'CONTINUE_SHADOW_TEST_COLLECT_MORE_DATA',
    data_quality_limitations: [
      ...(!records.length ? ['No scanner decision records found yet.'] : []),
      'Future 1m/5m/15m/30m/60m/EOD outcome windows still need observation fills before profitability comparison.',
      'Selection regret requires cycles with multiple eligible candidates.',
    ],
  };
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

if (require.main === module) {
  const fileArg = process.argv.find((arg) => arg.startsWith('--file='));
  const filePath = fileArg ? path.resolve(fileArg.slice('--file='.length)) : null;
  console.log(JSON.stringify(summarizeScannerSelectionValidation({ filePath }), null, 2));
}

module.exports = {
  summarizeScannerSelectionValidation,
};
