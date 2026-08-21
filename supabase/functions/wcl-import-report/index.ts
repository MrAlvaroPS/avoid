// Colocar en: supabase/functions/wcl-import-report/index.ts
// Fase 1: trae un report de WCL por código y guarda sus fights como pulls,
// sin clasificar todavía (eso llega en la Fase 2, sección 12).
//
// Es idempotente: se puede re-invocar con el mismo report y no duplica pulls
// (constraint unique(raid_night_id, wcl_fight_id) en la migración).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  wclGraphQL,
  REPORT_QUERY,
  WCL_DIFFICULTY_MAP,
  corsHeaders,
  type WclReportResponse,
} from '../_shared/wcl.ts';

interface ImportBody {
  reportCode: string;
  raidNightId?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { reportCode, raidNightId } = (await req.json()) as ImportBody;
    if (!reportCode?.trim()) {
      return json({ error: 'reportCode es obligatorio' }, 400);
    }

    // Cliente con la service role: las escrituras no pasan por RLS,
    // porque esta función ya valida el usuario a mano justo debajo.
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Resolver quién llama a partir del JWT que Angular manda automáticamente
    // vía supabase.functions.invoke(). No confiamos en ningún dato del body
    // para identidad.
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return json({ error: 'No autenticado' }, 401);
    }
    const userId = userData.user.id;

    // 1) Traer el report de WCL
    const wclData = await wclGraphQL<WclReportResponse>(REPORT_QUERY, {
      code: reportCode.trim(),
    });
    const report = wclData.reportData.report;
    if (!report) {
      return json({ error: 'Report no encontrado (revisa el código o si es público)' }, 404);
    }

    // 2) Resolver/crear el equipo del usuario (un único team por usuario en esta fase)
    let { data: team } = await supabase
      .from('raid_teams')
      .select('id')
      .eq('owner_id', userId)
      .maybeSingle();

    if (!team) {
      const { data: newTeam, error: teamErr } = await supabase
        .from('raid_teams')
        .insert({ owner_id: userId, name: 'Mi guild' })
        .select('id')
        .single();
      if (teamErr) throw teamErr;
      team = newTeam;
    }

    // 3) Resolver/crear la raid night
    let raidNight;
    if (raidNightId) {
      const { data, error } = await supabase
        .from('raid_nights')
        .select('*')
        .eq('id', raidNightId)
        .single();
      if (error) throw error;
      raidNight = data;
    } else {
      const { data: newNight, error: nightErr } = await supabase
        .from('raid_nights')
        .insert({
          team_id: team.id,
          date: new Date(report.startTime).toISOString().slice(0, 10),
          wcl_report_code: reportCode.trim(),
          status: 'live',
        })
        .select('*')
        .single();
      if (nightErr) throw nightErr;
      raidNight = newNight;
    }

    // 4) Por cada fight: resolver/crear encounter, y crear el pull si no existe ya
    const pullsCreated: unknown[] = [];
    const pullsSkipped: number[] = [];

    // pull_number se calcula por encounter dentro de esta raid night;
    // llevamos la cuenta en memoria para no repetir una query de count por fight
    const pullCountByEncounter = new Map<string, number>();

    for (const fight of report.fights) {
      let { data: encounter } = await supabase
        .from('encounters')
        .select('id')
        .eq('wcl_encounter_id', fight.encounterID)
        .maybeSingle();

      if (!encounter) {
        const { data: newEnc, error: encErr } = await supabase
          .from('encounters')
          .insert({
            wcl_encounter_id: fight.encounterID,
            name: fight.name,
            raid_zone: report.zone?.name ?? 'Desconocido',
          })
          .select('id')
          .single();
        if (encErr) throw encErr;
        encounter = newEnc;
      }

      // idempotencia: si el fight ya existe como pull, lo saltamos
      const { data: existingPull } = await supabase
        .from('pulls')
        .select('id')
        .eq('raid_night_id', raidNight.id)
        .eq('wcl_fight_id', fight.id)
        .maybeSingle();
      if (existingPull) {
        pullsSkipped.push(fight.id);
        continue;
      }

      if (!pullCountByEncounter.has(encounter.id)) {
        const { count } = await supabase
          .from('pulls')
          .select('id', { count: 'exact', head: true })
          .eq('raid_night_id', raidNight.id)
          .eq('encounter_id', encounter.id);
        pullCountByEncounter.set(encounter.id, count ?? 0);
      }
      const pullNumber = pullCountByEncounter.get(encounter.id)! + 1;
      pullCountByEncounter.set(encounter.id, pullNumber);

      const { data: pull, error: pullErr } = await supabase
        .from('pulls')
        .insert({
          raid_night_id: raidNight.id,
          encounter_id: encounter.id,
          pull_number: pullNumber,
          difficulty: fight.difficulty != null ? WCL_DIFFICULTY_MAP[fight.difficulty] ?? null : null,
          wcl_fight_id: fight.id,
          is_kill: fight.kill,
          pull_duration_ms: fight.endTime - fight.startTime,
          boss_hp_pct_final: fight.kill ? 0 : fight.bossPercentage,
          started_at: new Date(report.startTime + fight.startTime).toISOString(),
          ended_at: new Date(report.startTime + fight.endTime).toISOString(),
          raw_source: 'wcl_historical_import',
          analysis_state: 'pending',
        })
        .select('*')
        .single();
      if (pullErr) throw pullErr;
      pullsCreated.push(pull);
    }

    return json({
      raidNight,
      pullsCreated,
      pullsSkipped: pullsSkipped.length,
      totalFightsInReport: report.fights.length,
    });
  } catch (err) {
    console.error(err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
