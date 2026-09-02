// Colocar en: src/app/features/manifest/manifest.component.ts
// Tarea manual #1 de la hoja de ruta (§5), pero acelerada: la clasificación
// editorial (avoidable, categoría, umbral) sigue siendo humana, pero el
// candidato en sí sale de sync-boss-mechanics (Blizzard Journal + Wago DB2),
// cero texto tecleado para nombres/IDs.
import { Component, computed, inject, signal } from '@angular/core';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { isCandidateAutoClassified, ManifestService, type ManifestPolicyCoverage, type MechanicCatalogSyncState, type MechanicPolicyStatus, type ObservedHitStat } from '../../core/manifest.service';
import { ReportsService, type KnownBoss } from '../../core/reports.service';
import { formatPct, STANDARD_DIFFICULTY_IDS, WCL_DIFFICULTY_NAME_BY_ID } from '../../shared/format.util';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { MechanicInfoIconComponent } from '../../shared/mechanic-info-icon.component';
import { MechanicResolutionIconComponent } from '../../shared/mechanic-resolution-icon.component';
import type { BossMechanicCandidateRow } from '../../shared/models/domain';
import { difficultyRank, hasExactDifficultyEvidence, isContradictedByOtherDifficulty, type OtherDifficultyEvidence } from '../../shared/difficulty-evidence.util';
import { errorMessage } from '../../shared/error-message.util';
import { parseMechanicPolicySubmission } from '../../shared/mechanic-policy-batches';
import { DefensiveCatalogComponent } from '../defensive-catalog/defensive-catalog.component';
import { DiscordSettingsComponent } from '../discord-settings/discord-settings.component';
import { UnassignedMechanicsCatalogComponent } from '../unassigned-mechanics-catalog/unassigned-mechanics-catalog.component';
import { PolicyManifestEditorComponent } from '../policy-manifest-editor/policy-manifest-editor.component';
import { CombatEvaluationFeatureFlagsService } from '../../core/combat-evaluation-feature-flags.service';

const CATEGORIES = ['tankbuster', 'raid-damage', 'avoidable-ground', 'debuff-stack', 'interrupt', 'soak', 'spread', 'healing-absorb', 'personal-target', 'enrage'] as const;
const RESPONSIBILITIES = ['tank', 'dps', 'healer', 'raid', 'personal'] as const;

// §"vamos mejor a meterlo en ajustes... pestañas, una mecánicas de bosses...
// otra defensivos... así tenemos todos los ajustes centralizados" (feedback
// real): Ajustes pasa de ser una sola pantalla a un contenedor con
// pestañas. DefensiveCatalogComponent se queda intacto como hijo embebido
// (ya tenía su propia URL antes de este cambio; ahora en vez de eso vive
// aquí dentro) — mismo criterio que difficulty-tabs ya usaba: signal, no
// una ruta nueva, para no complicar el deep-linking de algo que es un modo
// de vista, no una entidad con URL propia.
// §"debe estar en la pestaña de ajustes, crear un nuevo submenu llamado
// Discord" (feedback real, 2026-08-28): tercera pestaña, mismo patrón que
// 'defensivos' — DiscordSettingsComponent embebido, sin ruta propia.
// §"UI en Ajustes para gestionar el catálogo a mano" (feedback real,
// 2026-08-29): cuarta pestaña, mismo patrón que 'defensivos' —
// UnassignedMechanicsCatalogComponent embebido, sin ruta propia.
type AjustesTab = 'mecanicas' | 'sin-asignar' | 'defensivos' | 'discord';

// §9.1: un boss sembrado por sync-season-bosses pero nunca pulleado no tiene
// dificultades "vistas" que ofrecer (difficulties queda vacío) — se ofrecen
// las 3 dificultades de raid progresivo para poder elegir cuál consultar.
// (STANDARD_DIFFICULTY_IDS ahora vive en shared/format.util.ts, compartida
// con reports.service.ts — ver import de arriba.)

@Component({
  selector: 'app-manifest',
  standalone: true,
  imports: [WowheadLinkComponent, MechanicInfoIconComponent, MechanicResolutionIconComponent, DefensiveCatalogComponent, DiscordSettingsComponent, UnassignedMechanicsCatalogComponent, PolicyManifestEditorComponent],
  templateUrl: './manifest.component.html',
  styleUrl: './manifest.component.scss',
})
export class ManifestComponent {
  private edgeFunctions = inject(EdgeFunctionsService);
  private manifestService = inject(ManifestService);
  private reportsService = inject(ReportsService);
  protected combatFlags = inject(CombatEvaluationFeatureFlagsService);

  activeTab = signal<AjustesTab>('mecanicas');

  readonly categories = CATEGORIES;
  readonly responsibilities = RESPONSIBILITIES;

  bosses = signal<KnownBoss[]>([]);
  selectedEncounterId = signal<number | null>(null);
  selectedDifficultyId = signal<number | null>(null);
  candidates = signal<BossMechanicCandidateRow[]>([]);
  hitStats = signal<Map<number, ObservedHitStat>>(new Map());
  otherDifficultyEvidence = signal<Map<number, OtherDifficultyEvidence[]>>(new Map());
  excludedByDifficultyCount = signal(0);

