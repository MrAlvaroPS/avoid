-- §"el timeline es horrible, hay que rehacerlo de cero con algo real y
-- útil": WCL tiene un endpoint `graph` pensado exactamente para esto (la
-- misma gráfica de daño-en-el-tiempo que se ve en la propia web de WCL/
-- Archon) — series por jugador, bucketizadas en intervalos regulares. Se
-- suman las series de daño recibido de toda la raid en UNA serie agregada y
-- se guarda en el pull (no se recalcula en cada visita, igual que el resto
-- de analyze-report).
alter table pulls
  add column if not exists raid_damage_taken_series jsonb;

comment on column pulls.raid_damage_taken_series is
  '{ pointIntervalMs: number, points: number[] } — daño recibido por TODA la raid, sumado por bucket de tiempo (WCL graph(dataType:DamageTaken, hostilityType:Friendlies)). Null si WCL no respondió (best-effort, no bloquea el resto del análisis).';
