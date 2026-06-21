# Trading Automation Control Plane

This repository is a paper-first trading control plane with a direct-running execution service.

## What It Does

- Normalizes market data into one internal schema.
- Scores signals with deterministic freshness, contradiction, source-quality, and risk-aware checks.
- Uses those quality scores in the hard risk gate so weak signals are blocked earlier.
- Blocks unsafe candidates with a deterministic risk gate.
- Can send approved orders to Alpaca when explicitly enabled with credentials and an Alpaca base URL.
- Routes approved paper candidates into a paper-trade adapter boundary.
- Records audit events, daily metrics, review items, and replay runs.
- Keeps a paper-outcome feedback loop with calibration buckets and daily live-results reporting.
- Produces tuning proposals from observed paper outcomes.
- Exposes direct HTTP ingest endpoints and a small JSON API surface.

## Safety Model

- Paper mode is the default.
- Live trading is disabled by default.
- Human approval is required by default.
- Risk enforcement is deterministic code, not an LLM prompt.
- The paper adapter remains the default execution boundary; Alpaca is opt-in when explicitly enabled.

## Architecture

Market data providers
-> normalization
-> research and signal scoring
-> deterministic risk gate
-> human review
-> paper trade adapter
-> order lifecycle tracking
-> audit log
-> daily metrics
-> direct HTTP control service

## Main Modules

- `src/market-data.js`: symbol normalization, freshness checks, provider metadata, validation.
- `src/signals.js`: signal scoring, contradiction checks, decision shaping.
- `src/risk-gate.js`: deterministic paper-approval gate with reason codes.
- `src/paper-adapter.js`: in-memory paper order lifecycle, idempotency, fills, reconciliation.
- `src/audit.js`: event recording and JSONL audit support.
- `src/metrics.js`: daily summaries and performance breakdowns.
- `src/feedback-loop.js`: paper outcome storage, daily reports, and tuning suggestions.
- `src/performance-tuning.js`: deterministic threshold proposals from paper results.
- `src/review.js`: operator review payloads.
- `src/replay.js`: replay runner for historical or fixture-driven checks.
- `src/reliability.js`: retries, circuit breaking, provider health, and dead-letter records.
- `src/server.js`: direct HTTP control and webhook endpoints.

## Safe Defaults

The repo ships with these defaults:

- `TRADING_MODE=paper`
- `LIVE_TRADING_ENABLED=false`
- `REQUIRE_HUMAN_APPROVAL=true`
- `AUDIT_LOG_ENABLED=true`
- `PAPER_ADAPTER_ENABLED=true`
- `MIN_CONFIDENCE_FOR_PAPER=72`
- `MIN_LIQUIDITY_SCORE=40`
- `MIN_PROVIDER_CONFIRMATION_SCORE=70`
- `MIN_EDGE_SCORE=60`
- `MAX_STALENESS_SECONDS=60`
- `MAX_OPEN_POSITIONS=12`
- `AUTO_POLICY_REFRESH=false`
- `AUTO_POLICY_REFRESH_MIN_BLOCKED_COUNT=2`
- `AUTO_POLICY_REFRESH_MIN_REJECTION_PRESSURE_SCORE=50`
- `AUTO_POLICY_REFRESH_MIN_PAPER_OUTCOMES=1`
- `ALPACA_EXECUTION_ENABLED=false`

The config loader rejects unsafe live-trading combinations.
See [.env.example](/C:/Users/dtoro/OneDrive/Documents/N8N/.env.example) for the current paper-first defaults and live-gate thresholds.
If you want Alpaca activity, set `ALPACA_EXECUTION_ENABLED=true` and provide `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, and `ALPACA_API_BASE_URL`.

## Running Tests

```bash
node --test
```

The test run also executes a case-sensitive import check so Windows-only path casing mistakes get caught before CI merges.
You can run the same gate explicitly with `npm run ci`.

## Starting The Trader

```bash
npm start
```

## Local Dashboard

```bash
npm run dashboard
```

The dashboard is read-only and starts on `http://127.0.0.1:1111` when free, or the next available local port if `1111` is already occupied. It reads the existing trader endpoints and local history files without changing any execution behavior.
It also opens your browser automatically when launched from `npm run dashboard`, unless you disable that with `DASHBOARD_OPEN_BROWSER=false`.
For a one-double-click launch on Windows, use [`start-dashboard.cmd`](/C:/Users/dtoro/OneDrive/Documents/N8N/start-dashboard.cmd).

For the dedicated standalone entrypoint, use:

```bash
npm run trader
```

By default, the server writes paper-history JSONL to `data/performance-history.jsonl` so the feedback loop can survive restarts.
Set `PERFORMANCE_HISTORY_PATH` to change the file location, or `PORT` / `SERVER_PORT` to change the listening port.
The server keeps the live policy snapshot at `data/live-policy.json` by default, or `LIVE_POLICY_PATH` if set.
It also stores policy history in `data/policy-history.jsonl` by default, or `POLICY_HISTORY_PATH` if set.
Use `MIN_PROVIDER_CONFIRMATION_SCORE`, `MIN_EDGE_SCORE`, `MAX_STALENESS_SECONDS`, `MAX_OPEN_POSITIONS`, and the `AUTO_POLICY_REFRESH*` settings to control how strict the live gate is before a signal can reach paper approval and how quickly the policy learns from outcomes and rejections. `MAX_OPEN_POSITIONS` now seeds the live startup policy, so the running service inherits your chosen concurrency target instead of falling back to the old tighter cap.

