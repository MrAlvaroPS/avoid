-- §"la raid debe hacerlo, lo que pasa que no marca a nadie a propósito para
-- hacerlo y es el RL quien lo dice o la propia voluntad del raider" (feedback
-- real, 2026-08-29): mecánicas donde CUALQUIER jugador elegible puede actuar
-- (coger un huevo, un orbe, usar un pez) sin que WCL/el Journal asigne un
-- responsable fijo. Distinto de MechanicCategory (que clasifica peligros a
-- evitar/responder) — esto es un catálogo aparte para acciones de utilidad
-- que SUMAN, nunca restan. Verificado empíricamente contra un log real
-- (Lvp1VCbzmwTRHdQ7) antes de escribir el esquema: huevos de Ula'tek y orbe
-- de Altar son NPCs interactuables (nunca aparecen en
-- applicable_boss_mechanics_candidates, que es 100% Journal — el Journal no
-- documenta objetos del suelo, solo hechizos del boss), mientras que el pez
-- de Lost Explorers es un cast real del jugador con dos IDs de WCL distintos
-- (uno es el estado del propio objeto, el otro — 1296535 — el cast real de
-- Smöll usándolo).
create table if not exists unassigned_mechanic_catalog (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  -- Exactamente uno de los dos debe venir relleno según detection_type:
  -- ability_id para 'cast'/'debuff_applied'/'buff_applied' (un hechizo real
  -- de WCL), actor_name_pattern para 'npc_interaction' (un NPC-objeto que no
  -- tiene ability_id propio, como "Quivering Egg Cluster").
  ability_id bigint,
  actor_name_pattern text,
  name text not null,
  detection_type text not null check (detection_type in ('cast', 'debuff_applied', 'buff_applied', 'npc_interaction')),
  -- Solo relevante para debuff_applied/buff_applied: quién aplica el efecto
  -- — un NPC/boss (caso típico al recoger algo) o el propio jugador
  -- (self-buff al usar un ítem). No se usa para filtrar detección, es
  -- documentación de qué evento buscar.
  applied_by text check (applied_by in ('npc', 'self')),
  -- §"la mayoria de estas mecanicas solo afecta a dps" (feedback real,
  -- 2026-08-29): informativo únicamente — NUNCA filtra qué cuenta como
  -- ocurrencia real (si un healer o un tank la resuelve igual, cuenta igual;
  -- es más meritorio, no menos, por salirse de lo esperado de su rol).
  eligible_roles text[],
  -- Id de la consecuencia (ej. la explosión del orbe, Fishy Feedback) si se
  -- conoce — solo para poder relacionarlas en la UI, nunca se usa para
  -- detectar quién hizo la acción.
  consequence_ability_id bigint,
  reviewed boolean not null default false,
  ai_confidence text,
  ai_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unassigned_mechanic_has_target check (ability_id is not null or actor_name_pattern is not null),
  constraint unassigned_mechanic_unique unique nulls not distinct (boss_id, difficulty, ability_id, actor_name_pattern)
);

comment on table unassigned_mechanic_catalog is 'Mecánicas de un boss donde cualquier jugador elegible puede actuar (sin asignación fija) y la raid sufre si nadie lo hace — coger/usar/depositar algo. Premia, nunca penaliza: no hay responsable individual claro a quien culpar si no se hace.';

-- §"ese orbe concreto al cogerlo, deja un debuffo que luego expira asi que
-- se puede contabilizar" (feedback real, 2026-08-29): a nivel de PULL, no de
-- jugador — es intrínsecamente un evento de raid (cualquiera puede ser quien
-- lo haga), igual que ya vive raid_damage_taken_series en pulls y no en
-- player_pull_records.
alter table pulls add column if not exists unassigned_mechanic_occurrences jsonb;
comment on column pulls.unassigned_mechanic_occurrences is 'Array de {catalogId, mechanicName, actorId, actorName, timestampMs} — quién resolvió cada mecánica sin asignar de este pull, calculado por analyze-report/reanalyze-unassigned-mechanics contra unassigned_mechanic_catalog.';

-- §"buscar si hay mas combates con mecanicas similares" (feedback real,
-- 2026-08-29): los 3 casos verificados contra un log real antes de escribir
-- esta migración (Lvp1VCbzmwTRHdQ7) — el resto de bosses de este tier
-- quedan pendientes de confirmar (ver conversación: Soulcoil Well/Surging
-- Totem/Amani Ghost Stalker se descartaron con evidencia real de que NO son
-- este patrón; Toxin Cloud Stalker/Fountain Stalker quedan "probablemente no"
-- sin cerrar del todo, por si resultan ser de Heroico/Mítico).
insert into unassigned_mechanic_catalog (boss_id, difficulty, actor_name_pattern, name, detection_type, applied_by, eligible_roles, reviewed, ai_notes)
values
  ('3492', 'Normal', 'Quivering Egg Cluster', 'Huevos de Ula''tek (racimo)', 'npc_interaction', 'self', array['Melee', 'Ranged'], true, 'Verificado contra Lvp1VCbzmwTRHdQ7 — NPC real en masterData.actors. Guía Wowhead: "Pick up and break Ula''tek''s Eggs to avoid an Empowered Add".'),
  ('3492', 'Normal', 'Squirming Egg', 'Huevos de Ula''tek (individual)', 'npc_interaction', 'self', array['Melee', 'Ranged'], true, 'Verificado contra Lvp1VCbzmwTRHdQ7 — NPC real en masterData.actors.'),
  ('3492', 'Normal', 'Doomscale Egg', 'Huevo de Doomscale (Fase 2)', 'npc_interaction', 'self', array['Melee', 'Ranged'], true, 'Verificado contra Lvp1VCbzmwTRHdQ7 — NPC real en masterData.actors. Guía: "one player should pick up the Doomscale Egg in the back of the room".')
on conflict do nothing;

insert into unassigned_mechanic_catalog (boss_id, difficulty, actor_name_pattern, name, detection_type, applied_by, eligible_roles, reviewed, ai_notes)
values
  ('3429', 'Normal', 'Coalesced Venom Stalker', 'Orbe de veneno coalescido', 'npc_interaction', 'self', array['Melee', 'Ranged'], true, 'Verificado contra Lvp1VCbzmwTRHdQ7 — NPC real (2 instancias) en masterData.actors. Guía Wowhead: "Pick up Coalesced Venom and drop them at an assigned point."')
on conflict do nothing;

insert into unassigned_mechanic_catalog (boss_id, difficulty, ability_id, name, detection_type, applied_by, eligible_roles, reviewed, ai_notes)
values
  ('3497', 'Normal', 1296535, 'Pez asqueroso (Disgusting Fish)', 'cast', 'self', array['Melee', 'Ranged'], true, 'Verificado contra Lvp1VCbzmwTRHdQ7, fight 21 — Cast real de Smöll (sourceID jugador). Ability 1292490 (mismo nombre) es el estado del propio objeto (applybuff/removebuff sourceID=targetID=NPC), no la acción del jugador — no usar ese id.')
on conflict do nothing;
