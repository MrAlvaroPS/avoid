import { createClient } from 'jsr:@supabase/supabase-js@2';
import { generateNightBrief } from '../_shared/llm-brief.ts';
import { buildNightBriefContext } from '../_shared/night-brief-context.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// Mismo patrón que generate-pull-brief, para el ámbito raid×noche completa
// (§"un resumen de una noche... a nivel de raid también" — feedback real).
// Sin `force`: si ya existe un brief para este report_code, se devuelve tal
// cual, CERO llamadas nuevas al LLM.

interface Body {
  reportCode: string;
  force?: boolean;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.reportCode) {
    return jsonResponse({ ok: false, error: 'reportCode es obligatorio' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    if (!body.force) {
      const { data: existing } = await supabase.from('night_briefs').select('*').eq('report_code', body.reportCode).maybeSingle();
      if (existing) return jsonResponse({ ok: true, cached: true, brief: existing });
    }

    const context = await buildNightBriefContext(supabase, body.reportCode);
    if (!context) return jsonResponse({ ok: false, error: `Report ${body.reportCode} sin pulls` });

    const brief = await generateNightBrief(supabase, context, body.force ? 'night-brief-regenerated' : 'night-brief');

    const { data: saved, error: upsertError } = await supabase
      .from('night_briefs')
      .upsert(
        {
          report_code: body.reportCode,
          headline: brief.headline,
          improved: brief.improved,
          regressed: brief.regressed,
          next_pull_actions: brief.nextPullActions,
          model: 'claude-haiku-4-5-20251001',
        },
        { onConflict: 'report_code' },
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
