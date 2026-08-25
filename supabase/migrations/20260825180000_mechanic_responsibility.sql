-- Quién tiene la acción principal para resolver una mecánica. El dato vive
-- tanto en el manifiesto editorial como en los eventos ya analizados para
-- que los informes puedan agregar señales sin reinterpretar la categoría.
alter table boss_mechanics_candidates
  add column if not exists responsibility text
    check (responsibility in ('tank', 'dps', 'healer', 'raid', 'personal'));

alter table pull_mechanic_events
  add column if not exists responsibility text
    check (responsibility in ('tank', 'dps', 'healer', 'raid', 'personal'));

comment on column boss_mechanics_candidates.responsibility is
  'Responsable principal de resolver la mecánica: tank, dps, healer, raid o personal.';
comment on column pull_mechanic_events.responsibility is
  'Snapshot de la responsabilidad editorial vigente al analizar o reclasificar la mecánica.';
comment on column boss_mechanics_candidates.resolution_sources is
  'Obsoleto desde prompt v4. Se conserva para compatibilidad histórica; las fuentes generales de ai_classification respaldan también resolution.';
