-- §hueco real encontrado al construir la UI de Ajustes para este catálogo
-- (2026-08-29): unassigned_mechanic_catalog se creó (20260829030000) sin
-- activar RLS — a diferencia de cooldown_catalog (mismo tipo de tabla:
-- catálogo de referencia editado a mano desde Ajustes), que sí tiene RLS +
-- una política de solo-lectura, dejando la escritura exclusivamente a
-- service_role (edge functions). Sin esto, cualquiera con la clave
-- publishable (la misma que ya lleva el frontend desplegado) podía
-- INSERT/UPDATE/DELETE directo contra esta tabla por REST, saltándose
-- save-unassigned-mechanic-edit por completo. Mismo patrón exacto que
-- cooldown_catalog.
alter table unassigned_mechanic_catalog enable row level security;

create policy "read all - unassigned_mechanic_catalog"
  on unassigned_mechanic_catalog
  for select
  using (true);