  loadingBosses = signal(true);
  syncing = signal(false);
  deepSyncing = signal(false);
  /** "Sincronizando Heroic… (2/3)" mientras onSync recorre las 3 dificultades una a una. */
  syncProgress = signal<string | null>(null);
  syncingSeason = signal(false);
  // §"arriba del todo en la subcabecera un botón de sincronizar para traer
  // los datos de wowaudit actualizados" (feedback real, 2026-08-28): visible
  // en las 3 pestañas de Ajustes (no solo en Discord) porque wowaudit_roster
  // alimenta más que los canales — rol/rango de fiabilidad y Roster también
  // leen de aquí.
  syncingRoster = signal(false);
  rosterSyncResult = signal<string | null>(null);
  rosterSyncError = signal<string | null>(null);
  readonly standardDifficultyIds = STANDARD_DIFFICULTY_IDS;
  loadingCandidates = signal(false);
  savingAbilityId = signal<number | null>(null);
  expandedPolicyAbilityId = signal<number | null>(null);
  backfillingPolicies = signal(false);
  confirmPolicyBackfill = signal(false);
  policyBackfillResult = signal<string | null>(null);
  policyRefreshVersion = signal(0);
  policyCoverage = signal<ManifestPolicyCoverage | null>(null);
  policyCoverageError = signal<string | null>(null);
  catalogSyncState = signal<MechanicCatalogSyncState | null>(null);
  catalogSyncStateError = signal<string | null>(null);
  error = signal<string | null>(null);
  lastSyncSummary = signal<string | null>(null);

  // §"un prompt para pasar a la IA y que investigue... clasificar todas las
  // mecánicas" (feedback real): mismo patrón de dos pasos que
  // llm-analysis-card.component.ts — copiar prompt / pegar respuesta —
  // aquí acotado siempre a boss+dificultad, nunca gasta la API propia.
  classifyPanelOpen = signal(false);
  loadingClassifyPrompt = signal(false);
  classifyPromptError = signal<string | null>(null);
  classifySystemPrompt = signal<string | null>(null);
  classifyUserMessage = signal<string | null>(null);
  classifyMechanicCount = signal(0);
  classifyPromptVersion = signal<number | null>(null);
  classifyCopied = signal(false);
  classifyPasteText = signal('');
  classifySubmitting = signal(false);
  classifySubmitError = signal<string | null>(null);
  classifyResult = signal<{
    submittedCount: number;
    fullyAppliedCount: number;
    applied: { abilityId: number; difficulty: string; name: string; category: string }[];
    skippedLowConfidence: { abilityId: number; difficulty: string; name: string; category: string | null; notes: string }[];
    skippedUndetermined: { abilityId: number; difficulty: string; name: string }[];
    invalid: { abilityId: unknown; difficulty: unknown; reason: string }[];
    resolutionsApplied: { abilityId: number; difficulty: string; name: string; resolution: string }[];
    resolutionsSkipped: { abilityId: number; difficulty: string; name: string; reason: string }[];
    resolutionContractMissing: boolean;
    responsibilitiesApplied: { abilityId: number; difficulty: string; name: string; responsibility: string }[];
    responsibilitiesSkipped: { abilityId: number; difficulty: string; name: string; reason: string }[];
    responsibilityContractMissing: boolean;
    avoidablesApplied: { abilityId: number; difficulty: string; name: string; avoidable: boolean | null }[];
    avoidablesSkipped: { abilityId: number; difficulty: string; name: string; reason: string }[];
    avoidableContractMissing: boolean;
  } | null>(null);

  policyClassifyPanelOpen = signal(false);
  loadingPolicyClassifyPrompt = signal(false);
  policyClassifyPromptError = signal<string | null>(null);
  policyClassifySystemPrompt = signal<string | null>(null);
  policyClassifyUserMessage = signal<string | null>(null);
  policyClassifyBossId = signal<string | null>(null);
  policyClassifyDifficulties = signal<string[]>([]);
  policyClassifyIdentities = signal<{ abilityId: number; mechanicKey: string; difficulty: string }[]>([]);
  policyClassifySkippedDifficulties = signal<{
    difficulty: string;
    totalCandidates: number;
    missingIdentities: number;
  }[]>([]);
  policyClassifyCount = signal(0);
  policyClassifyMaxBatchSize = signal(20);
  policyClassifyPromptVersion = signal<number | null>(null);
  policyClassifyCopied = signal(false);
  policyClassifyPasteText = signal('');
  policyClassifySubmitting = signal(false);
  policyClassifyProgress = signal<string | null>(null);
  policyClassifySubmitError = signal<string | null>(null);
  policyClassifyResult = signal<{
    submittedCount: number;
    applied: {
      abilityId: number;
      mechanicKey: string;
      difficulty: string;
      name: string;
      confidence: 'inferred' | 'uncertain';
      policyVersion: number;
    }[];
    invalid: { abilityId: unknown; mechanicKey: unknown; reason: string }[];
  } | null>(null);

