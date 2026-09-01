/**
 * Resolver canónico de defensivos efectivos.
 *
 * Es deliberadamente puro: los consumidores cargan catálogo/perfiles/reglas
 * en batch y esta función aplica exactamente la misma precedencia en analyze,
 * reanalyze, Preparación, solver y evaluator. No importa Supabase ni Deno, de
 * modo que su contrato se puede probar también desde la suite de Angular.
 */

export const EFFECTIVE_DEFENSIVE_RESOLVER_VERSION = 'effective-defensives@2.0.0';
export const LEGACY_GAME_BUILD = 'legacy-current';

export type DefensiveCategory = 'personal_defensive' | 'semi_defensive' | 'external_defensive' | 'utility';
export type DefensiveTargetingMode = 'self' | 'ally' | 'both' | 'raid' | 'unknown';
export type DefensiveResolutionConfidence = 'verified' | 'inferred' | 'fallback' | 'uncertain';
export type DefensiveEffectField = 'cooldown_ms' | 'duration_ms' | 'charges' | 'recharge_ms';
export type DefensiveModifierOperation = 'set_ms' | 'multiply' | 'add_ms' | 'subtract_ms' | 'charges_add';

export interface TalentBuildNode {
  id: number;
  nodeID: number;
  rank: number;
  spellId?: number;
}

export interface EffectiveDefensiveCatalogEntry {
  spellId: number;
  name: string;
  className: string;
  specName: string | null;
  specOverride: string[] | null;
  category: DefensiveCategory;
  survivalType: 'mitigation' | 'absorption' | 'sustain' | 'emergency' | null;
  targetingMode: DefensiveTargetingMode;
  baseCooldownMs: number | null;
  baseDurationMs: number | null;
  excluded?: boolean;
}

export interface EffectiveDefensiveSpecProfile {
  className: string;
  specName: string;
  spellId: number;
  gameBuild: string;
  baseCooldownMs: number | null;
  baseDurationMs: number | null;
  charges: number;
  rechargeMs: number | null;
  source?: string | null;
  sourceNote?: string | null;
  syncedFromCommit?: string | null;
}

export interface EffectiveDefensiveModifierRule {
  id: string;
  className: string;
  specNames: string[] | null;
  modifierSpellId: number;
  targetSpellId: number;
  operation: DefensiveModifierOperation;
  effectField: DefensiveEffectField;
  value: number;
  perRank: boolean;
  condition: 'always' | 'conditional';
  gameBuild: string;
  applicationOrder: number;
  description: string;
  source?: string | null;
  active: boolean;
}

export interface PlayerDefensiveOverride {
  id: string;
  characterId: number | null;
  playerName: string;
  className: string;
  specName: string | null;
  spellId: number;
  buildFingerprint: string | null;
  gameBuild: string;
  effectiveCooldownMs: number | null;
  effectiveDurationMs: number | null;
  charges: number | null;
  targetingMode: DefensiveTargetingMode | null;
  reason: string;
  active: boolean;
  updatedAt?: string | null;
}

export interface ResolveDefensiveKitInput {
  className: string;
  specName: string | null;
  talentBuild: TalentBuildNode[] | null;
  buildFingerprint: string | null;
  gameBuild: string | null;
  gameBuildConfidence?: DefensiveResolutionConfidence;
  playerIdentity?: { characterId?: number; playerName: string };
  includeExternal?: boolean;
  /** Todos los spellIds que pueden ser nodos de talento en este game build. */
  allTalentSpellIds?: ReadonlySet<number> | null;
  /** false significa que el lookup falló/no existe; undefined permite usar el resolver con catálogo sin talent gating. */
  talentLookupComplete?: boolean;
}

export interface EffectiveDefensiveData {
  catalog: EffectiveDefensiveCatalogEntry[];
  specProfiles: EffectiveDefensiveSpecProfile[];
  modifierRules: EffectiveDefensiveModifierRule[];
  overrides?: PlayerDefensiveOverride[];
}

