-- §"Preparación": catálogo de peligrosidad/timing por mecánica + asignación
-- de defensivos por spec, para generar reminders de MRT — ver plan guardado
-- (conversación real, 2026-08-30). Deliberadamente separado de
-- boss_mechanics_candidates (otro consumidor: severidad de mecánica
-- evitable) aunque comparten clave (boss_id, difficulty, ability_id), sin FK
-- entre ellas — mismo patrón sin FK que ya usa el resto de schema.sql para
-- boss_id/difficulty como texto suelto.

-- Perfil de daño/timing calculado desde logs de referencia (fightRankings
-- públicos, ver fetchPublicRankings) + histórico propio. Los campos
-- reference_* y requires_defensive/requires_defensive_source SOLO los
-- escribe sync-mechanic-defensive-profile (automático); requires_group_split
-- /group_split_notes/reviewed SOLO los toca la edición manual — mismo
-- contrato que ya deja documentado boss_mechanics_candidates para evitar que
-- un resync pise una curación a mano.
create table if not exists boss_mechanic_defensive_profile (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  ability_id bigint not null,
  -- Daño reconstruido (amount+absorbed) en hits SIN un defensivo de
  -- mitigación %-reducción activo en el objetivo — la señal "cruda" que no
  -- se ve amortiguada por logs de referencia ya bien jugados (§"trampeadas",
  -- ver plan). Uno por hit observado, no agregado, para poder recalcular
  -- percentiles sin re-sincronizar.
  reference_unmitigated_damage_samples numeric[] not null default '{}',
  -- Mismos hits pero CON un defensivo de %-reducción activo — delta real de
  -- mitigación observado, no supuesto.
  reference_mitigated_damage_samples numeric[] not null default '{}',
  -- { tank: 0.1, healer: 0.05, dps: 0.85 } — fracción de hits por rol.
  reference_role_hit_breakdown jsonb,
  -- Ms desde pull-start de cada ocurrencia observada — solo para
  -- timeline/preview en la pantalla y como fallback si no hay trigger de
  -- bossmod fiable; el trigger real preferido (event=7/BW_TIMER) no depende
  -- de esto.
  reference_cast_offset_ms_samples integer[] not null default '{}',
  reference_sample_fight_count integer not null default 0,
  requires_defensive boolean,
  -- 'own_history' | 'world_reference' | 'fixed_threshold' | 'manual_override'
  -- — mismo vocabulario que _shared/mechanic-severity.ts (SeveritySource),
  -- no un esquema de confianza nuevo.
  requires_defensive_source text,
  requires_group_split boolean not null default false,
  group_split_notes text,
  reviewed boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (boss_id, difficulty, ability_id)
);
create index if not exists boss_mechanic_defensive_profile_boss_idx on boss_mechanic_defensive_profile (boss_id, difficulty);

-- Asignación curada a mano: qué defensivo de qué spec cubre qué mecánica, y
-- con qué aviso previo/trigger. Referencia LÓGICA a cooldown_catalog
-- (class+spec+spell_id) — sin FK, mismo motivo que boss_id/difficulty arriba
-- (cooldown_catalog se resincroniza desde WoWAnalyzer y podría no tener fila
-- para un spell_id nuevo todavía sin romper esta asignación).
create table if not exists mechanic_defensive_assignments (
  id uuid primary key default gen_random_uuid(),
  boss_id text not null,
  difficulty text not null,
  ability_id bigint not null,
  class text not null,
  spec text not null,
  defensive_spell_id bigint not null,
  prewarn_seconds integer not null default 5,
  trigger_type text not null default 'bossmod' check (trigger_type in ('bossmod', 'time')),
  -- Normalmente = ability_id; distinto solo si el timer real de
  -- BigWigs/DBM usa otro spellID para esta mecánica.
  bossmod_spell_id bigint,
  notes text,
  updated_at timestamptz not null default now(),
  unique (boss_id, difficulty, ability_id, class, spec)
);
create index if not exists mechanic_defensive_assignments_boss_idx on mechanic_defensive_assignments (boss_id, difficulty);
create index if not exists mechanic_defensive_assignments_spec_idx on mechanic_defensive_assignments (class, spec);

-- RLS: mismo tratamiento que el resto de la app desde el cierre a oficiales
-- (ver 20260829100000_lock_down_rls_to_officers.sql) — lectura solo
-- is_officer(), ninguna escritura para anon/authenticated (las dos edge
-- functions que escriben aquí usan la service role key).
alter table boss_mechanic_defensive_profile enable row level security;
create policy "read all - boss_mechanic_defensive_profile" on boss_mechanic_defensive_profile for select using (is_officer());

alter table mechanic_defensive_assignments enable row level security;
create policy "read all - mechanic_defensive_assignments" on mechanic_defensive_assignments for select using (is_officer());