  selectedBoss = computed(() => this.bosses().find((b) => b.encounterId === this.selectedEncounterId()) ?? null);
  selectedDifficultyName = computed(() => (this.selectedDifficultyId() != null ? WCL_DIFFICULTY_NAME_BY_ID[this.selectedDifficultyId()!] : null));
  classifiedCandidateCount = computed(() => this.candidates().filter(isCandidateAutoClassified).length);
  pendingPolicyGenerationCount = computed(() => {
    const coverage = this.policyCoverage();
    return coverage ? coverage.basePolicies + coverage.missingPolicies : 0;
  });
  pendingPolicyReviewCount = computed(() => {
    const coverage = this.policyCoverage();
    return coverage
      ? coverage.basePolicies + coverage.uncertainPolicies + coverage.missingPolicies
      : 0;
  });

  constructor() {
    void this.loadBosses();
  }

  async loadBosses(): Promise<void> {
    this.loadingBosses.set(true);
    try {
      this.bosses.set(await this.reportsService.listKnownBosses());
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loadingBosses.set(false);
    }
  }

  selectBoss(encounterId: number): void {
    this.selectedEncounterId.set(encounterId);
    const boss = this.bosses().find((b) => b.encounterId === encounterId);
    // Preselecciona una dificultad con pulls propios si hay alguna (es la
    // más probable que se quiera consultar); si no hay ninguna, no se
    // preselecciona nada — las 3 siguen ahí para elegir a mano.
    this.selectedDifficultyId.set(boss?.difficulties[0] ?? null);
    this.candidates.set([]);
    this.excludedByDifficultyCount.set(0);
    this.closeClassifyPanel();
    this.closePolicyClassifyPanel();
    if (boss?.difficulties.length) void this.loadCandidates();
  }

  bossIdForPolicy(encounterId: number): string {
    return String(encounterId);
  }

  mechanicKeyFor(candidate: BossMechanicCandidateRow): string {
    return candidate.mechanic_key?.trim() || `ability:${candidate.ability_id}`;
  }

  policyStatusFor(candidate: BossMechanicCandidateRow): MechanicPolicyStatus {
    return this.policyCoverage()?.policiesByMechanicKey.get(this.mechanicKeyFor(candidate))?.status ?? 'missing';
  }

  policyStatusLabel(candidate: BossMechanicCandidateRow): string {
    const policy = this.policyCoverage()?.policiesByMechanicKey.get(this.mechanicKeyFor(candidate));
    if (!policy) return 'Sin policy';
    if (policy.status === 'base') return `Base v${policy.policyVersion}`;
    if (policy.status === 'verified') return `Verificada v${policy.policyVersion}`;
    if (policy.status === 'uncertain') return `Incierta v${policy.policyVersion}`;
    return `Revisada v${policy.policyVersion}`;
  }

  formatStatusDate(value: string | null): string {
    if (!value) return 'nunca';
    return new Intl.DateTimeFormat('es-ES', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  }

  togglePolicy(candidate: BossMechanicCandidateRow): void {
    this.expandedPolicyAbilityId.update((abilityId) =>
      abilityId === candidate.ability_id ? null : candidate.ability_id,
    );
  }

  openFirstPendingPolicy(): void {
    const candidate = this.candidates().find((entry) => {
      const status = this.policyStatusFor(entry);
      return status === 'base' || status === 'uncertain' || status === 'missing';
    });
    if (candidate) this.expandedPolicyAbilityId.set(candidate.ability_id);
  }

  async runPolicyBackfill(): Promise<void> {
    this.backfillingPolicies.set(true);
    this.error.set(null);
    try {
      const result = await this.edgeFunctions.backfillMechanicCandidatesToPolicy();
      this.policyBackfillResult.set(
        `${result.policiesCreated} policies y ${result.aliasesCreated} aliases preparados desde ${result.totalCandidates} mecánicas aplicables.`,
      );
      this.policyRefreshVersion.update((version) => version + 1);
      await this.loadCandidates();
      this.confirmPolicyBackfill.set(false);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.backfillingPolicies.set(false);
    }
  }

  selectDifficulty(difficultyId: number): void {
    this.selectedDifficultyId.set(difficultyId);
    this.closeClassifyPanel();
    this.closePolicyClassifyPanel();
    void this.loadCandidates();
  }

  async loadCandidates(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty) return;
    this.loadingCandidates.set(true);
    this.error.set(null);
    this.policyCoverageError.set(null);
    this.catalogSyncStateError.set(null);
    try {
      const [candidates, hitStats, otherDifficultyEvidence, catalogSyncState] = await Promise.all([
        this.manifestService.listCandidates(String(bossId), difficulty),
        this.manifestService.listObservedHitStats(String(bossId), difficulty),
        this.manifestService.listOtherDifficultyEvidence(String(bossId), difficulty),
        this.manifestService.getCatalogSyncState(String(bossId), difficulty).catch((err) => {
          this.catalogSyncStateError.set(errorMessage(err));
          return null;
        }),
      ]);
      const visibleCandidates = candidates.filter((candidate) => !isContradictedByOtherDifficulty(candidate, otherDifficultyEvidence.get(candidate.ability_id) ?? []));
      this.candidates.set(visibleCandidates);
      this.excludedByDifficultyCount.set(candidates.length - visibleCandidates.length);
      this.hitStats.set(hitStats);
      this.otherDifficultyEvidence.set(otherDifficultyEvidence);
      this.catalogSyncState.set(catalogSyncState);
      if (this.combatFlags.enabled('mechanicPolicyV2')) {
        try {
          this.policyCoverage.set(await this.manifestService.getPolicyCoverage(
            String(bossId),
            difficulty,
            visibleCandidates,
          ));
        } catch (err) {
          this.policyCoverage.set(null);
          this.policyCoverageError.set(errorMessage(err));
        }
      } else {
        this.policyCoverage.set(null);
      }
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loadingCandidates.set(false);
    }
  }

