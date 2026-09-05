import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type {
  AuditClaim,
  AuditScope,
  PlayerPullRecordEvidence,
  PullEvidenceRef,
  WclPullEvidence,
} from '../shared/models/night-player-audit';
import type { PlayerPullRecordRow, PullRow, ReportEncounterRow } from '../shared/models/domain';
import { pullEvidenceKey, pullEvidenceLabel } from '../shared/pull-evidence.util';
import { validAttemptOrdinal } from '../shared/pull-consistency.util';
import { wclFightUrl } from '../shared/wcl-code.util';

export type PullLedgerResult = 'kill' | 'wipe';
export type PullLedgerIntegrity = 'complete' | 'partial';
export type PullLedgerExclusionReason = 'ninja_pull' | 'identity_unresolved';

export type PullLedgerPullFact = Pick<
  PullRow,
  | 'id'
  | 'report_code'
  | 'fight_id'
  | 'boss_id'
  | 'difficulty'
  | 'pull_number'
  | 'wipe_pct'
  | 'duration_ms'
  | 'closed_at'
  | 'ninja_pull_excluded'
>;

export type PullLedgerPlayerFact = Pick<
  PlayerPullRecordRow,
  'id' | 'pull_id' | 'player_name' | 'world_rank_percent' | 'world_total_parses'
>;

export type PullLedgerEncounterFact = Pick<ReportEncounterRow, 'fight_id' | 'boss_name'>;

export interface NightPlayerPullLedgerRow {
  key: string;
  pull: PullEvidenceRef;
  label: string;
  wclUrl: string;
  wipePct: number | null;
  worldTotalParses: number | null;
  participation: AuditClaim<boolean>;
  identity: AuditClaim<string>;
  result: AuditClaim<PullLedgerResult>;
  duration: AuditClaim<number>;
  parse: AuditClaim<number>;
  integrity: PullLedgerIntegrity;
  integrityIssues: readonly string[];
}

export interface NightPlayerExcludedPullLedgerRow {
  pullId: string;
  fightId: number;
  bossId: string;
  bossName: string;
  difficulty: string;
  closedAt: string;
  reason: PullLedgerExclusionReason;
  wclUrl: string;
}

export interface NightPlayerPullLedger {
  reportCode: string;
  playerName: string;
  rows: readonly NightPlayerPullLedgerRow[];
  excludedParticipatedPulls: readonly NightPlayerExcludedPullLedgerRow[];
  integrity: PullLedgerIntegrity;
  integrityIssues: readonly string[];
}

function claimScope(
  reportCode: string,
  playerName: string,
  pull: PullLedgerPullFact,
): AuditScope {
  return {
    reportCode,
    playerName,
    pullIds: [pull.id],
    bossIds: [pull.boss_id],
    difficulty: pull.difficulty,
  };
}

function playerRecordEvidence(
  record: PullLedgerPlayerFact,
  pull: PullEvidenceRef,
  field: string,
): PlayerPullRecordEvidence {
  return {
    id: `player-pull-record:${record.id}:${field}`,
    kind: 'player_pull_record',
    source: 'wcl',
    locator: `player_pull_records:${record.id}`,
    pull,
    field,
  };
}

function wclPullEvidence(pull: PullEvidenceRef): WclPullEvidence {
  return {
    id: `wcl-pull:${pull.reportCode}:${pull.pullId}`,
    kind: 'wcl_pull',
    source: 'wcl',
    locator: wclFightUrl(pull.reportCode, pull.fightId),
    pull,
  };
}

/**
 * Pure builder used by the runtime service and regression tests. The function
 * projects already-ingested facts; it does not score, classify mechanics or
 * infer defensive behavior.
 */
