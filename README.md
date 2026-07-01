# Trading Automation Control Plane

This repository is a simplified Live Market trading control plane with a direct-running execution service and a local dashboard.

## What It Does

- Runs one visible workflow: Live Market stock trading.
- Approved symbols are sourced from the live policy snapshot in `data/live-policy.json`; `STOCK_SCANNER_SYMBOLS` seeds that snapshot at startup: `SPCX`, `SMCI`, `FDX`, `MU`, `APGE`, `NVDA`, `IBM`, `INTC`, `MRVL`, `MARA`, `IREN`, `GOOGL`, `FCEL`, `CBRS`, `VIX`, `AMO`, `SNDK`, `VTAK`.
- Uses live Alpaca positions, open orders, account buying power, and Daily Change as the source of truth.
- Holds at most two open positions.
- Buys up to `$150` per position and refuses dust buys below `$25`.
- Uses the configured stop and trail rules from `POSITION_STOP_LOSS_DOLLARS`, `POSITION_STOP_LOSS_NOTIONAL_PCT`, `POSITION_STOP_LOSS_MAX_DOLLARS`, `TRAILING_PROFIT_START_DOLLARS`, and `TRAILING_PROFIT_GIVEBACK_DOLLARS`.
- Keeps a local dashboard focused on the few numbers that matter.

## Safety Model

- Safe example config is the default.
- Live trading still requires local `.env.local` credentials and explicit enablement.
- Risk enforcement is deterministic code, not an LLM prompt.
- The operator dashboard does not include manual trade controls such as buy, sell, liquidate, close position, or cancel order.

## Feature Activation Model

- Meme Monitor and Regular Watch each split controls into runtime-only display toggles, two-key toggles that need both config allowment and a dashboard toggle, source toggles that can be validated at runtime, and locked controls that stay disabled.
- The dashboard Actions tab shows each feature's category, config allowment, runtime toggle, effective state, and any block reason so you can see why something is on or off.
- Auto Action remains locked until a safe implementation path exists.

## Watch Tab

- The Watch tab always uses four columns: `Regular Watch List`, `Regular Watch Movers List`, `Dynamic Hot List From Alerts`, and `Hot Hot List`.
- The tab shows which sources contributed to each ticker, along with status, score, freshness, spread, and rotation or priority context when available.
- The watch snapshot is contract-stable, so operators can compare what the scanner saw with what the dashboard rendered.

## Actions Tab

- The Actions tab shows feature state, source state, and runtime health in one place.
- Each row carries status, effective state, block reasons, and last error context when available.
- The dashboard shows controls for feature toggles and safe workflow actions, but it never exposes manual trade execution buttons.

## Meme Monitor

- Meme Monitor is source-driven and degrades one source at a time.
- It reads active sources from config and runtime state, validates each source before scanning, and marks missing or inaccessible sources inactive with a reason.
- Reddit collection, Phase A sources, and Phase B sources all mark failures as inactive instead of crashing the monitor.
- The monitor preserves source-level reasons so the dashboard can explain why a source is off.

## Reddit Source Tiers

- Tier 1 is the highest-heat default set and should carry the heaviest heat-score weight.
- Tier 2 is broader market chatter and contributes meaningful but lower-weight signal.
- Tier 3 is context-only unless market confirmation is strong.
- Ticker-specific communities help with known meme names, but they should not create Hot Hot status on their own.
- Optional high-noise sources stay disabled by default unless explicitly enabled.

## Phase A Confirmation Sources

- Phase A combines Reddit with Alpaca market, Alpaca assets, Nasdaq halts, and SEC EDGAR confirmation.
- Each source can fail independently, and the runtime records the inactive reason instead of crashing.
- Missing credentials, private communities, quarantines, bans, inaccessible sources, and rate limits are expected failure modes.

## Phase B Confirmation Sources

- Phase B adds StockTwits, Polygon, and Alpha Vantage confirmation.
- Phase B should keep running even when one or more confirmation providers are down or rate-limited.
- The dashboard source-health view shows the provider state with redacted error text.

## Dynamic Hot List vs Hot Hot List

- The Dynamic Hot List is the broader meme-alert list.
- The Hot Hot List is the stronger confirmation list used for higher urgency and priority override.
- A ticker can appear in the dynamic list without being strong enough for Hot Hot treatment.

