# Minimal v1 Scope

## Kept
- Market data normalization and validation.
- Signal scoring and risk gating.
- Paper-order submission.
- Broker fill confirmation.
- Outcome recording and daily results reporting.
- Case-sensitive import checking.

## Removed from the live launcher
- Overnight scanner startup.
- Auto policy refresh.
- Policy rollback and tuning as part of the default live path.
- Hidden defaults that mutate behavior outside the core loop.

## Live path
1. Market data enters the minimal server.
2. The signal is validated.
3. The risk gate approves or blocks it.
4. Approved signals become paper orders.
5. The broker order is polled until it is filled or final.
6. The result is recorded and reported.

## Reference implementation
- The legacy control plane remains in the repository for reference and admin-style workflows.
- The minimal v1 launcher is the default live path.
