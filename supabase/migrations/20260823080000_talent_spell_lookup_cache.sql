-- §"han desaparecido todos los talentos": fetchTalentSpellLookup descargaba
-- dos tablas DB2 completas (TraitNodeEntry + TraitDefinition, miles de filas
-- de TODAS las clases) de wago.tools en CADA invocación de analyze-report —
-- lento y ocasionalmente falla/tarda demasiado, y al fallar el código
-- degrada en silencio a "talentos sin resolver" (a propósito, para no
-- bloquear el análisis — pero eso hace que la tabla de talentos parpadee
-- entre "con iconos" y "vacía" dependiendo de si esa descarga concreta tuvo
-- suerte). Esta tabla cachea el resultado por build de juego — solo cambia
-- cuando Blizzard saca un parche, así que una vez resuelto no hay que volver
-- a pedirlo nunca para ese build.
create table if not exists talent_spell_lookup (
  build text primary key,
  entry_to_spell jsonb not null,
  synced_at timestamptz not null default now()
);

alter table talent_spell_lookup enable row level security;

create policy "talent_spell_lookup is publicly readable"
  on talent_spell_lookup for select
  using (true);