## Dynamic Watchlist

- The dynamic watchlist is the scanner-facing symbol set that can be expanded from alert flow.
- The watch tab shows which symbols entered through meme alerts, regular watch, or approved-symbol policy.
- Dynamic watchlist entries should stay visible even when the source that created them has gone stale.

## Priority Override

- Priority override can boost ranking, but it does not fabricate confirmation.
- Hot Hot status can influence ranking and slot selection, but it should still respect safety and market context.
- Ticker-specific communities and noisy sources should not auto-promote a ticker without stronger support.

## Hot Slot Rotation

- Hot slot rotation only replaces a slot when the replacement meets the breakeven-or-better safety rules.
- Rotation must respect the configured loss floor, timeout, and runner-protection rules.
- The rotation state should show whether a candidate was skipped, replaced, or protected.

## Regular Watch Intelligence

- Regular Watch uses market confirmation, asset validation, halt checks, SEC risk checks, news/catalyst context, priority scoring, scanner ranking, and position awareness.
- `REGULAR_WATCH_PRIORITY_SCORING_ENABLED`, `REGULAR_WATCH_SCANNER_RANKING_ENABLED`, and `REGULAR_WATCH_POSITION_AWARENESS_ENABLED` remain gated by effective state, not just runtime intent.
- Regular Watch should keep the output readable even when some sources are unavailable.

## External Source Health

- The dashboard source-health summary exposes active, inactive, and error states for both meme-monitor and regular-watch sources.
- A single bad provider must not crash the scanner.
- Error text should be redacted so secrets do not leak into the dashboard.

## Cache / Timeout / Redaction

- Reddit and external source fetches use the shared source-fetch path with cache helpers and timeout handling.
- Source validation should prefer cached results when they are still fresh.
- Error payloads must stay short, redacted, and operator-safe.

## Safe Defaults

- Dangerous and influence-heavy flags default to `false`.
- `MEME_AUTO_ACTION_ENABLED` stays locked off.
- Optional high-noise sources are disabled by default.
- Hot Slot Rotation uses breakeven-safe defaults.
- Regular Watch scanner ranking and position awareness stay off until explicitly enabled.
- The repo ships with safe defaults in `.env.example` and no secrets.

## Architecture

Market data providers
-> normalization
-> research and signal scoring
-> deterministic risk gate
-> human review
-> Alpaca execution adapter when explicitly enabled
-> order lifecycle tracking
-> audit log
-> daily metrics
-> direct HTTP control service

## Main Modules

