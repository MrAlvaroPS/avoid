import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import { errorMessage } from '../_shared/error-message.ts';

interface PlanAssignmentInput {
  windowKey: string;
  plannedTimeMs: number;
  impactScore: number;
  priority: number | null;
  abilityIds: number[];
  abilityNames: string[];
  primaryAbilityId: number;
  occurrenceIndex: number;
  defensiveSpellId: number;
  effectiveCooldownMs: number;
  cooldownExplanation: string;
  prewarnSeconds?: number;
  triggerType?: 'bossmod' | 'time';
  bossmodSpellId?: number | null;
  bossmodCounter?: number | null;
  locked?: boolean;
}

interface ReplaceRequest {
  action: 'replace';
  bossId: string;
  difficulty: string;
  characterId: number;
  playerName: string;
  class: string;
  spec: string;
  talentSpellIds: number[];
  loadoutHash: string;
  loadoutObservedAt?: string | null;
  catalogVersion?: string | null;
  mechanicProfileVersion?: string | null;
  assignments: PlanAssignmentInput[];
}

interface DeleteRequest {
  action: 'delete';
  bossId: string;
  difficulty: string;
  class?: string;
  characterId?: number;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  let body: ReplaceRequest | DeleteRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.bossId || !body.difficulty) return jsonResponse({ ok: false, error: 'bossId y difficulty son obligatorios' }, 400);
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    if (body.action === 'delete') {
      let query = supabase.from('defensive_plan_runs').delete().eq('boss_id', body.bossId).eq('difficulty', body.difficulty);
      if (body.class) query = query.eq('class', body.class);
      if (body.characterId != null) query = query.eq('character_id', body.characterId);
      const { error } = await query;
      if (error) throw error;
      return jsonResponse({ ok: true });
    }

    if (body.action !== 'replace') return jsonResponse({ ok: false, error: 'action inválida' }, 400);
    if (!body.characterId || !body.playerName || !body.class || !body.spec || !body.loadoutHash || !Array.isArray(body.assignments)) {
      return jsonResponse({ ok: false, error: 'Faltan datos obligatorios del plan' }, 400);
    }
    const invalidAssignment = body.assignments.find(
      (assignment) =>
        !assignment.windowKey ||
        !Number.isFinite(assignment.plannedTimeMs) ||
        assignment.plannedTimeMs < 0 ||
        !assignment.primaryAbilityId ||
        !assignment.defensiveSpellId ||
        !Number.isFinite(assignment.effectiveCooldownMs) ||
        assignment.effectiveCooldownMs < 0 ||
        assignment.occurrenceIndex < 1,
    );
    if (invalidAssignment) return jsonResponse({ ok: false, error: `Asignación inválida: ${invalidAssignment.windowKey || '(sin clave)'}` }, 400);

    const normalizedAssignments = body.assignments.map((assignment) => ({
      ...assignment,
      plannedTimeMs: Math.round(assignment.plannedTimeMs),
      effectiveCooldownMs: Math.round(assignment.effectiveCooldownMs),
      prewarnSeconds: assignment.prewarnSeconds ?? 5,
      triggerType: assignment.triggerType ?? 'bossmod',
      bossmodSpellId: assignment.bossmodSpellId ?? assignment.primaryAbilityId,
      bossmodCounter: assignment.bossmodCounter ?? assignment.occurrenceIndex,
      locked: assignment.locked ?? false,
    }));
    const { data: planId, error: replaceError } = await supabase.rpc('replace_defensive_plan_v2', {
      p_run: {
        bossId: body.bossId,
        difficulty: body.difficulty,
        characterId: body.characterId,
        playerName: body.playerName,
        class: body.class,
        spec: body.spec,
        talentSpellIds: body.talentSpellIds ?? [],
        loadoutHash: body.loadoutHash,
        loadoutObservedAt: body.loadoutObservedAt ?? '',
        catalogVersion: body.catalogVersion ?? '',
        mechanicProfileVersion: body.mechanicProfileVersion ?? '',
      },
      p_assignments: normalizedAssignments,
    });
    if (replaceError) throw replaceError;
    return jsonResponse({ ok: true, planId, assignmentCount: body.assignments.length });
  } catch (err) {
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});
