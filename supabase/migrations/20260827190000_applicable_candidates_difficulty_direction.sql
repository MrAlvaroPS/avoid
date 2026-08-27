-- §bug real reportado y contrastado en real (2026-08-27, boss 3445 "Entombed
-- Sentinels", feedback: "es raro que en mítico no haya mecánicas que sí hay
-- en normal o hc"): el mismo bug direccional que ya se arregló en el
-- frontend (difficulty-evidence.util.ts, isContradictedByOtherDifficulty) se
-- había quedado SIN arreglar aquí — esta vista es la que de verdad filtra
-- boss_mechanics_candidates para classify-mechanics, y en cascada para
-- applicable_pull_mechanic_events / player_mechanic_offenses /
-- player_pull_reliability_inputs (avoidable damage, fiabilidad por
-- jugador...), no solo para lo que se ve en Ajustes.
--
-- Antes: "otra dificultad tiene evidencia y esta no" excluía la fila SIN
-- IMPORTAR la dirección — así que Mítica podía perder una mecánica solo
-- porque Normal/Heroico ya la habían visto, exactamente al revés de cómo
-- funciona el diseño real de WoW (las dificultades más duras casi nunca
-- pierden mecánicas que ya existían en las más fáciles). Ahora solo cuenta
-- como pista de exclusividad la evidencia vista en una dificultad MÁS DURA.
create or replace view applicable_boss_mechanics_candidates
with (security_invoker = true) as
select candidate.*
from boss_mechanics_candidates candidate
where candidate.observed_in_logs is true
   or candidate.observed_in_reference_logs is true
   or candidate.observed_as_interrupt is true
   or coalesce(candidate.reference_occurrences, 0) > 0
   or exists (
     select 1
     from pull_mechanic_events event
     join pulls pull on pull.id = event.pull_id
     where pull.boss_id = candidate.boss_id
       and pull.difficulty = candidate.difficulty
       and lower(trim(event.mechanic_name)) = lower(trim(candidate.name))
   )
   or (
     candidate.official_difficulty_applicable is distinct from false
     and (
       candidate.reference_source_report is null
       or not exists (
         select 1
         from boss_mechanics_candidates other
         where other.boss_id = candidate.boss_id
           and other.ability_id = candidate.ability_id
           and other.difficulty <> candidate.difficulty
           and (
             other.observed_in_logs is true
             or other.observed_in_reference_logs is true
             or other.observed_as_interrupt is true
             or coalesce(other.reference_occurrences, 0) > 0
           )
           and (case other.difficulty when 'LFR' then 1 when 'Normal' then 3 when 'Heroic' then 4 when 'Mythic' then 5 else 0 end)
             > (case candidate.difficulty when 'LFR' then 1 when 'Normal' then 3 when 'Heroic' then 4 when 'Mythic' then 5 else 0 end)
       )
     )
   );

comment on view applicable_boss_mechanics_candidates is
  'Mecánicas aplicables por boss+dificultad tras contrastar evidencia oficial, de la guild y de logs públicos. Una dificultad más fácil con evidencia NUNCA excluye una más dura (las dificultades duras no pierden mecánicas de las fáciles) — solo al revés. Evita que filas conservadas para auditoría contaminen análisis y estadísticas.';
