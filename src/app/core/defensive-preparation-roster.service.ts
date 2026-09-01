import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { WowauditRosterService } from './wowaudit-roster.service';
import { defensiveBuildFreshness, type DefensiveBuildFreshness } from '../shared/defensive-build-freshness';
import type { DefensiveResolutionConfidence, PlayerLatestBuildRow } from '../shared/models/domain';

export interface DefensivePreparationPlayer {
  characterId: number;
  name: string;
  realm: string;
  className: string;
  specName: string | null;
  role: 'Tank' | 'Heal' | 'Melee' | 'Ranged';
  rank: 'Main' | 'Trial';
  gameBuild: string | null;
  buildFingerprint: string | null;
  buildSource: string | null;
  buildConfidence: DefensiveResolutionConfidence;
  observedAt: string | null;
  reportCode: string | null;
  pullId: string | null;
  freshness: DefensiveBuildFreshness;
}

@Injectable({ providedIn: 'root' })
export class DefensivePreparationRosterService {
  private supabase = inject(SupabaseService);
  private roster = inject(WowauditRosterService);

  async listPlayers(): Promise<DefensivePreparationPlayer[]> {
    const [roster, latestResult] = await Promise.all([
      this.roster.listRoster(),
      this.supabase.client.from('player_latest_build').select('*'),
    ]);
    if (latestResult.error) throw latestResult.error;
    const latestByName = new Map(
      ((latestResult.data ?? []) as PlayerLatestBuildRow[]).map((row) => [row.player_name.toLocaleLowerCase(), row]),
    );
    return roster
      .map((entry) => {
        const latest = latestByName.get(entry.name.toLocaleLowerCase()) ?? null;
        const gameBuild = latest?.game_build ?? null;
        const buildFingerprint = latest?.talent_build_fingerprint ?? null;
        const observedAt = latest?.observed_at ?? null;
        const buildConfidence = latest?.game_build_confidence ?? 'uncertain';
        return {
          characterId: entry.characterId,
          name: entry.name,
          realm: entry.realm,
          className: latest?.class ?? entry.class,
          specName: latest?.spec ?? null,
          role: entry.role,
          rank: entry.rank,
          gameBuild,
          buildFingerprint,
          buildSource: latest?.game_build_source ?? null,
          buildConfidence,
          observedAt,
          reportCode: latest?.report_code ?? null,
          pullId: latest?.pull_id ?? null,
          freshness: defensiveBuildFreshness({
            gameBuild,
            fingerprint: buildFingerprint,
            observedAt,
            confidence: buildConfidence,
          }),
        } satisfies DefensivePreparationPlayer;
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
