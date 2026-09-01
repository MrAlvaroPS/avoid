import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import {
  EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
  effectiveDefensiveDataFromDatabaseRows,
  fingerprintTalentBuild,
  normalizeTalentBuild,
  resolveEffectiveDefensiveKit,
  type DefensiveResolutionConfidence,
  type TalentBuildNode,
} from '../_shared/effective-defensives.ts';
import {
  DEFENSIVE_PLAN_SOLVER_VERSION,
  solveDefensivePlan,
  type MechanicOccurrence,
  type SolverPlayerKit,
  type SolverReservation,
} from '../_shared/defensive-plan-solver.ts';
import { persistDefensivePlanDraft } from '../_shared/defensive-plan-persistence.ts';
import { validateDefensivePlanDraft, type CreateDraftRequest } from '../_shared/defensive-plan-contract.ts';

interface RequestedMember {
  playerName: string;
  playerKey?: string;
  raidGroup?: number | null;
  role?: 'tank' | 'healer' | 'dps';
  included?: boolean;
}

interface GeneratePlanRequest {
  action?: 'health';
  bossId?: string;
  difficulty?: string;
  name?: string;
  mode?: 'full' | 'partial' | 'no_plan';
  members?: RequestedMember[];
  /** Selección explícita por jugador. Si no existe, solo entran personales;
   * semi/external siempre requieren opt-in y utility nunca entra al solver. */
  resourceSelections?: { playerName: string; spellIds: number[] }[];
  reservations?: SolverReservation[];
  maxSearchNodes?: number;
  supersedesId?: string | null;
  notes?: string | null;
}

interface RosterRow {
  character_id: number;
  name: string;
  class: string;
  role: string;
}

interface LatestBuildRow {
  player_name: string;
  class: string;
  spec: string | null;
  talent_build: TalentBuildNode[] | null;
  talent_build_fingerprint: string | null;
  game_build: string | null;
  game_build_source: string | null;
  game_build_confidence: DefensiveResolutionConfidence | null;
  observed_at: string | null;
  report_code: string | null;
  pull_id: string | null;
}

interface OccurrenceRow {
  ability_id: number;
  occurrence_index: number;
  median_offset_ms: number;
  p10_offset_ms: number;
  p90_offset_ms: number;
  updated_at: string;
}

interface PlanningRow {
  ability_id: number;
  world_priority: number | null;
  world_requires_defensive: boolean | null;
  world_median_unmitigated_damage: number | null;
  local_death_count: number | null;
  local_raid_impact_score: number | null;
  local_individual_lethality_score: number | null;
  combined_planning_priority: number | null;
  updated_at: string | null;
}

interface CandidateRow {
  ability_id: number;
  responsibility: string | null;
}

interface TemplateRow {
  ability_id: number;
  class: string;
  spec: string;
  defensive_spell_id: number;
  prewarn_seconds: number;
  trigger_type: 'bossmod' | 'time';
  bossmod_spell_id: number | null;
  notes: string | null;
}

function roleFromRoster(value: string): 'tank' | 'healer' | 'dps' {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'tank') return 'tank';
  if (normalized === 'heal' || normalized === 'healer') return 'healer';
  return 'dps';
}

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function latestTimestamp(rows: unknown[]): string | null {
  return rows
    .map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>)['updated_at'] : null))
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1) ?? null;
}

