import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getGuildReportsSince, getReportFights, isRaidReport } from '../_shared/wcl-client.ts';
import { upsertReportEncounters } from '../_shared/report-encounters.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// Catálogo de reports de la guild: recorre el histórico de WCL desde
// `sinceMs` y hace upsert en `reports` + `report_encounters` para todos los
// que sean de raid (isRaidReport). Es el complemento "barrido masivo" de
// analyze-report (que solo procesa el report que le pegas a mano) — sirve
// para poblar de golpe el desplegable de bosses (sync-boss-mechanics lee de
// report_encounters) sin tener que pegar cada código uno a uno.
//
// A propósito NO llama a analyze-report ni crea `pulls`/`player_pull_records`
// aquí: eso implica traer eventos por fight (caro, muchas páginas) y esta
// función está pensada para ejecutarse sobre decenas de reports de golpe.
// Clasificar pulls sigue siendo cosa de analyze-report, report a report.

interface SyncRequest {
  guildName: string;
  serverSlug: string;
  serverRegion: string;
  sinceMs?: number;
}

const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const MAX_REPORTS_PER_CALL = 40; // los reports viejos no se van a mover; de sobra para ponerse al día en una llamada

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  let body: SyncRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.guildName || !body.serverSlug || !body.serverRegion) {
    return jsonResponse({ ok: false, error: 'guildName, serverSlug y serverRegion son obligatorios' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const sinceMs = body.sinceMs ?? Date.now() - DEFAULT_LOOKBACK_MS;

  try {
    const summaries = await getGuildReportsSince({
      guildName: body.guildName,
      serverSlug: body.serverSlug,
      serverRegion: body.serverRegion,
      startTimeMs: sinceMs,
    });

    const batch = summaries.slice(0, MAX_REPORTS_PER_CALL);
    const remaining = summaries.length - batch.length;

    let reportsUpserted = 0;
    let encountersUpserted = 0;
    let skippedNonRaid = 0;

    for (const summary of batch) {
      const detail = await getReportFights(summary.code);
      if (!isRaidReport(detail.fights)) {
        skippedNonRaid++;
        continue;
      }

      const { error: reportErr } = await supabase.from('reports').upsert(
        {
          code: summary.code,
          title: summary.title,
          zone_id: summary.zone?.id ?? null,
          zone_name: summary.zone?.name ?? null,
          is_raid: true,
          start_time: summary.startTime,
          end_time: summary.endTime ?? null,
        },
        { onConflict: 'code' },
      );
      if (reportErr) throw reportErr;
      reportsUpserted++;

      encountersUpserted += await upsertReportEncounters(supabase, summary.code, detail.fights);
    }

    return jsonResponse({
      ok: true,
      reportsScanned: summaries.length,
      reportsUpserted,
      encountersUpserted,
      skippedNonRaid,
      remaining, // > 0 => reinvoca con el mismo sinceMs para seguir (hay más reports que MAX_REPORTS_PER_CALL)
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
