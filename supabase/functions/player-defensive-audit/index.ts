import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { errorMessage } from '../_shared/error-message.ts';
import { requireOfficer } from '../_shared/require-officer.ts';
import {
  buildDefensiveNightAudit,
  type DefensiveAuditEvaluationRowInput,
  type DefensiveAuditGenerationInput,
  type DefensiveAuditPullInput,
} from '../_shared/player-defensive-audit.ts';
import { DEFENSIVE_NIGHT_AUDIT_VERSION } from '../_shared/player-defensive-audit-contract.ts';

const FUNCTION_VERSION = 'player-defensive-audit@1';

interface Body {
  action?: 'audit' | 'health';
  reportCode?: string;
  playerName?: string;
}

interface PullDbRow {
  id: string;
  report_code: string;
  fight_id: number;
  boss_id: string;
  difficulty: string;
  ninja_pull_excluded: boolean;
}

interface PlayerRecordDbRow {
  pull_id: string;
  player_name: string;
  talent_build_fingerprint: string | null;
  defensive_casts: { spellId?: number; name?: string; timestampsMs?: number[] }[] | null;
}

function adminClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

function assertNoError(result: { error: unknown }, label: string): void {
  if (result.error) throw new Error(`${label}: ${errorMessage(result.error)}`);
}

function normalizeCasts(value: PlayerRecordDbRow['defensive_casts']): DefensiveAuditPullInput['defensiveCasts'] {
  return (value ?? []).flatMap((entry) => {
    const spellId = Number(entry.spellId);
    if (!Number.isInteger(spellId) || spellId <= 0) return [];
    return [{
      spellId,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `habilidad ${spellId}`,
      timestampsMs: (entry.timestampsMs ?? []).filter((timestamp): timestamp is number => typeof timestamp === 'number' && Number.isFinite(timestamp)),
    }];
  });
}