export interface EffectiveDefensiveDatabaseRows {
  catalogRows: Record<string, unknown>[];
  specProfileRows?: Record<string, unknown>[];
  modifierRuleRows?: Record<string, unknown>[];
  overrideRows?: Record<string, unknown>[];
}

export interface ObservedGameBuild {
  gameBuild: string | null;
  source: string | null;
  confidence: DefensiveResolutionConfidence;
}

export interface ResolutionStep {
  kind: 'catalog_base' | 'eligibility' | 'spec_profile' | 'modifier' | 'conditional_modifier' | 'player_override' | 'validation';
  field: DefensiveEffectField | 'eligible' | 'targeting_mode';
  before: number | string | boolean | null;
  after: number | string | boolean | null;
  operation?: DefensiveModifierOperation;
  source?: string | null;
  description: string;
  gameBuild?: string | null;
  ruleId?: string;
}

export interface ResolvedDefensive {
  spellId: number;
  name: string;
  className: string;
  specName: string | null;
  category: DefensiveCategory;
  survivalType: 'mitigation' | 'absorption' | 'sustain' | 'emergency' | null;
  targetingMode: DefensiveTargetingMode;
  effectiveCooldownMs: number | null;
  effectiveDurationMs: number | null;
  charges: number;
  rechargeMs: number | null;
  eligible: boolean;
  buildFingerprint: string | null;
  gameBuild: string | null;
  resolverVersion: string;
  confidence: DefensiveResolutionConfidence;
  provenance: ResolutionStep[];
  conditionalModifiers: ResolutionStep[];
}

const CONFIDENCE_RANK: Record<DefensiveResolutionConfidence, number> = {
  verified: 0,
  inferred: 1,
  fallback: 2,
  uncertain: 3,
};

const OPERATION_ORDER: Record<DefensiveModifierOperation, number> = {
  set_ms: 0,
  multiply: 1,
  add_ms: 2,
  subtract_ms: 2,
  charges_add: 3,
};

const TARGETING_MODES = new Set<DefensiveTargetingMode>(['self', 'ally', 'both', 'raid', 'unknown']);

