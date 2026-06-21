const { nowIso } = require('./util');

function buildReviewItem({ signal, riskDecision, evidenceSummary = '', contradictionSummary = '', tradePlan = {} }) {
  return {
    review_item_id: `review_${signal.signal_id}`,
    created_at: nowIso(),
    symbol: signal.symbol,
    asset_type: signal.asset_type,
    proposed_action: signal.action_candidate,
    confidence: signal.confidence_score,
    risk_score: signal.risk_score,
    risk_gate_result: riskDecision.decision,
    evidence_summary: evidenceSummary || signal.explanation,
    contradiction_summary: contradictionSummary || (signal.decision_reasons || []).join(', '),
    expected_trade_plan: tradePlan,
    stop_loss: signal.stop_loss ?? null,
    take_profit: signal.take_profit ?? null,
    position_sizing_rationale: tradePlan.position_sizing_rationale || `Deterministic risk gate required approval before size selection. Edge score ${Math.round(signal.edge_score ?? signal.confidence_score ?? 0)}/100 with provider confirmation ${Math.round(signal.provider_confirmation_score ?? 0)}/100.`,
    related_refs: signal.evidence_refs || [],
    actions: ['approve_for_paper', 'reject', 'downgrade_to_alert', 'pause_strategy', 'add_note', 'request_more_research'],
    notes: [],
  };
}

module.exports = {
  buildReviewItem,
};
