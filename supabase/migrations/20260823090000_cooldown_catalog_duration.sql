-- §"para calcular bien si había defensivo activo... tienes que revisar lo
-- que dura el defensivo con el momento de uso y el momento de su muerte, no
-- solo el CD" (feedback real): hasta ahora "activo al morir" solo se sabía
-- si WCL traía un snapshot de buffs reciente (evento de daño a ≤2s de la
-- muerte con ese buff en la lista) — si el jugador murió sin recibir daño
-- justo antes (ej. muerte por otra vía, o hueco en los eventos), no había
-- forma de saberlo aunque el cast SÍ estuviera dentro de su ventana de
-- duración. Con la duración real del catálogo, analyze-report puede
-- calcularlo siempre: cast + duración vs. momento de morir, sin depender de
-- que existiera ese snapshot. Nullable: sin dato, se sigue con el
-- comportamiento anterior (snapshot de buffs) — más honesto que inventar
-- una duración.
alter table cooldown_catalog
  add column if not exists base_duration_ms integer;

comment on column cooldown_catalog.base_duration_ms is
  'Duración real del buff/efecto en ms (cuánto dura activo tras lanzarlo) — distinto de base_cooldown_ms (cuánto tarda en volver a estar disponible). Null = sin verificar; el cálculo de "activo al morir" cae de vuelta al snapshot de buffs de WCL.';
