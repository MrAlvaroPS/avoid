import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SYSTEM_PROMPT, parsePullBriefResponse } from '../_shared/llm-brief.ts';
import { buildPullBriefContext } from '../_shared/pull-brief-context.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// §"un botón para copiar el prompt completo... y un botón para pegar el
// resultado... procesarlo como si fuese a través de la API" (feedback
// real): vía alternativa a generate-pull-brief para cuando no se quiere
// gastar la ANTHROPIC_API_KEY propia de la app — el usuario pega el prompt
// en SU sesión de Claude (o la que sea), pega la respuesta de vuelta aquí,
// y esto la guarda exactamente igual que si hubiera venido de la API real:
// mismo parseo (parsePullBriefResponse), misma tabla (pull_briefs), mismo
// contrato de columnas. La única diferencia real: NUNCA pasa por
// checkLlmBudget/recordLlmCall — no hay llamada real a Anthropic que
// medir, así que no tiene sentido ni contarla ni bloquearla por presupuesto.
//
// action: 'prompt' → construye el contexto (buildPullBriefContext, el MISMO
//   que usa el camino automático) y devuelve el system+user prompt listos
//   para copiar y pegar en cualquier chat de LLM.
// action: 'submit' → recibe el texto que la IA respondió, lo parsea con la
//   MISMA función que la respuesta real de la API, y lo guarda en
//   pull_briefs (model:'manual', para que quede claro en la BD de dónde
//   salió cada brief).

interface Body {
  pullId: string;
  action: 'prompt' | 'submit';
  rawResponseText?: string; // solo para action:'submit'
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.pullId || !body.action) {
    return jsonResponse({ ok: false, error: 'pullId y action son obligatorios' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    if (body.action === 'prompt') {
      const context = await buildPullBriefContext(supabase, body.pullId);
      if (!context) return jsonResponse({ ok: false, error: `Pull ${body.pullId} no encontrado` }, 404);
      return jsonResponse({ ok: true, systemPrompt: SYSTEM_PROMPT, userMessage: JSON.stringify(context.pullContext, null, 2) });
    }

    // action === 'submit'
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
      .from('pull_briefs')
      .upsert(
        {
          pull_id: body.pullId,
          headline: brief.headline,
          improved: brief.improved,
          regressed: brief.regressed,
          next_pull_actions: brief.nextPullActions,
          model: 'manual',
        },
        { onConflict: 'pull_id' },
      )
      .select()
      .single();
    if (upsertError) throw upsertError;

    return jsonResponse({ ok: true, brief: saved });
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
