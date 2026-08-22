import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

// Deben coincidir con src/app/core/llm-limits.ts (Angular). Si cambias un
// número, cámbialo en los dos sitios: son runtimes distintos y no comparten módulo.
export const LLM_LIMITS = {
  maxCallsPerMinute: 5, // corta bucles: nada legítimo necesita más de 5 análisis/minuto
  maxCallsPerHour: 40, // margen holgado para una noche de raid larga
  maxCostPerDayUsd: 1.5,
  maxCostPerMonthUsd: 15,
};

// Precios de la API de Anthropic en USD por millón de tokens (entrada/salida).
// Revisar en https://platform.claude.com/docs/en/about-claude/pricing si cambian.
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Comprueba límites de ritmo (anti-bucle) y de presupuesto (anti-sorpresa en
 * la factura) ANTES de gastar una sola llamada al LLM. Debe llamarse siempre
 * antes de invocar la API de Anthropic.
 */
export async function checkLlmBudget(supabase: SupabaseClient): Promise<GuardResult> {
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const oneHourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { count: callsLastMinute } = await supabase
    .from('llm_calls')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'ok')
    .gte('created_at', oneMinuteAgo);

  if ((callsLastMinute ?? 0) >= LLM_LIMITS.maxCallsPerMinute) {
    return {
      allowed: false,
      reason: `Ritmo excedido: ${callsLastMinute} llamadas en el último minuto (máx ${LLM_LIMITS.maxCallsPerMinute}). Posible bucle.`,
    };
  }

  const { count: callsLastHour } = await supabase
    .from('llm_calls')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'ok')
    .gte('created_at', oneHourAgo);

  if ((callsLastHour ?? 0) >= LLM_LIMITS.maxCallsPerHour) {
    return {
      allowed: false,
      reason: `Ritmo excedido: ${callsLastHour} llamadas en la última hora (máx ${LLM_LIMITS.maxCallsPerHour}).`,
    };
  }

  const { data: todayRows } = await supabase
    .from('llm_calls')
    .select('cost_usd')
    .eq('status', 'ok')
    .gte('created_at', startOfDay);
  const costToday = (todayRows ?? []).reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
  if (costToday >= LLM_LIMITS.maxCostPerDayUsd) {
    return {
      allowed: false,
      reason: `Presupuesto diario agotado: $${costToday.toFixed(3)} gastados hoy (máx $${LLM_LIMITS.maxCostPerDayUsd}).`,
    };
  }

  const { data: monthRows } = await supabase
    .from('llm_calls')
    .select('cost_usd')
    .eq('status', 'ok')
    .gte('created_at', startOfMonth);
  const costMonth = (monthRows ?? []).reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);
  if (costMonth >= LLM_LIMITS.maxCostPerMonthUsd) {
    return {
      allowed: false,
      reason: `Presupuesto mensual agotado: $${costMonth.toFixed(2)} gastados este mes (máx $${LLM_LIMITS.maxCostPerMonthUsd}).`,
    };
  }

  return { allowed: true };
}

export interface RecordCallParams {
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  status: 'ok' | 'blocked' | 'error';
  blockReason?: string;
}

/** Registra CADA intento de llamada (permitida, bloqueada o fallida). Es la fuente de la verdad del badge en Angular. */
export async function recordLlmCall(supabase: SupabaseClient, params: RecordCallParams): Promise<number> {
  const cost = params.status === 'ok' ? estimateCost(params.model, params.inputTokens, params.outputTokens) : 0;
  await supabase.from('llm_calls').insert({
    purpose: params.purpose,
    model: params.model,
    input_tokens: params.inputTokens,
    output_tokens: params.outputTokens,
    cost_usd: cost,
    status: params.status,
    block_reason: params.blockReason ?? null,
  });
  return cost;
}
