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
  recordScannerSelectionShadow,
};
