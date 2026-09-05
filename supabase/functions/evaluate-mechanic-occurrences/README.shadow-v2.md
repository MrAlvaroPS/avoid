# mechanic-occurrence-resolver@2.0.0

Shadow-only event-backed occurrence materialization.

Unlike v1 placeholder rows, v2 creates deterministic occurrences from real `applicable_pull_mechanic_events`, respects `pull_evaluation_context`, preserves source event evidence and reports unmapped/missing-policy events instead of inventing identity.

This does not change infographic/scoring consumers by itself.
