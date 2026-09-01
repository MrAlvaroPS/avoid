import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { DEFENSIVE_EXECUTION_EVALUATOR_VERSION } from '../_shared/defensive-execution-evaluator.ts';
import {
  defensiveV2BackfillState,
  defensiveV2Capabilities,
} from '../_shared/defensive-v2-readiness.ts';

type ReadinessState = 'ready' | 'partial' | 'missing';

interface ReadinessCheck {
  id: 'resolver_schema' | 'override_audit' | 'plan_schema' | 'evaluator_schema' | 'reliability_v2' | 'backfill';
  label: string;
  state: ReadinessState;
  detail: string;
  requiredMigration: string | null;
  completed?: number;
  total?: number;
}

function databaseErrorDetail(error: {
  message?: string;
  details?: string;
  hint?: string;
  code?: string;
}): string {
  const parts = [
    error.message?.trim(),
    error.details?.trim(),
    error.hint?.trim() ? `hint: ${error.hint.trim()}` : '',
    error.code?.trim() ? `código ${error.code.trim()}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Error de schema sin detalle devuelto por PostgREST.';
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  async function probe(
    id: ReadinessCheck['id'],
    label: string,
    requiredMigration: string,
    sources: { table: string; columns: string }[],
  ): Promise<ReadinessCheck> {
    for (const source of sources) {
      // Una respuesta HEAD no puede incluir el JSON de error de PostgREST.
      // Si falta una columna, supabase-js acaba exponiendo `{}` y el panel
      // pierde precisamente message/code/hint, que son lo importante aquí.
      // GET + limit(1) conserva el error estructurado y mantiene la sonda
      // acotada sin pedir count ni recorrer la tabla completa.
      const { error } = await supabase.from(source.table).select(source.columns).limit(1);
      if (error) {
        return {
          id,
          label,
          state: 'missing',
          detail: `${source.table} [${source.columns}]: ${databaseErrorDetail(error)}`,
          requiredMigration,
        };
      }
    }
    return { id, label, state: 'ready', detail: 'Esquema disponible.', requiredMigration };
  }

  try {
    const [resolverSchema, overrideAudit, planSchema, evaluatorSchema, reliabilitySchema] = await Promise.all([
      probe('resolver_schema', 'Resolver y builds', 'M1–M3 · 20260831200000–20260831220000', [
        { table: 'cooldown_catalog', columns: 'spell_id,targeting_mode' },
        { table: 'defensive_spec_profiles', columns: 'class,spec,game_build' },
        { table: 'defensive_modifier_rules', columns: 'target_spell_id,game_build,effect_field' },
        { table: 'player_latest_build', columns: 'player_name,talent_build_fingerprint,game_build' },
        { table: 'player_defensive_overrides', columns: 'player_name,spell_id,game_build,build_fingerprint,active' },
      ]),
      probe('override_audit', 'Override exacto auditable', 'M10 · 20260901150000', [
        { table: 'player_defensive_override_audit', columns: 'override_id,action,automatic_effective_cooldown_ms,automatic_effective_duration_ms,reason,changed_by' },
      ]),
      probe('plan_schema', 'Planes desplegados', 'M7 · 20260901110000', [
        { table: 'defensive_plan_versions', columns: 'id,status,solver_version,content_fingerprint' },
        { table: 'defensive_plan_members', columns: 'plan_version_id,player_name,effective_kit' },
        { table: 'defensive_plan_slots', columns: 'id,plan_version_id,assigned_player_key,occurrence_time_ms' },
        { table: 'pull_defensive_plan_binding', columns: 'pull_id,plan_version_id,bound_at' },
      ]),
      probe('evaluator_schema', 'Evaluator post-pull', 'M8 · 20260901120000', [
        { table: 'player_pull_defensive_evaluations', columns: 'pull_id,player_name,evaluator_version,data_confidence,management_score' },
      ]),
      probe('reliability_v2', 'Vista Fiabilidad v2', 'M9 · 20260901130000', [
        {
          table: 'player_pull_reliability_inputs',
          columns:
            'pull_id,player_name,defensive_management_score_v2,defensive_management_decision_count,defensive_required_count,defensive_required_success_count,defensive_broken_reservation_count,defensive_death_viable_cd_count,defensive_evaluation_confidence,defensive_evaluator_version',
        },
      ]),
    ]);

    let backfill: ReadinessCheck = {
      id: 'backfill',
      label: 'Backfill evaluator v2',
      state: 'missing',
      detail: 'No se puede medir hasta que M9 esté disponible.',
      requiredMigration: 'M8–M9 + reanálisis controlado',
      completed: 0,
      total: 0,
    };

    if (reliabilitySchema.state === 'ready') {
      const totalQuery = supabase
        .from('player_pull_reliability_inputs')
        .select('pull_id', { count: 'exact', head: true });
      const completedQuery = supabase
        .from('player_pull_reliability_inputs')
        .select('pull_id', { count: 'exact', head: true })
        .not('defensive_management_decision_count', 'is', null)
        .not('defensive_required_count', 'is', null)
        .not('defensive_required_success_count', 'is', null)
        .not('defensive_broken_reservation_count', 'is', null)
        .not('defensive_death_viable_cd_count', 'is', null)
        .not('defensive_evaluation_confidence', 'is', null)
        .eq('defensive_evaluator_version', DEFENSIVE_EXECUTION_EVALUATOR_VERSION)
        .or('defensive_management_decision_count.eq.0,defensive_management_score_v2.not.is.null');
      const [totalResult, completedResult] = await Promise.all([totalQuery, completedQuery]);
      const countError = totalResult.error ?? completedResult.error;
      if (countError) {
        backfill = {
          ...backfill,
          detail: `No se pudo medir: ${databaseErrorDetail(countError)}`,
        };
      } else {
        const total = totalResult.count ?? 0;
        const completed = completedResult.count ?? 0;
        backfill = {
          ...backfill,
          state: defensiveV2BackfillState(total, completed),
          detail:
            total === 0
              ? 'No hay filas evaluables todavía.'
              : `${completed}/${total} filas están materializadas con ${DEFENSIVE_EXECUTION_EVALUATOR_VERSION} y conteos completos.`,
          completed,
          total,
        };
      }
    }

    const checks = [resolverSchema, overrideAudit, planSchema, evaluatorSchema, reliabilitySchema, backfill];
    const schemaReady = checks.slice(0, 5).every((check) => check.state === 'ready');
    const capabilities = defensiveV2Capabilities({
      resolverEndpoint: true,
      resolverSchema: resolverSchema.state,
      planSchema: planSchema.state,
      evaluatorSchema: evaluatorSchema.state,
      reliabilitySchema: reliabilitySchema.state,
      overrideAudit: overrideAudit.state,
      backfill: backfill.state,
    });
    return jsonResponse({
      ok: true,
      state: !schemaReady ? 'missing' : backfill.state === 'ready' ? 'ready' : 'partial',
      checkedAt: new Date().toISOString(),
      evaluatorVersion: DEFENSIVE_EXECUTION_EVALUATOR_VERSION,
      checks,
      capabilities,
    });
  } catch (err) {
    console.error('defensive-v2-readiness error:', err);
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
