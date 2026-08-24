-- §"la API de wowaudit... roster de verdad en lugar de deducirlo": hasta
-- ahora el roster se deducía de "quién ha aparecido en algún pull" — esta
-- tabla es el roster CANÓNICO real (quién está de verdad en la guild, su rol
-- de raid, si es Main/Trial) más la asistencia agregada que wowaudit ya
-- calcula — exactamente el dato que le faltaba al eje "asistencia" de
-- fiabilidad (§12, documentado como bloqueado en reliability.service.ts por
-- "roster canónico sin construir").
create table if not exists wowaudit_roster (
  character_id bigint primary key, -- id de wowaudit, no de Blizzard/WCL
  name text not null,
  realm text not null,
  class text not null,
  -- Tank / Heal / Melee / Ranged (Melee+Ranged = dps a efectos de icono de rol)
  role text not null,
  rank text not null, -- Main / Trial
  status text not null,
  attended_amount_of_raids integer not null default 0,
  total_amount_of_raids integer not null default 0,
  attended_percentage numeric,
  synced_at timestamptz not null default now()
);
create index if not exists wowaudit_roster_name_idx on wowaudit_roster (name);

alter table wowaudit_roster enable row level security;
create policy "wowaudit_roster is publicly readable"
  on wowaudit_roster for select
  using (true);
