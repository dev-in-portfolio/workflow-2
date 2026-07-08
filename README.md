# Trading Automation Control Plane

This repository is a **local Live Market trading automation control plane** built in Node/CommonJS. It runs a direct local trading service, a stock scanner, a dashboard/operator control plane, and safety workflows around Alpaca paper/live execution.

This is **not** a simple webhook bot, not an n8n workflow, not a TradingView-only bridge, and not a Python/agentic portfolio project.

The codebase contains meaningful trading-path safety controls, including deterministic risk gates, broker reconciliation, open-order conflict checks, partial-fill state handling, Alpaca idempotency, live preflight checks, source-health handling, scanner guards, and a broad test suite.

The main remaining safety concern is **not “missing risk logic.”** The main remaining concern is **control-plane hardening**: local HTTP endpoints, dashboard POST routes, process-control actions, policy mutation routes, scanner feature toggles, Tailscale/mobile exposure, request size/rate limits, endpoint authorization, and activation discipline.

---

## Read This First: Code Is the Source of Truth

The README is only an operator guide. The actual runtime behavior is defined by the code.

Important correction:

- The dashboard is **not just a passive viewer**.
- The dashboard intentionally avoids manual trade buttons such as buy, sell, liquidate, close position, or cancel order.
- However, the dashboard can still expose privileged control-plane behavior, including workflow/trader/scanner process controls and scanner/source feature mutations.
- Therefore, “no manual trade buttons” does **not** mean “read-only.”

Treat the dashboard, local HTTP APIs, scanner activation, feature toggles, policy mutation routes, and Tailscale/mobile helper scripts as privileged control-plane surfaces.

---

## Execution Mode Integrity

Workflow 2 supports paper execution and live execution. The selected execution mode is an operator decision and must be treated as runtime intent, not as a suggestion.

Paper mode is for explicit testing and validation. It is not an automatic fallback for a session that was configured for a different execution mode.

If the selected mode is not safe, complete, or internally consistent, the correct behavior is to **fail closed with a clear blocking reason**. The system must not silently rewrite the execution mode to paper as a safety substitute.

Required behavior:

```text
selected mode + valid configuration = proceed through the selected-mode path
selected mode + invalid configuration = hard stop with blocking reason
selected mode + configuration mismatch = hard stop with blocking reason
uncertain operator intent = do not mutate mode automatically
```

Forbidden behavior:

```text
silently changing the selected execution mode
silently replacing operator-reviewed local config with example defaults
using paper mode to hide a failed live-mode preflight
making tests pass by changing runtime intent from one mode to another
assuming example defaults are runtime authority over local operator config
```

Safety controls should block unsafe operation. They should not disguise one execution mode as another.

This rule applies to humans, Codex, automated agents, docs, tests, scripts, and generated patches.

---

## Current Verdict

Workflow 2 is a strong local trading-control-plane foundation with real deterministic safety controls already present.

It should be treated as **local and operator-controlled**. Live operation requires explicit local configuration and green live preflight. Paper operation is explicit testing mode and must not be used as an automatic fallback when a different execution mode was selected.

Before meaningful live-money use, the control plane needs explicit hardening around:

- dashboard/API authentication
- route-level authorization
- signed or token-protected order-triggering routes
- request body size limits
- route rate limits
- audit events for every dashboard/control POST
- policy mutation confirmation and rollback discipline
- Tailscale/mobile exposure rules
- operator runbooks
- alerting/monitoring

---

## What It Does

The system currently focuses on one visible workflow:

- **Live Market stock trading** through a local trader service and stock scanner.
- Approved symbols are seeded from `STOCK_SCANNER_SYMBOLS` and written into the live policy snapshot at `data/live-policy.json`.
- Alpaca positions, open orders, account buying power, and Daily Change are treated as source-of-truth inputs for local decisions.
- Default operating limits are intentionally small:
  - max open positions: `2`
  - target buy notional: `$150`
  - minimum buy notional floor: `$25`