  // §"hay que hacer esto por cada dificultad en lugar de traernos todo de
  // todas las dificultades" (feedback real): sync-boss-mechanics acepta
  // `difficulties: number[]` y las recorre todas en un solo Deno.serve —
  // pero mandar las 3 en UNA sola llamada (con deep sync, varias referencias
  // referencia POR dificultad, cada uno con ~6-7 queries WCL) resultó ser
  // demasiado para una sola invocación de Edge Function: §bug real
  // reportado y reproducido en real (2026-08-27, boss 3445): "Edge Function
  // returned a non-2xx status code" — HTTP 546 WORKER_RESOURCE_LIMIT
  // ("not having enough compute resources"), y en otro intento varias
  // dificultades fallaban con errores de rate-limit de WCL a mitad de
  // función. La sincronización en sí (una dificultad, deep sync) YA
  // funcionaba bien antes de este cambio — el problema es agrupar 4 en una
  // sola invocación, no el volumen total de trabajo en sí. Solución: el
  // FRONTEND sigue ofreciendo "sincronizar las 3 a la vez" como una sola
  // acción, pero por debajo hace 3 llamadas secuenciales (una por
  // dificultad) en vez de una. Un fallo en una dificultad ya no aborta las
  // demás, sigue con la siguiente.
  // Contrastado además en real: encadenar las 3 llamadas SIN pausa seguía
  // reventando la 3ª/4ª igual (mismo WORKER_RESOURCE_LIMIT) y de paso hacía
  // fallar el fetch de Wago DB2 (mappingStatus caía a
  // difficulty-metadata-unavailable) — la MISMA dificultad, aislada y sin
  // llamadas justo antes, sincronizaba perfecta en <25s. No es "4
  // dificultades" lo que revienta, es encadenar invocaciones pesadas sin
  // aire entre medias — de ahí la pausa de 5s entre cada una, dentro del
  // bucle de abajo.
  //
  // §"no sé muy bien para qué sirve el sync profundo... si aporta algo"
  // (feedback real): sí aporta — hasta 20 logs públicos de referencia por
  // dificultad en vez de 3, así que la contrastación entre dificultades
  // (§9.2, de la que depende directamente que no se mezclen mecánicas) es
  // más fiable con más muestra. Por eso sigue siendo el comportamiento POR
  // DEFECTO al sincronizar un boss entero — queda un enlace secundario para
  // cuando de verdad solo hace falta un refresco rápido.
  async onSync(deepSync = true): Promise<void> {
    const bossId = this.selectedEncounterId();
    if (bossId == null) return;
    if (deepSync) this.deepSyncing.set(true);
    else this.syncing.set(true);
    this.error.set(null);
    this.lastSyncSummary.set(null);
    let totalUpserts = 0;
    let totalCandidates = 0;
    const perDifficulty: string[] = [];
    const failures: string[] = [];
    try {
      for (const [i, diffId] of this.standardDifficultyIds.entries()) {
        const label = this.difficultyLabel(diffId);
        // §contrastado en real (2026-08-27): partir en 4 llamadas
        // secuenciales quita el crash de "4 a la vez" (§comentario de
        // arriba), pero encadenarlas SIN pausa seguía reventando la 3ª/4ª
        // (WORKER_RESOURCE_LIMIT) y además hacía fallar el fetch de Wago
        // DB2 (mappingStatus caía a difficulty-metadata-unavailable) —
        // aislada, esa misma dificultad sincronizaba perfecta en <25s. Una
        // pausa corta entre dificultades le da tiempo al runtime/Wago a
        // recuperarse antes de la siguiente invocación pesada.
        if (i > 0) {
          this.syncProgress.set(`Esperando antes de ${label}… (${i + 1}/${this.standardDifficultyIds.length})`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        this.syncProgress.set(`Sincronizando ${label}… (${i + 1}/${this.standardDifficultyIds.length})`);
        try {
          const result = await this.edgeFunctions.syncBossMechanics(String(bossId), [diffId], deepSync);
          totalCandidates = result.candidates; // mismo Journal para las 3 — no se suma, solo se refresca
          totalUpserts += result.upserts;
          for (const d of result.difficulties) {
            perDifficulty.push(
              `${d.difficulty}: ${d.mappingStatus}` +
                (d.snapshotFetchError ? ` (⚠ sin mapeo oficial Wago: ${d.snapshotFetchError})` : '') +
                (d.referenceFetchError ? ` (⚠ sin logs de referencia: ${d.referenceFetchError})` : ''),
            );
          }
        } catch (err) {
          failures.push(`${label}: ${errorMessage(err)}`);
        }
      }
      this.lastSyncSummary.set(
        `${totalCandidates} candidatas del Journal, ${totalUpserts} sincronizadas en total` +
          (deepSync ? ' (sync profundo, hasta 20 logs de referencia por dificultad)' : ' (sync rápido, hasta 3 logs de referencia por dificultad)') +
          `. ` +
          perDifficulty.join(' · ') +
          (failures.length ? ` · ✕ FALLÓ: ${failures.join(' · ')}` : ''),
      );
      await this.loadCandidates();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.syncing.set(false);
      this.deepSyncing.set(false);
      this.syncProgress.set(null);
    }
  }

  /** §9.1: siembra known_raid_bosses para toda la instancia — así aparecen en la lista los bosses que la guild no ha pulleado todavía. */
  async onSyncSeason(): Promise<void> {
    this.syncingSeason.set(true);
    this.error.set(null);
    this.lastSyncSummary.set(null);
    try {
      const result = await this.edgeFunctions.syncSeasonBosses();
      this.lastSyncSummary.set(
        `${result.zoneName}: ${result.bossesSeeded} bosses en el catálogo (${result.journalEncountersMatched}/${result.wclEncountersSeen} confirmados por Blizzard Journal), ${result.referenceStatsUpserts} filas de comparativa global sembradas.`,
      );
      await this.loadBosses();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.syncingSeason.set(false);
    }
  }

  /** §"un botón de sincronizar para traer los datos de wowaudit actualizados": trae rango/rol/asistencia frescos de wowaudit — no edita nada aquí (esta app solo espeja wowaudit, nunca al revés), así que un ascenso hecho EN wowaudit ya se refleja tras esto; uno que solo se acordó verbalmente no. */
  async onSyncRoster(): Promise<void> {
    this.syncingRoster.set(true);
    this.rosterSyncError.set(null);
    this.rosterSyncResult.set(null);
    try {
      const result = await this.edgeFunctions.syncWowauditRoster();
      this.rosterSyncResult.set(`Roster actualizado ✓ (${result.charactersSynced} personajes) — ${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (err) {
      this.rosterSyncError.set(errorMessage(err));
    } finally {
      this.syncingRoster.set(false);
    }
  }

  async onEdit(
    candidate: BossMechanicCandidateRow,
    patch: Partial<Pick<BossMechanicCandidateRow, 'category' | 'responsibility' | 'avoidable' | 'severity_threshold' | 'reviewed'>>,
  ): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty) return;

    this.savingAbilityId.set(candidate.ability_id);
    try {
      await this.edgeFunctions.saveMechanicEdit({
        bossId: String(bossId),
        difficulty,
        abilityId: candidate.ability_id,
        category: 'category' in patch ? patch.category : candidate.category,
        responsibility: 'responsibility' in patch ? patch.responsibility : candidate.responsibility,
        avoidable: 'avoidable' in patch ? patch.avoidable : candidate.avoidable,
        expectedResponse: candidate.expected_response,
        severityThreshold: patch.severity_threshold ?? candidate.severity_threshold,
        reviewed: patch.reviewed ?? true,
      });
      this.candidates.update((list) => list.map((c) => (c.ability_id === candidate.ability_id ? { ...c, ...patch, reviewed: patch.reviewed ?? true } : c)));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.savingAbilityId.set(null);
    }
  }

  // §"señalar cuándo una mecánica es exclusiva de cierta dificultad —
  // parecen pisarse entre sí": si ESTA dificultad no tiene ninguna
  // evidencia real (ni casts emparejados ni logs de referencia) pero OTRA
  // dificultad del mismo boss sí la tiene, es una pista real de que puede
  // ser exclusiva de esa otra. Las filas contradichas ya se excluyen en
  // loadCandidates; esta nota explica las visibles aún no concluyentes.
  crossDifficultyNote(candidate: BossMechanicCandidateRow): { text: string; kind: 'warning' | 'info' } | null {
    const hasEvidenceHere = hasExactDifficultyEvidence(candidate);
    if (hasEvidenceHere) return null;
    const others = this.otherDifficultyEvidence().get(candidate.ability_id) ?? [];
    const withEvidence = others.filter((o) => o.hasEvidence);
    const ownRank = difficultyRank(candidate.difficulty);
    // §bug real reportado (2026-08-27, boss 3445 "Entombed Sentinels", "es
    // raro que en mítico no haya mecánicas que sí hay en normal o hc"):
    // igual que isContradictedByOtherDifficulty, solo cuenta como pista de
    // exclusividad la evidencia vista en una dificultad MÁS DURA — los
    // tiers duros casi nunca quitan mecánicas que ya existían en los
    // fáciles. Evidencia en una dificultad más fácil (o igual, no debería
    // pasar) se sigue avisando, pero como 'info' tranquilizador en vez de
    // 'warning' — antes ambos casos compartían el mismo ⚠, que sonaba a
    // problema incluso cuando el mensaje explicaba que no lo era.
    const harder = withEvidence.filter((o) => difficultyRank(o.difficulty) > ownRank).map((o) => o.difficulty);
    const easierOrEqual = withEvidence.filter((o) => difficultyRank(o.difficulty) <= ownRank).map((o) => o.difficulty);
    if (harder.length) return { kind: 'warning', text: `Sin evidencia aquí, pero sí en ${harder.join('/')} — puede ser exclusiva de esa dificultad` };
    if (easierOrEqual.length) {
      return {
        kind: 'info',
        text: `Vista en ${easierOrEqual.join('/')}, sin confirmar aquí todavía — no se oculta solo por eso (las dificultades más duras no suelen perder mecánicas de las más fáciles), probablemente solo falta muestra`,
      };
    }
    // §"filtrar bien por dificultad... ver un método fiable y que se pueda
    // contrastar" (feedback real): isContradictedByOtherDifficulty solo
    // puede excluir una candidata cuando hay evidencia POSITIVA en otra
    // dificultad que la contradiga — una candidata sin evidencia en NINGUNA
    // dificultad (solo del Journal/DB2, nunca vista en un log real ni
    // propio ni de referencia) no tiene nada que la contradiga y por tanto
    // nunca se excluye, pero tampoco se distinguía visualmente de una fila
    // confirmada de verdad. Se avisa igual que el caso de arriba, mismo
    // estilo, para que quede claro cuál de las dos cosas es.
    if (candidate.reference_source_report) {
      return { kind: 'info', text: 'Todavía sin ninguna evidencia observada (ni en vuestros logs ni en los de referencia) — candidata solo del Journal, sin confirmar' };
    }
    return null;
  }

  difficultyEvidenceLabel(candidate: BossMechanicCandidateRow): string {
    const sources: string[] = [];
    if (candidate.observed_in_logs) sources.push('log de la guild');
    if (candidate.observed_in_reference_logs || (candidate.reference_occurrences ?? 0) > 0) sources.push('logs públicos de referencia');
    if (candidate.observed_as_interrupt) sources.push('interrupt observado');
    if (sources.length) return `verificada en ${candidate.difficulty}: ${sources.join(' + ')}`;
    return candidate.reference_source_report
      ? `no observada en la referencia de ${candidate.difficulty}; conservada por falta de contradicción concluyente`
      : `Journal compartido; ${candidate.difficulty} todavía sin contraste suficiente`;
  }

  difficultyLabel(id: number): string {
    return WCL_DIFFICULTY_NAME_BY_ID[id] ?? `Dificultad ${id}`;
  }

  // §"si tienes muestras para que no sea el 0.35, actualiza ahi el valor
  // real para que sea visual" (feedback real, 2026-08-27): en cuanto hay
  // ≥5 muestras de referencia, resolveSeverity (_shared/mechanic-severity.
  // ts) deja de mirar el severity_threshold fijo de esta fila — el número
  // del <input> deja de ser "la verdad" y esto calcula la que sí lo es,
  // para no dejar la cifra vieja en pantalla sin avisar. Ahí,
  // percentileRank es count(samples <= X)/length > 50%; eso equivale
  // exactamente al valor en el índice floor(length/2) del array ordenado —
  // misma frontera, forma cerrada. No se puede importar el archivo real
  // (Deno vs Angular, mismo problema que PERSONAL_RESPONSIBILITY_CATEGORIES
  // duplicado a mano en la migración de personal_mechanic_fail_count).
  effectiveThreshold(samples: number[] | null | undefined): number | null {
    if (!samples || samples.length < 5) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  formatPct = formatPct;

  hitStatFor(abilityId: number): ObservedHitStat | null {
    return this.hitStats().get(abilityId) ?? null;
  }

  // Sugerencia heurística a partir de vuestros propios logs, no de un
  // umbral mágico: pocos jugadores golpeados de media = probablemente
  // evitable/posicional; casi todo el raid = probablemente raid-wide.
  // Deliberadamente conservadora — sin normalizar por tamaño de raid (no lo
  // tenemos persistido), así que solo sugiere en los casos claros y nunca
  // decide sola: sigue siendo un clic humano.
  suggestedAvoidable(abilityId: number): boolean | null {
    const stat = this.hitStatFor(abilityId);
    if (!stat) return null;
    if (stat.avgPlayersHit <= 6) return true;
    if (stat.avgPlayersHit >= 15) return false;
    return null;
  }

  applySuggestion(candidate: BossMechanicCandidateRow): void {
    const suggestion = this.suggestedAvoidable(candidate.ability_id);
    if (suggestion === null) return;
    void this.onEdit(candidate, { avoidable: suggestion });
  }

  /** Confirma tal cual la sugerencia de sync-boss-mechanics (categoría inferida de texto del Journal + comportamiento en un log público de referencia — ver inferred_category_reasons). */
  confirmInferredCategory(candidate: BossMechanicCandidateRow): void {
    if (!candidate.inferred_category) return;
    void this.onEdit(candidate, { category: candidate.inferred_category });
  }

  // Angular templates no pueden llamar a Number()/globals arbitrarios directamente.
  toNumber(value: string): number {
    return Number(value);
  }

  // §"el prompt de mecánicas de bosses no puede consultar las 3
  // dificultades a la vez... asegurando la calidad de datos obviamente"
  // (feedback real, 2026-08-27): antes se generaba SIEMPRE para el
  // boss+dificultad seleccionados en pantalla, nunca mezclaba dificultades
  // — eso seguía siendo cierto EN LA MISMA LLAMADA, pero obligaba a repetir
  // la investigación una vez por dificultad. Ahora scope='all' cubre TODAS
  // las dificultades del boss con candidatas en un único prompt — la
  // "calidad de datos" se mantiene porque cada fila del prompt lleva su
  // propia difficulty y la IA investiga cada (habilidad, dificultad) por
  // separado (ver classify-mechanics/index.ts), no porque se sigan pidiendo
  // de una en una. scope=<difficulty> sigue disponible como opción más
  // estrecha (ej. tras añadir una mecánica nueva solo en una dificultad).
  classifyScope = signal<string | 'all' | null>(null);

  async openClassifyPanel(scope: string | 'all'): Promise<void> {
    this.closePolicyClassifyPanel();
    this.classifyPanelOpen.set(true);
    this.classifyResult.set(null);
    if (this.classifySystemPrompt() != null && this.classifyScope() === scope) return; // ya traído para este alcance, no repetir la llamada
    this.classifyScope.set(scope);
    const bossId = this.selectedEncounterId();
    if (bossId == null) return;
    this.loadingClassifyPrompt.set(true);
    this.classifyPromptError.set(null);
    try {
      const res = await this.edgeFunctions.getMechanicClassificationPrompt(String(bossId), scope === 'all' ? undefined : [scope]);
      this.classifySystemPrompt.set(res.systemPrompt);
      this.classifyUserMessage.set(res.userMessage);
      this.classifyMechanicCount.set(res.mechanicCount);
      this.classifyPromptVersion.set(res.promptVersion);
    } catch (err) {
      this.classifyPromptError.set(errorMessage(err));
    } finally {
      this.loadingClassifyPrompt.set(false);
    }
  }

  closeClassifyPanel(): void {
    this.classifyPanelOpen.set(false);
    this.classifyScope.set(null);
    this.classifySystemPrompt.set(null);
    this.classifyUserMessage.set(null);
    this.classifyPromptVersion.set(null);
    this.classifyPasteText.set('');
    this.classifySubmitError.set(null);
    this.classifyResult.set(null);
  }

  get classifyFullPrompt(): string {
    return `${this.classifySystemPrompt() ?? ''}\n\n---\n\n${this.classifyUserMessage() ?? ''}`;
  }

  async copyClassifyPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.classifyFullPrompt);
      this.classifyCopied.set(true);
      setTimeout(() => this.classifyCopied.set(false), 2000);
    } catch (err) {
      this.classifyPromptError.set('No se pudo copiar automáticamente — selecciona el texto a mano. (' + errorMessage(err) + ')');
    }
  }

  async submitClassification(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const scope = this.classifyScope();
    if (bossId == null || !scope || !this.classifyPasteText().trim()) return;
    this.classifySubmitting.set(true);
    this.classifySubmitError.set(null);
    try {
      const res = await this.edgeFunctions.submitMechanicClassification(String(bossId), scope === 'all' ? undefined : [scope], this.classifyPasteText());
      this.classifyPasteText.set('');
      // §bug real encontrado (2026-08-23, feedback real: "el desplegable
      // 'sin clasificar' no cambia aunque haya sido clasificado"): esto
      // ANTES se hacía después de fijar classifyResult — el banner de
      // "✓ N mecánicas clasificadas" aparecía mientras loadCandidates()
      // todavía estaba en vuelo, así que se veía el éxito y la tabla vieja
      // a la vez (los datos SÍ se guardaban bien, solo llegaban tarde a
      // pantalla). Se espera a tener la tabla fresca antes de anunciar éxito.
      await this.loadCandidates();
      this.classifyResult.set({
        submittedCount: res.submittedCount,
        fullyAppliedCount: res.fullyAppliedCount,
        applied: res.applied,
        skippedLowConfidence: res.skippedLowConfidence,
        skippedUndetermined: res.skippedUndetermined,
        invalid: res.invalid,
        resolutionsApplied: res.resolutionsApplied,
        resolutionsSkipped: res.resolutionsSkipped,
        resolutionContractMissing: res.resolutionContractMissing,
        responsibilitiesApplied: res.responsibilitiesApplied,
        responsibilitiesSkipped: res.responsibilitiesSkipped,
        responsibilityContractMissing: res.responsibilityContractMissing,
        avoidablesApplied: res.avoidablesApplied,
        avoidablesSkipped: res.avoidablesSkipped,
        avoidableContractMissing: res.avoidableContractMissing,
      });
    } catch (err) {
      this.classifySubmitError.set(errorMessage(err));
    } finally {
      this.classifySubmitting.set(false);
    }
  }

  async openPolicyClassifyPanel(): Promise<void> {
    const bossId = this.selectedEncounterId();
    if (bossId == null) return;
    this.closeClassifyPanel();
    this.policyClassifyPanelOpen.set(true);
    this.policyClassifyResult.set(null);
    if (this.policyClassifySystemPrompt() != null && this.policyClassifyBossId() === String(bossId)) return;
    this.policyClassifyBossId.set(String(bossId));
    this.loadingPolicyClassifyPrompt.set(true);
    this.policyClassifyPromptError.set(null);
    try {
      const res = await this.edgeFunctions.getMechanicPolicyClassificationPrompt(String(bossId));
      this.policyClassifySystemPrompt.set(res.systemPrompt);
      this.policyClassifyUserMessage.set(res.userMessage);
      this.policyClassifyCount.set(res.policyCount);
      this.policyClassifyDifficulties.set(res.difficulties);
      this.policyClassifyIdentities.set(res.policyIdentities);
      this.policyClassifySkippedDifficulties.set(res.skippedDifficulties ?? []);
      this.policyClassifyMaxBatchSize.set(res.maxBatchSize);
      this.policyClassifyPromptVersion.set(res.promptVersion);
    } catch (err) {
      this.policyClassifyPromptError.set(errorMessage(err));
    } finally {
      this.loadingPolicyClassifyPrompt.set(false);
    }
  }

  closePolicyClassifyPanel(): void {
    this.policyClassifyPanelOpen.set(false);
    this.policyClassifyBossId.set(null);
    this.policyClassifyDifficulties.set([]);
    this.policyClassifyIdentities.set([]);
    this.policyClassifySkippedDifficulties.set([]);
    this.policyClassifySystemPrompt.set(null);
    this.policyClassifyUserMessage.set(null);
    this.policyClassifyPromptVersion.set(null);
    this.policyClassifyCount.set(0);
    this.policyClassifyPasteText.set('');
    this.policyClassifyProgress.set(null);
    this.policyClassifyPromptError.set(null);
    this.policyClassifySubmitError.set(null);
    this.policyClassifyResult.set(null);
  }

  get policyClassifyFullPrompt(): string {
    return `${this.policyClassifySystemPrompt() ?? ''}\n\n---\n\n${this.policyClassifyUserMessage() ?? ''}`;
  }

  async copyPolicyClassifyPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.policyClassifyFullPrompt);
      this.policyClassifyCopied.set(true);
      setTimeout(() => this.policyClassifyCopied.set(false), 2_000);
    } catch (err) {
      this.policyClassifyPromptError.set(`No se pudo copiar automáticamente — selecciona el texto a mano. (${errorMessage(err)})`);
    }
  }

  async submitPolicyClassification(): Promise<void> {
    const bossId = this.selectedEncounterId();
    if (bossId == null || !this.policyClassifyPasteText().trim()) return;
    this.policyClassifySubmitting.set(true);
    this.policyClassifySubmitError.set(null);
    const previousResult = this.policyClassifyResult();
    const applied: {
      abilityId: number;
      mechanicKey: string;
      difficulty: string;
      name: string;
      confidence: 'inferred' | 'uncertain';
      policyVersion: number;
    }[] = [...(previousResult?.applied ?? [])];
    const invalid: { abilityId: unknown; mechanicKey: unknown; reason: string }[] = [];
    let submittedCount = previousResult?.submittedCount ?? 0;
    try {
      const submission = parseMechanicPolicySubmission(
        this.policyClassifyPasteText(),
        this.policyClassifyMaxBatchSize(),
        previousResult ? undefined : this.policyClassifyIdentities(),
      );
      if (!previousResult) submittedCount = submission.submittedCount;
      if (!previousResult && submission.submittedCount !== this.policyClassifyCount()) {
        throw new Error(`La respuesta contiene ${submission.submittedCount} policies, pero el prompt pedía ${this.policyClassifyCount()}. No se ha publicado nada.`);
      }

      let remainingEntries = [...submission.entries];
      for (const [index, batch] of submission.batches.entries()) {
        this.policyClassifyProgress.set(
          `Publicando ${batch.difficulty} · lote ${index + 1}/${submission.batches.length} · ${batch.entries.length} policies`,
        );
        const result = await this.edgeFunctions.submitMechanicPolicyClassification(
          String(bossId),
          batch.difficulty,
          JSON.stringify(batch.entries),
        );
        applied.push(...result.applied);
        invalid.push(...result.invalid);

        const batchEntries = new Set(batch.entries);
        const invalidKeys = new Set(
          result.invalid
            .map((entry) => typeof entry.mechanicKey === 'string' ? entry.mechanicKey : null)
            .filter((key): key is string => key != null),
        );
        remainingEntries = remainingEntries.filter((entry) =>
          !batchEntries.has(entry) ||
          (typeof entry['mechanicKey'] === 'string' && invalidKeys.has(entry['mechanicKey'])),
        );
        this.policyClassifyPasteText.set(remainingEntries.length ? JSON.stringify(remainingEntries, null, 2) : '');
        this.policyClassifyResult.set({ submittedCount, applied: [...applied], invalid: [...invalid] });
      }

      this.policyRefreshVersion.update((version) => version + 1);
      await this.loadCandidates();
      this.policyClassifyResult.set({
        submittedCount,
        applied,
        invalid,
      });
      if (!invalid.length) {
        this.policyClassifySystemPrompt.set(null);
        this.policyClassifyUserMessage.set(null);
      }
    } catch (err) {
      if (applied.length) {
        this.policyRefreshVersion.update((version) => version + 1);
        await this.loadCandidates().catch(() => {});
        this.policyClassifyResult.set({ submittedCount, applied, invalid });
      }
      this.policyClassifySubmitError.set(errorMessage(err));
    } finally {
      this.policyClassifyProgress.set(null);
      this.policyClassifySubmitting.set(false);
    }
  }
}
