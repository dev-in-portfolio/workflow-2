# Direct Integration Contracts

These contracts are designed for deterministic, paper-first integration.

## Common Rules

- Require an idempotency key or request id.
- Fail closed when required fields are missing.
- Write audit events for every accepted event.
- Never let the orchestrator directly place live orders.

## Common Responses

- Success: `200` with `{ "accepted": true, ... }`
- Validation failure: `400` with a machine-readable `error` field
- Duplicate request: `200` with the existing record reference
- Unexpected failure: `500` with a trace id that can be logged and replayed

## Market Ingest Webhook

Path: `/webhooks/market-ingest`

Required fields:

- `provider`
- `symbol`
- `asset_type`
- `timestamp`
- `kind`

Example:

```json
{
  "provider": "alpaca",
  "symbol": "AAPL",
  "asset_type": "stock",
  "kind": "quote",
  "timestamp": "2026-06-14T13:00:00.000Z",
  "price": 200.12,
  "volume": 152300
}
```

Expected response:

```json
{ "accepted": true, "normalized": true }
```

Error example:

```json
{ "error": "MISSING_TIMESTAMP", "accepted": false }
```

## Signal Created Webhook

Path: `/webhooks/signal-created`

Required fields:

- `signal_id`
- `symbol`
- `asset_type`
- `strategy_name`
- `direction`

Optional fields:

- `market_context.alpaca_quote`
- `market_context.twelve_data_quote`
- `market_context.provider_degraded`
- `market_context.volatility_pct`
- `market_context.alpaca_quote.timestamp`
- `market_context.twelve_data_quote.timestamp`
- `market_context.alpaca_quote.received_at`
- `market_context.twelve_data_quote.received_at`

The control plane will reject stale or invalid provider timestamps and will fail closed when Alpaca and Twelve Data disagree beyond the confirmation thresholds.
When the ingest payload includes enough real price movement and the provider confirmation is clean, the server can promote the ingest into a scored signal and paper-order request.

## Risk Decision Webhook

Path: `/webhooks/risk-decision`

Required fields:

- `signal_id`
- `decision`
- `reason_codes`

## Human Approval Webhook

Path: `/webhooks/human-approval`

Actions:

- `approve_for_paper`
- `reject`
- `downgrade_to_alert`
- `pause_strategy`
- `add_note`
- `request_more_research`

## Paper Order Request Webhook

Path: `/webhooks/paper-order-request`

Required fields:

- `request_id`
- `signal_id`
- `symbol`
- `side`
- `order_type`

Optional fields:

- `position_size_multiplier`
- `policy_snapshot`
- `normalized_quantity`

## Daily Summary Webhook

Path: `/webhooks/daily-summary`

Expected payload:

```json
{
  "date": "2026-06-14",
  "total_signals": 1,
  "approved_for_paper": 1,
  "blocked_by_risk": 0
}
```

## Paper Outcome Webhook

Path: `/paper-outcomes`

Required fields:

- `original_signal`
- `paper_result`
- `entry_price`
- `exit_price`
- `high_price`
- `low_price`
- `quantity`
- `side`

Expected response:

```json
{
  "accepted": true,
  "outcome": {
    "pnl": 5,
    "win_loss": "win",
    "calibration_bucket": "80-89"
  }
}
```

## Daily Live Results Endpoint

Path: `/daily-live-results`

Expected response includes:

- `signal_count`
- `blocked_count`
- `approved_count`
- `paper_pnl`
- `drawdown`
- `false_positives`
- `best_signal`
- `worst_signal`
- `top_block_reasons`
- `calibration_buckets`
- `best_calibration_bucket`
- `worst_calibration_bucket`

## Tuning Endpoint

Path: `/performance/tuning`

Returns the daily report plus calibration buckets and suggested tuning notes.

It also includes a `threshold_proposal` object with recommended adjustments for:

- `minConfidenceForPaper`
- `minFreshnessScore`
- `minSourceQualityScore`
- `minProviderConfirmationScore`
- `minEdgeScore`
- `maxContradictionScore`
- `maxRiskScore`
- `minLiquidityScore`
- `maxOpenPositions`
- `positionSizeMultiplier`

## Live Policy Snapshot

Path: `/risk-policy`

GET returns the current live policy snapshot.

POST stores a new live policy snapshot so the running process can use the latest tuned thresholds on the next restart or sync.

## Policy Refresh

Path: `/policy-refresh`

POST refreshes the live policy from the current learning signals, including rejection pressure, dominant block reasons, calibration buckets, and outcome history.

The server can also trigger the same refresh automatically once enough learning evidence has accumulated.

## Policy Effectiveness

Path: `/policy-effectiveness`

GET returns policy intervals with outcome attribution so you can see which live threshold sets helped or hurt after adoption.
The response also includes a `recommended_position_size_multiplier` for the current best interval.

## Policy Rollback

Path: `/policy-rollback`

POST restores the best historical policy snapshot from the stored effectiveness history when the current policy starts underperforming.

## Policy Size Rebalance

Path: `/policy-size-rebalance`

POST adjusts the live `positionSizeMultiplier` using effectiveness history when the current policy is still usable but the sizing is too aggressive or too conservative.

Expected response includes:

- `accepted`
- `policy_snapshot`
- `reason_codes`

## Walk-Forward Comparison Endpoint

Path: `/walk-forward-comparison`

Required fields:

- `fixtures`

Optional fields:

- `baseline_policy`
- `date`

Expected response includes:

- `baseline`
- `tuned`
- `delta`
- `winner`
- `recommendation`

## Error Alert Webhook

Path: `/webhooks/error-alert`

Required fields:

- `event_type`
- `message`
- `trace_id`

## Idempotency

If the same request id is received twice, the control plane should return the existing record instead of creating a duplicate.
