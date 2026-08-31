-- §"un tank de paladin me comentó que una habilidad defensiva la tenemos
-- puesta como suya pero ya no la tiene" (feedback real, 2026-08-31): `spec`
-- en cooldown_catalog viene del extractor de WoWAnalyzer (o de la IA vía
-- classify-defensives) y no era editable a mano — spec_override es la
-- corrección humana por ENCIMA de eso, mismo eje que ya existe entre
-- inferred_survival_type (sugerencia) y survival_type (confirmado a mano),
-- pero aquí como lista explícita de specs en vez de un único valor: null =
-- sin corrección, se sigue derivando de `spec` tal cual (spec=null → toda la
-- clase, "Feral/Guardian" → esas dos); no-null = la lista real, gane lo que
-- gane `spec` o un resync futuro del extractor.
alter table cooldown_catalog add column if not exists spec_override text[];
comment on column cooldown_catalog.spec_override is 'Corrección manual de qué specs tienen este defensivo de verdad — null = sin corregir, se deriva de `spec`. Nunca lo toca el extractor de WoWAnalyzer ni classify-defensives, solo save-defensive-edit.';
