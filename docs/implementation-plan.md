# Implementation Plan

1. Establish a safe paper-first project skeleton with deterministic modules and Node-based tests.
2. Build canonical market-data normalization with symbol mapping, freshness checks, and provider metadata.
3. Add signal scoring, contradiction checks, and a deterministic risk gate that fails closed.
4. Introduce an in-memory paper-trade adapter with idempotency, state transitions, and reconciliation helpers.
5. Add audit logging, metrics summaries, replay support, and operator-review payloads for the trader.
6. Document the safety model, defaults, integration contracts, and what remains intentionally paper-only.