function pullOrdinals(pulls: readonly PullDbRow[]): Map<string, number | null> {
  const byGroup = new Map<string, PullDbRow[]>();
  for (const pull of [...pulls].sort((a, b) => a.fight_id - b.fight_id || a.id.localeCompare(b.id))) {
    const key = `${pull.boss_id}|${pull.difficulty}`;
    const group = byGroup.get(key) ?? [];
    group.push(pull);
    byGroup.set(key, group);
  }
  const result = new Map<string, number | null>();
  for (const group of byGroup.values()) {
    let ordinal = 0;
    for (const pull of group) {
      if (pull.ninja_pull_excluded) result.set(pull.id, null);
      else result.set(pull.id, ++ordinal);
    }
  }
  return result;
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
  if (body.action === 'health') {
    return jsonResponse({ ok: true, version: FUNCTION_VERSION, auditVersion: DEFENSIVE_NIGHT_AUDIT_VERSION });
  }
  const reportCode = body.reportCode?.trim() ?? '';
  const playerName = body.playerName?.trim() ?? '';
  if (!/^[A-Za-z0-9]{8,32}$/.test(reportCode)) return jsonResponse({ ok: false, error: 'reportCode inválido.' }, 400);
  if (!playerName || playerName.length > 80) return jsonResponse({ ok: false, error: 'playerName inválido.' }, 400);

  const client = adminClient();
  try {
    const pointerBefore = await client
      .from('defensive_generation_pointer')
      .select('published_generation_id')
      .eq('id', true)
      .maybeSingle();
    assertNoError(pointerBefore, 'pointer inicial');
    const generationId = pointerBefore.data?.published_generation_id as string | null | undefined;

    let generation: DefensiveAuditGenerationInput | null = null;
    if (generationId) {
      const response = await client
        .from('defensive_generations')
        .select('id,status,published_at,evaluator_version,episode_version,resolver_version,semantic_resolver_version,semantic_version,game_build')
        .eq('id', generationId)
        .maybeSingle();
      assertNoError(response, 'generación');
      if (response.data) {
        const row = response.data as Record<string, unknown>;
        generation = {
          id: String(row['id']),
          status: String(row['status']),
          publishedAt: typeof row['published_at'] === 'string' ? row['published_at'] : null,
          evaluatorVersion: typeof row['evaluator_version'] === 'string' ? row['evaluator_version'] : null,
          episodeVersion: typeof row['episode_version'] === 'string' ? row['episode_version'] : null,
          resolverVersion: String(row['resolver_version'] ?? ''),
          semanticResolverVersion: String(row['semantic_resolver_version'] ?? ''),
          semanticVersion: String(row['semantic_version'] ?? ''),
          gameBuild: String(row['game_build'] ?? ''),
        };
      }
    }

    const pullsResponse = await client
      .from('pulls')
      .select('id,report_code,fight_id,boss_id,difficulty,ninja_pull_excluded')
      .eq('report_code', reportCode)
      .order('fight_id', { ascending: true });
    assertNoError(pullsResponse, 'pulls del report');
    const pullRows = (pullsResponse.data ?? []) as PullDbRow[];
    const pullIds = pullRows.map((pull) => pull.id);

    const empty = { data: [], error: null };
    const [recordsResponse, expectedResponse, stagingResponse, contextsResponse, encountersResponse, mechanicsResponse] = await Promise.all([
      pullIds.length
        ? client.from('player_pull_records').select('pull_id,player_name,talent_build_fingerprint,defensive_casts').in('pull_id', pullIds).eq('player_name', playerName)
        : Promise.resolve(empty),
      generationId
        ? client.from('published_defensive_expected_player_pulls').select('pull_id').eq('report_code', reportCode).eq('player_name', playerName).eq('defensive_generation_id', generationId)
        : Promise.resolve(empty),
      generationId && pullIds.length
        ? client.from('player_pull_defensive_episode_evaluations')
            .select('pull_id,player_name,episode_evaluator_version,semantic_version,semantic_resolver_version,resolver_version,build_fingerprint,effective_kit,episodes,evaluated_at')
            .eq('defensive_generation_id', generationId)
            .eq('player_name', playerName)
            .in('pull_id', pullIds)
        : Promise.resolve(empty),
      pullIds.length
        ? client.from('pull_evaluation_context').select('pull_id,evaluation_end_ms').in('pull_id', pullIds)
        : Promise.resolve(empty),
      client.from('report_encounters').select('fight_id,boss_name').eq('report_code', reportCode),
      pullIds.length
        ? client.from('pull_mechanic_events').select('pull_id,ability_id,mechanic_name').in('pull_id', pullIds)
        : Promise.resolve(empty),
    ]);
    for (const [result, label] of [
      [recordsResponse, 'records'],
      [expectedResponse, 'población esperada'],
      [stagingResponse, 'staging'],
      [contextsResponse, 'cutoffs'],
      [encountersResponse, 'encuentros'],
      [mechanicsResponse, 'mecánicas'],
    ] as const) assertNoError(result, label);

    const recordByPull = new Map(((recordsResponse.data ?? []) as PlayerRecordDbRow[]).map((row) => [row.pull_id, row]));
    const expectedIds = new Set(((expectedResponse.data ?? []) as { pull_id: string }[]).map((row) => row.pull_id));
    const cutoffByPull = new Map(((contextsResponse.data ?? []) as { pull_id: string; evaluation_end_ms: number | null }[]).map((row) => [row.pull_id, row.evaluation_end_ms]));
    const bossByFight = new Map(((encountersResponse.data ?? []) as { fight_id: number; boss_name: string }[]).map((row) => [row.fight_id, row.boss_name]));
    const mechanicsByPull = new Map<string, Record<string, string>>();
    for (const row of (mechanicsResponse.data ?? []) as { pull_id: string; ability_id: number; mechanic_name: string }[]) {
      const names = mechanicsByPull.get(row.pull_id) ?? {};
      const key = String(row.ability_id);
      if (!names[key] || row.mechanic_name.localeCompare(names[key]) < 0) names[key] = row.mechanic_name;
      mechanicsByPull.set(row.pull_id, names);
    }
    const ordinals = pullOrdinals(pullRows);
    const pulls: DefensiveAuditPullInput[] = pullRows.map((pull) => {
      const record = recordByPull.get(pull.id);
      return {
        pullId: pull.id,
        reportCode,
        fightId: pull.fight_id,
        bossId: pull.boss_id,
        bossName: bossByFight.get(pull.fight_id) ?? null,
        difficulty: pull.difficulty,
        pullNumber: ordinals.get(pull.id) ?? null,
        canonical: expectedIds.has(pull.id),
        evaluationEndMs: cutoffByPull.get(pull.id) ?? null,
        playerParticipated: record != null,
        buildFingerprint: record?.talent_build_fingerprint ?? null,
        defensiveCasts: normalizeCasts(record?.defensive_casts ?? null),
        mechanicNamesByAbilityId: mechanicsByPull.get(pull.id) ?? {},
      };
    });
    const rows: DefensiveAuditEvaluationRowInput[] = ((stagingResponse.data ?? []) as Record<string, unknown>[]).map((row) => ({
      pullId: String(row['pull_id']),
      playerName: String(row['player_name']),
      episodeEvaluatorVersion: String(row['episode_evaluator_version']),
      semanticVersion: String(row['semantic_version']),
      semanticResolverVersion: String(row['semantic_resolver_version']),
      resolverVersion: String(row['resolver_version']),
      buildFingerprint: typeof row['build_fingerprint'] === 'string' ? row['build_fingerprint'] : null,
      effectiveKit: Array.isArray(row['effective_kit']) ? row['effective_kit'] as DefensiveAuditEvaluationRowInput['effectiveKit'] : [],
      episodes: Array.isArray(row['episodes']) ? row['episodes'] as DefensiveAuditEvaluationRowInput['episodes'] : [],
      evaluatedAt: String(row['evaluated_at']),
    }));

    const pointerAfter = await client
      .from('defensive_generation_pointer')
      .select('published_generation_id')
      .eq('id', true)
      .maybeSingle();
    assertNoError(pointerAfter, 'pointer final');
    const audit = buildDefensiveNightAudit({
      reportCode,
      playerName,
      generatedAt: new Date().toISOString(),
      pointerStable: (pointerAfter.data?.published_generation_id ?? null) === (generationId ?? null),
      generation,
      pulls,
      rows,
    });
    return jsonResponse({ ok: true, audit });
  } catch (err) {
    return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
  }
});

