# evaluate-mechanic-attribution-shadow

Officer-only shadow evaluator. Requires `mechanic-occurrence-resolver@2.0.0` occurrences for the pull and persists non-punitive ownership decisions into `mechanic_attribution_shadow_evaluations`.

It must not feed UI, scoring or `player_execution_events` during shadow v1. The evaluator and DB both enforce `new_accusation_count = 0`.
