-- §12/§12.1: disponibilidad real de cooldown ("próximo_disponible(t) =
-- último_cast_antes_de(t) + base_cooldown_ms"), no solo "lo lanzó alguna vez
-- en el pull". Necesita el cooldown base por spell, que hasta ahora no se
-- extraía porque analyze-report no lo usaba para nada — a partir de esta
-- fase sí.
alter table cooldown_catalog
  add column if not exists base_cooldown_ms integer; -- null = expresión dinámica no resoluble por texto (talentos/haste), disponibilidad queda 'unknown' para esa spell

comment on column cooldown_catalog.base_cooldown_ms is
  'Cooldown base en ms, talentos/haste en 0 (el "peor caso" antes de reducciones). Null cuando el extractor no pudo resolver un número plano del código fuente — ver supabase/wowanalyzer-extractor/extract.mjs.';

-- Descripción de la mecánica (de dónde sale: Blizzard Journal body_text/title)
-- para poder explicar/criticar qué hace, no solo cómo se llama.
alter table pull_mechanic_events
  add column if not exists description text;
comment on column pull_mechanic_events.description is 'Copiado de boss_mechanics_candidates.description en el momento de clasificar — así el pull queda autocontenido aunque el manifiesto cambie después.';
