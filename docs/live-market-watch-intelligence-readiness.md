# Live Market Watch Intelligence Readiness Report

## Current Status

Ready for dashboard/shadow inspection with safe defaults and operator controls. Scanner-influencing features remain hold-until-approved.

## Next Step: Shadow-Only Validation

Shadow-only validation means the dashboard may collect, score, display, and explain symbols, but those symbols must not influence scanner ranking, candidate selection, position slot rotation, or order submission.

- Run the operator checklist in `docs/shadow-only-validation-runbook.md`.
- Keep Auto Action locked and leave manual trade controls unavailable.
- Treat any shadow result that changes scanner behavior as a blocker, not a launch signal.

## Ready Now

- Dashboard / Watch tab
- Actions tab operational controls
- Meme Monitor shadow mode after local credential and source validation
- Regular Watch display and source checks after local source validation

## Hold / Not Yet

- Dynamic Watchlist: hold until shadow data is reviewed
- Priority Override: hold
- Hot Slot Rotation: hold until operator validation is complete
- Regular Watch scanner ranking: hold
- Regular Watch position awareness: hold
- Auto Action: locked

## Feature Activation Summary

- Meme Monitor and Regular Watch continue to use the layered activation model of display toggles, two-key toggles, source toggles, and locked controls.
- Active sources are read from config and runtime state, validated before scanning, and marked inactive with reasons instead of crashing the scanner.
- Reddit source tiers remain tiered and optional high-noise sources stay disabled by default.
- Hot Hot promotion still depends on stronger confirmation than tier-3 or ticker-specific chatter alone.
- The dashboard does not expose manual trade execution controls.

## Test Status

- `npm test`: passed
- `npm run ci`: passed
- Dedicated hot-slot rotation coverage is present in `test/hot-slot-rotation.test.js` and wired into both test scripts.
- The Hot Slot Rotation blocker matrix was expanded with direct candidate, eviction, and plan checks.
- New dashboard source-health and meme-action coverage verifies the corrected status handling.
- Shadow-only guardrail coverage is added in `test/shadow-only-validation.test.js`.

## Remaining Operator Validation

- Review shadow data before enabling any scanner-influencing feature.
- Confirm source credentials and subreddit access for the Reddit tiers in use.
- Keep optional high-noise Reddit sources disabled unless there is a specific reason to enable them.
- Validate any Hot Slot Rotation behavior in shadow before considering broader use.

## Deferred Item

- `EXECUTION_ADAPTER_ENABLED` aliasing was deferred in this pass to avoid changing execution-adapter semantics while the legacy `PAPER_ADAPTER_ENABLED` gate remains in place.
