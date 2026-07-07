const fs = require('fs');
const path = require('path');
const { nowIso, resolveRepoRoot } = require('./util');

function resolveScannerOutcomeShadowPath({ env = process.env, repoRoot = resolveRepoRoot() } = {}) {
  return path.resolve(env.SCANNER_OUTCOME_SHADOW_PATH || path.join(repoRoot, 'data', 'runtime', 'scanner-selection-shadow-outcomes.jsonl'));
}

function recordScannerSelectionShadow({ candidates = [], receivedAt = nowIso(), filePath = null, env = process.env, repoRoot = resolveRepoRoot() } = {}) {
  const buyCandidates = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.payload?.side === 'buy')
    .slice(0, 10);
  if (!buyCandidates.length) return { recorded: 0 };
  const targetPath = filePath || resolveScannerOutcomeShadowPath({ env, repoRoot });
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const lines = buyCandidates.map((candidate, index) => {
    const scanner = candidate.payload?.market_context?.scanner || {};
    const selectionV2 = scanner.selection_v2 || null;
    return JSON.stringify({
      recorded_at: nowIso(),
      decision_at: receivedAt,
      symbol: candidate.symbol,
      legacy_rank: index + 1,
      legacy_rank_score: candidate.rankScore ?? null,
      selection_v2_rank_score: selectionV2?.final_opportunity_score ?? null,
      selection_v2_qualified: selectionV2?.qualified ?? null,
      setup_classification: selectionV2?.setup_classification ?? null,
      entry_price: candidate.payload?.entry_price ?? scanner.current_price ?? null,
      spread_pct: scanner.spread_pct ?? null,
      move_pct: scanner.move_pct ?? null,
      lifecycle_state: scanner.candidate_lifecycle_status || null,
      block_stage: scanner.execution_status || scanner.waiting_reason || null,
      block_reason: firstReason(scanner),
      horizons: [
        { label: '1m', due_at: addMinutes(receivedAt, 1) },
        { label: '5m', due_at: addMinutes(receivedAt, 5) },
        { label: '15m', due_at: addMinutes(receivedAt, 15) },
        { label: '30m', due_at: addMinutes(receivedAt, 30) },
        { label: '60m', due_at: addMinutes(receivedAt, 60) },
        { label: 'eod', due_at: null },
      ],
      observed: false,
    });
  });
  fs.appendFileSync(targetPath, `${lines.join('\n')}\n`, 'utf8');
  return { recorded: lines.length, path: targetPath };
}

function resolveScannerDecisionRecordsPath({ env = process.env, repoRoot = resolveRepoRoot() } = {}) {
  return path.resolve(env.SCANNER_DECISION_RECORDS_PATH || path.join(repoRoot, 'data', 'runtime', 'scanner-decision-records.jsonl'));
}

function recordScannerDecisionCycle({
  receivedAt = nowIso(),
  mode = 'live-market',
  marketRegime = null,
  symbolUniverse = null,
  approvedSymbols = [],
  candidates = [],
  selectedCandidates = [],
  previewCandidates = [],
  skipSummary = {},
  recentSkips = [],
  candidateLifecycle = null,
  results = [],
  brokerState = null,
  filePath = null,
  env = process.env,
  repoRoot = resolveRepoRoot(),
} = {}) {
  const targetPath = filePath || resolveScannerDecisionRecordsPath({ env, repoRoot });
  const fullCandidates = summarizeCandidates(candidates);
  const selectedSymbols = new Set((Array.isArray(selectedCandidates) ? selectedCandidates : []).map((candidate) => String(candidate?.symbol || '').toUpperCase()).filter(Boolean));
  const previewSymbols = new Set((Array.isArray(previewCandidates) ? previewCandidates : []).map((candidate) => String(candidate?.symbol || '').toUpperCase()).filter(Boolean));
  const oldRanked = fullCandidates
    .map((candidate) => ({ ...candidate }))
    .sort((a, b) => Number(b.legacy_sort_score || b.rank_score || 0) - Number(a.legacy_sort_score || a.rank_score || 0));
  const v2Ranked = fullCandidates
    .map((candidate) => ({ ...candidate }))
    .sort((a, b) => Number(b.selection_v2_score ?? -Infinity) - Number(a.selection_v2_score ?? -Infinity));
  const record = {
    schema_version: '2026-07-07.scanner-decision-record.1',
    recorded_at: nowIso(),
    decision_at: receivedAt,
    mode,
    market_regime: marketRegime,
    approved_symbol_count: Array.isArray(approvedSymbols) ? approvedSymbols.length : 0,
    approved_symbols: Array.isArray(approvedSymbols) ? approvedSymbols.slice(0, 500) : [],
    symbol_universe: symbolUniverse,
    candidate_count: fullCandidates.length,
    selected_key: candidateLifecycle?.state?.selected_key || candidateLifecycle?.selection?.selected_key || null,
    selected_symbols: [...selectedSymbols],
    preview_symbols: [...previewSymbols],
    old_model_top: oldRanked[0] || null,
    old_model_top_three: oldRanked.slice(0, 3),
    new_model_top: v2Ranked[0] || null,
    new_model_top_three: v2Ranked.slice(0, 3),
    candidates: fullCandidates.map((candidate) => ({
      ...candidate,
      selected_for_submission: selectedSymbols.has(candidate.symbol),
      preview_only: previewSymbols.has(candidate.symbol),
    })),
    skip_summary: skipSummary || {},
    recent_skips: Array.isArray(recentSkips) ? recentSkips.slice(0, 50) : [],
    candidate_lifecycle_summary: candidateLifecycle?.summary || null,
    post_results: (Array.isArray(results) ? results : []).map(summarizePostResult),
    broker_state: brokerState ? {
      available: brokerState.available,
      strict_buy_blocked: brokerState.strict_buy_blocked,
      reason_codes: brokerState.reason_codes || [],
      account_available: brokerState.account_available,
      positions_available: brokerState.positions_available,
      open_orders_available: brokerState.open_orders_available,
    } : null,
    outcome_windows_pending: ['1m', '5m', '15m', '30m', '60m', 'eod'],
  };
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.appendFileSync(targetPath, `${JSON.stringify(record)}\n`, 'utf8');
  return { recorded: 1, path: targetPath, candidate_count: fullCandidates.length };
}

function summarizeCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.payload?.side === 'buy')
    .map((candidate, index) => {
      const scanner = candidate.payload?.market_context?.scanner || {};
      const selectionV2 = scanner.selection_v2 || candidate.selectionV2 || null;
      return {
        legacy_rank: index + 1,
        symbol: String(candidate.symbol || '').toUpperCase(),
        setup_key: candidate.setupKey || scanner.setup_key || null,
        rank_score: round(candidate.rankScore ?? scanner.rank_score),
        base_rank_score: round(candidate.baseRankScore ?? scanner.base_rank_score),
        legacy_sort_score: round(candidate.regularWatchSortScore ?? candidate.priorityOverrideSortScore ?? candidate.rankScore),
        current_price: scanner.current_price ?? candidate.payload?.entry_price ?? null,
        previous_close: scanner.previous_close ?? null,
        move_pct: scanner.move_pct ?? null,
        spread_pct: scanner.spread_pct ?? null,
        volume: candidate.payload?.volume ?? null,
        lifecycle_status: scanner.candidate_lifecycle_status || null,
        lifecycle_selected: Boolean(scanner.candidate_lifecycle_selected),
        lifecycle_reason_codes: scanner.candidate_lifecycle_reason_codes || [],
        priority_override_applied: Boolean(scanner.priority_override_applied),
        priority_override_bonus: scanner.priority_override_bonus ?? 0,
        regular_watch_comparison: scanner.regular_watch_comparison || null,
        selection_v2_score: selectionV2?.final_opportunity_score ?? null,
        selection_v2_qualified: selectionV2?.qualified ?? null,
        setup_classification: selectionV2?.setup_classification ?? null,
        selection_v2_components: selectionV2?.components || null,
        selection_v2_penalties: selectionV2?.penalties || null,
        selection_v2_reason_codes: selectionV2?.reason_codes || [],
        sizing_method: scanner.sizing_method || candidate.payload?.sizing_method || null,
        structure_stop: scanner.structure_stop || candidate.payload?.structure_stop || null,
      };
    });
}

function summarizePostResult(result = {}) {
  const response = result.response || {};
  return {
    symbol: result.symbol || response.signal?.symbol || null,
    accepted: result.accepted,
    status: result.status,
    stage: response.stage || response.last_result?.stage || null,
    reason_codes: response.reason_codes || response.last_result?.reason_codes || response.riskDecision?.reason_codes || response.risk_decision?.reason_codes || [],
    risk_decision: response.riskDecision?.decision || response.risk_decision?.decision || null,
  };
}

function round(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(4)) : null;
}

function firstReason(scanner = {}) {
  const reasonCodes = [
    ...(Array.isArray(scanner.preview_reason_codes) ? scanner.preview_reason_codes : []),
    ...(Array.isArray(scanner.candidate_lifecycle_reason_codes) ? scanner.candidate_lifecycle_reason_codes : []),
    ...(Array.isArray(scanner.selection_v2?.reason_codes) ? scanner.selection_v2.reason_codes : []),
  ];
  return reasonCodes[0] || null;
}

function addMinutes(value, minutes) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}

module.exports = {
  resolveScannerOutcomeShadowPath,
  resolveScannerDecisionRecordsPath,
  recordScannerSelectionShadow,
  recordScannerDecisionCycle,
};
