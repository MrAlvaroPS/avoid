import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { checkLlmBudget, recordLlmCall } from './llm-guard.ts';

// Nota: purpose por defecto sigue siendo 'pull-brief'; el que llama puede
// pasar otro (ej. 'pull-brief-regenerated') para distinguir en llm_calls.

const MODEL = 'claude-haiku-4-5-20251001'; // barato y rápido: encaja con "solo redacta, JSON fijo"
const ANTHROPIC_VERSION = '2023-06-01';

const SYSTEM_PROMPT = `Eres el asistente de un Raid Leader de World of Warcraft en progresión Mythic.
Recibirás un JSON con datos ya calculados de un pull: comparación contra pulls anteriores propios
y, si está disponible, contra un perfil de kills de referencia. NUNCA inventes datos que no estén
en el JSON de entrada.

Responde ÚNICAMENTE con JSON válido (sin texto, sin markdown, sin backticks), con esta forma exacta:
{
  "headline": string,            // máx 20 palabras, el resumen del pull
  "improved": string[],          // 0 a 3 items, cada uno máx 15 palabras
  "regressed": string[],         // 0 a 3 items, cada uno máx 15 palabras
  "nextPullActions": string[]    // 1 a 3 acciones concretas y accionables, cada una máx 15 palabras
}`;

export interface PullBriefResult {
  headline: string;
  improved: string[];
  regressed: string[];
  nextPullActions: string[];
}

/**
 * Genera el brief del pull. SIEMPRE pasa por checkLlmBudget() primero: si el
 * guard bloquea, lanza un error y NO se gasta ninguna llamada real a la API.
 */
export async function generatePullBrief(
  supabase: SupabaseClient,
  pullContext: unknown,
  purpose = 'pull-brief',
): Promise<PullBriefResult> {
  const guard = await checkLlmBudget(supabase);
  if (!guard.allowed) {
    await recordLlmCall(supabase, {
      purpose,
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      status: 'blocked',
      blockReason: guard.reason,
    });
    throw new Error(`Llamada al LLM bloqueada por el guard: ${guard.reason}`);
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY en las variables de entorno de la función.');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(pullContext) }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
    }

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    await recordLlmCall(supabase, { purpose, model: MODEL, inputTokens, outputTokens, status: 'ok' });

    const textBlock = data.content?.find((block: { type: string }) => block.type === 'text');
    const parsed = JSON.parse(textBlock?.text ?? '{}');
    return {
      headline: parsed.headline ?? '',
      improved: Array.isArray(parsed.improved) ? parsed.improved : [],
      regressed: Array.isArray(parsed.regressed) ? parsed.regressed : [],
      nextPullActions: Array.isArray(parsed.nextPullActions) ? parsed.nextPullActions : [],
    };
  } catch (err) {
    await recordLlmCall(supabase, {
      purpose,
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      status: 'error',
      blockReason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