- Stop/trailing behavior is configured through:
  - `POSITION_STOP_LOSS_DOLLARS`
  - `POSITION_STOP_LOSS_NOTIONAL_PCT`
  - `POSITION_STOP_LOSS_MAX_DOLLARS`
  - `TRAILING_PROFIT_START_DOLLARS`
  - `TRAILING_PROFIT_GIVEBACK_DOLLARS`

---

## What It Is Not

This repo is not:

- a generic Alpaca wrapper
- a one-file hobby trading script
- a TradingView-only webhook forwarder
- an n8n automation
- a Python agentic trading repo
- a dashboard-only viewer
- a safe-to-expose public web app

It is closer to a local mini trading control plane: signal/scanner input, broker-aware checks, deterministic risk gating, explicit paper/live adapter paths, dashboard/operator controls, policy state, source health, and audit/history files.

---

## Core Trading Path

The main order path is code-driven and should be understood as:

```text
HTTP route or scanner candidate
  -> signal processing / payload normalization
  -> broker portfolio reconciliation
  -> deterministic risk gate
  -> order build
  -> pending partial-fill conflict check
  -> open-order conflict check
  -> selected execution adapter
  -> broker/paper confirmation
  -> partial-fill state update
  -> outcome/audit/event recording
```

The selected execution adapter must follow the operator-selected mode. If the selected mode cannot pass its required checks, the session should stop with a blocking reason instead of being silently converted to another mode.

This path is substantially safer than a raw “webhook to broker” design, but it still depends on protecting the local endpoints that can enter or influence the path.

---

## Existing Safety Architecture

The codebase includes meaningful safety controls, including:

- deterministic risk gate with reason codes
- kill switch support
- max daily loss controls
- max position notional controls
- max open position controls
- max trades/day controls
- exposure checks
- liquidity/freshness/source-quality checks
- stale signal rejection
- provider confirmation requirements
- stop-loss / take-profit / reward-risk requirements
- human approval controls for live operation
- explicit paper/live mode gates
- broker reconciliation before risk evaluation
- broker fail-closed behavior for strict buy paths
- open-order conflict checks
- same-side and opposite-side open-order blocking
- wash-trade risk protection
- partial-fill conflict checks
- partial-fill state updates after execution
- Alpaca `client_order_id` handling
- existing-order lookup and duplicate reuse
- duplicate client-order error recovery
- Alpaca request timeout handling
- live config validation
- live preflight checks
- redaction in operator-facing output
- process locks for local trader/scanner workflow control
- source-health degradation
- shadow-only feature controls
- scanner session guards
- anti-churn state
- setup fatigue state
- execution-quality state
- candidate lifecycle state
- market-hours guards

These controls should be preserved. New work should harden the control plane around them, not assume they are absent. Safety hardening must preserve operator-selected execution mode and must never silently downgrade one mode into another.

---

## Main Remaining Risk: Control-Plane Exposure

The highest-risk area is the local HTTP/control/dashboard surface.

The system exposes local endpoints and dashboard APIs that can:

- ingest signals
- ingest market data
- accept legacy paper-order compatibility requests
- refresh policy
- store new policy snapshots
- roll back policy
- rebalance size/capacity
- start/stop/restart workflow components
- start/stop trader
- start/stop scanner
- mutate Meme Monitor feature state
- mutate Regular Watch feature state
- run Meme/Regular Watch actions
- expose runtime snapshots and process state

This means the dashboard and HTTP servers are privileged control-plane surfaces.

Do not expose them beyond the local machine unless you have deliberately implemented and tested authentication, authorization, request limits, route permissions, and an operator runbook.

---

## Dashboard Reality

The dashboard provides useful operator visibility, but it also exposes control behavior.

The dashboard includes static pages such as:

- Home
- Status
- Policy
- Exit Rules
- Alerts
- Watch
- Control

The dashboard APIs include areas such as:

- `/api/health`
- `/api/snapshot`
- `/api/control/state`
- `/api/control/action`
- `/api/meme/status`
- `/api/meme/features`
- `/api/meme/action`
- `/api/regular-watch/features`
- `/api/regular-watch/status`
- `/api/regular-watch/action`

The dashboard should be treated as an **operator control plane**, not a passive display page.

Recommended future hardening:

