# System Improvement Plan

## Phase 0 — Quick Wins (low effort, high impact)

### 0.1 Centralize path resolution
- Move all `process.cwd()` references to a single `resolveRepoRoot()` in `util.js`.
- Create `resolveDataPath(...segments)` that all modules call instead of ad-hoc path building.
- Files: `minimal-cli.js`, `stock-scanner.js`, `trading-loop.js`, `feedback-loop.js`, `server.js`, `execution-quality-state.js`, `anti-churn-engine.js`, `setup-fatigue.js`

### 0.2 Replace config validation blocks with a schema loop
- Define an array of validation rules:
  ```js
  const RANGE_RULES = [
    { key: 'MIN_CONFIDENCE_FOR_PAPER', min: 0, max: 100 },
    { key: 'MIN_LIQUIDITY_SCORE', min: 0, max: 100 },
    // ... 12 more
  ];
  const POSITIVE_RULES = [
    'BUY_NOTIONAL_TARGET', 'MIN_BUY_NOTIONAL', 'MIN_VOLUME',
    'POSITION_STOP_LOSS_DOLLARS', 'MIN_STOP_DISTANCE_DOLLARS',
    'TRAILING_PROFIT_START_DOLLARS', 'TRAILING_PROFIT_GIVEBACK_DOLLARS',
  ];
  ```
- File: `src/config.js` (~90 lines → ~20 lines)

### 0.3 Extract risk gate decision severity map
- Replace ~40-line boolean `if` chain at `risk-gate.js:279-321` with a classification table:
  ```js
  const SEVERITY_MAP = {
    KILL_SWITCH_ENABLED: 'BLOCKED',
    MAX_OPEN_POSITIONS_EXCEEDED: 'BLOCKED',
    LOW_CONFIDENCE: 'HUMAN_REVIEW',
    LOW_FRESHNESS: 'WARNING',
    // ...
  };
  ```
- Then `decision = reasonCodes.reduce((d, c) => maxSeverity(d, SEVERITY_MAP[c] || 'WARNING'), 'APPROVED')`
- File: `src/risk-gate.js`

### 0.4 Add structured logger
- Create `src/logger.js`:
  ```js
  function createLogger(level = 'info') {
    return { info, warn, error, debug } // writes JSON to stdout + optional file
  }
  ```
- Replace `typeof options.logger === 'function'` pattern across all modules.
- Files: `stock-scanner.js`, `trading-loop.js`, `server.js`, `minimal-server.js`

### 0.5 Route if/chain → route map
- Create a route map in `server.js` and `minimal-server.js`:
  ```js
  const ROUTES = {
    'GET /health': handleHealth,
    'GET /status': handleStatus,
    'POST /paper-order': handlePaperOrder,
    // ...
  };
  ```
- One match function, one dispatch. Adding a route = one entry in map.
- Files: `src/server.js`, `src/minimal-server.js`

---

## Phase 1 — Eliminate Config Duplication

### 1.1 Create typed config sub-objects
- Add to `config.js`:
  ```js
  function buildScannerConfig(env) {
    return {
      symbols: parseSymbolList(env.STOCK_SCANNER_SYMBOLS, APPROVED_LIVE_MARKET_SYMBOLS),
      buyNotionalTarget: parseNumber(env.BUY_NOTIONAL_TARGET, 150),
      minBuyNotional: parseNumber(env.MIN_BUY_NOTIONAL, 25),
      maxOpenPositions: parseNumber(env.MAX_OPEN_POSITIONS, 2),
      // ... all scanner-specific env vars, parsed once
    };
  }
  ```
  Same for `buildRiskPolicyConfig()`, `buildScannerOptions()`, `buildAntiChurnConfig()`.

### 1.2 Inject config, don't re-read env
- `stock-scanner.js`: accept a `scannerConfig` object instead of reading env vars 100+ times at the top of `createStockScanner`.
- `minimal-cli.js`: accept the `config` object instead of re-building `startupPolicyPatch` inline.
- `risk-gate.js`: accept pre-merged `riskPolicy` instead of re-defaulting at `risk-gate.js:55-93`.

### 1.3 Collapse env-var parsing into the startup path
- Currently `stock-scanner.js` re-reads `env.STOCK_SCANNER_INTERVAL_SECONDS`, `env.STOCK_SCANNER_MAX_CANDIDATES`, etc. The caller (`scripts/start-stock-scanner.js`) already calls `loadConfig()`. Pass it through.
- Files: `scripts/start-stock-scanner.js`, `stock-scanner.js`, `scanner-runtime-state.js`

---

## Phase 2 — Decompose Monoliths

### 2.1 Split `stock-scanner.js`
- Extract modules:
  - `src/scanner/broker-fetcher.js` — `fetchStockBundle`, `fetchPositions`, `fetchOpenOrders`, `fetchAccount`, `fetchTwelveDataBundle`
  - `src/scanner/candidate-builder.js` — `buildCandidates`, `buildStockCandidateForSymbol`, scoring/pricing logic
  - `src/scanner/rank-penalties.js` — `calculateSpreadRankPenalty`, `loadRecentTradePenalties`, trade/loss/stopout penalties
  - `src/scanner/state-writer.js` — `writeRuntimeSnapshot` (currently nested, 150+ lines, 40+ parameters)
