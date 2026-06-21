# Phase 1-4 Signoff

## 1. Freeze the legacy system
- Kept as reference: [`src/server.js`](../src/server.js), [`src/server-cli.js`](../src/server-cli.js), [`src/overnight-scanner.js`](../src/overnight-scanner.js).
- New live path separated into: [`src/minimal-server.js`](../src/minimal-server.js), [`src/minimal-cli.js`](../src/minimal-cli.js), [`src/trading-loop.js`](../src/trading-loop.js).
- Scope note: [`docs/minimal-v1-scope.md`](./minimal-v1-scope.md).

## 2. Define the minimal v1
- Minimal flow documented in [`docs/minimal-v1-scope.md`](./minimal-v1-scope.md).
- Defaults reduced in [`src/config.js`](../src/config.js).
- Default launcher switched to the minimal server in [`package.json`](../package.json).

## 3. Rebuild the core loop
- Shared signal-to-order path: [`src/trading-loop.js`](../src/trading-loop.js).
- Minimal server endpoints: [`src/minimal-server.js`](../src/minimal-server.js).
- Case-sensitive import safety remains in `scripts/check-case-sensitive-imports.js`.

## 4. Validate live behavior
- Fresh live smoke script: [`scripts/live-minimal-paper-smoke.js`](../scripts/live-minimal-paper-smoke.js).
- Current proof output: accepted `true`, stage `order_confirmed`, broker status `filled`.

## 5. Observability
- Block reasons come back in `reason_codes`.
- Order triggers return `paper_order`, `order_confirmation`, `paper_result`, and `paper_outcome`.
- Minimal server rejects legacy admin routes with `404`.

## 6. Test alignment
- Minimal-v1 test gate: [`test/minimal-v1.test.js`](../test/minimal-v1.test.js).
- Default test command now runs the minimal gate and key integration checks.

## 7. Final acceptance
- New live launcher: [`src/trader-cli.js`](../src/trader-cli.js) -> [`src/minimal-cli.js`](../src/minimal-cli.js).
- No hidden overnight scanner in the default path.
- Live paper order proof completed against Alpaca paper API.
