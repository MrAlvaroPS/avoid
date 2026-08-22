import { createClient } from 'jsr:@supabase/supabase-js@2';
import { generatePullBrief } from '../_shared/llm-brief.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

// Genera (o devuelve de caché) el brief de UN pull concreto. Separado de
// analyze-report a propósito: analyze-report solo engancha pulls/registros
// (rápido, sin LLM); esto es lo único que gasta una llamada real, y solo la
// gasta si hace falta:
//  - Sin `force`: si ya existe un brief para ese pull_id, lo devuelve tal
//    cual — CERO llamadas nuevas al LLM. Así, mirar un pull de hace 3 días
//    no cuesta nada salvo que se pida explícitamente.
//  - Con `force: true`: lo regenera y sobreescribe (upsert por pull_id).

interface Body {
  pullId: string;
  force?: boolean;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.pullId) {
    return jsonResponse({ ok: false, error: 'pullId es obligatorio' }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const { data: pull } = await supabase.from('pulls').select('*').eq('id', body.pullId).maybeSingle();
    if (!pull) {
      return jsonResponse({ ok: false, error: `Pull ${body.pullId} no encontrado` });
    }

    if (!body.force) {
      const { data: existing } = await supabase.from('pull_briefs').select('*').eq('pull_id', body.pullId).maybeSingle();
      if (existing) {
        return jsonResponse({ ok: true, cached: true, brief: existing });
      }
    }

    const { data: records } = await supabase
      .from('player_pull_records')
      .select('died,avoidable_damage_taken')
      .eq('pull_id', body.pullId);
    const deaths = (records ?? []).filter((r) => r.died).length;
    const avoidableDamageTotal = (records ?? []).reduce((sum, r) => sum + Number(r.avoidable_damage_taken ?? 0), 0);

    // Delta contra los pulls anteriores de ESTE boss+dificultad — el "mejoró/empeoró" del brief.
    const { data: priorPulls } = await supabase
      .from('pulls')
      .select('pull_number,wipe_pct,duration_ms')
      .eq('boss_id', pull.boss_id)
      .eq('difficulty', pull.difficulty)
      .lt('pull_number', pull.pull_number)
      .order('pull_number', { ascending: false })
      .limit(3);

    const pullContext = {
      pullNumber: pull.pull_number,
      wipePct: pull.wipe_pct,
      durationMs: pull.duration_ms,
      deaths,
      avoidableDamageTotal,
      previousPulls: (priorPulls ?? []).map((p) => ({ pullNumber: p.pull_number, wipePct: p.wipe_pct, durationMs: p.duration_ms })),
      // TODO Fase 2: perfil de referencia de WCL Rankings como tercer eje.
    };

    const brief = await generatePullBrief(supabase, pullContext, body.force ? 'pull-brief-regenerated' : 'pull-brief');

    const { data: saved, error: upsertError } = await supabase
      .from('pull_briefs')
      .upsert(
        {
          pull_id: body.pullId,
          headline: brief.headline,
          improved: brief.improved,
          regressed: brief.regressed,
          next_pull_actions: brief.nextPullActions,
          model: 'claude-haiku-4-5-20251001',
        },
        { onConflict: 'pull_id' },
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
