-- Cierra el hueco señalado en real (captura de pantalla): el manifiesto
-- enseñaba "Sin categoría" en TODAS las filas porque sync-boss-mechanics
-- nunca escribe `category` (solo save-mechanic-edit, a propósito, para no
-- pisar una edición humana en un resync — ver comentario en
-- 20260822000000_schema_v2_no_auth.sql). La solución no es que sync empiece
-- a escribir `category`: es darle una columna PROPIA para su sugerencia
-- (inferred_category + el porqué, inferred_category_reasons), que el front
-- usa como valor por defecto del desplegable mientras `category` siga sin
-- confirmar. Así nunca hay una fila en blanco de verdad, y la sugerencia
-- queda separada del dato editorial confirmado.

alter table boss_mechanics_candidates drop constraint if exists boss_mechanics_candidates_category_check;
alter table boss_mechanics_candidates add constraint boss_mechanics_candidates_category_check
  check (category in ('tankbuster','raid-damage','avoidable-ground','debuff-stack','interrupt','soak','spread','healing-absorb'));

alter table boss_mechanics_candidates
  add column if not exists inferred_category text
    check (inferred_category in ('tankbuster','raid-damage','avoidable-ground','debuff-stack','interrupt','soak','spread','healing-absorb')),
  add column if not exists inferred_category_reasons jsonb not null default '[]'::jsonb;

comment on column boss_mechanics_candidates.inferred_category is
  'Sugerencia automática de sync-boss-mechanics (texto del Journal + comportamiento en un log público de referencia — ver _shared/mechanic-category-inference.ts). Se recalcula en cada resync. NUNCA sustituye a `category`: el front la usa solo como valor por defecto del desplegable mientras `category` esté sin confirmar.';
comment on column boss_mechanics_candidates.inferred_category_reasons is
  'Array de frases legibles explicando de dónde salió inferred_category — la evidencia real, para el botón/tooltip de provenance ("¿por qué esta categoría?").';

-- Benchmark contra el mismo log público de referencia: cuánta gente golpea
-- de media esta mecánica ahí, para poder comparar contra vuestro propio
-- pull_mechanic_events.players_hit ("¿estamos golpeando más gente de lo que
-- golpea incluso el mejor kill del mundo con esta misma mecánica?").
alter table boss_mechanics_candidates
  add column if not exists reference_avg_players_hit numeric,
  add column if not exists reference_occurrences integer,
  add column if not exists reference_source_report text;

comment on column boss_mechanics_candidates.reference_avg_players_hit is 'Media de objetivos golpeados por cast de esta mecánica en el log público de referencia (fightRankings), como cuenta absoluta de jugadores — no ratio.';
comment on column boss_mechanics_candidates.reference_source_report is 'Código del report público usado para el benchmark — trazabilidad/provenance, no es dato de la guild.';

-- §"compendio de uso de defensivos": todos los casts de cada defensivo por
-- jugador durante el pull (no solo el estado en el instante de morir, que ya
-- vive en death_cause.defensiveOptions). El cálculo ya existía en memoria
-- dentro de analyze-report (defensiveCastTimestampsByActor) — antes solo se
-- usaba para resolver el momento de la muerte y se descartaba.
alter table player_pull_records
  add column if not exists defensive_casts jsonb not null default '[]'::jsonb;
comment on column player_pull_records.defensive_casts is
  '[{ spellId, name, timestampsMs: number[] }] — CADA cast de cada defensivo del catálogo de su clase durante el pull completo, no solo el que estaba activo al morir. timestampsMs relativo al inicio del pull (mismo espacio que trigger_time_ms).';

-- Consumibles: piedra de brujo y poción de vida (WCL los ve como casts
-- normales — ver _shared/consumables.ts para cómo se resuelven sus
-- abilityId reales desde masterData.abilities de CADA report, nunca IDs fijos
-- a mano, porque el nombre de la poción de vida cambia cada tier).
alter table player_pull_records
  add column if not exists consumables jsonb not null default '{}'::jsonb;
comment on column player_pull_records.consumables is
  '{ healthstone: { available, used, count, timestampsMs }, healthPotion: { used, count, timestampsMs } }. `available` de healthstone = había algún Warlock en la raid de este pull (Blizzard permite que cualquiera lleve la suya si la crafteó, pero la señal fiable sin adivinar es esta: si NO hay warlock y el jugador no la usó, no se puede asegurar que la tuviera disponible, así que available queda false en ese caso en vez de asumir que sí la tenía).';