function weakerConfidence(
  current: DefensiveResolutionConfidence,
  candidate: DefensiveResolutionConfidence,
): DefensiveResolutionConfidence {
  return CONFIDENCE_RANK[candidate] > CONFIDENCE_RANK[current] ? candidate : current;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Adaptador compartido de filas snake_case al contrato puro. Mantenerlo aquí
 * evita que analyze, reanalyze y el endpoint interpreten columnas de forma
 * distinta. Los defaults legacy solo existen para poder desplegar el código
 * antes de ejecutar un backfill; nunca elevan la confidence a verified.
 */
export function effectiveDefensiveDataFromDatabaseRows(rows: EffectiveDefensiveDatabaseRows): EffectiveDefensiveData {
  return {
    catalog: rows.catalogRows.map((row) => ({
      spellId: Number(row['spell_id']),
      name: String(row['name'] ?? ''),
      className: String(row['class'] ?? ''),
      specName: nullableString(row['spec']),
      specOverride: Array.isArray(row['spec_override']) ? row['spec_override'].map(String) : null,
      category: row['category'] as DefensiveCategory,
      survivalType: nullableString(row['survival_type']) as EffectiveDefensiveCatalogEntry['survivalType'],
      targetingMode: (nullableString(row['targeting_mode']) ?? 'unknown') as DefensiveTargetingMode,
      baseCooldownMs: nullableNumber(row['base_cooldown_ms']),
      baseDurationMs: nullableNumber(row['base_duration_ms']),
      excluded: row['excluded'] === true,
    })),
    specProfiles: (rows.specProfileRows ?? []).map((row) => ({
      className: String(row['class'] ?? ''),
      specName: String(row['spec'] ?? ''),
      spellId: Number(row['spell_id']),
      gameBuild: nullableString(row['game_build']) ?? LEGACY_GAME_BUILD,
      baseCooldownMs: nullableNumber(row['base_cooldown_ms']),
      baseDurationMs: nullableNumber(row['base_duration_ms']),
      charges: nullableNumber(row['charges']) ?? 1,
      rechargeMs: nullableNumber(row['recharge_ms']),
      source: nullableString(row['source']),
      sourceNote: nullableString(row['source_note']),
      syncedFromCommit: nullableString(row['synced_from_commit']),
    })),
    modifierRules: (rows.modifierRuleRows ?? []).map((row) => ({
      id: String(row['id'] ?? ''),
      className: String(row['class'] ?? ''),
      specNames: Array.isArray(row['specs']) ? row['specs'].map(String) : null,
      modifierSpellId: Number(row['modifier_spell_id']),
      targetSpellId: Number(row['target_spell_id']),
      operation: row['operation'] as DefensiveModifierOperation,
      effectField: (nullableString(row['effect_field']) ?? (row['operation'] === 'charges_add' ? 'charges' : 'cooldown_ms')) as DefensiveEffectField,
      value: Number(row['value']),
      perRank: row['per_rank'] === true,
      condition: row['condition'] === 'conditional' ? 'conditional' : 'always',
      gameBuild: nullableString(row['game_build']) ?? LEGACY_GAME_BUILD,
      applicationOrder: nullableNumber(row['application_order']) ?? 100,
      description: String(row['description'] ?? ''),
      source: nullableString(row['source']),
      active: row['active'] !== false,
    })),
    overrides: (rows.overrideRows ?? []).map((row) => ({
      id: String(row['id'] ?? ''),
      characterId: nullableNumber(row['character_id']),
      playerName: String(row['player_name'] ?? ''),
      className: String(row['class'] ?? ''),
      specName: nullableString(row['spec']),
      spellId: Number(row['spell_id']),
      buildFingerprint: nullableString(row['build_fingerprint']),
      gameBuild: String(row['game_build'] ?? ''),
      effectiveCooldownMs: nullableNumber(row['effective_cooldown_ms']),
      effectiveDurationMs: nullableNumber(row['effective_duration_ms']),
      charges: nullableNumber(row['charges']),
      targetingMode: nullableString(row['targeting_mode']) as DefensiveTargetingMode | null,
      reason: String(row['reason'] ?? ''),
      active: row['active'] !== false,
      updatedAt: nullableString(row['updated_at']),
    })),
  };
}

const CURRENT_BUILD_OBSERVATION_WINDOW_MS = 48 * 60 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * WCL no expone la patch exacta en ReportMasterData. Solo asociamos el build
 * actual de Blizzard a un pull observado como máximo 48 h antes del análisis,
 * y aun así se etiqueta inferred. Un histórico queda null/uncertain.
 */
export function inferCurrentGameBuildObservation(params: {
  currentGameBuild: string | null;
  reportStartTimeMs: number;
  fightStartTimeMs: number;
  analyzedAtMs?: number;
}): ObservedGameBuild {
  const observedAtMs = params.reportStartTimeMs + params.fightStartTimeMs;
  const analyzedAtMs = params.analyzedAtMs ?? Date.now();
  const ageMs = analyzedAtMs - observedAtMs;
  if (
    !params.currentGameBuild ||
    !Number.isFinite(observedAtMs) ||
    !Number.isFinite(analyzedAtMs) ||
    ageMs < -FUTURE_CLOCK_SKEW_MS ||
    ageMs > CURRENT_BUILD_OBSERVATION_WINDOW_MS
  ) {
    return { gameBuild: null, source: null, confidence: 'uncertain' };
  }
  return {
    gameBuild: params.currentGameBuild,
    source: 'blizzard-current-namespace:report-observed-within-48h',
    confidence: 'inferred',
  };
}

export function normalizeTalentBuild(nodes: TalentBuildNode[] | null): TalentBuildNode[] | null {
  if (nodes == null) return null;
  const byIdentity = new Map<string, TalentBuildNode>();
  for (const raw of nodes) {
    if (!positiveInteger(raw?.id) || !positiveInteger(raw?.nodeID) || !nonNegativeInteger(raw?.rank)) continue;
    const spellId = positiveInteger(raw.spellId) ? raw.spellId : undefined;
    const normalized: TalentBuildNode = { id: raw.id, nodeID: raw.nodeID, rank: raw.rank, ...(spellId ? { spellId } : {}) };
    const key = `${normalized.nodeID}:${normalized.id}`;
    const previous = byIdentity.get(key);
    if (!previous || normalized.rank > previous.rank || (normalized.rank === previous.rank && previous.spellId == null && normalized.spellId != null)) {
      byIdentity.set(key, normalized);
    }
  }
  return [...byIdentity.values()].sort(
    (a, b) => a.nodeID - b.nodeID || a.id - b.id || (a.spellId ?? 0) - (b.spellId ?? 0) || a.rank - b.rank,
  );
}

export async function fingerprintTalentBuild(
  className: string,
  specName: string | null,
  gameBuild: string | null,
  talentBuild: TalentBuildNode[] | null,
): Promise<string | null> {
  const normalized = normalizeTalentBuild(talentBuild);
  if (normalized == null) return null;
  const payload = JSON.stringify({
    className: className.trim(),
    specName: specName?.trim() ?? null,
    gameBuild: gameBuild?.trim() ?? null,
    nodes: normalized.map((node) => [node.nodeID, node.id, node.rank, node.spellId ?? null]),
  });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function specApplies(
  entry: Pick<EffectiveDefensiveCatalogEntry, 'specName' | 'specOverride'>,
  playerSpec: string | null,
): boolean {
  if (playerSpec == null) return true;
  if (entry.specOverride != null) return entry.specOverride.includes(playerSpec);
  if (entry.specName == null) return true;
  return entry.specName
    .split('/')
    .map((spec) => spec.trim())
    .includes(playerSpec);
}

function ruleIdentity(rule: EffectiveDefensiveModifierRule): string {
  return [rule.className, rule.modifierSpellId, rule.targetSpellId, rule.operation, rule.effectField].join(':');
}

function rulesForBuild(
  rules: EffectiveDefensiveModifierRule[],
  gameBuild: string | null,
): { rule: EffectiveDefensiveModifierRule; buildConfidence: DefensiveResolutionConfidence }[] {
  const exactKeys = new Set(
    gameBuild == null
      ? []
      : rules.filter((rule) => rule.gameBuild === gameBuild).map(ruleIdentity),
  );
  return rules
    .filter((rule) => {
      if (gameBuild != null && rule.gameBuild === gameBuild) return true;
      return rule.gameBuild === LEGACY_GAME_BUILD && !exactKeys.has(ruleIdentity(rule));
    })
    .map((rule) => ({
      rule,
      buildConfidence: rule.gameBuild === gameBuild ? 'verified' : 'fallback',
    }));
}

function profileForBuild(
  profiles: EffectiveDefensiveSpecProfile[],
  gameBuild: string | null,
): { profile: EffectiveDefensiveSpecProfile; buildConfidence: DefensiveResolutionConfidence } | null {
  const exact = gameBuild == null ? undefined : profiles.find((profile) => profile.gameBuild === gameBuild);
  if (exact) return { profile: exact, buildConfidence: 'verified' };
  const legacy = profiles.find((profile) => profile.gameBuild === LEGACY_GAME_BUILD);
  return legacy ? { profile: legacy, buildConfidence: 'fallback' } : null;
}

function buildRanks(nodes: TalentBuildNode[] | null): Map<number, number> {
  const ranks = new Map<number, number>();
  for (const node of nodes ?? []) {
    if (!positiveInteger(node.spellId) || node.rank <= 0) continue;
    ranks.set(node.spellId, Math.max(ranks.get(node.spellId) ?? 0, node.rank));
  }
  return ranks;
}

function matchingOverride(
  overrides: PlayerDefensiveOverride[],
  input: ResolveDefensiveKitInput,
  spellId: number,
): PlayerDefensiveOverride | null {
  // La consolidación visual elimina el antiguo scope reutilizable con
  // fingerprint null. Sin identidad exacta solo puede existir una corrección
  // dentro del snapshot de un draft, nunca una regla global del resolver.
  if (!input.playerIdentity || !input.gameBuild || !input.buildFingerprint) return null;
  const name = input.playerIdentity.playerName.trim().toLowerCase();
  const matches = overrides.filter((override) => {
    if (!override.active || override.spellId !== spellId || override.className !== input.className || override.gameBuild !== input.gameBuild) return false;
    if (override.specName != null && override.specName !== input.specName) return false;
    if (override.characterId != null) {
      if (input.playerIdentity?.characterId == null || override.characterId !== input.playerIdentity.characterId) return false;
    } else if (override.playerName.trim().toLowerCase() !== name) {
      return false;
    }
    return override.buildFingerprint != null && override.buildFingerprint === input.buildFingerprint;
  });
  return matches
    .sort((a, b) => {
      const exactSpecA = a.specName == null ? 0 : 1;
      const exactSpecB = b.specName == null ? 0 : 1;
      if (exactSpecA !== exactSpecB) return exactSpecB - exactSpecA;
      const stableIdentityA = a.characterId == null ? 0 : 1;
      const stableIdentityB = b.characterId == null ? 0 : 1;
      if (stableIdentityA !== stableIdentityB) return stableIdentityB - stableIdentityA;
      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id);
    })[0] ?? null;
}

function ruleValue(rule: EffectiveDefensiveModifierRule, rank: number): number {
  return rule.value * (rule.perRank ? rank : 1);
}

export function resolveEffectiveDefensiveKit(
  input: ResolveDefensiveKitInput,
  data: EffectiveDefensiveData,
): ResolvedDefensive[] {
  const normalizedBuild = normalizeTalentBuild(input.talentBuild);
  const ranks = buildRanks(normalizedBuild);
  const unresolvedSelectedNodes = (normalizedBuild ?? []).some((node) => node.rank > 0 && !positiveInteger(node.spellId));
  const gameBuildConfidence = input.gameBuildConfidence ?? (input.gameBuild ? 'verified' : 'uncertain');

  return data.catalog
    .filter((entry) => !entry.excluded && entry.className === input.className && specApplies(entry, input.specName))
    .filter((entry) => input.includeExternal !== false || entry.category !== 'external_defensive')
    .map((entry): ResolvedDefensive => {
      let confidence: DefensiveResolutionConfidence = gameBuildConfidence;
      let eligible = true;
      let cooldownMs = entry.baseCooldownMs;
      let durationMs = entry.baseDurationMs;
      let charges = 1;
      let rechargeMs: number | null = null;
      let targetingMode = TARGETING_MODES.has(entry.targetingMode) ? entry.targetingMode : 'unknown';
      const provenance: ResolutionStep[] = [
        {
          kind: 'catalog_base',
          field: 'cooldown_ms',
          before: null,
          after: cooldownMs,
          description: 'Cooldown base de cooldown_catalog.',
        },
        {
          kind: 'catalog_base',
          field: 'duration_ms',
          before: null,
          after: durationMs,
          description: 'Duración base de cooldown_catalog.',
        },
        {
          kind: 'catalog_base',
          field: 'targeting_mode',
          before: null,
          after: targetingMode,
          description: 'Semántica de target del catálogo.',
        },
      ];
      const conditionalModifiers: ResolutionStep[] = [];

      if (input.talentLookupComplete === false) {
        confidence = weakerConfidence(confidence, 'fallback');
        provenance.push({
          kind: 'eligibility',
          field: 'eligible',
          before: true,
          after: true,
          description: 'No hay lookup completo de talentos; el defensivo se conserva y eligibility queda en fallback.',
        });
      }

      if (input.specName == null && (entry.specName != null || entry.specOverride != null)) {
        confidence = weakerConfidence(confidence, 'uncertain');
        provenance.push({
          kind: 'eligibility',
          field: 'eligible',
          before: true,
          after: true,
          description: 'La spec del jugador no está resuelta; el defensivo se conserva visible pero su pertenencia queda uncertain.',
        });
      }

      if (!TARGETING_MODES.has(entry.targetingMode)) {
        confidence = weakerConfidence(confidence, 'uncertain');
        provenance.push({
          kind: 'validation',
          field: 'targeting_mode',
          before: entry.targetingMode,
          after: 'unknown',
          description: 'targeting_mode inválido; se degrada a unknown.',
        });
      }

      if (input.allTalentSpellIds?.has(entry.spellId)) {
        if (normalizedBuild == null) {
          confidence = weakerConfidence(confidence, 'uncertain');
          provenance.push({
            kind: 'eligibility',
            field: 'eligible',
            before: true,
            after: true,
            description: 'El defensivo es talent-gated, pero no hay snapshot de build; no se oculta y queda uncertain.',
          });
        } else if (ranks.has(entry.spellId)) {
          provenance.push({
            kind: 'eligibility',
            field: 'eligible',
            before: true,
            after: true,
            description: 'El nodo del defensivo está seleccionado en el build observado.',
          });
        } else if (unresolvedSelectedNodes) {
          confidence = weakerConfidence(confidence, 'uncertain');
          provenance.push({
            kind: 'eligibility',
            field: 'eligible',
            before: true,
            after: true,
            description: 'Hay nodos seleccionados sin spellId; no se puede demostrar que el defensivo falte.',
          });
        } else {
          eligible = false;
          provenance.push({
            kind: 'eligibility',
            field: 'eligible',
            before: true,
            after: false,
            description: 'El defensivo es un talento y no está seleccionado en este build.',
          });
        }
      }

      const profileCandidates = data.specProfiles.filter(
        (profile) => profile.className === input.className && profile.specName === input.specName && profile.spellId === entry.spellId,
      );
      const selectedProfile = profileForBuild(profileCandidates, input.gameBuild);
      if (selectedProfile) {
        const { profile, buildConfidence } = selectedProfile;
        confidence = weakerConfidence(confidence, buildConfidence === 'verified' ? gameBuildConfidence : buildConfidence);
        if (profile.baseCooldownMs != null) {
          provenance.push({
            kind: 'spec_profile',
            field: 'cooldown_ms',
            before: cooldownMs,
            after: profile.baseCooldownMs,
            source: profile.source,
            description: profile.sourceNote ?? 'El perfil de spec sustituye el cooldown base.',
            gameBuild: profile.gameBuild,
          });
          cooldownMs = profile.baseCooldownMs;
        }
        if (profile.baseDurationMs != null) {
          provenance.push({
            kind: 'spec_profile',
            field: 'duration_ms',
            before: durationMs,
            after: profile.baseDurationMs,
            source: profile.source,
            description: profile.sourceNote ?? 'El perfil de spec sustituye la duración base.',
            gameBuild: profile.gameBuild,
          });
          durationMs = profile.baseDurationMs;
        }
        provenance.push({
          kind: 'spec_profile',
          field: 'charges',
          before: charges,
          after: profile.charges,
          source: profile.source,
          description: profile.sourceNote ?? 'Cargas base del perfil de spec.',
          gameBuild: profile.gameBuild,
        });
        charges = profile.charges;
        if (profile.rechargeMs != null) {
          provenance.push({
            kind: 'spec_profile',
            field: 'recharge_ms',
            before: rechargeMs,
            after: profile.rechargeMs,
            source: profile.source,
            description: profile.sourceNote ?? 'Recarga base del perfil de spec.',
            gameBuild: profile.gameBuild,
          });
          rechargeMs = profile.rechargeMs;
        }
      }

      const targetRules = data.modifierRules.filter(
        (rule) =>
          rule.active &&
          rule.className === input.className &&
          rule.targetSpellId === entry.spellId,
      );
      const candidateRules = targetRules.filter(
        (rule) => rule.specNames == null || (input.specName != null && rule.specNames.includes(input.specName)),
      );
      if (input.specName == null && targetRules.some((rule) => rule.specNames != null)) {
        confidence = weakerConfidence(confidence, 'uncertain');
        provenance.push({
          kind: 'validation',
          field: 'cooldown_ms',
          before: cooldownMs,
          after: cooldownMs,
          description: 'Hay reglas limitadas por spec, pero la spec del jugador es desconocida; no se aplican.',
        });
      }
      if (candidateRules.length && normalizedBuild == null) {
        confidence = weakerConfidence(confidence, 'uncertain');
        provenance.push({
          kind: 'validation',
          field: 'cooldown_ms',
          before: cooldownMs,
          after: cooldownMs,
          description: 'Existen reglas de talento para este defensivo, pero falta el build; no se aplica ninguna.',
        });
      } else if (candidateRules.length && unresolvedSelectedNodes) {
        confidence = weakerConfidence(confidence, 'uncertain');
        provenance.push({
          kind: 'validation',
          field: 'cooldown_ms',
          before: cooldownMs,
          after: cooldownMs,
          description: 'El build contiene nodos sin spellId; una regla de talento podría no haberse resuelto.',
        });
      }

      // Se elige la versión antes de filtrar por spec. Si una regla exacta
      // cambió de specs, esa ausencia exacta debe ganar sobre una fila legacy
      // más permisiva; de lo contrario una patch nueva heredaría reglas viejas.
      const applicableRules = rulesForBuild(targetRules, input.gameBuild)
        .filter(({ rule }) => rule.specNames == null || (input.specName != null && rule.specNames.includes(input.specName)))
        .filter(({ rule }) => ranks.has(rule.modifierSpellId))
        .sort(
          (a, b) =>
            a.rule.applicationOrder - b.rule.applicationOrder ||
            OPERATION_ORDER[a.rule.operation] - OPERATION_ORDER[b.rule.operation] ||
            a.rule.id.localeCompare(b.rule.id),
        );

      const conflictingSetRuleIds = new Set<string>();
      const setsByFieldAndOrder = new Map<string, { id: string; value: number }[]>();
      for (const { rule } of applicableRules) {
        if (rule.condition !== 'always' || rule.operation !== 'set_ms') continue;
        const key = `${rule.effectField}:${rule.applicationOrder}`;
        const rows = setsByFieldAndOrder.get(key) ?? [];
        rows.push({ id: rule.id, value: ruleValue(rule, ranks.get(rule.modifierSpellId) ?? 0) });
        setsByFieldAndOrder.set(key, rows);
      }
      for (const rows of setsByFieldAndOrder.values()) {
        if (new Set(rows.map((row) => row.value)).size <= 1) continue;
        for (const row of rows) conflictingSetRuleIds.add(row.id);
      }

      const readField = (field: DefensiveEffectField): number | null => {
        if (field === 'cooldown_ms') return cooldownMs;
        if (field === 'duration_ms') return durationMs;
        if (field === 'charges') return charges;
        return rechargeMs ?? cooldownMs;
      };
      const writeField = (field: DefensiveEffectField, value: number): void => {
        if (field === 'cooldown_ms') cooldownMs = value;
        else if (field === 'duration_ms') durationMs = value;
        else if (field === 'charges') charges = value;
        else rechargeMs = value;
      };

      for (const { rule, buildConfidence } of applicableRules) {
        const rank = ranks.get(rule.modifierSpellId) ?? 0;
        const amount = ruleValue(rule, rank);
        const before = readField(rule.effectField);
        const stepBase: Omit<ResolutionStep, 'kind' | 'after'> = {
          field: rule.effectField,
          before,
          operation: rule.operation,
          source: rule.source,
          description: `${rule.description}${rule.perRank ? ` (rango ${rank})` : ''}`,
          gameBuild: rule.gameBuild,
          ruleId: rule.id,
        };

        if (rule.condition === 'conditional') {
          conditionalModifiers.push({ ...stepBase, kind: 'conditional_modifier', after: before });
          continue;
        }
        confidence = weakerConfidence(confidence, buildConfidence === 'verified' ? gameBuildConfidence : buildConfidence);

        if (conflictingSetRuleIds.has(rule.id)) {
          confidence = weakerConfidence(confidence, 'uncertain');
          provenance.push({
            ...stepBase,
            kind: 'validation',
            after: before,
            description: `Reglas set_ms incompatibles para ${rule.effectField}; no se inventa un orden.`,
          });
          continue;
        }
        if (!Number.isFinite(amount) || amount < 0 || (rule.operation === 'charges_add' && !Number.isInteger(amount))) {
          confidence = weakerConfidence(confidence, 'uncertain');
          provenance.push({ ...stepBase, kind: 'validation', after: before, description: 'Valor de regla inválido; no se aplica.' });
          continue;
        }

        let after: number | null = before;
        if (rule.operation === 'set_ms') after = Math.round(amount);
        else if (rule.operation === 'charges_add') after = (before ?? 0) + amount;
        else if (before != null && rule.operation === 'multiply') after = Math.round(before * amount);
        else if (before != null && rule.operation === 'add_ms') after = Math.round(before + amount);
        else if (before != null && rule.operation === 'subtract_ms') after = Math.round(before - amount);

        if (after == null || !Number.isFinite(after) || after < 0 || (rule.effectField === 'charges' && (!Number.isInteger(after) || after < 1))) {
          confidence = weakerConfidence(confidence, 'uncertain');
          provenance.push({ ...stepBase, kind: 'validation', after: before, description: 'La regla produciría un valor inválido; no se aplica.' });
          continue;
        }
        writeField(rule.effectField, after);
        provenance.push({ ...stepBase, kind: 'modifier', after });
      }

      const override = matchingOverride(data.overrides ?? [], input, entry.spellId);
      if (override) {
        confidence = weakerConfidence(confidence, override.buildFingerprint == null ? 'inferred' : 'verified');
        const applyOverride = (field: DefensiveEffectField, value: number | null): void => {
          if (value == null) return;
          const before = readField(field);
          writeField(field, value);
          provenance.push({
            kind: 'player_override',
            field,
            before,
            after: value,
            source: `override:${override.id}`,
            description: override.reason,
            gameBuild: override.gameBuild,
          });
        };
        applyOverride('cooldown_ms', override.effectiveCooldownMs);
        applyOverride('duration_ms', override.effectiveDurationMs);
        applyOverride('charges', override.charges);
        if (override.targetingMode != null) {
          const before = targetingMode;
          targetingMode = override.targetingMode;
          provenance.push({
            kind: 'player_override',
            field: 'targeting_mode',
            before,
            after: targetingMode,
            source: `override:${override.id}`,
            description: override.reason,
            gameBuild: override.gameBuild,
          });
        }
      }

      if (charges > 1 && rechargeMs == null && cooldownMs != null) {
        rechargeMs = cooldownMs;
        provenance.push({
          kind: 'validation',
          field: 'recharge_ms',
          before: null,
          after: rechargeMs,
          description: 'Sin recarga específica: se usa el cooldown efectivo como recarga por carga.',
        });
      }

      if (!nonNegativeInteger(cooldownMs) && cooldownMs != null) confidence = weakerConfidence(confidence, 'uncertain');
      if (!nonNegativeInteger(durationMs) && durationMs != null) confidence = weakerConfidence(confidence, 'uncertain');
      if (!positiveInteger(charges)) confidence = weakerConfidence(confidence, 'uncertain');
      if (!nonNegativeInteger(rechargeMs) && rechargeMs != null) confidence = weakerConfidence(confidence, 'uncertain');

      return {
        spellId: entry.spellId,
        name: entry.name,
        className: entry.className,
        specName: input.specName,
        category: entry.category,
        survivalType: entry.survivalType,
        targetingMode,
        effectiveCooldownMs: cooldownMs,
        effectiveDurationMs: durationMs,
        charges,
        rechargeMs,
        eligible,
        buildFingerprint: input.buildFingerprint,
        gameBuild: input.gameBuild,
        resolverVersion: EFFECTIVE_DEFENSIVE_RESOLVER_VERSION,
        confidence,
        provenance,
        conditionalModifiers,
      };
    })
    .sort((a, b) => a.spellId - b.spellId);
}
