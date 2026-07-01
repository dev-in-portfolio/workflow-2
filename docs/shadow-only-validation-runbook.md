# Shadow-Only Validation Runbook

## Purpose

This runbook defines the last safe validation step before any scanner-influencing feature is considered for broader use.

Shadow-only validation is display-only. The system may collect, score, cache, and render symbols, but it must not let those symbols change scanner ranking, candidate selection, slot rotation, or order submission.

## Safety Rules

- Do not edit `.env.local` for this validation pass.
- Do not add or enable new trading behavior.
- Do not unlock `MEME_AUTO_ACTION_ENABLED`.
- Do not add manual buy, sell, liquidate, close-position, or cancel-order controls.
- Keep optional high-noise sources disabled unless the operator explicitly enables them later.
- Keep scanner-influencing feature flags off by default.

## Source Health Expectations

Every source should be validated before scanning. If a source is missing, private, banned, quarantined, inaccessible, rate-limited, or missing credentials, the system should mark it inactive with a reason and continue without crashing.

Expected source status shape:

```json
{
  "source": "wallstreetbets2",
  "tier": "tier_1",
  "status": "active",
  "lastScanAt": "2026-06-30T14:05:00-04:00",
  "lastError": null,
  "symbolsDetected": 4
}
```

Unavailable source example:

```json
{
  "source": "wallstreetbets2",
  "tier": "tier_1",
  "status": "inactive",
  "blockedReason": "source_not_found_or_inaccessible",
  "lastScanAt": null,
  "lastError": "Unable to validate subreddit"
}
```

## Operator Checklist

1. Open the Actions tab and confirm shadow-only features show the expected active, shadow, inactive, or blocked state.
2. Open the Watch tab and confirm it shows which sources contributed to each ticker.
3. Confirm tier 1 sources carry more heat weight than tier 2, tier 3 stays context-only unless market confirmation is strong, and ticker-specific communities do not auto-promote Hot Hot on their own.
4. Confirm optional high-noise sources stay disabled by default.
5. Confirm source validation marks bad sources inactive instead of crashing the scanner.
6. Confirm Auto Action remains locked.
7. Confirm no manual trade controls are present anywhere in the dashboard.
8. Confirm shadow symbols appear in display output only and do not alter ranking, rotation, or execution paths.

## Acceptance Criteria

- The dashboard can explain active and inactive sources without leaking secrets.
- The scanner continues operating when one source fails.
- Watch tab attribution stays visible and stable.
- Shadow-only features remain non-influential.
- No live execution behavior is introduced during validation.

## Blockers

Treat any of the following as a stop condition:

- Shadow output changes scanner ranking.
- A source failure crashes the monitor.
- Auto Action becomes available.
- A manual trade control appears.
- Optional high-noise sources come on by default.

## After Validation

If everything passes, keep the current hold-until-approved posture and wait for an explicit operator decision before enabling any scanner-influencing feature.
