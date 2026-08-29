import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getZoneEncounters } from '../_shared/wcl-client.ts';
import { findJournalInstanceByName, getJournalInstance } from '../_shared/blizzard-client.ts';
import { fetchPublicRankings, summarizePublicRankings } from '../_shared/wcl-client.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// §9.1 de la hoja de ruta (auditoría v2): "los bosses solo se cargan si hay
// un pull propio — un boss que todavía no habéis pulleado no existe en el
// sistema, aunque el resto del mundo ya lo esté matando". Esto puebla
// known_raid_bosses para TODA la instancia de una vez, cruzando dos fuentes
// reales (WCL para el ID correcto, Blizzard Journal para confirmar cuáles
// de los encuentros de la zona son bosses "de verdad" del raid, filtrando
// ruido como encuentros de mundo que WCL a veces mete en la misma zona —
// verificado en real: la zona 53 trae 9 encuentros de WCL pero Blizzard
// Journal solo reconoce 8 como parte de la instancia) — y de paso siembra
// boss_reference_stats para cada boss+dificultad aunque la guild no haya
// intentado ese boss todavía, mismo mecanismo que ya usa sync-boss-mechanics.

interface SyncRequest {
  zoneId?: number; // WCL zone id; si se omite, se usa el de vuestro report más reciente
}

const WCL_DIFFICULTY_IDS = [1, 3, 4, 5]; // LFR, Normal, Heroic, Mythic
const WCL_DIFFICULTY_NAME_BY_ID: Record<number, string> = { 1: 'LFR', 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  let body: SyncRequest = {};
  try {
    body = await req.json();
  } catch {
    // body vacío es válido aquí (todos los campos son opcionales)
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    let zoneId = body.zoneId ?? null;
    if (!zoneId) {
      const { data: latestReport } = await supabase
        .from('reports')
        .select('zone_id')
        .not('zone_id', 'is', null)
        .order('start_time', { ascending: false })
        .limit(1)
        .maybeSingle();
      zoneId = (latestReport?.zone_id as number | undefined) ?? null;
    }
    if (!zoneId) {
      return jsonResponse({ ok: false, error: 'No hay zoneId — pasa uno a mano o importa al menos un report primero.' }, 400);
    }

    // --- 1. WCL: catálogo real con el ID correcto (mismo espacio que el resto del esquema) ---
    const zone = await getZoneEncounters(zoneId);
    if (!zone) {
      return jsonResponse({ ok: false, error: `WCL no conoce la zona ${zoneId}.` }, 404);
    }

    // --- 2. Blizzard Journal: filtro de "cuáles son bosses de verdad de esta instancia" + orden real ---
    // best-effort: si Blizzard no encuentra la instancia (nombre no coincide
    // por localización, o instancia no-raid sin Journal), se siembra igual
    // con lo que da WCL — un catálogo sin journal_encounter_id/orden sigue
    // siendo mejor que ningún catálogo.
    let journalEncounters: { id: number; name: string; order: number }[] = [];
    try {
      const instance = await findJournalInstanceByName(zone.name);
      if (instance) {
        const detail = await getJournalInstance(instance.id);
        journalEncounters = (detail.encounters ?? []).map((e, i) => ({ id: e.id, name: e.name, order: i }));
      }
    } catch (err) {
      console.error('sync-season-bosses: fallo consultando Blizzard Journal (se sigue solo con WCL):', err);
    }
    const journalByName = new Map(journalEncounters.map((e) => [e.name.toLowerCase(), e]));

    const rows = zone.encounters
      .map((enc) => {
        const journalMatch = journalByName.get(enc.name.toLowerCase());
        return {
          encounter_id: enc.id,
          boss_name: enc.name,
          zone_id: zone.id,
          zone_name: zone.name,
          journal_encounter_id: journalMatch?.id ?? null,
          order_index: journalMatch?.order ?? null,
          synced_at: new Date().toISOString(),
        };
      })
      // Si Blizzard respondió pero este encuentro de WCL no está en su
      // lista, se descarta como ruido de la zona (ver nota de arriba) — pero
      // SOLO cuando Blizzard sí respondió algo: si journalEncounters está
      // vacío (Blizzard falló del todo), no hay base para filtrar nada, así
      // que se siembra todo lo que da WCL sin recortar.
      .filter((r) => journalEncounters.length === 0 || r.journal_encounter_id != null);

    if (rows.length) {
      const { error } = await supabase.from('known_raid_bosses').upsert(rows, { onConflict: 'encounter_id' });
      if (error) throw error;
    }

    // --- 3. boss_reference_stats para cada boss+dificultad, aunque no se haya pulleado nunca ---
    // Mismo cálculo que ya hace sync-boss-mechanics — aquí en bloque para
    // toda la instancia de una vez. best-effort por fila: una dificultad sin
    // rankings públicos todavía (raid muy nueva) no debe tumbar el resto.
    let referenceStatsUpserts = 0;
    for (const row of rows) {
      for (const wclDifficultyId of WCL_DIFFICULTY_IDS) {
        try {
          const rankings = await fetchPublicRankings(row.encounter_id, wclDifficultyId);
          const summary = summarizePublicRankings(rankings);
          if (!summary || !rankings[0]) continue;
          const { error } = await supabase.from('boss_reference_stats').upsert(
            {
              boss_id: String(row.encounter_id),
              difficulty: WCL_DIFFICULTY_NAME_BY_ID[wclDifficultyId],
              reference_kill_duration_ms: rankings[0].duration,
              reference_report_code: rankings[0].reportCode,
              reference_fight_id: rankings[0].reportFightId,
              reference_sample_size: summary.sampleSize,
              reference_median_duration_ms: summary.medianDurationMs,
              reference_p25_duration_ms: summary.p25DurationMs,
              reference_zero_death_rate: summary.zeroDeathRate,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'boss_id,difficulty' },
          );
          if (!error) referenceStatsUpserts++;
        } catch (err) {
          console.error(`sync-season-bosses: fallo trayendo rankings de ${row.boss_name} dificultad ${wclDifficultyId}:`, err);
        }
      }
    }

    return jsonResponse({
      ok: true,
      zoneId: zone.id,
      zoneName: zone.name,
      wclEncountersSeen: zone.encounters.length,
      journalEncountersMatched: journalEncounters.length,
      bossesSeeded: rows.length,
      referenceStatsUpserts,
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
