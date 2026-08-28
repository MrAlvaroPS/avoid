-- §Parte A del plan de severidad variable: nivel 1 (historial propio de
-- Avoid) necesita el RATIO (players_hit/raidSize) de cada instancia
-- histórica de una mecánica, en kills únicamente (mismo criterio que
-- Wipefest — comparan contra "successful fights", no contra el caos de
-- wipes tempranos). pull_mechanic_events.players_hit es una CUENTA
-- absoluta, no un ratio, y no hay una columna raid_size en pulls — el
-- tamaño de la raid para un pull histórico solo se puede derivar contando
-- player_pull_records de ese mismo pull. Vista en vez de repetir este join
-- a mano en analyze-report cada vez.
create or replace view own_mechanic_hit_ratios
with (security_invoker = true) as
select
  pme.pull_id,
  pme.ability_id,
  p.boss_id,
  p.difficulty,
  pme.players_hit,
  raid.raid_size,
  (pme.players_hit::numeric / nullif(raid.raid_size, 0)) as hit_ratio
from pull_mechanic_events pme
join pulls p on p.id = pme.pull_id
join lateral (
  select count(*) as raid_size
  from player_pull_records ppr
  where ppr.pull_id = pme.pull_id
) raid on true
where p.wipe_pct = 0
  -- category='interrupt' reutiliza players_hit como "¿se resolvió?" (0/1),
  -- no un conteo de golpes (ver comentario en PullMechanicEventRow,
  -- domain.ts) — su ratio no significaría nada aquí, y de todas formas los
  -- interrupts nunca pasan por resolveSeverity (analyze-report los resuelve
  -- clean/fail antes de llegar a esa lógica).
  and pme.category is distinct from 'interrupt'
  and raid.raid_size > 0;

comment on view own_mechanic_hit_ratios is
  'Ratio (players_hit/raidSize) de cada instancia histórica de mecánica, SOLO en pulls con kill (wipe_pct=0) — la muestra de nivel 1 (historial propio) para resolveSeverity en _shared/mechanic-severity.ts. raidSize derivado de player_pull_records porque pulls no guarda un tamaño de raid propio.';
