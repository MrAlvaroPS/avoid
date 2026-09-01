export type ControlledBackfillAuditState = 'passed' | 'failed' | 'not_observed';

export interface ControlledBackfillAuditCase {
  id: 'fade_modifier' | 'unchanged_base' | 'charges_recharge' | 'external_target' | 'unknown_build';
  label: string;
  state: ControlledBackfillAuditState;
  observed: number;
  detail: string;
}

interface AuditRecord {
  playerName: string;
  gameBuild: string | null;
  gameBuildConfidence: string | null;
  defensiveResolutionShadow: unknown;
  deathDefensiveOptionsV2: unknown;
  defensivePressureWindowsV2: unknown;
}

interface AuditKitEntry {
  spellId: number;
  name: string;
  effectiveCooldownMs: number | null;
  effectiveDurationMs: number | null;
  charges: number;
  rechargeMs: number | null;
  category?: string;
  targetingMode: string;
  confidence: string;
  provenance: { kind?: string; field?: string; after?: unknown }[];
}

function kitFor(record: AuditRecord): AuditKitEntry[] {
  const shadow = record.defensiveResolutionShadow as { kit?: unknown } | null;
  if (!shadow || !Array.isArray(shadow.kit)) return [];
  return shadow.kit.filter((entry): entry is AuditKitEntry => Boolean(entry && typeof entry === 'object'));
}

function baseValue(entry: AuditKitEntry, field: 'cooldown_ms' | 'duration_ms'): number | null {
  const step = (entry.provenance ?? []).find((item) => item.kind === 'catalog_base' && item.field === field);
  return typeof step?.after === 'number' ? step.after : null;
}

function opportunitySpellIds(value: unknown): Set<number> {
  const result = new Set<number>();
  const collect = (options: unknown) => {
    if (!Array.isArray(options)) return;
    for (const option of options) {
      if (!option || typeof option !== 'object') continue;
      const candidate = option as {
        spellId?: unknown;
        availableOpportunity?: unknown;
        status?: unknown;
        confidence?: unknown;
      };
      const isReliableUnused =
        candidate.status === 'available_unused' &&
        (candidate.confidence === 'verified' || candidate.confidence === 'inferred');
      if ((candidate.availableOpportunity === true || isReliableUnused) && typeof candidate.spellId === 'number') {
        result.add(candidate.spellId);
      }
    }
  };
  if (Array.isArray(value)) collect(value);
  const windows = (value as { windows?: unknown[] } | null)?.windows;
  if (Array.isArray(windows)) {
    for (const window of windows) collect((window as { options?: unknown } | null)?.options);
  }
  return result;
}

export function auditControlledDefensiveBackfill(records: AuditRecord[]): ControlledBackfillAuditCase[] {
  const entries = records.flatMap((record) => kitFor(record).map((entry) => ({ record, entry })));

  const fade = entries.filter(({ entry }) => entry.spellId === 586 || entry.name.trim().toLowerCase() === 'fade');
  const fadePassed = fade.filter(({ entry }) => {
    const hasModifier = (entry.provenance ?? []).some((step) => step.kind === 'modifier' && step.field === 'cooldown_ms');
    return baseValue(entry, 'cooldown_ms') === 30_000 && entry.effectiveCooldownMs === 20_000 && hasModifier;
  }).length;

  const unchanged = entries.filter(({ entry }) => {
    const modifyingStep = (entry.provenance ?? []).some((step) =>
      ['spec_profile', 'modifier', 'conditional_modifier', 'player_override'].includes(step.kind ?? ''),
    );
    return !modifyingStep && baseValue(entry, 'cooldown_ms') != null;
  });
  const unchangedPassed = unchanged.filter(({ entry }) => {
    const baseCooldown = baseValue(entry, 'cooldown_ms');
    const baseDuration = baseValue(entry, 'duration_ms');
    return entry.effectiveCooldownMs === baseCooldown && (baseDuration == null || entry.effectiveDurationMs === baseDuration);
  }).length;

  const charged = entries.filter(({ entry }) => entry.charges >= 2);
  const chargedPassed = charged.filter(({ entry }) => typeof entry.rechargeMs === 'number' && entry.rechargeMs >= 0).length;

  let externalObserved = 0;
  let externalPassed = 0;
  for (const record of records) {
    const externalIds = new Set(
      kitFor(record)
        .filter((entry) => entry.category === 'external_defensive' || entry.targetingMode === 'ally')
        .map((entry) => entry.spellId),
    );
    if (!externalIds.size || !Array.isArray(record.deathDefensiveOptionsV2)) continue;
    externalObserved++;
    const opportunities = opportunitySpellIds(record.deathDefensiveOptionsV2);
    if ([...externalIds].every((spellId) => !opportunities.has(spellId))) externalPassed++;
  }

  const unknown = records.filter((record) => !record.gameBuild || record.gameBuildConfidence === 'uncertain');
  const unknownPassed = unknown.filter((record) => {
    const kitIsNonAuthoritative = kitFor(record).every((entry) => entry.confidence === 'fallback' || entry.confidence === 'uncertain');
    const opportunities = new Set([
      ...opportunitySpellIds(record.deathDefensiveOptionsV2),
      ...opportunitySpellIds(record.defensivePressureWindowsV2),
    ]);
    return kitIsNonAuthoritative && opportunities.size === 0;
  }).length;

  const result = (
    id: ControlledBackfillAuditCase['id'],
    label: string,
    observed: number,
    passed: number,
    successDetail: string,
  ): ControlledBackfillAuditCase => ({
    id,
    label,
    observed,
    state: observed === 0 ? 'not_observed' : passed === observed ? 'passed' : 'failed',
    detail: observed === 0 ? 'El sample no contiene este caso; ampliar o escoger pulls dirigidos.' : `${passed}/${observed} ${successDetail}`,
  });

  return [
    result('fade_modifier', 'Fade 30 s → 20 s con modificador', fade.length, fadePassed, 'resoluciones correctas.'),
    result('unchanged_base', 'Base = efectivo sin modificadores', unchanged.length, unchangedPassed, 'resoluciones sin cambios coherentes.'),
    result('charges_recharge', 'Dos cargas y recharge', charged.length, chargedPassed, 'defensivos con recharge válido.'),
    result('external_target', 'External no cuenta como personal propio', externalObserved, externalPassed, 'muertes sin falsa oportunidad personal.'),
    result('unknown_build', 'Build histórico desconocido no punitivo', unknown.length, unknownPassed, 'snapshots inciertos sin oportunidad punitiva.'),
  ];
}
