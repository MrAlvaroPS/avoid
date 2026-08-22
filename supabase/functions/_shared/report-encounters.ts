import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { isEncounterFight, type WclFight } from './wcl-client.ts';

/**
 * Guarda en report_encounters los fights de boss de un report (encounterID +
 * nombre + dificultad reales de WCL). Usado tanto por sync-reports (barrido
 * masivo de la guild) como por analyze-report (para que un log pegado a mano,
 * que nunca pasó por sync-reports, también alimente el desplegable... bueno,
 * ya no hay desplegable: alimente la lista de bosses del report que se está
 * mirando).
 */
export async function upsertReportEncounters(
  supabase: SupabaseClient,
  reportCode: string,
  fights: WclFight[],
): Promise<number> {
  const raidFights = fights.filter(isEncounterFight);
  if (!raidFights.length) return 0;

  const rows = raidFights.map((f) => ({
    report_code: reportCode,
    fight_id: f.id,
    encounter_id: f.encounterID,
    boss_name: f.name,
    wcl_difficulty_id: f.difficulty,
    kill: f.kill,
    start_time: f.startTime,
    end_time: f.endTime,
  }));
  const { error, count } = await supabase
    .from('report_encounters')
    .upsert(rows, { onConflict: 'report_code,fight_id', count: 'exact' });
  // No relanzamos (quien llama no debería morir por esto), pero SÍ lo dejamos
  // en logs — antes este error se tragaba en silencio y dejaba
  // report_encounters vacía sin ningún rastro (bug real encontrado el
  // 2026-08-22: se llamaba antes de que existiera la fila padre en `reports`,
  // violando la FK en cada report nuevo).
  if (error) console.error('upsertReportEncounters falló:', error.message);
  return error ? 0 : (count ?? rows.length);
}
