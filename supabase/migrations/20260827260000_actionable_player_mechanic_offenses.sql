-- El roster usaba player_mechanic_offenses como si players_hit_names fuese
-- siempre una lista de culpables. En realidad también contiene receptores de
-- daño inevitable de raid, tankbusters y jugadores alcanzados por la explosión
-- de otra persona. Eso producía decenas de falsos "atascos constantes".
--
-- Esta vista queda deliberadamente conservadora: solo crea una ofensa cuando
-- la clasificación confirma simultáneamente que el daño era evitable, la
-- responsabilidad era personal y la categoría identifica directamente a la
-- persona que permaneció en el suelo. Es preferible omitir una señal dudosa a
-- acusar a un jugador con evidencia que no permite atribuir responsabilidad.
create or replace view player_mechanic_offenses as
select
  p.id as pull_id,
  p.boss_id,
  p.difficulty,
  p.closed_at,
  e.category,
  e.ability_id,
  e.mechanic_name,
  e.outcome,
  unnest(e.players_hit_names) as player_name
from applicable_pull_mechanic_events e
join pulls p on p.id = e.pull_id
where e.category = 'avoidable-ground'
  and e.avoidable is true
  and e.responsibility = 'personal'
  and e.outcome <> 'clean'
  and array_length(e.players_hit_names, 1) > 0
  and not p.ninja_pull_excluded
  and not (
    p.wipe_call_excluded
    and p.wipe_call_signals is not null
    and jsonb_typeof(p.wipe_call_signals->'wipeCallStartMs') = 'number'
    and e.trigger_time_ms >= (p.wipe_call_signals->>'wipeCallStartMs')::numeric
  );

comment on view player_mechanic_offenses is
  'Una fila por jugador con un fallo individual atribuible y repetible: solo zonas de suelo confirmadas como evitables y de responsabilidad personal. Excluye daño de raid, tankbusters, responsabilidad compartida, ninja pulls y eventos posteriores a wipeCallStartMs.';
