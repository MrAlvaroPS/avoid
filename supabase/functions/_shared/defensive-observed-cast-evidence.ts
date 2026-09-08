import {
  computeDemonstratedPersistentCastSpellIds,
  resolveEffectiveDefensiveKit,
  type EffectiveDefensiveData,
  type ResolveDefensiveKitInput,
  type ResolvedDefensive,
} from './effective-defensives.ts';
import { mergeObservedCastEvidenceV6 } from './defensive-evidence-v6.ts';

const PAGE_SIZE = 1_000;

export interface StoredDefensiveCastEvidenceRow {
  pull_id: string;
  talent_build_fingerprint: string | null;
  defensive_casts: { spellId?: number; timestampsMs?: number[] }[] | null;
}

export function storedDefensiveCastRowsToObservedEvidence(
  rows: readonly StoredDefensiveCastEvidenceRow[],
  currentPullId: string,
  fingerprint: string | null,
): { spellId: number; samePull: boolean; pullTalentBuildFingerprint: string | null }[] {
  const out: { spellId: number; samePull: boolean; pullTalentBuildFingerprint: string | null }[] = [];
  for (const row of rows) {
    const samePull = row.pull_id === currentPullId;
    if (!samePull && (!fingerprint || row.talent_build_fingerprint !== fingerprint)) continue;
    for (const cast of row.defensive_casts ?? []) {
      if (!Number.isInteger(cast?.spellId) || !Array.isArray(cast?.timestampsMs) || !cast.timestampsMs.length) continue;
      out.push({
        spellId: Number(cast.spellId),
        samePull,
        pullTalentBuildFingerprint: samePull ? null : row.talent_build_fingerprint ?? null,
      });
    }
  }
  return out;
}

export function resolveEffectiveDefensiveKitFromObservedCastEvidence(params: {
  input: ResolveDefensiveKitInput;
  data: EffectiveDefensiveData;
  storedRows: readonly StoredDefensiveCastEvidenceRow[];
  currentPullId: string;
  liveSpellIds: readonly number[];
}): {
  kit: ResolvedDefensive[];
  firstPassKit: ResolvedDefensive[];
  demonstratedSpellIds: ReadonlyMap<number, 'observed_cast_same_pull' | 'observed_cast_same_build_fingerprint'>;
} {
  const firstPassKit = resolveEffectiveDefensiveKit(params.input, params.data);
  const stored = storedDefensiveCastRowsToObservedEvidence(
    params.storedRows,
    params.currentPullId,
    params.input.buildFingerprint,
  );
  const observed = mergeObservedCastEvidenceV6(stored, params.liveSpellIds);
  const demonstratedSpellIds = computeDemonstratedPersistentCastSpellIds(
    observed,
    params.input.buildFingerprint,
    firstPassKit,
  );
  const kit = demonstratedSpellIds.size
    ? resolveEffectiveDefensiveKit(
        { ...params.input, demonstratedPersistentCastSpellIds: demonstratedSpellIds },
        params.data,
      )
    : firstPassKit;
  return { kit, firstPassKit, demonstratedSpellIds };
}

/**
 * Single authoritative observed-cast path for analyze/reanalyze.
 *
 * Historical evidence is deliberately scoped by exact player + game build +
 * non-null exact talent fingerprint. It is paginated rather than relying on
 * Supabase's 1,000-row default, so a long-lived character cannot silently lose
 * acquisition evidence. Live WCL spell ids are merged as same-pull evidence.
 */
export async function resolveEffectiveDefensiveKitWithObservedCastEvidence(params: {
  client: any;
  input: ResolveDefensiveKitInput;
  data: EffectiveDefensiveData;
  currentPullId: string;
  liveSpellIds: readonly number[];
}): Promise<{
  kit: ResolvedDefensive[];
  firstPassKit: ResolvedDefensive[];
  demonstratedSpellIds: ReadonlyMap<number, 'observed_cast_same_pull' | 'observed_cast_same_build_fingerprint'>;
}> {
  const playerName = params.input.playerIdentity?.playerName?.trim() ?? '';
  const fingerprint = params.input.buildFingerprint;
  const gameBuild = params.input.gameBuild;
  const storedRows: StoredDefensiveCastEvidenceRow[] = [];

  if (playerName && fingerprint && gameBuild) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await params.client
        .from('player_pull_records')
        .select('pull_id,talent_build_fingerprint,defensive_casts')
        .eq('player_name', playerName)
        .eq('game_build', gameBuild)
        .eq('talent_build_fingerprint', fingerprint)
        .order('pull_id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        throw new Error(`No se pudo cargar evidencia histórica de casts defensivos para ${playerName}: ${error.message}`);
      }
      const page = (data ?? []) as StoredDefensiveCastEvidenceRow[];
      storedRows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
  }

  return resolveEffectiveDefensiveKitFromObservedCastEvidence({
    input: params.input,
    data: params.data,
    storedRows,
    currentPullId: params.currentPullId,
    liveSpellIds: params.liveSpellIds,
  });
}