function rolesForResponsibility(value: string | null): ('tank' | 'healer' | 'dps')[] | undefined {
  if (value === 'tank') return ['tank'];
  if (value === 'healer') return ['healer'];
  if (value === 'dps') return ['dps'];
  return undefined;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: GeneratePlanRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (body.action === 'health') {
    return jsonResponse({
      ok: true,
      generatorVersion: 'generate-defensive-plan@2.1.0',
      solverVersion: DEFENSIVE_PLAN_SOLVER_VERSION,
      resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
    });
  }
  if (!body.bossId?.trim() || !body.difficulty?.trim() || !body.name?.trim() || !body.mode) {
    return jsonResponse({ ok: false, error: 'bossId, difficulty, name y mode son obligatorios.' }, 400);
  }
  if (!['full', 'partial', 'no_plan'].includes(body.mode)) return jsonResponse({ ok: false, error: 'mode inválido.' }, 400);
  if (!Array.isArray(body.members) || !body.members.length) return jsonResponse({ ok: false, error: 'members debe contener el roster a desplegar.' }, 400);
  if (body.mode === 'no_plan' && body.reservations?.some((reservation) => reservation.hard || reservation.locked)) {
    return jsonResponse({ ok: false, error: 'El modo no_plan no admite reservas hard/locked.' }, 400);
  }
  const requestedNames = body.members.map((member) => member.playerName?.trim()).filter(Boolean);
  if (new Set(requestedNames).size !== body.members.length) return jsonResponse({ ok: false, error: 'Cada member necesita un playerName único.' }, 400);
  if (
    body.resourceSelections != null &&
    (!Array.isArray(body.resourceSelections) || body.resourceSelections.some((selection) =>
      !selection?.playerName?.trim() ||
      !Array.isArray(selection.spellIds) ||
      selection.spellIds.some((spellId) => !Number.isInteger(spellId) || spellId <= 0)
    ))
  ) {
    return jsonResponse({ ok: false, error: 'resourceSelections contiene una selección inválida.' }, 400);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const [rosterResult, latestResult, occurrenceResult, planningResult, candidateResult, templateResult] = await Promise.all([
      supabase.from('wowaudit_roster').select('character_id,name,class,role').in('name', requestedNames),
      supabase.from('player_latest_build').select('*').in('player_name', requestedNames),
      supabase
        .from('boss_mechanic_occurrence_profile')
        .select('ability_id,occurrence_index,median_offset_ms,p10_offset_ms,p90_offset_ms,updated_at')
        .eq('boss_id', body.bossId)
        .eq('difficulty', body.difficulty),
      supabase.from('boss_mechanic_defensive_planning_view').select('*').eq('boss_id', body.bossId).eq('difficulty', body.difficulty),
      supabase.from('boss_mechanics_candidates').select('ability_id,responsibility').eq('boss_id', body.bossId).eq('difficulty', body.difficulty),
      supabase.from('mechanic_defensive_assignments').select('*').eq('boss_id', body.bossId).eq('difficulty', body.difficulty),
    ]);
    for (const result of [rosterResult, latestResult, occurrenceResult, planningResult, candidateResult, templateResult]) {
      if (result.error) throw result.error;
    }
    const occurrenceRows = (occurrenceResult.data ?? []) as OccurrenceRow[];
    if (!occurrenceRows.length) return jsonResponse({ ok: false, error: 'No hay perfiles por ocurrencia; sincroniza primero el boss y dificultad.' }, 409);

    const rosterByName = new Map(((rosterResult.data ?? []) as RosterRow[]).map((row) => [row.name, row]));
    const latestByName = new Map(((latestResult.data ?? []) as LatestBuildRow[]).map((row) => [row.player_name, row]));
    const memberSources = body.members.map((requested) => {
      const roster = rosterByName.get(requested.playerName.trim());
      const latest = latestByName.get(requested.playerName.trim());
      const className = latest?.class || roster?.class || null;
      if (!className) throw new Error(`No se pudo resolver la clase de ${requested.playerName}.`);
      return { requested, roster, latest, className };
    });
    const classes = [...new Set(memberSources.map((source) => source.className))];
    const builds = [...new Set(memberSources.map((source) => source.latest?.game_build).filter((value): value is string => Boolean(value)))];

    const [catalogResult, profileResult, ruleResult, overrideResult, lookupResult] = await Promise.all([
      supabase.from('cooldown_catalog').select('*').in('class', classes).eq('excluded', false),
      supabase.from('defensive_spec_profiles').select('*').in('class', classes),
      supabase.from('defensive_modifier_rules').select('*').in('class', classes).eq('active', true),
      supabase.from('player_defensive_overrides').select('*').in('class', classes).eq('active', true),
      builds.length
        ? supabase.from('talent_spell_lookup').select('build,entry_to_spell').in('build', builds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const result of [catalogResult, profileResult, ruleResult, overrideResult, lookupResult]) {
      if (result.error) throw result.error;
    }
    const resolverData = effectiveDefensiveDataFromDatabaseRows({
      catalogRows: catalogResult.data ?? [],
      specProfileRows: profileResult.data ?? [],
      modifierRuleRows: ruleResult.data ?? [],
      overrideRows: overrideResult.data ?? [],
    });
    const lookupByBuild = new Map(
      ((lookupResult.data ?? []) as { build: string; entry_to_spell: Record<string, number> }[]).map((row) => [row.build, row.entry_to_spell]),
    );

    const memberSnapshots: CreateDraftRequest['members'] = [];
    const solverPlayers: SolverPlayerKit[] = [];
    const resourceSelectionByPlayer = new Map(
      (body.resourceSelections ?? []).map((selection) => [
        selection.playerName.trim().toLocaleLowerCase(),
        new Set(selection.spellIds),
      ]),
    );
    for (const source of memberSources) {
      const playerName = source.requested.playerName.trim();
      const gameBuild = source.latest?.game_build ?? null;
      const entryToSpell = gameBuild ? lookupByBuild.get(gameBuild) : undefined;
      const talentBuild = normalizeTalentBuild(
        source.latest?.talent_build?.map((node) => {
          const resolvedSpellId = node.spellId ?? (entryToSpell ? finite(entryToSpell[String(node.id)], 0) : 0);
          return resolvedSpellId > 0 ? { ...node, spellId: resolvedSpellId } : { id: node.id, nodeID: node.nodeID, rank: node.rank };
        }) ?? null,
      );
      const buildFingerprint = gameBuild
        ? await fingerprintTalentBuild(source.className, source.latest?.spec ?? null, gameBuild, talentBuild)
        : null;
      const allTalentSpellIds = entryToSpell
        ? new Set(Object.values(entryToSpell).map(Number).filter((value) => Number.isInteger(value) && value > 0))
        : null;
      const buildConfidence = source.latest?.game_build_confidence ?? 'uncertain';
      const kit = resolveEffectiveDefensiveKit(
        {
          className: source.className,
          specName: source.latest?.spec ?? null,
          talentBuild,
          buildFingerprint,
          gameBuild,
          gameBuildConfidence: buildConfidence,
          playerIdentity: { characterId: source.roster?.character_id, playerName },
          includeExternal: true,
          allTalentSpellIds,
          talentLookupComplete: allTalentSpellIds != null,
        },
        resolverData,
      );
      const playerKey = source.requested.playerKey?.trim() || (source.roster ? `character:${source.roster.character_id}` : `name:${playerName.toLowerCase()}`);
      const role = source.requested.role ?? roleFromRoster(source.roster?.role ?? 'dps');
      const included = source.requested.included !== false;
      const explicitSelection = resourceSelectionByPlayer.get(playerName.toLocaleLowerCase());
      const planningKit = kit.filter((defensive) =>
        defensive.category !== 'utility' &&
        (explicitSelection ? explicitSelection.has(defensive.spellId) : defensive.category === 'personal_defensive'),
      );
      solverPlayers.push({
        playerKey,
        playerName,
        className: source.className,
        specName: source.latest?.spec ?? null,
        role,
        raidGroup: source.requested.raidGroup ?? null,
        buildFingerprint,
        included,
        defensives: planningKit,
      });
      memberSnapshots.push({
        playerKey,
        characterId: source.roster?.character_id ?? null,
        playerName,
        class: source.className,
        spec: source.latest?.spec ?? null,
        role,
        raidGroup: source.requested.raidGroup ?? null,
        buildFingerprint,
        gameBuild,
        buildObservedAt: source.latest?.observed_at ?? null,
        buildConfidence,
        included,
        resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
        effectiveKit: kit,
        provenance: {
          sourceReportCode: source.latest?.report_code ?? null,
          sourcePullId: source.latest?.pull_id ?? null,
          gameBuildSource: source.latest?.game_build_source ?? null,
          talentLookupComplete: allTalentSpellIds != null,
          planningResourceSpellIds: planningKit.map((defensive) => defensive.spellId),
          optionalResourcesRequireOptIn: true,
        },
      });
    }

    const planningByAbility = new Map(((planningResult.data ?? []) as PlanningRow[]).map((row) => [Number(row.ability_id), row]));
    const candidateByAbility = new Map(((candidateResult.data ?? []) as CandidateRow[]).map((row) => [Number(row.ability_id), row]));
    const occurrences: MechanicOccurrence[] = occurrenceRows.map((row) => {
      const planning = planningByAbility.get(Number(row.ability_id));
      const candidate = candidateByAbility.get(Number(row.ability_id));
      const priority = Math.max(1, Math.min(5, Math.trunc(finite(planning?.combined_planning_priority, 1))));
      const requirementLevel = planning?.world_requires_defensive === true ? 'required' : priority >= 3 ? 'recommended' : 'optional';
      const uncertainty = Math.max(
        Math.abs(finite(row.median_offset_ms) - finite(row.p10_offset_ms)),
        Math.abs(finite(row.p90_offset_ms) - finite(row.median_offset_ms)),
      );
      return {
        abilityId: Number(row.ability_id),
        occurrenceIndex: Number(row.occurrence_index),
        timeMs: Math.max(0, Math.trunc(finite(row.median_offset_ms))),
        timeUncertaintyMs: Math.max(0, Math.ceil(uncertainty)),
        requirementLevel,
        priority,
        raidImpactScore: finite(planning?.local_raid_impact_score, finite(planning?.world_median_unmitigated_damage)),
        individualLethalityScore: finite(planning?.local_individual_lethality_score),
        applicableRoles: rolesForResponsibility(candidate?.responsibility ?? null),
        demandType: candidate?.responsibility === 'tank' ? 'tank' : candidate?.responsibility === 'raid' ? 'raid' : 'personal',
        emergencyEligible: requirementLevel === 'required' && (priority >= 5 || finite(planning?.local_death_count) > 0),
        prewarnMs: 5_000,
      };
    });

    const templates = (templateResult.data ?? []) as TemplateRow[];
    const occurrenceByAbility = new Map<number, MechanicOccurrence[]>();
    for (const occurrence of occurrences) {
      const rows = occurrenceByAbility.get(occurrence.abilityId) ?? [];
      rows.push(occurrence);
      occurrenceByAbility.set(occurrence.abilityId, rows);
    }
    const templateReservations: SolverReservation[] = [];
    for (const template of templates) {
      for (const player of solverPlayers.filter((entry) => entry.className === template.class && entry.specName === template.spec)) {
        for (const occurrence of occurrenceByAbility.get(Number(template.ability_id)) ?? []) {
          templateReservations.push({
            playerKey: player.playerKey,
            spellId: Number(template.defensive_spell_id),
            abilityId: occurrence.abilityId,
            occurrenceIndex: occurrence.occurrenceIndex,
            plannedCastAtMs: Math.max(0, occurrence.timeMs - Math.max(0, template.prewarn_seconds) * 1000),
            hard: false,
            source: 'template',
            triggerMode: template.trigger_type,
            bossmodSpellId: template.bossmod_spell_id,
            bossmodCounterVerified: false,
            notes: template.notes,
          });
        }
      }
    }

    const result = solveDefensivePlan({
      mode: body.mode,
      occurrences,
      players: solverPlayers,
      reservations: [...templateReservations, ...(body.reservations ?? [])],
      maxSearchNodes: body.maxSearchNodes,
    });
    if (!result.feasible) return jsonResponse({ ok: false, error: 'Las reservas hard contienen conflictos.', solver: result }, 409);

    const rosterFingerprint = await sha256(
      memberSnapshots
        .map((member) => ({ playerKey: member.playerKey, buildFingerprint: member.buildFingerprint, included: member.included }))
        .sort((left, right) => left.playerKey.localeCompare(right.playerKey)),
    );
    const memberBuilds = [
      ...new Set(
        memberSnapshots
          .filter((member) => member.included !== false)
          .map((member) => member.gameBuild)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    ];
    const sourceProfileRevision = [...occurrenceRows.map((row) => row.updated_at), ...((planningResult.data ?? []) as PlanningRow[]).map((row) => row.updated_at).filter(Boolean)]
      .sort()
      .at(-1) ?? null;
    const sourceCatalogRevision = latestTimestamp([
      ...(catalogResult.data ?? []),
      ...(profileResult.data ?? []),
      ...(ruleResult.data ?? []),
      ...(overrideResult.data ?? []),
    ]);
    const draft: CreateDraftRequest = {
      action: 'create_draft',
      bossId: body.bossId,
      difficulty: body.difficulty,
      name: body.name,
      planMode: body.mode,
      planningQuality: result.planningQuality,
      gameBuild: memberBuilds.length === 1 ? memberBuilds[0] : null,
      solverVersion: DEFENSIVE_PLAN_SOLVER_VERSION,
      resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
      backendResolved: true,
      rosterFingerprint,
      sourceProfileRevision,
      sourceCatalogRevision,
      supersedesId: body.supersedesId ?? null,
      uncertaintyMarginMs: Math.max(0, ...occurrences.map((occurrence) => occurrence.timeUncertaintyMs)),
      fallbackUsed: result.planningQuality === 'fallback_greedy',
      rosterSnapshotAt: new Date().toISOString(),
      diagnostics: {
        ...result.diagnostics,
        strictScoringEligible: result.strictScoringEligible,
        mixedGameBuilds: memberBuilds.length > 1,
      },
      notes: body.notes ?? null,
      members: memberSnapshots,
      slots: result.assignments.map((slot) => ({
        abilityId: slot.abilityId,
        occurrenceIndex: slot.occurrenceIndex,
        slotIndex: slot.slotIndex,
        occurrenceTimeMs: slot.occurrenceTimeMs,
        windowStartMs: slot.windowStartMs,
        windowEndMs: slot.windowEndMs,
        priority: slot.priority,
        requirementLevel: slot.requirementLevel,
        demandType: slot.demandType,
        coverageStatus: slot.coverageStatus,
        assignedPlayerKey: slot.assignedPlayerKey,
        targetPlayerKey: slot.targetPlayerKey,
        defensiveSpellId: slot.defensiveSpellId,
        plannedCastAtMs: slot.plannedCastAtMs,
        prewarnMs: slot.prewarnMs,
        source: slot.source,
        locked: slot.locked,
        emergencyReserved: slot.emergencyReserved,
        confidence: slot.confidence,
        triggerMode: slot.triggerMode,
        bossmodSpellId: slot.bossmodSpellId,
        bossmodCounter: slot.bossmodCounter,
        bossmodCounterVerified: slot.bossmodCounterVerified,
        assignedGroups: slot.assignedGroups,
        effectiveCooldownMsSnapshot: slot.effectiveCooldownMsSnapshot,
        effectiveDurationMsSnapshot: slot.effectiveDurationMsSnapshot,
        chargesSnapshot: slot.chargesSnapshot,
        buildFingerprintSnapshot: slot.buildFingerprintSnapshot,
        notes: slot.notes,
        rationale: slot.rationale,
      })),
    };
    const validationError = validateDefensivePlanDraft(draft);
    if (validationError) throw new Error(`El solver produjo un draft inválido: ${validationError}`);
    const plan = await persistDefensivePlanDraft(supabase, draft, guard.userId);

    return jsonResponse({ ok: true, plan, solver: result });
  } catch (error) {
    console.error('generate-defensive-plan error:', error);
    return jsonResponse({ ok: false, error: errorMessage(error) }, 500);
  }
});