- `createStockScanner` becomes an orchestrator that calls these in sequence.

### 2.2 Split `risk-gate.js`
- Extract:
  - `src/risk/scanner-checks.js` — symbol approval, liquidity, volume, spread, volatility
  - `src/risk/portfolio-checks.js` — open positions, daily loss, exposure, buying power
  - `src/risk/signal-checks.js` — confidence, freshness, edge, contradiction, source quality
  - `src/risk/broker-checks.js` — reconciliation state, broker availability
- `evaluateRiskGate` calls each check group, collects reason codes, then applies the severity map.

### 2.3 Split `trading-loop.js` (611 lines)
- Extract modules:
  - `src/trading/signal-processor.js` — normalize + validate signal
  - `src/trading/order-builder.js` — build paper order request from signal
  - `src/trading/execution-orchestrator.js` — submit order, confirm, reconcile

### 2.4 Split test files
- `stock-scanner.test.js` (1657 lines) → one file per extracted scanner module.

---

## Phase 3 — Standardize Error Handling

### 3.1 Create Result type
- `src/result.js`:
  ```js
  function ok(value) { return { ok: true, value }; }
  function fail(error, reasonCodes = []) { return { ok: false, error, reasonCodes }; }
  ```
- Existing pattern `{ accepted: false, stage, reason_codes }` becomes `fail(new Error(msg), reasonCodes)`.

### 3.2 Consistent error propagation
- The scanner currently mixes throws, `{ accepted: false }` returns, and state mutations. Choose one pattern (recommend: return Result, never throw except at the top-level catch).
- Audit and performance store methods should return Result too, so callers don't need try/catch around every `recordEvent()` call.

### 3.3 Create error hierarchy
- `TradingError` (base) → `ConfigError`, `BrokerError`, `RiskGateError`, `ScannerError`
- Each carries `reasonCodes`, `stage`, and `symbol`.

---

## Phase 4 — State Management

### 4.1 Create Storage abstraction
- `src/storage.js`:
  ```js
  class JsonFileStore {
    constructor(root) { this.root = root; }
    async read(name) { ... }
    async write(name, data) { ... }
    async append(name, line) { ... }
  }
  ```
- Inject into modules instead of ad-hoc `fs.readFileSync`/`fs.writeFileSync`.

### 4.2 Consolidate state files into a single directory
- Currently: `data/live-policy.json`, `data/policy-history.jsonl`, `data/performance-history.jsonl`, `data/logs/*`, `data/locks/*`, `data/runtime/*`
- Create `data/state/` for all runtime state, `data/logs/` for logs, `data/history/` for JSONL history.
- Update all path resolvers to use the centralized `resolveDataPath()`.

### 4.3 Add state versioning
- Each persisted state file gets a `_version` field. On read, migrate if version is stale.
- This prevents silent corruption when the schema changes between deployments.

---

## Phase 5 — Testing & CI

### 5.1 Add linting
- `npm install --save-dev eslint` (or use `standard`).
- Add `.eslintrc.json` with minimal rules (semicolons, spacing, unused vars).
- Add `npm run lint` script, add to CI workflow.

### 5.2 Add unit tests for extracted modules
- For each extracted module (scanner checks, risk checks, signal processor), add a `test/unit/` directory with pure-function tests.
- Mock filesystem and network via dependency injection or `sinon`.

### 5.3 Integration test improvements
- The scanner tests currently hit the real file system. Use `fs.mkdtempSync` + cleanup in `after` hooks, or inject a `MemoryStore`.
- Test the risk gate severity map exhaustively: every reason code maps to expected severity.

### 5.4 Add broker connectivity test
- A smoke test that calls `GET /health` and confirms the broker liveness check actually hits Alpaca's API (even if it fails gracefully with no credentials).

---

## Phase 6 — Operations

### 6.1 Real health check
- `server.js`: add an actual Alpaca API ping (`GET /v2/account`) in the `/health` handler.
- Return `{ status, alpaca: { reachable, account_status } }`.

### 6.2 Request logging middleware
- Add a `logRequest` wrapper that logs method, path, status, duration for every request.
- Use the structured logger from 0.4.

### 6.3 Graceful shutdown
- Currently no `SIGTERM`/`SIGINT` handler. Add one that:
  1. Stops the scanner timer
  2. Writes final status snapshot
  3. Flushes performance store to disk
  4. Closes the HTTP server

---

## Order of Execution

```
Phase 0 (quick wins)     → 2-3 days
Phase 1 (config)         → 1-2 days
Phase 2 (decompose)      → 3-5 days
Phase 3 (error handling) → 1-2 days  (can overlap with Phase 2)
Phase 4 (state)          → 1-2 days
Phase 5 (testing)        → 2-3 days  (can overlap with Phase 2-4)
Phase 6 (ops)            → 1 day
```

Each phase is safe to deploy independently. No phase should change behavior or introduce regressions — only refactor tests to match new module paths.
