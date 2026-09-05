-- §E2.1 (2026-09-04) — corrección de build-provenance tras la auditoría de
-- roster completo (E2). El E2 audit encontró que TODOS los jugadores
-- evaluables tienen exactamente un nodo de talento SELECCIONADO cuyo
-- entry_to_spell no resuelve a ningún spellId — el resolver interpretaba
-- eso como "nodo genuinamente sin resolver" (unresolvedSelectedNodes=true),
-- lo que bloqueaba buildPresence='absent' para prácticamente todo el
-- roster. Investigación real: ese nodo existe de verdad en el DB2 del
-- build (probablemente el selector del árbol de Hero Talents, sin spell
-- propio) — no es un dato faltante, es un nodo estructural legítimo.
--
-- entry_to_spell (solo entries que SÍ resuelven a spell) no puede por sí
-- solo distinguir "entry real sin spell" de "entry que no se pudo
-- resolver". Esta columna añade el snapshot completo de qué TraitNodeEntry
-- existen de verdad en el DB2 de ese build, resuelvan o no — nunca se
-- inventa un spellId para ellos, solo se registra su existencia.
alter table talent_spell_lookup
  add column if not exists known_entry_ids jsonb not null default '[]'::jsonb;

comment on column talent_spell_lookup.known_entry_ids is
  'Array de TraitNodeEntry.ID que existen de verdad en el DB2 de este build (resuelvan o no a un spellId) — ver wago-db2-client.ts TalentSpellLookup.knownEntryIds. [] en filas cacheadas antes de esta migración; se repuebla en la siguiente sincronización de ese build (fetchTalentSpellLookup ya lo calcula).';

notify pgrst, 'reload schema';