- dashboard auth token
- view-only vs operator-control vs policy-admin roles
- signed POST requests or local control token
- route-level permission matrix
- visual “view-only/control-enabled” banner
- POST audit events
- CSRF protection if browser-exposed
- no Tailscale/mobile exposure unless auth is enabled

---

## Tailscale / Mobile Dashboard Warning

The dashboard binds locally by default, typically to `127.0.0.1` on port `1111` or the next available local port.

The repo also includes helper scripts for mobile/Tailscale access, including:

- `scripts/start-mobile-dashboard.ps1`
- `scripts/serve-dashboard-tailscale.ps1`
- `scripts/check-mobile-dashboard.ps1`

The Tailscale Serve helper can expose the local dashboard port to the tailnet.

This is useful, but it changes the threat model. A local dashboard becomes a network-reachable control plane for tailnet devices.

Before using Tailscale/mobile dashboard access, require an explicit checklist:

- dashboard auth enabled
- route permissions enabled
- control POST audit enabled
- request body limits enabled
- rate limits enabled
- operator identity/owner assumption reviewed
- Tailscale Serve status checked
- Tailscale Serve disabled when not needed

Until then, treat Tailscale/mobile dashboard access as **not production-hardened**.

---

## Scanner and Candidate Flow

The stock scanner is not a simple alert poster.

It uses or coordinates:

- Alpaca market data
- Alpaca account state
- Alpaca positions
- Alpaca open orders
- optional Twelve Data confirmation
- approved symbol universe
- excluded buy symbols
- max candidates per run
- buy notional and minimum buy notional
- max open positions
- stop-loss and trailing-profit rules
- anti-churn state
- setup fatigue state
- session guards
- partial-fill state
- execution-quality state
- candidate lifecycle state
- Meme Monitor attention symbols
- Regular Watch ranking
- Regular Watch position awareness
- hot-slot rotation
- market-hours rules
- spread/rank penalties
- risk-budget sizing options
- structure-aware stops

The scanner can post built candidates into the local trader endpoint, usually through the legacy compatibility route currently named `/paper-order`. That route name is a compatibility artifact and must not be interpreted as permission to downgrade the selected execution mode.

---

## Hot Slot Rotation

Hot Slot Rotation is powerful and should remain locked/off, shadow-only, or paper-validation-first until explicitly proven.

When enabled, it can:

1. evaluate whether an existing slot should be rotated,
2. select an eviction candidate,
3. submit a sell candidate,
4. wait for exit confirmation,
5. recheck broker positions/open orders/account,
6. revalidate the replacement candidate,
7. promote the replacement through the normal risk gate.

That is a sell/reconcile/buy sequence. It is not just a display feature.

Recommended status:

- keep disabled by default
- require paper-validation branch
- require proof logs
- require manual runbook
- require endpoint auth and feature-mutation auth before broader use

---

## Feature Activation Model

Feature state should be understood in layers:

- config allowment
- runtime toggle
- effective state
- block reason
- shadow-only status
- locked/off status

Dangerous or influence-heavy features must remain locked/off or shadow-only until reviewed.

Examples that should remain carefully gated:

- `MEME_AUTO_ACTION_ENABLED`
- Dynamic Watchlist influence
- Priority Override influence
- Hot Slot Rotation
- Regular Watch scanner ranking
- Regular Watch position awareness
- risk-budget sizing
- execution-quality size multipliers
- volatility stops
- market-quality ranking

---

## Shadow-Only Validation

Shadow-only validation means a feature may collect, score, display, and explain symbols, but it must not influence:

- scanner ranking
- candidate selection
- slot rotation
- order submission
- policy mutation
- execution sizing

The operator checklist and acceptance criteria live in:

- [`docs/shadow-only-validation-runbook.md`](./docs/shadow-only-validation-runbook.md)

---

## Direct Service Routes

The direct service accepts direct and compatibility routes, including:

- `POST /signal`
- `POST /signals`
- `POST /market-ingest`
- `POST /paper-order`
- `POST /paper-fill`
- `POST /risk-decision`
- `GET /status`

Compatibility webhook-style routes include:

