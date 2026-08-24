import { createClient } from 'jsr:@supabase/supabase-js@2';
import { generateNightPlayerBrief } from '../_shared/llm-brief.ts';
import { buildNightPlayerBriefContext } from '../_shared/night-player-brief-context.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

// Mismo patrón que generate-pull-brief, para el ámbito jugador×noche
// (§"meter en el dosier de un jugador... la consulta de IA" — feedback
// real). Sin `force`: si ya existe un brief para este report_code+player_name,
// se devuelve tal cual, CERO llamadas nuevas al LLM.

interface Body {
  reportCode: string;
  playerName: string;
  force?: boolean;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.reportCode || !body.playerName) {
    return jsonResponse({ ok: false, error: 'reportCode y playerName son obligatorios' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    if (!body.force) {
      const { data: existing } = await supabase.from('night_player_briefs').select('*').eq('report_code', body.reportCode).eq('player_name', body.playerName).maybeSingle();
      if (existing) return jsonResponse({ ok: true, cached: true, brief: existing });
    }

    const context = await buildNightPlayerBriefContext(supabase, body.reportCode, body.playerName);
    if (!context) return jsonResponse({ ok: false, error: `Sin pulls de ${body.playerName} en el report ${body.reportCode}` });

    const brief = await generateNightPlayerBrief(supabase, context, body.force ? 'night-player-brief-regenerated' : 'night-player-brief');

    const { data: saved, error: upsertError } = await supabase
      .from('night_player_briefs')
      .upsert(
        {
          report_code: body.reportCode,
          player_name: body.playerName,
          headline: brief.headline,
          improved: brief.improved,
          regressed: brief.regressed,
          next_pull_actions: brief.nextPullActions,
          model: 'claude-haiku-4-5-20251001',
        },
        { onConflict: 'report_code,player_name' },
      )
      .select()
      .single();
    if (upsertError) throw upsertError;

    return jsonResponse({ ok: true, cached: false, brief: saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith('Llamada al LLM bloqueada') ? 429 : 500;
    return jsonResponse({ ok: false, error: message }, status);
  }
});
