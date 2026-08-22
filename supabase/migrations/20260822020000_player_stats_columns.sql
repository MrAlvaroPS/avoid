-- Cierra el hueco de §3/§7: dps/hps, absorciones y talentos/trinkets
-- (combatantInfo de WCL) que la hoja de ruta pide explícitamente y que el
-- esquema nuevo (schema.sql) se había dejado fuera al simplificar
-- player_pull_records a solo muertes + daño evitable.

alter table player_pull_records
  add column if not exists dps numeric,
  add column if not exists hps numeric,
  add column if not exists absorbed_damage_taken bigint not null default 0,
  add column if not exists talent_build jsonb,
  add column if not exists equipped_items jsonb;

comment on column player_pull_records.dps is 'DamageDone total del jugador / duración del pull en segundos. Simplificación conocida: usa duración total del pull, no "active time" (WCL descuenta huecos sin objetivo válido) — por eso puede quedar algo por debajo del DPS que enseña la propia web de WCL.';
comment on column player_pull_records.hps is 'Healing total (incluye overheal) del jugador / duración del pull en segundos. Mismo matiz de active time que dps.';
comment on column player_pull_records.absorbed_damage_taken is 'Suma del campo `absorbed` de los eventos DamageTaken de este jugador — daño que un escudo evitó, no daño recibido.';
comment on column player_pull_records.talent_build is 'Array de talentos tal cual viene de events(dataType: CombatantInfo) de WCL para este jugador en este fight.';
comment on column player_pull_records.equipped_items is 'Array de gear (incluye trinkets) tal cual viene de events(dataType: CombatantInfo) de WCL para este jugador en este fight.';