- `/webhooks/market-ingest`
- `/webhooks/research-completed`
- `/webhooks/signal-created`
- `/webhooks/risk-decision`
- `/webhooks/human-approval`
- `/webhooks/paper-order-request`
- `/webhooks/paper-fill-event`
- `/webhooks/daily-summary`
- `/webhooks/error-alert`

Policy/performance routes include:

- `POST /paper-outcomes`
- `GET /daily-live-results`
- `GET /performance/tuning`
- `GET /risk-policy`
- `POST /risk-policy`
- `POST /policy-refresh`
- `GET /policy-effectiveness`
- `POST /policy-rollback`
- `POST /policy-size-rebalance`
- `POST /policy-capacity-rebalance`
- `POST /walk-forward-comparison`

These routes are useful locally, but they must be protected before any network exposure. Route names containing `paper` may exist for compatibility; they must not override the operator-selected runtime mode.

---

## Running Tests

Run the test suite with:

```bash
npm test
```

Run CI-style checks with:

```bash
npm run ci
```

The package scripts include coverage across risk gate behavior, broker reconciliation, partial-fill state/integration, execution quality, Alpaca idempotency, process locks, exit protection, live preflight, dashboard controls, source health, scanner behavior, source runners, shadow-only validation, market hours, and market confirmation scoring.

Do not claim this repo has “no tests” without inspecting the test files and package scripts.

---

## Starting the Trader

```bash
npm start
```

Dedicated trader entrypoint:

```bash
npm run trader
```

The running service stores local execution/performance history and policy history under `data/` by default, including files such as:

- `data/performance-history.jsonl`
- `data/live-policy.json`
- `data/policy-history.jsonl`

Environment variables can override these paths.

---

## Local Dashboard

```bash
npm run dashboard
```

The dashboard starts on `http://127.0.0.1:1111` when free, or the next available local port if `1111` is occupied.

For Windows double-click use:

- [`start-dashboard.cmd`](./start-dashboard.cmd)

The dashboard may open the browser automatically unless disabled with:

```bash
DASHBOARD_OPEN_BROWSER=false
```

If you pin a different local dashboard port, set:

```bash
TRADER_DASHBOARD_PORT=1111
```

Security note: the dashboard exposes operator controls and feature mutation routes. Keep it local unless control-plane hardening has been completed.

---

## Local Process Control

The local process controller can:

- start workflow
- stop workflow
- restart workflow
- start trader
- stop trader
- restart trader
- start scanner
- stop scanner
- restart scanner
- switch scanner profile
- discover running trader/scanner processes
- kill detected trader/scanner PIDs
- write operator timeline events

Process locks are local filesystem locks under:

```text
data/locks/<name>.lock.json
```

They include owner, PID, hostname, timestamps, and metadata. Stale locks can be replaced.

This is suitable for a one-machine local operator model. It is not a distributed lock or professional multi-host orchestration layer.

---

## Live / Paper Mode Contract

Example defaults in `.env.example` are intentionally conservative for first-run setup and public documentation. They are not runtime authority over the operator's local configuration.

Paper-mode example defaults include:

- `TRADING_MODE=paper`
- `LIVE_TRADING_ENABLED=false`
- `REQUIRE_HUMAN_APPROVAL=true`
- `AUDIT_LOG_ENABLED=true`
- `PAPER_ADAPTER_ENABLED=true`
- `ALPACA_EXECUTION_ENABLED=false`
- `MAX_OPEN_POSITIONS=2`
- `BUY_NOTIONAL_TARGET=150`
- `MIN_BUY_NOTIONAL=25`

For local live operation, `.env.local` should be reviewed before every market session.

Live mode should require explicit local configuration, human approval where configured, confirmation phrase where configured, audit logging, adapter requirements, and broker credentials/base URL when broker execution is enabled.

Critical rule: when an execution mode has been selected, invalid configuration must produce a hard stop with a clear blocking reason. It must not produce a different-mode session.

See:

- [`.env.example`](./.env.example)

---

## Before Market Open Checklist

Before any live-market session:

