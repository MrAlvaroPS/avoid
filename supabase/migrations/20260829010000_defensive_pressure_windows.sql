-- §"picos de daño... juntando ventanas de daño sufrido + defensivos que usa
-- y tiene disponible, excluyendo muertes, ninja pulls y wipe calls" (feedback
-- real, 2026-08-29): hoy defensive_use_opportunity/used_defensive_in_pull
-- (ver 20260828120000) son booleanos por pull entero — "¿hubo presión?
-- sí/no", "¿usó algo? sí/no". No distinguen 8 ventanas de presión con 3
-- usos habiendo opción de cubrir las 8, de 1 ventana con 1 uso. Esta columna
-- guarda, por jugador y pull, CADA ventana de presión detectada (ver
-- supabase/functions/_shared/damage-pressure-windows.ts — diseño validado
-- empíricamente contra 3 pulls reales y 5 perfiles de clase/rol antes de
-- escribir esto) con su estado de cobertura real.
--
-- Se escribe en analyze-report para reports nuevos; el histórico ya
-- importado se rellena aparte (reanalyze-defensive-pressure, backfill
-- explícito) — null aquí significa "todavía no reanalizado", no "sin
-- ventanas" (mismo criterio que otras columnas de despliegue en dos tiempos
-- de este pipeline, ver reliability.service.ts LEGACY_RELIABILITY_COLUMNS).
alter table player_pull_records
  add column if not exists defensive_pressure_windows jsonb;

comment on column player_pull_records.defensive_pressure_windows is
  'Ventanas de presión detectadas en report.graph(DamageTaken) de este jugador en este pull (umbral relativo a su propia línea base, no un % fijo), cada una con su cobertura real (covered/coverable/options) evaluada con la misma fórmula de cooldown que death_cause.defensiveOptions. null = pull todavía no reanalizado con esta lógica (no "sin ventanas") — ver defensive-pressure-windows.ts y el backfill en reanalyze-defensive-pressure.';