export function buildNightPlayerPullLedger(args: {
  reportCode: string;
  playerName: string;
  pulls: readonly PullLedgerPullFact[];
  encounters: readonly PullLedgerEncounterFact[];
  records: readonly PullLedgerPlayerFact[];
}): NightPlayerPullLedger {
  const globalIntegrityIssues: string[] = [];
  const encounterNameByFightId = new Map(args.encounters.map((row) => [row.fight_id, row.boss_name]));

  const recordsByPullId = new Map<string, PullLedgerPlayerFact>();
  const recordCountsByPullId = new Map<string, number>();
  for (const record of args.records) {
    recordCountsByPullId.set(record.pull_id, (recordCountsByPullId.get(record.pull_id) ?? 0) + 1);
    if (!recordsByPullId.has(record.pull_id)) recordsByPullId.set(record.pull_id, record);
  }
  for (const [pullId, count] of recordCountsByPullId) {
    if (count > 1) {
      globalIntegrityIssues.push(
        `player_pull_records contiene ${count} filas para el mismo jugador y pull ${pullId}.`,
      );
    }
  }

  const pullIds = new Set(args.pulls.map((pull) => pull.id));
  for (const record of args.records) {
    if (!pullIds.has(record.pull_id)) {
      globalIntegrityIssues.push(
        `player_pull_records ${record.id} referencia un pull fuera del report (${record.pull_id}).`,
      );
    }
  }

  const bossGroups = new Map<string, PullLedgerPullFact[]>();
  for (const pull of args.pulls) {
    const key = `${pull.boss_id}|${pull.difficulty}`;
    if (!bossGroups.has(key)) bossGroups.set(key, []);
    bossGroups.get(key)!.push(pull);
  }

  const bossOrdinalByPullId = new Map<string, number>();
  for (const group of bossGroups.values()) {
    group.sort((a, b) => a.pull_number - b.pull_number || a.fight_id - b.fight_id);
    for (const pull of group) {
      const ordinal = validAttemptOrdinal(group, pull.id);
      if (ordinal != null) bossOrdinalByPullId.set(pull.id, ordinal);
    }
  }

  const rows: NightPlayerPullLedgerRow[] = [];
  const excludedParticipatedPulls: NightPlayerExcludedPullLedgerRow[] = [];

  const participatedPulls = args.pulls
    .filter((pull) => recordsByPullId.has(pull.id))
    .slice()
    .sort((a, b) => a.fight_id - b.fight_id);

  for (const pull of participatedPulls) {
    const record = recordsByPullId.get(pull.id)!;
    const bossName = encounterNameByFightId.get(pull.fight_id) ?? `Boss ${pull.boss_id}`;
    const wclUrl = wclFightUrl(args.reportCode, pull.fight_id);

    if (!encounterNameByFightId.has(pull.fight_id)) {
      globalIntegrityIssues.push(
        `No existe report_encounters para fight ${pull.fight_id}; se usa ${bossName} como etiqueta técnica.`,
      );
    }

    if (pull.ninja_pull_excluded) {
      excludedParticipatedPulls.push({
        pullId: pull.id,
        fightId: pull.fight_id,
        bossId: pull.boss_id,
        bossName,
        difficulty: pull.difficulty,
        closedAt: pull.closed_at,
        reason: 'ninja_pull',
        wclUrl,
      });
      continue;
    }

    const bossPullNumber = bossOrdinalByPullId.get(pull.id);
    if (bossPullNumber == null) {
      globalIntegrityIssues.push(`No se pudo resolver el ordinal boss-local para pull ${pull.id}.`);
      excludedParticipatedPulls.push({
        pullId: pull.id,
        fightId: pull.fight_id,
        bossId: pull.boss_id,
        bossName,
        difficulty: pull.difficulty,
        closedAt: pull.closed_at,
        reason: 'identity_unresolved',
        wclUrl,
      });
      continue;
    }

    const pullRef: PullEvidenceRef = {
      reportCode: args.reportCode,
      pullId: pull.id,
      fightId: pull.fight_id,
      bossId: pull.boss_id,
      bossName,
      difficulty: pull.difficulty,
      bossPullNumber,
    };
    const scope = claimScope(args.reportCode, args.playerName, pull);
    const pullEvidence = wclPullEvidence(pullRef);
    const participationEvidence = playerRecordEvidence(record, pullRef, 'player_name');
    const parseEvidence = playerRecordEvidence(record, pullRef, 'world_rank_percent');

    const participation: AuditClaim<boolean> = {
      id: `pull.population:${pull.id}`,
      label: 'Participación',
      value: true,
      status: 'direct',
      scope,
      definition: 'Existe una fila player_pull_records para este jugador en este pull.',
      evidence: [participationEvidence],
      sourceVersion: 'player_pull_records',
      integrityIssues: [],
    };

    const identityValue = pullEvidenceLabel(pullRef);
    const identity: AuditClaim<string> = {
      id: `pull.identity:${pull.id}`,
      label: 'Identidad del pull',
      value: identityValue,
      status: 'derived',
      scope,
      definition: 'Ordinal 1..N dentro de boss+dificultad, ignorando ninja pulls excluidos.',
      formula: 'validAttemptOrdinal(all boss+difficulty pulls, pullId)',
      evidence: [pullEvidence],
      sourceVersion: 'pull-consistency.validAttemptOrdinal',
      integrityIssues: [],
    };

    const resultIssues = pull.wipe_pct == null ? ['pulls.wipe_pct no está disponible para este fight.'] : [];
    const resultValue: PullLedgerResult | null =
      pull.wipe_pct == null ? null : pull.wipe_pct === 0 ? 'kill' : 'wipe';
    const result: AuditClaim<PullLedgerResult> = {
      id: `pull.result:${pull.id}`,
      label: 'Resultado',
      value: resultValue,
      status: resultValue == null ? 'not_evaluable' : 'derived',
      scope,
      definition: 'Resultado proyectado desde el progreso final observado por WCL.',
      formula: 'wipe_pct === 0 → kill; wipe_pct > 0 → wipe',
      evidence: [pullEvidence],
      sourceVersion: 'pulls.wipe_pct',
      integrityIssues: resultIssues,
    };

    const durationIssues = pull.duration_ms == null ? ['pulls.duration_ms no está disponible para este fight.'] : [];
    const duration: AuditClaim<number> = {
      id: `pull.duration:${pull.id}`,
      label: 'Duración',
      value: pull.duration_ms,
      status: pull.duration_ms == null ? 'not_evaluable' : 'direct',
      scope,
      definition: 'Duración del fight persistida desde Warcraft Logs.',
      evidence: [pullEvidence],
      sourceVersion: 'pulls.duration_ms',
      integrityIssues: durationIssues,
    };

    const parseIssues =
      record.world_rank_percent == null
        ? ['WCL no devolvió world_rank_percent para este jugador en este pull; se muestra N/D.']
        : [];
    const parse: AuditClaim<number> = {
      id: `wcl.parse:${pull.id}`,
      label: 'Parse WCL',
      value: record.world_rank_percent,
      status: record.world_rank_percent == null ? 'not_evaluable' : 'direct',
      scope,
      definition: 'Percentil world_rank_percent persistido para este jugador y fight.',
      evidence: [pullEvidence, parseEvidence],
      sourceVersion: 'player_pull_records.world_rank_percent',
      integrityIssues: parseIssues,
    };

    const integrityIssues = [
      ...identity.integrityIssues,
      ...result.integrityIssues,
      ...duration.integrityIssues,
      ...parse.integrityIssues,
    ];

    rows.push({
      key: pullEvidenceKey(pullRef),
      pull: pullRef,
      label: identityValue,
      wclUrl,
      wipePct: pull.wipe_pct,
      worldTotalParses: record.world_total_parses,
      participation,
      identity,
      result,
      duration,
      parse,
      integrity: integrityIssues.length ? 'partial' : 'complete',
      integrityIssues,
    });
  }

  return {
    reportCode: args.reportCode,
    playerName: args.playerName,
    rows,
    excludedParticipatedPulls,
    integrity: globalIntegrityIssues.length ? 'partial' : 'complete',
    integrityIssues: globalIntegrityIssues,
  };
}

