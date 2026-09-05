import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { isReactiveConsumableUse } from '../_shared/consumables.ts';

interface Body {
  pullId?: unknown;
}

const LEDGER_EVALUATOR_VERSION = 'execution-ledger@1.0.0';

interface PlayerPullRecord {
  player_name: string;
  died: boolean;
  death_cause: { timeMs?: unknown } | null;
  consumables: {
    healthstone?: { available: boolean; used: boolean; usedReactively?: boolean; timestampsMs: number[] };
    healthPotion?: { used: boolean; usedReactively?: boolean; timestampsMs: number[] };
  } | null;
  defensive_pressure_windows_v2: {
    windows?: Array<{ startMs?: unknown; endMs?: unknown }>;
  } | null;
}

function generateDeduplicationKey(
  pullId: string,
  domain: string,
  playerName: string,
  consumableType: string,
  hash: string,
): string {
  return `${pullId}:${domain}:${playerName}:${consumableType}:${hash}`;
}

function stableCausalGroupId(seed: string): string {
  let first = 2_166_136_261;
  let second = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    first = Math.imul(first ^ seed.charCodeAt(index), 16_777_619);
    second = Math.imul(second ^ seed.charCodeAt(seed.length - index - 1), 16_777_619);
  }
  const hex = `${first >>> 0}`.padStart(8, '0') + `${second >>> 0}`.padStart(8, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4000-8000-${hex.slice(4, 16)}`;
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
    return jsonResponse({ ok: false, error: 'Body JSON inválido.' }, 400);
  }

  if (typeof body.pullId !== 'string' || !body.pullId) {
    return jsonResponse({ ok: false, error: 'pullId es obligatorio.' }, 400);
  }

  try {
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Leer pull_evaluation_context para obtener evaluation window
    const { data: contextData, error: contextErr } = await client
      .from('pull_evaluation_context')
      .select('*')
      .eq('pull_id', body.pullId)
      .single();

    if (contextErr || !contextData) {
      return jsonResponse(
        { ok: false, error: `No se encontró contexto para ${body.pullId}` },
        404,
      );
    }

    const pullContext = contextData as any;
    if (pullContext.evaluation_eligible !== true) {
      return jsonResponse({ ok: false, error: 'El pull no es elegible para evaluación.' }, 409);
    }

    const { data: pullData, error: pullErr } = await client
      .from('pulls')
      .select('boss_id, difficulty')
      .eq('id', body.pullId)
      .single();
    if (pullErr || !pullData) {
      return jsonResponse({ ok: false, error: `No se encontró pull ${body.pullId}` }, 404);
    }

    // Leer player_pull_records (disponibilidad de consumibles)
    const { data: recordsData, error: recordsErr } = await client
      .from('player_pull_records')
      .select('player_name, died, death_cause, consumables, defensive_pressure_windows_v2')
      .eq('pull_id', body.pullId);

    if (recordsErr) throw recordsErr;

    const records: PlayerPullRecord[] = recordsData as any[] || [];

    // Generar eventos de consumibles
    const now = new Date().toISOString();
    const eventsToInsert: any[] = [];

    for (const record of records) {
      const deathMs = record.death_cause?.timeMs;
      const healthstone = record.consumables?.healthstone;
      const healthPotion = record.consumables?.healthPotion;
      const pressureWindows = (record.defensive_pressure_windows_v2?.windows ?? []).flatMap((window) => {
        const startMs = window.startMs;
        const endMs = window.endMs;
        return typeof startMs === 'number' && typeof endMs === 'number' && startMs >= 0 && endMs >= startMs
          ? [{ startMs, endMs }]
          : [];
      });
      const healthstoneReactive =
        healthstone?.used === true && isReactiveConsumableUse(healthstone.timestampsMs, pressureWindows);
      const healthPotionReactive =
        healthPotion?.used === true && isReactiveConsumableUse(healthPotion.timestampsMs, pressureWindows);

      // HEALTHSTONE
      if (healthstoneReactive) {
        const timestampMs = healthstone.timestampsMs.find(
          (timestamp) => Number.isFinite(timestamp) && timestamp >= 0,
        );
        if (timestampMs != null) {
          const hash = `hs-reactive_${body.pullId}_${record.player_name}`.substring(0, 8);
          eventsToInsert.push({
          pull_id: body.pullId,
          boss_id: pullData.boss_id,
          difficulty: pullData.difficulty,
          player_name: record.player_name,
          occurrence_id: null,
          causal_group_id: stableCausalGroupId(`healthstone:${body.pullId}:${record.player_name}`),
          timestamp_ms: timestampMs,
          domain: 'consumable',
          event_type: 'healthstone_reactive',
          verdict: 'success',
          reason_code: 'HEALTHSTONE_REACTIVE',
          credit_eligible: false,
          penalty_eligible: false,
          primary_penalty: false,
          severity: 0,
          priority: 3,
          confidence: 'verified',
          evidence: { source: 'player_pull_records', consumable_type: 'healthstone', used_reactively: true },
          policy_version: null,
          context_resolver_version: pullContext.resolver_version,
          occurrence_resolver_version: null,
          ledger_evaluator_version: LEDGER_EVALUATOR_VERSION,
          deduplication_key: generateDeduplicationKey(body.pullId, 'consumable', record.player_name, 'healthstone-reactive', hash),
          created_at: now,
            evaluated_at: now,
          });
        }
      } else if (
        record.died &&
        typeof deathMs === 'number' &&
        deathMs >= 0 &&
        healthstone?.available &&
        !healthstone.used
      ) {
        // Disponible pero no usado → no-hold
        const hash = `hs_${body.pullId}_${record.player_name}`.substring(0, 8);
        eventsToInsert.push({
          pull_id: body.pullId,
          boss_id: pullData.boss_id,
          difficulty: pullData.difficulty,
          player_name: record.player_name,
          occurrence_id: null,
          causal_group_id: stableCausalGroupId(`healthstone:${body.pullId}:${record.player_name}`),
          timestamp_ms: deathMs,
          domain: 'consumable',
          event_type: 'healthstone_not_used',
          verdict: 'failure',
          reason_code: 'HEALTHSTONE_VIABLE_NOT_USED',
          credit_eligible: false,
          penalty_eligible: true,
          primary_penalty: true,
          severity: 30,
          priority: 2,
          confidence: 'verified',
          evidence: {
            source: 'player_pull_records',
            consumable_type: 'healthstone',
            available: true,
            used_reactively: false,
            death_ms: deathMs,
          },
          policy_version: null,
          context_resolver_version: pullContext.resolver_version,
          occurrence_resolver_version: null,
          ledger_evaluator_version: LEDGER_EVALUATOR_VERSION,
          deduplication_key: generateDeduplicationKey(
            body.pullId,
            'consumable',
            record.player_name,
            'healthstone',
            hash,
          ),
          created_at: now,
          evaluated_at: now,
        });
      }

      // HEALTH POTION
      if (healthPotionReactive) {
        const timestampMs = healthPotion.timestampsMs.find(
          (timestamp) => Number.isFinite(timestamp) && timestamp >= 0,
        );
        if (timestampMs != null) {
          const hash = `hp_${body.pullId}_${record.player_name}`.substring(0, 8);
          eventsToInsert.push({
          pull_id: body.pullId,
          boss_id: pullData.boss_id,
          difficulty: pullData.difficulty,
          player_name: record.player_name,
          occurrence_id: null,
          causal_group_id: stableCausalGroupId(`health-potion:${body.pullId}:${record.player_name}`),
          timestamp_ms: timestampMs,
          domain: 'consumable',
          event_type: 'health_potion_reactive',
          verdict: 'success',
          reason_code: 'HEALTH_POTION_REACTIVE',
          credit_eligible: false,
          penalty_eligible: false,
          primary_penalty: false,
          severity: 0,
          priority: 3,
          confidence: 'verified',
          evidence: {
            source: 'player_pull_records',
            consumable_type: 'health_potion',
            used_reactively: true,
            death_ms: typeof deathMs === 'number' ? deathMs : null,
          },
          policy_version: null,
          context_resolver_version: pullContext.resolver_version,
          occurrence_resolver_version: null,
          ledger_evaluator_version: LEDGER_EVALUATOR_VERSION,
          deduplication_key: generateDeduplicationKey(
            body.pullId,
            'consumable',
            record.player_name,
            'health_potion',
            hash,
          ),
          created_at: now,
            evaluated_at: now,
          });
        }
      }
    }

    // UPSERT idempotente
    const { data: inserted, error: upsertErr } = await client
      .from('player_execution_events')
      .upsert(eventsToInsert, {
        onConflict: 'pull_id,ledger_evaluator_version,deduplication_key',
        ignoreDuplicates: false,
      })
      .select('id, player_name, event_type, verdict');

    if (upsertErr) throw upsertErr;

    const result = (inserted as Record<string, unknown>[] | null) || [];

    return jsonResponse({
      ok: true,
      action: 'materialize_consumable_execution',
      pullId: body.pullId,
      playersWithDeaths: records.filter((r) => r.died).length,
      eventsCreated: result.length,
      ledgerEvaluatorVersion: LEDGER_EVALUATOR_VERSION,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('materialize-consumable-execution error:', error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
