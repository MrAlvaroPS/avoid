-- §"dentro de roster... a mí (Pandokie) me dice que no he usado un
-- defensivo en Coiled Altar pull 7, pero la realidad es que eso es un wipe
-- call... esto aplica a varias partes de la app y varios raiders" (feedback
-- real, 2026-08-28): el arreglo de detectWipeCall y el backfill de
-- reanalyze-wipe-call SÍ corrigieron el dato en player_pull_reliability_inputs
-- (verificado contra el pull real), pero roster-snapshot-cache.service.ts
-- guarda un snapshot en localStorage y solo lo invalida si cambió el último
-- pull, el último report o el roster de wowaudit — una corrección
-- RETROACTIVA sobre un pull antiguo (wipe call reanalizado, editado a mano,
-- ninja pull revertido) no mueve ninguna de esas tres señales, así que el
-- snapshot cacheado se queda desactualizado indefinidamente aunque la base
-- de datos ya esté bien. `updated_at` es la señal que faltaba: se bumpea en
-- cada corrección posterior a la inserción inicial (reanalyze-wipe-call,
-- set-wipe-call-status, set-ninja-pull-status) y el fingerprint del roster
-- ahora también mira el más reciente.
alter table pulls add column if not exists updated_at timestamptz not null default now();

-- Backfill: closed_at (no el now() que puso el DEFAULT de arriba al recién
-- añadir la columna) para no invalidar de golpe todos los snapshots
-- cacheados existentes por una migración que en sí misma no cambia ningún
-- dato observable. Justo después del ALTER, TODAS las filas tienen el mismo
-- valor puesto por el DEFAULT — pisarlo aquí sin condición es seguro.
update pulls set updated_at = closed_at;

comment on column pulls.updated_at is
  'Última vez que se corrigió algo de este pull DESPUÉS de la inserción inicial (reanalyze-wipe-call, set-wipe-call-status, set-ninja-pull-status) — no se toca en la inserción original (para eso ya está created_at/closed_at). Es la señal que consume roster-snapshot-cache.service.ts para saber si un snapshot cacheado sigue siendo válido tras una corrección retroactiva.';
