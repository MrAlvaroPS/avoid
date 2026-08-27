-- §"pantalla nueva para clasificar defensivos (sustain, defensivo, absorb,
-- etc)... parecida a la de mecánicas de bosses pero para defensivos"
-- (feedback real, con las 4 categorías definidas a mano por el usuario).
--
-- cooldown_catalog YA es la tabla base (§12.1, sincronizada desde el repo
-- real de WoWAnalyzer) y ya tiene una columna `category` — pero esa
-- responde a una pregunta distinta ("personal/semi/external/utility" = A
-- QUIÉN protege). survival_type responde a "QUÉ le hace al daño que te
-- están metiendo": mitigation (lo reduce antes de que llegue), absorption
-- (lo intercepta con un pool aparte), sustain (repara el HP ya perdido),
-- emergency (evita la muerte o dispara el margen de supervivencia). Son dos
-- ejes ortogonales — no se toca `category`, se añade uno nuevo al lado.
--
-- Mismo patrón exacto que boss_mechanics_candidates: valor confirmado a
-- mano (survival_type) separado de la sugerencia automática
-- (inferred_survival_type), con el razonamiento de la IA en
-- ai_classification y `reviewed` para marcar qué se ha revisado ya.
alter table cooldown_catalog
  add column if not exists survival_type text
    check (survival_type in ('mitigation', 'absorption', 'sustain', 'emergency')),
  add column if not exists inferred_survival_type text
    check (inferred_survival_type in ('mitigation', 'absorption', 'sustain', 'emergency')),
  add column if not exists ai_classification jsonb,
  add column if not exists reviewed boolean not null default false;

comment on column cooldown_catalog.survival_type is
  'Confirmado a mano (Ajustes > Defensivos) o aplicado desde una clasificación IA. Eje ortogonal a `category`: category = a quién protege (personal/semi/external/utility), survival_type = qué le hace al daño (mitigation = lo reduce, absorption = lo intercepta con un pool aparte, sustain = repara HP ya perdido, emergency = evita la muerte / dispara el margen de supervivencia).';
comment on column cooldown_catalog.inferred_survival_type is
  'Sugerencia automática (IA) sin confirmar todavía — nunca pisa survival_type una vez confirmado a mano.';
comment on column cooldown_catalog.ai_classification is
  'Razonamiento de la clasificación IA: {confidence, sources, notes, classifiedAt} — mismo contrato que boss_mechanics_candidates.ai_classification.';
comment on column cooldown_catalog.reviewed is
  'true = un humano ha revisado esta fila en la pantalla de Defensivos, confirmada o no. No implica que TODAS las specs de la clase tengan este defensivo — eso depende de spec/talentos, ver cooldown_catalog.spec y el cruce real en defensive-cooldowns.ts.';
