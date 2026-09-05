# Night Player Audit Shell

Phase 1B presentation surface for the auditable Night Player Dossier.

This feature is intentionally isolated from the stable dossier route while the
Truth Catalog is being built. It must remain a read/presentation layer: domain
metrics belong to their canonical owners and are introduced only in the phase
that owns their cutover.

Current audit route:

`/report/:reportCode/player/:playerName/audit`

Do not use this shell to reimplement scoring, pull filtering, defensive
availability, mechanic classification, Reliability or AI interpretation.
