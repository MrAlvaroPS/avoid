import { createClient } from 'jsr:@supabase/supabase-js@2';
import { NIGHT_SYSTEM_PROMPT, parsePullBriefResponse } from '../_shared/llm-brief.ts';
import { buildNightBriefContext } from '../_shared/night-brief-context.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

// Mismo patrón que manual-pull-brief, para el ámbito raid×noche completa.

interface Body {
  reportCode: string;
  action: 'prompt' | 'submit';
  rawResponseText?: string;
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
  if (!body.reportCode || !body.action) {
    return jsonResponse({ ok: false, error: 'reportCode y action son obligatorios' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    if (body.action === 'prompt') {
      const context = await buildNightBriefContext(supabase, body.reportCode);
      if (!context) return jsonResponse({ ok: false, error: `Report ${body.reportCode} sin pulls` }, 404);
      return jsonResponse({ ok: true, systemPrompt: NIGHT_SYSTEM_PROMPT, userMessage: JSON.stringify(context, null, 2) });
    }

    if (!body.rawResponseText?.trim()) {
      return jsonResponse({ ok: false, error: 'rawResponseText vacío' }, 400);
    }
    let brief;
    try {
      brief = parsePullBriefResponse(body.rawResponseText);
    } catch (err) {
      return jsonResponse({ ok: false, error: `No se pudo interpretar como JSON el texto pegado: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

    const { data: saved, error: upsertError } = await supabase
      .from('night_briefs')
      .upsert(
        {
          report_code: body.reportCode,
          headline: brief.headline,
          improved: brief.improved,
          regressed: brief.regressed,
          next_pull_actions: brief.nextPullActions,
          model: 'manual',
        },
        { onConflict: 'report_code' },
      )
      .select()
      .single();
    if (upsertError) throw upsertError;

    return jsonResponse({ ok: true, brief: saved });
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
