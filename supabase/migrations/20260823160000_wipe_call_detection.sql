-- §"cuándo se determina un wipe global... esa gente no debería afectar su
-- fiabilidad ni sus defensivos ni contar como muerte, marcado como wipe
-- call" (feedback real). Detección en analyze-report (ver
-- supabase/functions/analyze-report/index.ts, detectWipeCall) — un cluster
-- de muertes casi simultáneas cerca del final de un wipe, con señales de
-- sanación/daño de la raid desplomándose justo antes y causas de muerte
-- heterogéneas (no todos a la misma habilidad, que sería una mecánica real
-- y no un wipe call). Auto-excluido de las estadísticas por defecto cuando
-- la confianza es alta (§decisión del usuario: "que autoexcluya pero que
-- permita también editarlo... para restaurar los valores"), pero SIEMPRE
-- editable a mano — wipe_call_excluded es la decisión final, wipe_call_signals
-- queda como evidencia para que el RL pueda revisar/corregir el auto-guess.

alter table pulls add column if not exists wipe_call_confidence numeric; -- null = no se detectó ningún cluster (nunca se evaluó, o el pull fue kill)
alter table pulls add column if not exists wipe_call_signals jsonb; -- desglose de señales (simultaneityFraction, abilityDiversity, healingCollapseRatio, damageCollapseRatio, sustainedDeathFraction, nearEndMs) — mismo espíritu que inferred_category_reasons: transparencia del porqué, no una caja negra
alter table pulls add column if not exists wipe_call_excluded boolean not null default false; -- la decisión que de verdad consumen los cálculos — true = excluir estas muertes de fiabilidad/métricas/tendencias. Se inicializa a (confidence >= umbral) en analyze-report, editable después vía set-wipe-call-status

comment on column pulls.wipe_call_excluded is
  'Decisión real que consumen reliability (player_pull_reliability_inputs), las tarjetas de métricas y "a quién dirigir": excluir las muertes del cluster detectado (player_pull_records.wipe_call_cluster=true de este pull) de fiabilidad/racha/mecánicas falladas. Editable por el RL vía la función set-wipe-call-status — nunca se sobreescribe en un re-análisis del mismo pull salvo que cambie el propio wipe_call_confidence.';

alter table player_pull_records add column if not exists wipe_call_cluster boolean not null default false; -- true = esta muerte concreta forma parte del cluster detectado en ESTE pull (independiente de si wipe_call_excluded está activo o no — es el hecho, no la decisión)

comment on column player_pull_records.wipe_call_cluster is
  'true = esta muerte formó parte del cluster de "posible wipe call" detectado para el pull. No implica que esté excluida de las estadísticas — eso lo decide pulls.wipe_call_excluded, editable aparte.';
