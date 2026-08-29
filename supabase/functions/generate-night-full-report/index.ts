import { createClient } from 'jsr:@supabase/supabase-js@2';
import { buildNightFullReport } from '../_shared/night-full-report.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { errorMessage } from '../_shared/error-message.ts';

// §"cambiar 'copiar informe' por 'generar informe'... cuando el informe
// está generado ese botón se convierte en 'ver informe' pero se puede
// actualizar con este otro botón" (feedback real): informe DETERMINISTA
// (sin LLM) cacheado en night_full_reports — sin `force`, si ya existe se
// devuelve tal cual; con `force:true` (el botón "Actualizar") se recalcula
// y sobreescribe. Nunca gasta presupuesto de LLM porque no llama a ninguno.

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
  if (!body.reportCode) return jsonResponse({ ok: false, error: 'reportCode es obligatorio' }, 400);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    if (!body.force) {
      const { data: existing } = await supabase.from('night_full_reports').select('*').eq('report_code', body.reportCode).maybeSingle();
      if (existing?.report?.schemaVersion === 15) {
        return jsonResponse({ ok: true, cached: true, report: existing.report, generatedAt: existing.generated_at });
      }
    }

    const report = await buildNightFullReport(supabase, body.reportCode);
    if (!report) return jsonResponse({ ok: false, error: `Report ${body.reportCode} sin pulls` });

    const { data: saved, error } = await supabase
      .from('night_full_reports')
      .upsert({ report_code: body.reportCode, report, generated_at: new Date().toISOString() }, { onConflict: 'report_code' })
      .select()
      .single();
    if (error) throw error;

    return jsonResponse({ ok: true, cached: false, report: saved.report, generatedAt: saved.generated_at });
  } catch (err) {
    // §"[object Object]" bug ya visto varias veces esta sesión (classify-defensives,
    // etc.) — el mismo patrón vivía aquí sin arreglar. errorMessage() sí
    // sabe leer un PostgrestError real en vez de sólo Error/String().
    console.error('generate-night-full-report falló:', err);
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
