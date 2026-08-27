-- §"podemos quitar la dificultad LFR de ajustes, del prompt y de la
-- sincronización... no es relevante para nada y nos ahorrará unos tokens y
-- molestias" (feedback real, 2026-08-27): la app ya deja de OFRECER LFR en
-- Ajustes/sync/prompt (ver STANDARD_DIFFICULTY_IDS en shared/format.util.ts
-- y el filtro .neq('difficulty','LFR') en classify-mechanics) — esto limpia
-- las filas que ya existían de antes, contrastado en real: 101 filas en
-- boss_mechanics_candidates y 4 en boss_reference_stats, cero pulls reales
-- de la guild en LFR (pulls.difficulty nunca lo tiene). Seguro de borrar:
-- ninguna otra tabla referencia estas filas por FK — pull_mechanic_events/
-- death_cause guardan una foto por NOMBRE en el momento de analizar el
-- pull, no un FK a boss_mechanics_candidates.
delete from boss_mechanics_candidates where difficulty = 'LFR';
delete from boss_reference_stats where difficulty = 'LFR';