- Confirm Alpaca cash, positions, and open orders.
- Confirm `.env.local` is the reviewed local runtime config and was not overwritten from `.env.example`.
- Confirm the dashboard says `Live Market` and shows expected limits.
- Confirm the workflow is stopped before activation.
- Confirm only one trader and one stock scanner are running.
- Confirm approved symbols come from the live policy snapshot.
- Run live preflight.
- Confirm no Tailscale Serve exposure unless dashboard auth is enabled.
- Confirm policy mutation routes are protected or not exposed.
- Confirm Hot Slot Rotation is locked/off unless running a dedicated paper-validation test.
- Confirm source-health state is acceptable.
- Confirm logs/operator timeline are writable.

---

## Operator Do-Not-Do List

- Do not expose dashboard/control routes to a network without authentication and route permissions.
- Do not assume Tailscale alone is a complete dashboard security layer.
- Do not enable Auto Action unless the implementation path is reviewed and proven.
- Do not enable Hot Slot Rotation outside shadow/paper-validation without a specific runbook.
- Do not mutate policy during an active session without a rollback plan.
- Do not assume “no manual trade buttons” means the dashboard cannot affect execution.
- Do not assume a single source is enough when source health is degraded.
- Do not treat tier 3 or ticker-specific chatter as Hot Hot by itself.
- Do not use live mode unless preflight is green and exposure is controlled.
- Do not silently downgrade the selected execution mode.
- Do not overwrite reviewed local runtime config with example defaults.
- Do not use paper mode as a safety substitute for a failed different-mode configuration.

---

## Daily Automation

This repo includes repo-local weekday automation that uses the dashboard control API to start the live-market workflow at `8:30 AM America/New_York` and stop it at `4:15 PM America/New_York`.

Register Windows scheduled tasks:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-live-market-automation.ps1
```

Remove them later:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall-live-market-automation.ps1
```

The automation skips US market holidays when the holiday helper is available and does not manually trade. However, because it uses dashboard/control APIs, those APIs must be treated as privileged automation surfaces. Automated start/stop scripts must preserve operator-selected runtime mode and must never convert one selected mode into another.
If `TRADING_MODE=live` is selected but live execution prerequisites are not satisfied, startup now fails closed with explicit reason codes instead of silently using paper behavior.

## Regular Stock Workflow Automation

This repo also includes a repo-local weekday automation for the regular stock workflow. It starts the trader plus stock scanner at `5:00 AM America/New_York` and stops them at `5:00 PM America/New_York`.

To register the Windows scheduled tasks:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-regular-stock-automation.ps1
```

To remove them later:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall-regular-stock-automation.ps1
```

The morning start skips US market holidays, but the stop task still runs so an already-active workflow can be shut down safely.
This regular-stock workflow automation is separate from the meme-monitor hot list. The watch UI now distinguishes displayed rank from execution score and shows the current live "waiting on" reason when no buy is placed.

---

## Recommended Next Hardening Work

Highest-priority documentation and implementation work:

1. Add dashboard/control API authentication.
2. Add route-level authorization roles:
   - view-only
   - operator-control
   - policy-admin
3. Add signed/token-protected local webhook/order-triggering routes.
4. Add request body size limits to all HTTP JSON readers.
5. Add rate limits to mutation/order/control routes.
6. Add audit events for every dashboard POST.
7. Protect policy refresh/rollback/rebalance routes with auth and confirmation.
8. Add a preflight block: no Tailscale Serve unless dashboard auth is enabled.
9. Add route permission matrix tests.
10. Add dashboard control-mode banner.
11. Keep Hot Slot Rotation locked/off until a paper-validation branch proves it.
12. Add operator runbooks for broker outage, partial fills, hot-slot rotation, dashboard exposure, and policy rollback.
13. Add explicit tests that selected-mode configuration hard-stops on invalid settings instead of downgrading into another execution mode.

---

## Development Rule

Future audits and implementation work must be source-code-first.

Do not infer a generic project structure. Do not invent files, middleware, databases, auth systems, or missing protections. Verify against the actual code, tests, package scripts, and runtime paths.

Do not treat paper mode as the safe replacement for another selected mode. Preserve operator intent and fail closed on invalid configuration rather than changing runtime mode.