To have it start automatically when you log in on Windows, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/startup-install.ps1
```

That creates a launcher in your Windows Startup folder and reads `.env.local` if present.
The startup script also writes a transcript to `data/logs/trader-startup.log` so you can inspect launch issues after the fact.
The running service also keeps a durable overnight snapshot at `data/logs/overnight-status.json` by default.
It writes an initial startup snapshot right away, then keeps refreshing it while the server is idle.
That snapshot is refreshed periodically while the server is idle so the file stays current even when no requests are coming in.
It includes `started_at` and `uptime_minutes` so you can tell how long the run has been alive.
It also includes request and heartbeat counters so you can see whether the system has been active or only idling.
You can print that snapshot at any time with `npm run status:overnight`, which also flags whether the file is fresh or stale.

To remove that startup launcher later:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall-startup.ps1
```

To refresh that policy from the stored paper history:

```bash
npm run tune:policy
```

The direct service accepts either the legacy compatibility paths or the simpler direct paths:

- `POST /signal` or `POST /signals`
- `POST /market-ingest`
- `POST /paper-order`
- `POST /paper-fill`
- `POST /risk-decision`
- `GET /status`

The paper-order intake path carries the live `positionSizeMultiplier` into normalized order requests so downstream sizing follows the active policy.
`POST /market-ingest` can normalize real provider data, score it, and create a paper-order request when Alpaca and Twelve Data confirmation is strong enough.

## Replay Mode

Replay runs use the same normalization, scoring, and risk gate logic as the paper flow.
Daily live-results reports include blocked counts, approved counts, paper PnL, drawdown, false positives, and best/worst outcomes.
They also include the live `recommended_max_open_positions` target so you can see the current capacity recommendation alongside the rest of the daily rollup.
They also include calibration-bucket performance so you can see which confidence ranges are winning or losing.

```bash
node src/replay-cli.js examples/replay-fixture.json
```

## Optional Compatibility

If you still route events through an external orchestrator, the server accepts the legacy compatibility paths:

- `/webhooks/market-ingest`
- `/webhooks/research-completed`
- `/webhooks/signal-created`
- `/webhooks/risk-decision`
- `/webhooks/human-approval`
- `/webhooks/paper-order-request`
- `/webhooks/paper-fill-event`
- `/webhooks/daily-summary`
- `/webhooks/error-alert`

That compatibility layer is optional. The direct service does not require the orchestrator.

## Feedback Loop

The local API exposes:

- `POST /paper-outcomes` to ingest a paper result
- `GET /daily-live-results` to retrieve the current report
- `GET /performance/tuning` to retrieve tuning suggestions and calibration buckets
- `GET /risk-policy` to inspect the current live policy snapshot
- `POST /policy-refresh` to refresh the live policy from the latest rejection-aware learning signals
- `GET /policy-effectiveness` to inspect whether each policy snapshot helped or hurt after adoption
- `POST /risk-policy` to store a new live policy snapshot
- `POST /policy-rollback` to restore the best historical policy snapshot when performance deteriorates
- `POST /policy-size-rebalance` to adjust the live position-size multiplier from effectiveness history
- `POST /policy-capacity-rebalance` to adjust the live open-position cap from effectiveness history
- `POST /walk-forward-comparison` to compare baseline and tuned policies on the same replay set

The server can also refresh the policy automatically after enough blocked decisions, outcomes, or rejection pressure accumulate, so the live gate keeps learning without a manual operator step.

The tuning output now includes a proposed policy snapshot that can tighten or relax confidence, freshness, source-quality, contradiction, and signal-risk thresholds based on observed paper results.
It also carries provider-confirmation and edge-score floors so weak multi-source agreement does not silently expand risk.
The walk-forward comparison shows whether the tuned policy actually improves paper PnL, drawdown, and false positives relative to baseline.
If no replay fixtures are posted, the comparison can fall back to stored paper history captured by the performance store.
If you pass `performanceHistoryPath` when creating the server, the performance store will persist signals, decisions, outcomes, and events to JSONL so restarts can keep using the same history.
If you pass `policyPath` when creating the server, the live policy snapshot is written to disk and can be refreshed with the tuning CLI.
If you need to widen or reduce how many positions can be open at once, `POST /policy-capacity-rebalance` will apply the current learning recommendation from the stored effectiveness history.
If you need an emergency retreat, `POST /policy-rollback` will restore the best historical live policy from the stored effectiveness history.

## Before Any Live Trading

You would still need:

- A verified broker integration with explicit live flags.
- Human approval gates for live turns.
- Real portfolio reconciliation.
- Production monitoring and incident response.
- End-to-end live safety review.
