import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import type {
  EvaluationConfidence,
  MechanicPolicyContract,
  OccurrenceOutcome,
} from '../_shared/combat-evaluation-contract.ts';
import { EVENT_BACKED_OCCURRENCE_RESOLVER_VERSION } from '../_shared/mechanic-occurrence-event-resolver.ts';
import {
  MECHANIC_ATTRIBUTION_SHADOW_VERSION,
  evaluateMechanicAttributionShadow,
} from '../_shared/mechanic-attribution-shadow.ts';

interface Body {
  pullId?: unknown;
}

function policyFromSnapshot(snapshot: Record<string, unknown>): MechanicPolicyContract {
  return {
    bossId: snapshot['boss_id'] as string,
    difficulty: snapshot['difficulty'] as string,
    mechanicKey: snapshot['mechanic_key'] as string,
    policyVersion: snapshot['policy_version'] as number,
    displayCategory: snapshot['display_category'] as string | null,
    targetingMode: snapshot['targeting_mode'] as MechanicPolicyContract['targetingMode'],
    requiredResponse: snapshot['required_response'] as string | null,
    responsibilityMode: snapshot['responsibility_mode'] as MechanicPolicyContract['responsibilityMode'],
    damageSemantics: snapshot['damage_semantics'] as MechanicPolicyContract['damageSemantics'],
    failurePropagation: snapshot['failure_propagation'] as MechanicPolicyContract['failurePropagation'],
    assignmentMode: snapshot['assignment_mode'] as MechanicPolicyContract['assignmentMode'],
    defensiveExpectation: snapshot['defensive_expectation'] as MechanicPolicyContract['defensiveExpectation'],
    creditScope: snapshot['credit_scope'] as MechanicPolicyContract['creditScope'],
    penaltyScope: snapshot['penalty_scope'] as MechanicPolicyContract['penaltyScope'],
    causalRule: (snapshot['causal_rule'] as Record<string, unknown>) ?? {},
    confidence: snapshot['confidence'] as EvaluationConfidence,
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function assignmentPlayers(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [];
  const row = snapshot as Record<string, unknown>;
  const assignedPlayer = typeof row['assignedPlayer'] === 'string' ? [row['assignedPlayer']] : [];
  const assignedGroup = stringArray(row['assignedGroup']);
  return [...new Set([...assignedPlayer, ...assignedGroup])];
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
    const client = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: pullData, error: pullError } = await client
      .from('pulls')
      .select('id,boss_id,difficulty,ingestion_status')
      .eq('id', body.pullId)
      .single();
    if (pullError || !pullData) {
      return jsonResponse({ ok: false, error: `No se encontró pull ${body.pullId}.` }, 404);
    }
    if ((pullData as Record<string, unknown>)['ingestion_status'] !== 'complete') {
      return jsonResponse({ ok: false, error: 'El pull no tiene ingesta completa.' }, 400);
    }

    const pull = pullData as { id: string; boss_id: string; difficulty: string };
    const { data: occurrenceData, error: occurrenceError } = await client
      .from('mechanic_occurrence_evaluations')
      .select('*')
      .eq('pull_id', body.pullId)
      .eq('occurrence_resolver_version', EVENT_BACKED_OCCURRENCE_RESOLVER_VERSION)
      .order('resolve_ms', { ascending: true })
      .order('mechanic_key', { ascending: true })
      .order('occurrence_index', { ascending: true });
    if (occurrenceError) throw occurrenceError;

    const occurrences = (occurrenceData ?? []) as Record<string, unknown>[];
    if (occurrences.length === 0) {
      return jsonResponse(
        {
          ok: false,
          error:
            `No hay occurrences ${EVENT_BACKED_OCCURRENCE_RESOLVER_VERSION} para el pull. ` +
            'Ejecuta evaluate-mechanic-occurrences antes del shadow attribution.',
        },
        409,
      );
    }

    const { data: versionRows, error: versionError } = await client
      .from('boss_mechanic_policy_versions')
      .select('mechanic_key,policy_version,snapshot,confidence')
      .eq('boss_id', pull.boss_id)
      .eq('difficulty', pull.difficulty);
    if (versionError) throw versionError;

    const policyByVersion = new Map<string, MechanicPolicyContract>();
    for (const row of (versionRows ?? []) as Record<string, unknown>[]) {
      const snapshot = row['snapshot'];
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
      const policy = policyFromSnapshot(snapshot as Record<string, unknown>);
      policyByVersion.set(`${policy.mechanicKey}:${policy.policyVersion}`, policy);
    }

    const rows = occurrences.map((occurrence) => {
      const evidence = (occurrence['evidence'] as Record<string, unknown>) ?? {};
      const policy = policyByVersion.get(
        `${occurrence['mechanic_key'] as string}:${occurrence['policy_version'] as number}`,
      ) ?? null;
      const decision = evaluateMechanicAttributionShadow({
        outcome: occurrence['outcome'] as OccurrenceOutcome,
        occurrenceConfidence: occurrence['confidence'] as EvaluationConfidence,
        category: evidence['category'] as string | null | undefined,
        responsibility: evidence['responsibility'] as string | null | undefined,
        playersHitNames: stringArray(evidence['players_hit_names']),
        policy,
        assignedPlayers: assignmentPlayers(occurrence['assignment_snapshot']),
      });

      return {
        occurrence_id: occurrence['id'],
        pull_id: occurrence['pull_id'],
        boss_id: occurrence['boss_id'],
        difficulty: occurrence['difficulty'],
        mechanic_key: occurrence['mechanic_key'],
        occurrence_index: occurrence['occurrence_index'],
        attribution_status: decision.status,
        reason_code: decision.reason,
        responsible_players: decision.responsiblePlayers,
        safety_v1_players: decision.safetyV1Players,
        new_accusation_players: decision.newAccusationPlayers,
        confidence: decision.confidence,
        evidence_claims: decision.evidenceClaims,
        evaluator_version: decision.evaluatorVersion,
        occurrence_resolver_version: occurrence['occurrence_resolver_version'],
        policy_version: occurrence['policy_version'],
        evaluated_at: new Date().toISOString(),
      };
    });

    const { data: persisted, error: upsertError } = await client
      .from('mechanic_attribution_shadow_evaluations')
      .upsert(rows, {
        onConflict: 'occurrence_id,evaluator_version',
        ignoreDuplicates: false,
      })
      .select('*');
    if (upsertError) throw upsertError;

    const persistedRows = (persisted ?? []) as Record<string, unknown>[];
    const countStatus = (status: string) =>
      persistedRows.filter((row) => row['attribution_status'] === status).length;
    const canonicalVerifiedPlayers = persistedRows.reduce(
      (sum, row) => sum + stringArray(row['responsible_players']).length,
      0,
    );
    const safetyV1Players = persistedRows.reduce(
      (sum, row) => sum + stringArray(row['safety_v1_players']).length,
      0,
    );
    const newAccusationCount = persistedRows.reduce(
      (sum, row) => sum + stringArray(row['new_accusation_players']).length,
      0,
    );

    if (newAccusationCount !== 0) {
      // Should also be impossible at DB level. Keep this runtime gate so a
      // future schema drift cannot silently expand blame.
      throw new Error(`Shadow invariant violated: ${newAccusationCount} new accusation(s).`);
    }

    return jsonResponse({
      ok: true,
      action: 'evaluate_mechanic_attribution_shadow',
      pullId: body.pullId,
      evaluatorVersion: MECHANIC_ATTRIBUTION_SHADOW_VERSION,
      occurrenceResolverVersion: EVENT_BACKED_OCCURRENCE_RESOLVER_VERSION,
      occurrenceCount: persistedRows.length,
      statuses: {
        verified: countStatus('verified'),
        roleOnly: countStatus('role_only'),
        raidOnly: countStatus('raid_only'),
        unresolved: countStatus('unresolved'),
        notApplicable: countStatus('not_applicable'),
      },
      safetyV1PlayerCount: safetyV1Players,
      canonicalVerifiedPlayerCount: canonicalVerifiedPlayers,
      newAccusationCount,
      evaluations: persistedRows,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('evaluate-mechanic-attribution-shadow error:', error);
    return jsonResponse({ ok: false, error: message }, 500);
  }
});
