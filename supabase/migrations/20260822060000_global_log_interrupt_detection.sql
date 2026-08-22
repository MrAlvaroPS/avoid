-- Cruce con logs públicos globales (no solo los de la guild), tal como
-- sugeriste: WCL tiene fightRankings/characterRankings por encuentro+
-- dificultad, con acceso público (client_credentials de sobra, son reports
-- ajenos pero públicos). sync-boss-mechanics ahora trae el mejor kill público
-- de este boss+dificultad y comprueba sus eventos Interrupts reales — así
-- "esto es una mecánica de interrupt" deja de ser una suposición y pasa a
-- ser un hecho observado en logs de verdad, aunque en los vuestros propios
-- (con solo 2-3 días de progresión) nunca haya sucedido un interrupt todavía.
alter table boss_mechanics_candidates
  add column if not exists observed_as_interrupt boolean not null default false;

comment on column boss_mechanics_candidates.observed_as_interrupt is
  'true si esta ability_id aparece como extraAbilityGameID en un evento Interrupts de un log público de referencia (fightRankings) para este boss+dificultad — evidencia real, no heurística. Sync-boss-mechanics lo recalcula cada vez; no es un campo editorial (no lo toca save-mechanic-edit).';