- `src/market-data.js`: symbol normalization, freshness checks, provider metadata, validation.
- `src/signals.js`: signal scoring, contradiction checks, decision shaping.
- `src/risk-gate.js`: deterministic approval gate with reason codes.
- `src/alpaca-adapter.js`: Alpaca execution adapter for explicitly enabled live operation.
- `src/audit.js`: event recording and JSONL audit support.
- `src/metrics.js`: daily summaries and performance breakdowns.
- `src/feedback-loop.js`: local outcome storage, daily reports, and tuning suggestions.
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
- `PAPER_ADAPTER_ENABLED=true` as the execution-adapter safety gate required for live mode.
- `MIN_CONFIDENCE_FOR_PAPER=72`
- `MIN_LIQUIDITY_SCORE=40`
- `MIN_PROVIDER_CONFIRMATION_SCORE=70`
- `MIN_EDGE_SCORE=60`
- `MAX_STALENESS_SECONDS=60`
- `MAX_OPEN_POSITIONS=2`
- `BUY_NOTIONAL_TARGET=150`
- `MIN_BUY_NOTIONAL=25`
- `STOCK_SCANNER_SYMBOLS=SPCX,SMCI,FDX,MU,APGE,NVDA,IBM,INTC,MRVL,MARA,IREN,GOOGL,FCEL,CBRS,VIX,AMO,SNDK,VTAK` seeds the approved list that gets written into `data/live-policy.json` at startup.
- `STOCK_SCANNER_EXCLUDED_BUY_SYMBOLS=` can temporarily block new buys for symbols while still allowing sell/exit management if they are already held.
- `STOCK_SCANNER_MIN_ADJUSTED_RANK_SCORE=0`
- `STOCK_SCANNER_RECENT_STOP_EXIT_PENALTY_MINUTES=30`
- `STOCK_SCANNER_RECENT_STOP_EXIT_RANK_PENALTY=80`
- `STOCK_SCANNER_SPREAD_RANK_PENALTY_THRESHOLD_PCT=0.75`
- `STOCK_SCANNER_SPREAD_RANK_PENALTY_PER_PCT=25`
- `STOCK_SCANNER_SPREAD_RANK_PENALTY_CAP=80`
- `STOCK_SCANNER_OPENING_NOISE_MINUTES=5`
- `STOCK_SCANNER_NEAR_CLOSE_MANAGE_ONLY_MINUTES=15`
- `STOCK_SCANNER_VOLATILITY_STOP_ENABLED=false`
- `STOCK_SCANNER_MARKET_QUALITY_RANKING_ENABLED=false`
- `POSITION_STOP_LOSS_DOLLARS=1`
- `POSITION_STOP_LOSS_NOTIONAL_PCT=0.75`
- `POSITION_STOP_LOSS_MAX_DOLLARS=2.5`
- `RISK_BUDGET_SIZING_ENABLED=false`
- `MAX_RISK_PER_TRADE_DOLLARS=0`
- `MAX_RISK_PER_TRADE_PCT_EQUITY=0`
- `MAX_TRADE_NOTIONAL=0`
- `MIN_STOP_DISTANCE_DOLLARS=0.01`
- `MAX_STOP_DISTANCE_DOLLARS=0`
- `ALLOW_RISK_BUDGET_FRACTIONAL_SHARES=false`
- `RISK_BUDGET_REQUIRE_BROKER_EQUITY=true`
- `TRAILING_PROFIT_START_DOLLARS=0.5`
- `TRAILING_PROFIT_GIVEBACK_DOLLARS=0.3`
- `AUTO_POLICY_REFRESH=false`
- `AUTO_POLICY_REFRESH_MIN_BLOCKED_COUNT=2`
- `AUTO_POLICY_REFRESH_MIN_REJECTION_PRESSURE_SCORE=50`
- `AUTO_POLICY_REFRESH_MIN_PAPER_OUTCOMES=1`
- `ALPACA_EXECUTION_ENABLED=false`

The config loader rejects unsafe live-trading combinations. Risk-budget sizing and structure-aware stop selection are optional and disabled by default; when disabled, the scanner keeps the fixed-notional sizing path.
See [.env.example](./.env.example) for safe defaults. For local live operation, `.env.local` should set `TRADING_MODE=live`, `LIVE_TRADING_ENABLED=true`, `ALPACA_EXECUTION_ENABLED=true`, and the Alpaca credentials/base URL.

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

The dashboard starts on `http://127.0.0.1:1111` when free, or the next available local port if `1111` is already occupied. It reads the existing trader endpoints and local history files without changing execution behavior, and it exposes operational controls plus feature toggles without manual trade buttons.
It also opens your browser automatically when launched from `npm run dashboard`, unless you disable that with `DASHBOARD_OPEN_BROWSER=false`.
For a one-double-click launch on Windows, use [start-dashboard.cmd](./start-dashboard.cmd).
If you want to pin a different local dashboard port, set `TRADER_DASHBOARD_PORT` in your environment. The dashboard still defaults to `1111`.
The Watch tab now shows which source groups contributed to each symbol, and the source-health summary keeps meme-monitor and regular-watch source states visible in one place.

For the dedicated standalone entrypoint, use:

```bash
npm run trader
```

By default, the server writes local execution-history JSONL to `data/performance-history.jsonl` so the feedback loop can survive restarts.
Set `PERFORMANCE_HISTORY_PATH` to change the file location, or `PORT` / `SERVER_PORT` to change the listening port.
The server keeps the live policy snapshot at `data/live-policy.json` by default, or `LIVE_POLICY_PATH` if set.
It also stores policy history in `data/policy-history.jsonl` by default, or `POLICY_HISTORY_PATH` if set.
Use `MIN_PROVIDER_CONFIRMATION_SCORE`, `MIN_EDGE_SCORE`, `MAX_STALENESS_SECONDS`, `MAX_OPEN_POSITIONS`, and the `AUTO_POLICY_REFRESH*` settings to control how strict the live gate is before a signal can reach approval and how quickly the policy learns from outcomes and rejections. `MAX_OPEN_POSITIONS` now seeds the live startup policy, so the running service inherits your chosen concurrency target instead of falling back to an old cap.
The mobile/Tailscale helper commands live in `scripts/start-mobile-dashboard.ps1`, `scripts/serve-dashboard-tailscale.ps1`, and `scripts/check-mobile-dashboard.ps1`. They keep the dashboard private to your laptop plus tailnet devices and never require Funnel.

