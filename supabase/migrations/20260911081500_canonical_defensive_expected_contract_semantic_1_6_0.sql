-- §frenzied-regen-shapeshift-override (2026-09-11) — mismo mecanismo que 20260910170100/20260910190000:
-- actualizar canonical_defensive_expected_contract junto al bump de versión en TypeScript es lo que permite
-- que needs_refresh() detecte el cambio de catálogo sin depender de que los datos "parezcan" incompletos.
update canonical_defensive_expected_contract
set semantic_resolver_version = 'effective-defensive-semantics@1.6.0',
    updated_at = now()
where id = true;
