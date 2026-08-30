-- §"si tras sufrir daño uso la piedra de brujo es un uso correcto, usarla
-- por usarla no es correcto" (feedback real, 2026-08-30): analyze-report/
-- reanalyze-defensive-pressure ya escriben consumables.<healthstone|
-- healthPotion>.usedReactively para cualquier pull procesado a partir de
-- este despliegue (ver _shared/consumables.ts, isReactiveConsumableUse) —
-- esta migración rellena esa misma clave en el histórico ya importado, sin
-- pedir nada a WCL: reactivo = el cast cae dentro de una ventana de presión
-- real de ESE jugador en ESE pull (±2s antes / +8s después, mismo margen
-- que el resto del informe) — y esas ventanas (defensive_pressure_windows)
-- YA están persistidas por pull, así que esto es una transformación
-- puramente sobre datos que ya viven en la base, no un reanálisis.
--
-- Deliberadamente NO toca las filas cuyo defensive_pressure_windows es NULL
-- (pulls de antes del 2026-08-29, cuando esa columna ni existía todavía) —
-- para esas, "no reactivo" sería inventado (no hay ventanas con las que
-- comparar), así que se dejan sin la clave usedReactively y el cliente cae
-- al criterio antiguo (cualquier cast cuenta) como fallback explícito, ver
-- night-player-summary.service.ts. Solo se sobrescribe cuando de verdad hay
-- con qué comparar.
do $$
declare
  rec record;
  windows jsonb;
  hs_timestamps numeric[];
  hp_timestamps numeric[];
  hs_reactive boolean;
  hp_reactive boolean;
  updated_consumables jsonb;
  pad_before constant numeric := 2000;
  pad_after constant numeric := 8000;
  rows_updated int := 0;
begin
  for rec in
    select id, consumables
    from player_pull_records
    where defensive_pressure_windows is not null
      and consumables is not null
      and (consumables ? 'healthstone' or consumables ? 'healthPotion')
  loop
    select coalesce(defensive_pressure_windows -> 'windows', '[]'::jsonb)
      into windows
      from player_pull_records
      where id = rec.id;

    updated_consumables := rec.consumables;

    if rec.consumables ? 'healthstone' then
      select coalesce(array_agg((elem)::numeric), array[]::numeric[])
        into hs_timestamps
        from jsonb_array_elements_text(coalesce(rec.consumables -> 'healthstone' -> 'timestampsMs', '[]'::jsonb)) as elem;
      hs_reactive := exists (
        select 1
        from unnest(hs_timestamps) as ts
        cross join lateral jsonb_array_elements(windows) as w
        where ts >= (w ->> 'startMs')::numeric - pad_before
          and ts <= (w ->> 'endMs')::numeric + pad_after
      );
      updated_consumables := jsonb_set(updated_consumables, '{healthstone,usedReactively}', to_jsonb(hs_reactive));
    end if;

    if rec.consumables ? 'healthPotion' then
      select coalesce(array_agg((elem)::numeric), array[]::numeric[])
        into hp_timestamps
        from jsonb_array_elements_text(coalesce(rec.consumables -> 'healthPotion' -> 'timestampsMs', '[]'::jsonb)) as elem;
      hp_reactive := exists (
        select 1
        from unnest(hp_timestamps) as ts
        cross join lateral jsonb_array_elements(windows) as w
        where ts >= (w ->> 'startMs')::numeric - pad_before
          and ts <= (w ->> 'endMs')::numeric + pad_after
      );
      updated_consumables := jsonb_set(updated_consumables, '{healthPotion,usedReactively}', to_jsonb(hp_reactive));
    end if;

    update player_pull_records set consumables = updated_consumables where id = rec.id;
    rows_updated := rows_updated + 1;
  end loop;

  raise notice 'backfill_reactive_consumable_use: % filas actualizadas', rows_updated;
end $$;