To have it start automatically when you log in on Windows, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/startup-install.ps1
```

That creates a launcher in your Windows Startup folder and reads `.env.local` if present.
The startup script also writes a transcript to `data/logs/trader-startup.log` so you can inspect launch issues after the fact.
The running service also keeps local status snapshots under `data/logs/` so the dashboard can show freshness, uptime, request count, and heartbeat state even after restarts.

To remove that startup launcher later:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/uninstall-startup.ps1
```

To refresh that policy from stored local history:

```bash
npm run tune:policy
```

The direct service accepts either the legacy compatibility paths or the simpler direct paths:

- `POST /signal` or `POST /signals`
- `POST /market-ingest`
- `POST /paper-order` compatibility intake
- `POST /paper-fill` compatibility fill intake
- `POST /risk-decision`
- `GET /status`

The compatibility order intake path carries the live `positionSizeMultiplier` into normalized order requests so downstream sizing follows the active policy.
`POST /market-ingest` can normalize real provider data, score it, and create an order request when Alpaca and Twelve Data confirmation is strong enough.

## Replay Mode

Replay runs use the same normalization, scoring, and risk gate logic as the live-market flow.
Daily live-results reports include blocked counts, approved counts, local-history PnL, drawdown, false positives, and best/worst outcomes.
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

- `POST /paper-outcomes` compatibility intake for a recorded result
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

The tuning output now includes a proposed policy snapshot that can tighten or relax confidence, freshness, source-quality, contradiction, and signal-risk thresholds based on observed local results.
It also carries provider-confirmation and edge-score floors so weak multi-source agreement does not silently expand risk.
The walk-forward comparison shows whether the tuned policy actually improves local-history PnL, drawdown, and false positives relative to baseline.
If no replay fixtures are posted, the comparison can fall back to stored history captured by the performance store.
If you pass `performanceHistoryPath` when creating the server, the performance store will persist signals, decisions, outcomes, and events to JSONL so restarts can keep using the same history.
If you pass `policyPath` when creating the server, the live policy snapshot is written to disk and can be refreshed with the tuning CLI.
If you need to widen or reduce how many positions can be open at once, `POST /policy-capacity-rebalance` will apply the current learning recommendation from the stored effectiveness history.
If you need an emergency retreat, `POST /policy-rollback` will restore the best historical live policy from the stored effectiveness history.

## Before Market Open

- Confirm Alpaca shows the expected cash and zero or known open positions.
- Confirm the dashboard Home page says `Live Market`, max positions `2`, buy cap `$150`, and workflow `stopped`.
- Start the workflow only during regular US market hours.
- Watch that only one trader and one stock scanner run.
- Confirm the approved symbol list comes from `STOCK_SCANNER_SYMBOLS` and the live policy snapshot in `data/live-policy.json`.

## Operator Do-Not-Do List

- Do not enable auto action unless the implementation path is safe and reviewed.
- Do not use manual buy, sell, liquidate, close position, or cancel-order controls from the dashboard, because they are intentionally not provided.
- Do not assume a single source is enough when source health is degraded.
- Do not treat tier 3 or ticker-specific chatter as Hot Hot by itself.
- Do not forget to verify the live policy snapshot before market open.

## Daily Automation

This repo now includes a repo-local weekday automation that uses the dashboard control API to start the live-market workflow at `8:30 AM America/New_York` and stop it at `4:15 PM America/New_York`.

To register the Windows scheduled tasks:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-live-market-automation.ps1
```

To remove them later:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall-live-market-automation.ps1
```

The automation skips US market holidays when the holiday calendar helper is available, and it never trades manually or changes strategy settings.
