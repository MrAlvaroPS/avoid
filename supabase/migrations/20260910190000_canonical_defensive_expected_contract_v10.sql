-- §pressure-detection-recalibration (2026-09-10) — episode-evaluator@10:
-- DEFAULT_FACTOR de detectDamageWindows() baja de 2.5 a 1.7 (ver
-- damage-pressure-windows.ts), contrastado contra 2 noches reales (34
-- pulls, 753 filas jugador×pull, 4 roles). Mismo mecanismo que
-- 20260910170100: actualizar canonical_defensive_expected_contract junto al
-- bump de versión en TypeScript es lo que permite que needs_refresh()
-- detecte el cambio de código sin depender de que los datos "parezcan"
-- incompletos.
update canonical_defensive_expected_contract
set episode_version = 'episode-evaluator@10',
    evaluator_version = 'episode-evaluator@10',
    updated_at = now()
where id = true;