@Injectable({ providedIn: 'root' })
export class NightPlayerPullLedgerService {
  private readonly supabase = inject(SupabaseService);

  async load(reportCode: string, playerName: string): Promise<NightPlayerPullLedger> {
    const client = this.supabase.client;
    const [{ data: pullsData, error: pullsError }, { data: encountersData, error: encountersError }] =
      await Promise.all([
        client
          .from('pulls')
          .select(
            'id,report_code,fight_id,boss_id,difficulty,pull_number,wipe_pct,duration_ms,closed_at,ninja_pull_excluded',
          )
          .eq('report_code', reportCode)
          .order('fight_id', { ascending: true }),
        client
          .from('report_encounters')
          .select('fight_id,boss_name')
          .eq('report_code', reportCode),
      ]);

    if (pullsError) throw pullsError;
    if (encountersError) throw encountersError;

    const pulls = (pullsData ?? []) as PullLedgerPullFact[];
    const pullIds = pulls.map((pull) => pull.id);

    const { data: recordsData, error: recordsError } = pullIds.length
      ? await client
          .from('player_pull_records')
          .select('id,pull_id,player_name,world_rank_percent,world_total_parses')
          .in('pull_id', pullIds)
          .eq('player_name', playerName)
      : { data: [] as PullLedgerPlayerFact[], error: null };

    if (recordsError) throw recordsError;

    return buildNightPlayerPullLedger({
      reportCode,
      playerName,
      pulls,
      encounters: (encountersData ?? []) as PullLedgerEncounterFact[],
      records: (recordsData ?? []) as PullLedgerPlayerFact[],
    });
  }
}
