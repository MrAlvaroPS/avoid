// Colocar en: src/app/features/boss-prep/boss-prep.component.ts
// §"Preparación" (ver plan guardado, conversación real 2026-08-30): catálogo
// de peligrosidad/timing por mecánica (independiente del efecto whack-a-mole
// de un pull concreto, ver punto 4 de la infografía) + asignación de
// defensivo por spec + generador de reminders MRT. Mismo esqueleto que
// unassigned-mechanics-catalog.component.ts (lista de bosses + tabs de
// dificultad + tabla editable + un edge function por escritura), sección
// propia en el nav en vez de tab de Ajustes porque así se pidió — ver
// app.routes.ts/app.html.
import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import {
  EdgeFunctionsService,
  type ControlledDefensiveBackfillAuditCase,
  type DefensiveReanalysisJobRef,
  type DefensiveV2ReadinessResult,
} from '../../core/edge-functions.service';
import { ManifestService } from '../../core/manifest.service';
import { BossMechanicDefensiveProfileService } from '../../core/boss-mechanic-defensive-profile.service';
import { DefensiveCatalogService } from '../../core/defensive-catalog.service';
import {
  DefensivePreparationRosterService,
  type DefensivePreparationPlayer,
} from '../../core/defensive-preparation-roster.service';
import { ReportsService, type KnownBoss } from '../../core/reports.service';
import { STANDARD_DIFFICULTY_IDS, WCL_DIFFICULTY_NAME_BY_ID } from '../../shared/format.util';
import { ALL_CLASSES, specsForClass, mechanicAppliesToRole, roleFromSpec } from '../../shared/spec-role.util';
import { defensivesForSpec } from '../../shared/defensive-spec-match.util';
import { encodeMrtExport, spellTag, type MrtReminderInput, type MrtTrigger } from '../../shared/mrt/mrt-reminder-codec';
import { exportDeployedPlanToMrt } from '../../shared/mrt/deployed-plan-mrt';
import { autoAssignCascade } from '../../shared/mrt/auto-assign-cascade.util';
import { errorMessage } from '../../shared/error-message.util';
import { classColor } from '../../shared/format.util';
import { ClassIconComponent } from '../../shared/class-icon.component';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { MechanicResolutionIconComponent } from '../../shared/mechanic-resolution-icon.component';
import type {
  BossMechanicCandidateRow,
  BossMechanicDefensiveProfileRow,
  CooldownCatalogRow,
  DefensivePlanMemberRow,
  DefensivePlanSlotRow,
  DefensivePlanVersionRow,
  MechanicDefensiveAssignmentRow,
  ResolvedDefensiveRow,
  ResolvedPlayerDefensiveKitResult,
} from '../../shared/models/domain';

// §Validado en real (2026-08-30, ver mrt-reminder-codec.ts): un export real
// decodificado desde el juego en Normal trajo difficultyId=14 — confirma
// que MRT usa SU PROPIO id de dificultad, distinto del de WCL
// (WCL_DIFFICULTY_NAME_BY_ID de esta misma app: 1=LFR/3=Normal/4=Heroic/
// 5=Mythic).
const MRT_DIFFICULTY_ID_BY_WCL_DIFFICULTY_ID: Record<number, number> = { 1: 17, 3: 14, 4: 15, 5: 16 };

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface AssignmentDraft {
  abilityId: number;
  class: string;
  spec: string;
  defensiveSpellId: number | null;
  prewarnSeconds: number;
  triggerType: 'bossmod' | 'time';
  bossmodSpellId: string;
  notes: string;
  /** Grupos de raid (1-6) — [] = todos/sin restringir. Ver migración 20260831130000. */
  assignedGroups: number[];
}

const RAID_GROUPS = [1, 2, 3, 4, 5, 6];

interface ExportResult {
  class: string;
  spec: string;
  text: string;
  skippedForMissingTiming: string[];
  timeFallbacks: string[];
}

interface TimelineEntry {
  trackKey: string;
  abilityId: number;
  name: string;
  timeMs: number;
  priority: number | null;
  assignment: MechanicDefensiveAssignmentRow | DefensivePlanSlotRow | null;
  defensiveName: string | null;
  cooldownMs: number | null;
  /** El mismo defensivo ya se habría usado antes en esta cronología y su cooldown no le habría dado tiempo a estar libre de nuevo aquí. */
  conflict: boolean;
}

@Component({
  selector: 'app-boss-prep',
  standalone: true,
  imports: [DecimalPipe, PercentPipe, DatePipe, ClassIconComponent, WowheadLinkComponent, MechanicResolutionIconComponent],
  templateUrl: './boss-prep.component.html',
  styleUrl: './boss-prep.component.scss',
})
export class BossPrepComponent {
  private edgeFunctions = inject(EdgeFunctionsService);
  private manifestService = inject(ManifestService);
  private profileService = inject(BossMechanicDefensiveProfileService);
  private defensiveCatalogService = inject(DefensiveCatalogService);
  private defensivePreparationRoster = inject(DefensivePreparationRosterService);
  private reportsService = inject(ReportsService);

  readonly standardDifficultyIds = STANDARD_DIFFICULTY_IDS;
  readonly allClasses = ALL_CLASSES;
  readonly raidGroups = RAID_GROUPS;
  readonly classColor = classColor;

  bosses = signal<KnownBoss[]>([]);
  loadingBosses = signal(true);
  selectedEncounterId = signal<number | null>(null);
  selectedDifficultyId = signal<number | null>(null);
  assignmentView = signal<'spec' | 'player'>('spec');
  preparationPlayers = signal<DefensivePreparationPlayer[]>([]);
  loadingPreparationPlayers = signal(false);
  preparationPlayersError = signal<string | null>(null);
  selectedPlayerCharacterId = signal<number | null>(null);
  selectedPlayerKit = signal<ResolvedPlayerDefensiveKitResult | null>(null);
  loadingSelectedPlayerKit = signal(false);
  selectedPlayerKitError = signal<string | null>(null);
  private selectedPlayerKitRequestId = 0;
  expandedKitSpellId = signal<number | null>(null);
  editingOverrideSpellId = signal<number | null>(null);
  overrideCooldownSeconds = signal('');
  overrideDurationSeconds = signal('');
  overrideReason = signal('');
  overrideConfirmKey = signal<string | null>(null);
  savingOverride = signal(false);
  overrideResult = signal<string | null>(null);
  draftInvalidatedByOverride = signal(false);
  planningResourceSelections = signal<Record<string, number[]>>({});
  includeSemiInTemplateAuto = signal(false);
  generatingPlan = signal(false);
  publishingPlan = signal(false);
  planActionMessage = signal<string | null>(null);

  candidates = signal<BossMechanicCandidateRow[]>([]);
  profiles = signal<BossMechanicDefensiveProfileRow[]>([]);
  assignments = signal<MechanicDefensiveAssignmentRow[]>([]);
  planVersions = signal<DefensivePlanVersionRow[]>([]);
  activePlanVersion = signal<DefensivePlanVersionRow | null>(null);
  planMembers = signal<DefensivePlanMemberRow[]>([]);
  planSlots = signal<DefensivePlanSlotRow[]>([]);
  loadingRows = signal(false);
  error = signal<string | null>(null);

  v2Readiness = signal<DefensiveV2ReadinessResult | null>(null);
  v2ReadinessLoading = signal(true);
  v2ReadinessError = signal<string | null>(null);
  v2ReadinessDetailsOpen = signal(false);
  private v2ReadinessTask: Promise<void> | null = null;

  backfillSampleSize = signal(5);
  backfillBatchId = signal<string | null>(null);
  backfillRunning = signal(false);
  backfillProgress = signal<{ total: number; completed: number; running: number; failed: number } | null>(null);
  backfillAudit = signal<ControlledDefensiveBackfillAuditCase[]>([]);
  backfillError = signal<string | null>(null);
  backfillReused = signal(false);
  backfillProgressPercent = computed(() => {
    const progress = this.backfillProgress();
    return progress?.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  });

  cooldownCatalog = signal<CooldownCatalogRow[]>([]);

  syncing = signal(false);
  syncSummary = signal<string | null>(null);
  syncState = signal<{ referenceFightsConsumed: number; lastSyncedAt: string | null } | null>(null);

  expandedAbilityId = signal<number | null>(null);
  /** §"doble clasificación: al pulsar despliega las clases... y la fila de clase se pueda desplegar para ver specs" (feedback real, 2026-08-31) — clave `${abilityId}|${class}`, un solo grupo abierto a la vez por mecánica. */
  expandedMechanicClass = signal<string | null>(null);
  savingProfileId = signal<number | null>(null);
  assignmentDraft = signal<AssignmentDraft | null>(null);
  savingAssignment = signal(false);
  confirmingDeleteAssignmentId = signal<string | null>(null);

  exportResult = signal<ExportResult | null>(null);
  copyStatus = signal<'idle' | 'copied' | 'error'>('idle');
  exportModalOpen = signal(false);

  selectedBoss = computed(() => this.bosses().find((b) => b.encounterId === this.selectedEncounterId()) ?? null);
  selectedDifficultyName = computed(() => (this.selectedDifficultyId() != null ? WCL_DIFFICULTY_NAME_BY_ID[this.selectedDifficultyId()!] : null));
  selectedPreparationPlayer = computed(
    () => this.preparationPlayers().find((player) => player.characterId === this.selectedPlayerCharacterId()) ?? null,
  );
  selectedPlayerBuildState = computed<'fresh_verified' | 'inferred' | 'stale' | 'unknown' | 'changed_after_draft'>(() => {
    const player = this.selectedPreparationPlayer();
    if (!player) return 'unknown';
    const draft = this.activePlanVersion()?.status === 'draft' ? this.activePlanVersion() : null;
    const member = draft
      ? this.planMembers().find(
          (candidate) =>
            candidate.character_id === player.characterId ||
            candidate.player_name.toLocaleLowerCase() === player.name.toLocaleLowerCase(),
        )
      : null;
    if (
      member?.build_fingerprint &&
      player.buildFingerprint &&
      member.build_fingerprint !== player.buildFingerprint
    ) {
      return 'changed_after_draft';
    }
    return player.freshness;
  });
  selectedPlayerEffectiveKit = computed(() => this.selectedPlayerKit()?.kit ?? []);
  selectedPlayerEligibleDefensiveCount = computed(() => this.selectedPlayerEffectiveKit().filter((defensive) => defensive.eligible).length);
  activeDraft = computed(() => this.activePlanVersion()?.status === 'draft' ? this.activePlanVersion() : null);
  publishedPlan = computed(() => this.planVersions().find((plan) => plan.status === 'published') ?? null);
  exactOverrideScopeReady = computed(() => {
    const source = this.selectedPlayerKit()?.sourceBuild;
    const player = this.selectedPreparationPlayer();
    const state = this.selectedPlayerBuildState();
    return Boolean(
      player?.specName &&
      this.v2Readiness()?.capabilities.playerOverride === true &&
      source?.gameBuild &&
      source.fingerprint &&
      (state === 'fresh_verified' || state === 'inferred' || state === 'changed_after_draft'),
    );
  });

  /** Mecánica + su perfil de daño/timing (si ya se sincronizó) + sus asignaciones — una fila de la tabla. */
  mechanicRows = computed(() => {
    const profiles = this.profiles();
    const assignments = this.assignments();
    return this.candidates().map((candidate) => ({
      candidate,
      profile: profiles.find((p) => p.ability_id === candidate.ability_id) ?? null,
      assignments: assignments.filter((a) => a.ability_id === candidate.ability_id),
    }));
  });

  /** §"saber que los defensivos que asignas no dejan huecos de mecánicas... sin cubrir" (feedback real, 2026-08-31): mecánicas que SÍ exigen defensivo (auto o a mano) pero no tienen ni una sola asignación, de ninguna clase/spec, en este boss+dificultad. */
  coverageGaps = computed(() => {
    const assignedAbilityIds = this.planSlots().length
      ? new Set(
          this.planSlots()
            .filter((slot) => slot.assigned_player_key != null && (slot.coverage_status === 'covered' || slot.coverage_status === 'partial'))
            .map((slot) => slot.ability_id),
        )
      : new Set(this.assignments().map((a) => a.ability_id));
    return this.mechanicRows().filter((r) => r.profile?.requires_defensive === true && !assignedAbilityIds.has(r.candidate.ability_id));
  });

  constructor() {
    void this.loadBosses();
    void this.loadCooldownCatalog();
    void this.ensureV2Readiness();
  }

  private ensureV2Readiness(): Promise<void> {
    this.v2ReadinessTask ??= this.loadV2Readiness();
    return this.v2ReadinessTask;
  }

  private async loadV2Readiness(): Promise<void> {
    this.v2ReadinessLoading.set(true);
    this.v2ReadinessError.set(null);
    try {
      const readiness = await this.edgeFunctions.defensiveV2Readiness();
      this.v2Readiness.set(readiness);
      if (!readiness.capabilities.playerMode && this.assignmentView() === 'player') this.assignmentView.set('spec');
      if (readiness.capabilities.playerMode && !this.preparationPlayers().length) {
        void this.loadPreparationPlayers();
      }
    } catch (err) {
      this.v2Readiness.set(null);
      this.v2ReadinessError.set(errorMessage(err));
      if (this.assignmentView() === 'player') this.assignmentView.set('spec');
    } finally {
      this.v2ReadinessLoading.set(false);
    }
  }

  selectAssignmentView(view: 'spec' | 'player'): void {
    this.assignmentView.set(view);
    this.timelineEntries.set([]);
    if (view === 'player' && this.v2Readiness()?.capabilities.playerMode && !this.preparationPlayers().length) {
      void this.loadPreparationPlayers();
    }
  }

  private async loadPreparationPlayers(): Promise<void> {
    if (this.loadingPreparationPlayers()) return;
    this.loadingPreparationPlayers.set(true);
    this.preparationPlayersError.set(null);
    try {
      const players = await this.defensivePreparationRoster.listPlayers();
      this.preparationPlayers.set(players);
      if (this.selectedPlayerCharacterId() != null && !players.some((player) => player.characterId === this.selectedPlayerCharacterId())) {
        this.selectedPlayerCharacterId.set(null);
        this.selectedPlayerKit.set(null);
      }
    } catch (err) {
      this.preparationPlayersError.set(errorMessage(err));
      this.preparationPlayers.set([]);
    } finally {
      this.loadingPreparationPlayers.set(false);
    }
  }

  async selectPreparationPlayer(rawCharacterId: string): Promise<void> {
    const requestId = ++this.selectedPlayerKitRequestId;
    const characterId = Number(rawCharacterId);
    this.selectedPlayerCharacterId.set(Number.isInteger(characterId) && characterId > 0 ? characterId : null);
    this.selectedPlayerKit.set(null);
    this.selectedPlayerKitError.set(null);
    this.loadingSelectedPlayerKit.set(false);
    this.expandedKitSpellId.set(null);
    this.editingOverrideSpellId.set(null);
    this.overrideResult.set(null);
    const player = this.selectedPreparationPlayer();
    if (!player) return;
    this.loadingSelectedPlayerKit.set(true);
    try {
      const resolved = await this.edgeFunctions.resolvePlayerDefensiveKit({
          playerName: player.name,
          characterId: player.characterId,
          className: player.className,
          includeExternal: true,
        });
      if (requestId === this.selectedPlayerKitRequestId && this.selectedPlayerCharacterId() === player.characterId) {
        this.selectedPlayerKit.set(resolved);
      }
    } catch (err) {
      if (requestId === this.selectedPlayerKitRequestId) this.selectedPlayerKitError.set(errorMessage(err));
    } finally {
      if (requestId === this.selectedPlayerKitRequestId) this.loadingSelectedPlayerKit.set(false);
    }
  }

  playerBuildStateLabel(): string {
    switch (this.selectedPlayerBuildState()) {
      case 'fresh_verified': return 'Actualizado · verificado';
      case 'inferred': return 'Actualizado';
      case 'stale': return 'Build desactualizado';
      case 'changed_after_draft': return 'Cambió después del borrador';
      default: return 'Faltan datos del build';
    }
  }

  defensiveCategoryLabel(category: ResolvedDefensiveRow['category']): string {
    if (category === 'personal_defensive') return 'Personal';
    if (category === 'semi_defensive') return 'Semi · opcional';
    if (category === 'external_defensive') return 'External · opcional';
    return 'Utility';
  }

  defensiveSurvivalLabel(defensive: ResolvedDefensiveRow): string {
    if (defensive.survivalType === 'mitigation') return 'Mitigación';
    if (defensive.survivalType === 'absorption') return 'Absorción';
    if (defensive.survivalType === 'sustain') return 'Sustain';
    if (defensive.survivalType === 'emergency') return 'Emergencia';
    return 'Tipo sin revisar';
  }

  defensiveConfidenceLabel(defensive: ResolvedDefensiveRow): string {
    if (this.defensiveHasManualOverride(defensive)) return 'Manual';
    if (defensive.confidence === 'verified') return 'Verificado';
    if (defensive.confidence === 'inferred') return 'Datos actuales';
    if (defensive.confidence === 'fallback') return 'Fallback';
    return 'Necesita datos';
  }

  planMemberFor(playerKey: string | null): DefensivePlanMemberRow | null {
    if (!playerKey) return null;
    return this.planMembers().find((member) => member.player_key === playerKey) ?? null;
  }

  visiblePlanSlotsForAbility(abilityId: number): DefensivePlanSlotRow[] {
    const selectedPlayer = this.selectedPreparationPlayer();
    return this.planSlots()
      .filter((slot) => slot.ability_id === abilityId && slot.assigned_player_key != null)
      .filter((slot) => {
        const member = this.planMemberFor(slot.assigned_player_key);
        if (!member?.included) return false;
        if (this.assignmentView() === 'player') {
          return Boolean(
            selectedPlayer &&
            (member.character_id === selectedPlayer.characterId ||
              member.player_name.toLocaleLowerCase() === selectedPlayer.name.toLocaleLowerCase()),
          );
        }
        return member.class === this.autoAssignClass() && member.spec === this.autoAssignSpec();
      })
      .sort(
        (left, right) =>
          left.occurrence_time_ms - right.occurrence_time_ms ||
          left.occurrence_index - right.occurrence_index ||
          left.slot_index - right.slot_index,
      );
  }

  displayedAssignmentCount(abilityId: number, legacyCount: number): number {
    return this.planSlots().length ? this.visiblePlanSlotsForAbility(abilityId).length : legacyCount;
  }

  planDefensiveName(spellId: number | null): string {
    if (spellId == null) return '—';
    return this.cooldownCatalog().find((entry) => entry.spell_id === spellId)?.name ?? `#${spellId}`;
  }

  planningResourceSelected(defensive: ResolvedDefensiveRow): boolean {
    const player = this.selectedPreparationPlayer();
    if (!player) return false;
    const explicit = this.planningResourceSelections()[player.name.toLocaleLowerCase()];
    return explicit ? explicit.includes(defensive.spellId) : defensive.category === 'personal_defensive';
  }

  planningResourceSelectable(defensive: ResolvedDefensiveRow): boolean {
    return defensive.eligible && defensive.category !== 'utility';
  }

  togglePlanningResource(defensive: ResolvedDefensiveRow): void {
    const player = this.selectedPreparationPlayer();
    const kit = this.selectedPlayerKit()?.kit ?? [];
    if (!player || !this.planningResourceSelectable(defensive)) return;
    const key = player.name.toLocaleLowerCase();
    const current = this.planningResourceSelections()[key] ?? kit
      .filter((entry) => entry.category === 'personal_defensive' && entry.eligible)
      .map((entry) => entry.spellId);
    const next = current.includes(defensive.spellId)
      ? current.filter((spellId) => spellId !== defensive.spellId)
      : [...current, defensive.spellId].sort((left, right) => left - right);
    this.planningResourceSelections.update((selections) => ({ ...selections, [key]: next }));
  }

  toggleKitInspector(spellId: number): void {
    this.expandedKitSpellId.set(this.expandedKitSpellId() === spellId ? null : spellId);
  }

  defensiveBaseValue(defensive: ResolvedDefensiveRow, field: 'cooldown_ms' | 'duration_ms'): number | null {
    const step = defensive.provenance.find((item) => item.kind === 'catalog_base' && item.field === field);
    return typeof step?.after === 'number' ? step.after : null;
  }

  defensiveAutomaticValue(defensive: ResolvedDefensiveRow, field: 'cooldown_ms' | 'duration_ms'): number | null {
    const override = defensive.provenance.find((item) => item.kind === 'player_override' && item.field === field);
    const value = override ? override.before : field === 'cooldown_ms' ? defensive.effectiveCooldownMs : defensive.effectiveDurationMs;
    return typeof value === 'number' ? value : null;
  }

  defensiveHasManualOverride(defensive: ResolvedDefensiveRow): boolean {
    return defensive.provenance.some((step) => step.kind === 'player_override');
  }

  defensiveDeltaMs(defensive: ResolvedDefensiveRow, field: 'cooldown_ms' | 'duration_ms'): number | null {
    const base = this.defensiveBaseValue(defensive, field);
    const automatic = this.defensiveAutomaticValue(defensive, field);
    return base == null || automatic == null ? null : automatic - base;
  }

  defensiveDeltaLabel(defensive: ResolvedDefensiveRow, field: 'cooldown_ms' | 'duration_ms'): string {
    const delta = this.defensiveDeltaMs(defensive, field);
    if (delta == null || delta === 0) return 'sin cambio automático';
    return `${delta > 0 ? '+' : '−'}${Math.abs(delta) / 1000}s por build`;
  }

  beginOverrideEdit(defensive: ResolvedDefensiveRow): void {
    this.editingOverrideSpellId.set(defensive.spellId);
    this.overrideCooldownSeconds.set(defensive.effectiveCooldownMs == null ? '' : String(defensive.effectiveCooldownMs / 1000));
    this.overrideDurationSeconds.set(defensive.effectiveDurationMs == null ? '' : String(defensive.effectiveDurationMs / 1000));
    this.overrideReason.set('');
    this.overrideConfirmKey.set(null);
    this.overrideResult.set(null);
  }

  cancelOverrideEdit(): void {
    this.editingOverrideSpellId.set(null);
    this.overrideConfirmKey.set(null);
  }

  requestSaveOverride(defensive: ResolvedDefensiveRow): void {
    const key = `save:${defensive.spellId}`;
    if (this.overrideConfirmKey() !== key) {
      this.overrideConfirmKey.set(key);
      return;
    }
    void this.persistPlayerOverride(defensive, 'save');
  }

  requestDeactivateOverride(defensive: ResolvedDefensiveRow): void {
    const key = `deactivate:${defensive.spellId}`;
    if (this.overrideConfirmKey() !== key) {
      this.overrideConfirmKey.set(key);
      this.overrideReason.set('Restablecer el valor automático verificado.');
      return;
    }
    void this.persistPlayerOverride(defensive, 'deactivate');
  }

  private async persistPlayerOverride(defensive: ResolvedDefensiveRow, action: 'save' | 'deactivate'): Promise<void> {
    const player = this.selectedPreparationPlayer();
    const source = this.selectedPlayerKit()?.sourceBuild;
    if (!player?.specName || !source?.gameBuild || !source.fingerprint || !this.exactOverrideScopeReady()) {
      this.selectedPlayerKitError.set('No hay fingerprint fiable; solo se permite una corrección de snapshot de borrador.');
      return;
    }
    const cooldownSeconds = this.overrideCooldownSeconds().trim() === '' ? null : Number(this.overrideCooldownSeconds());
    const durationSeconds = this.overrideDurationSeconds().trim() === '' ? null : Number(this.overrideDurationSeconds());
    if (
      action === 'save' &&
      ((cooldownSeconds != null && (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 0)) ||
        (durationSeconds != null && (!Number.isFinite(durationSeconds) || durationSeconds < 0)) ||
        (cooldownSeconds == null && durationSeconds == null))
    ) {
      this.selectedPlayerKitError.set('Introduce cooldown o duración efectivos válidos.');
      return;
    }
    if (!this.overrideReason().trim()) {
      this.selectedPlayerKitError.set('El motivo auditable es obligatorio.');
      return;
    }
    this.savingOverride.set(true);
    this.selectedPlayerKitError.set(null);
    try {
      await this.edgeFunctions.managePlayerDefensiveOverride({
        action,
        characterId: player.characterId,
        playerName: player.name,
        className: player.className,
        specName: player.specName,
        spellId: defensive.spellId,
        gameBuild: source.gameBuild,
        buildFingerprint: source.fingerprint,
        ...(action === 'save'
          ? {
              effectiveCooldownMs: cooldownSeconds == null ? null : Math.round(cooldownSeconds * 1000),
              effectiveDurationMs: durationSeconds == null ? null : Math.round(durationSeconds * 1000),
            }
          : {}),
        reason: this.overrideReason().trim(),
      });
      const resultMessage = action === 'save'
        ? 'Override exacto guardado. El borrador activo queda stale; no se reanalizó histórico.'
        : 'Override desactivado. Se restauró el cálculo automático; el borrador activo queda stale.';
      this.draftInvalidatedByOverride.set(true);
      this.editingOverrideSpellId.set(null);
      this.overrideConfirmKey.set(null);
      await this.selectPreparationPlayer(String(player.characterId));
      this.overrideResult.set(resultMessage);
    } catch (err) {
      this.selectedPlayerKitError.set(errorMessage(err));
    } finally {
      this.savingOverride.set(false);
    }
  }

  formatResolutionValue(field: string, value: number | string | boolean | null): string {
    if (value == null) return '—';
    if (typeof value === 'number' && ['cooldown_ms', 'duration_ms', 'recharge_ms'].includes(field)) return `${value / 1000}s`;
    return String(value);
  }

  async retryV2Readiness(): Promise<void> {
    this.v2ReadinessTask = null;
    await this.ensureV2Readiness();
    if (this.selectedEncounterId() != null) await this.loadRows();
  }

  toggleV2ReadinessDetails(): void {
    this.v2ReadinessDetailsOpen.update((open) => !open);
  }

  onBackfillSampleSize(raw: string): void {
    const value = Math.floor(Number(raw));
    if (Number.isInteger(value) && value >= 5 && value <= 10) this.backfillSampleSize.set(value);
  }

  async startControlledBackfill(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty || this.backfillRunning()) return;
    if (this.v2Readiness()?.capabilities.evaluator !== true) {
      this.backfillError.set('Resolver, M7 y M8 deben estar listos antes de ejecutar un backfill v2.');
      return;
    }
    this.backfillRunning.set(true);
    this.backfillError.set(null);
    this.backfillAudit.set([]);
    try {
      const started = await this.edgeFunctions.startControlledDefensiveBackfill({
        bossId: String(bossId),
        difficulty,
        sampleSize: this.backfillSampleSize(),
      });
      this.backfillBatchId.set(started.batchId);
      this.backfillReused.set(started.reused);
      this.backfillProgress.set({ total: started.pullIds.length, completed: 0, running: 0, failed: 0 });
      await this.runControlledBackfillJobs(started.jobs);
    } catch (err) {
      this.backfillError.set(errorMessage(err));
    } finally {
      this.backfillRunning.set(false);
    }
  }

  private async runControlledBackfillJobs(jobs: DefensiveReanalysisJobRef[]): Promise<void> {
    let completed = 0;
    let failed = 0;
    const total = Math.max(this.backfillProgress()?.total ?? 0, jobs.length);
    for (const job of jobs) {
      this.backfillProgress.set({ total, completed, running: 1, failed });
      try {
        await this.edgeFunctions.reanalyzeDefensivePressure(job.pullId, job.id);
        completed++;
      } catch (err) {
        failed++;
        console.error(`Falló el pull ${job.pullId} del backfill controlado:`, err);
      }
      this.backfillProgress.set({ total, completed, running: 0, failed });
    }
    await this.refreshControlledBackfillReport();
    this.v2ReadinessTask = null;
    await this.ensureV2Readiness();
  }

  async refreshControlledBackfillReport(): Promise<void> {
    const batchId = this.backfillBatchId();
    if (!batchId) return;
    try {
      const report = await this.edgeFunctions.controlledDefensiveBackfillReport(batchId);
      this.backfillProgress.set(report.progress);
      this.backfillAudit.set(report.cases);
      this.backfillError.set(null);
    } catch (err) {
      this.backfillError.set(errorMessage(err));
    }
  }

  async retryControlledBackfillFailures(): Promise<void> {
    const batchId = this.backfillBatchId();
    if (!batchId || this.backfillRunning()) return;
    this.backfillRunning.set(true);
    this.backfillError.set(null);
    try {
      await this.edgeFunctions.retryDefensiveReanalysisQueue(batchId);
      const pending = await this.edgeFunctions.pendingDefensiveReanalysisJobs(batchId, 10);
      await this.runControlledBackfillJobs(pending.jobs);
    } catch (err) {
      this.backfillError.set(errorMessage(err));
    } finally {
      this.backfillRunning.set(false);
    }
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

  async loadCooldownCatalog(): Promise<void> {
    try {
      this.cooldownCatalog.set(await this.defensiveCatalogService.listAll());
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  selectBoss(encounterId: number): void {
    this.selectedEncounterId.set(encounterId);
    const boss = this.bosses().find((b) => b.encounterId === encounterId);
    this.selectedDifficultyId.set(boss?.difficulties[0] ?? this.standardDifficultyIds[0]);
    this.closeAll();
    void this.loadRows();
  }

  selectDifficulty(difficultyId: number): void {
    this.selectedDifficultyId.set(difficultyId);
    this.closeAll();
    void this.loadRows();
  }

  private closeAll(): void {
    this.expandedAbilityId.set(null);
    this.expandedMechanicClass.set(null);
    this.assignmentDraft.set(null);
    this.exportResult.set(null);
    this.syncSummary.set(null);
    this.backfillBatchId.set(null);
    this.backfillProgress.set(null);
    this.backfillAudit.set([]);
    this.backfillError.set(null);
    this.backfillReused.set(false);
  }

  async loadRows(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty) return;
    this.loadingRows.set(true);
    this.error.set(null);
    try {
      await this.ensureV2Readiness();
      const planManagementReady = this.v2Readiness()?.capabilities.planManagement === true;
      const [candidates, profiles, assignments, syncState, planVersions] = await Promise.all([
        this.manifestService.listCandidates(String(bossId), difficulty),
        this.profileService.listProfiles(String(bossId), difficulty),
        this.profileService.listAssignments(String(bossId), difficulty),
        this.profileService.getSyncState(String(bossId), difficulty),
        planManagementReady
          ? this.profileService.listPlanVersions(String(bossId), difficulty)
          : Promise.resolve([] as DefensivePlanVersionRow[]),
      ]);
      this.candidates.set(candidates);
      this.profiles.set(profiles);
      this.assignments.set(assignments);
      this.syncState.set(syncState);
      this.planVersions.set(planVersions);
      const activePlan = planVersions[0] ?? null;
      this.activePlanVersion.set(activePlan);
      if (activePlan) {
        const contents = await this.profileService.getPlanContents(activePlan.id);
        this.planMembers.set(contents.members);
        this.planSlots.set(contents.slots);
      } else {
        this.planMembers.set([]);
        this.planSlots.set([]);
      }
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loadingRows.set(false);
    }
  }

  async runSync(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficultyId = this.selectedDifficultyId();
    if (bossId == null || difficultyId == null) return;
    this.syncing.set(true);
    this.error.set(null);
    this.syncSummary.set(null);
    try {
      const res = await this.edgeFunctions.syncMechanicDefensiveProfile(String(bossId), [difficultyId]);
      const difficulty = this.selectedDifficultyName();
      if (!difficulty) throw new Error('No se pudo resolver la dificultad seleccionada.');
      const local = await this.edgeFunctions.syncLocalDefensiveProfile(String(bossId), difficulty);
      const r = res.results[0];
      // §"muchos muchos muchos logs" (feedback real, 2026-08-31): cada
      // sync trae la SIGUIENTE tanda, no repite — totalFightsConsumed es
      // la muestra acumulada real, no solo esta tanda. exhausted avisa
      // cuando el leaderboard ya no tiene más logs nuevos que dar.
      this.syncSummary.set(
        r
          ? `+${r.referenceFightsUsed} logs world (${r.mechanicsProfiled} mecánicas y ${r.occurrenceProfilesUpdated ?? 0} ocurrencias); evidencia local reconstruida desde ${local.eligiblePulls} pulls (${local.profilesUpdated} perfiles) — ${r.totalFightsConsumed} world acumulados.` +
            (r.exhausted ? ' El leaderboard público no tiene (por ahora) más logs nuevos que dar.' : '')
          : 'Sin resultado — revisa que el boss tenga mecánicas curadas en Ajustes → Mecánicas.',
      );
      await this.loadRows();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.syncing.set(false);
    }
  }

  toggleExpanded(abilityId: number): void {
    this.expandedAbilityId.set(this.expandedAbilityId() === abilityId ? null : abilityId);
    this.expandedMechanicClass.set(null);
    this.assignmentDraft.set(null);
  }

  /** §"al pulsar sobre la fila de la mecánica... despliegue el acordeón, siempre que no sea pulsar en el desplegable de exige defensivo o requiere turnos" (feedback real, 2026-08-31): toda la fila es clicable salvo los controles interactivos propios (select/checkbox/textarea/botón "asignaciones" ya tiene su propio toggle — sin excluir BUTTON aquí se dispararían los dos handlers en el mismo click y se anularían entre sí). */
  onMechanicRowClick(event: MouseEvent, abilityId: number): void {
    const tag = (event.target as HTMLElement | null)?.tagName;
    if (tag && ['SELECT', 'INPUT', 'TEXTAREA', 'BUTTON', 'OPTION', 'A'].includes(tag)) return;
    this.toggleExpanded(abilityId);
  }

  toggleMechanicClass(abilityId: number, cls: string): void {
    const key = `${abilityId}|${cls}`;
    this.expandedMechanicClass.set(this.expandedMechanicClass() === key ? null : key);
  }

  isMechanicClassExpanded(abilityId: number, cls: string): boolean {
    return this.expandedMechanicClass() === `${abilityId}|${cls}`;
  }

  groupAssignmentsByClass(rows: MechanicDefensiveAssignmentRow[]): { class: string; rows: MechanicDefensiveAssignmentRow[] }[] {
    const byClass = new Map<string, MechanicDefensiveAssignmentRow[]>();
    for (const r of rows) {
      if (!byClass.has(r.class)) byClass.set(r.class, []);
      byClass.get(r.class)!.push(r);
    }
    return [...byClass.entries()].map(([cls, classRows]) => ({ class: cls, rows: classRows })).sort((a, b) => a.class.localeCompare(b.class));
  }

  // --- edición manual del perfil (requires_defensive/group_split/reviewed) ---

  async setRequiresDefensive(abilityId: number, value: boolean | null): Promise<void> {
    await this.saveProfileEdit(abilityId, { requiresDefensive: value });
  }

  async setRequiresGroupSplit(abilityId: number, value: boolean): Promise<void> {
    await this.saveProfileEdit(abilityId, { requiresGroupSplit: value });
  }

  async setGroupSplitNotes(abilityId: number, notes: string): Promise<void> {
    await this.saveProfileEdit(abilityId, { groupSplitNotes: notes.trim() || null });
  }

  async setReviewed(abilityId: number, value: boolean): Promise<void> {
    await this.saveProfileEdit(abilityId, { reviewed: value });
  }

  private async saveProfileEdit(
    abilityId: number,
    patch: { requiresDefensive?: boolean | null; requiresGroupSplit?: boolean; groupSplitNotes?: string | null; reviewed?: boolean },
  ): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty) return;
    this.savingProfileId.set(abilityId);
    this.error.set(null);
    try {
      await this.edgeFunctions.saveMechanicDefensiveProfileEdit({ bossId: String(bossId), difficulty, abilityId, ...patch });
      this.profiles.update((rows) => {
        const idx = rows.findIndex((r) => r.ability_id === abilityId);
        const base: BossMechanicDefensiveProfileRow =
          idx >= 0
            ? rows[idx]
            : {
                id: '',
                boss_id: String(bossId),
                difficulty,
                ability_id: abilityId,
                reference_unmitigated_damage_samples: [],
                reference_mitigated_damage_samples: [],
                reference_role_hit_breakdown: null,
                reference_cast_offset_ms_samples: [],
                reference_sample_fight_count: 0,
                priority: null,
                requires_defensive: null,
                requires_defensive_source: null,
                requires_group_split: false,
                group_split_notes: null,
                reviewed: false,
                updated_at: new Date().toISOString(),
              };
        const merged: BossMechanicDefensiveProfileRow = {
          ...base,
          ...('requiresDefensive' in patch ? { requires_defensive: patch.requiresDefensive ?? null, requires_defensive_source: patch.requiresDefensive == null ? null : ('manual_override' as const) } : {}),
          ...('requiresGroupSplit' in patch ? { requires_group_split: patch.requiresGroupSplit ?? false } : {}),
          ...('groupSplitNotes' in patch ? { group_split_notes: patch.groupSplitNotes ?? null } : {}),
          ...('reviewed' in patch ? { reviewed: patch.reviewed ?? false } : {}),
        };
        return idx >= 0 ? rows.map((r, i) => (i === idx ? merged : r)) : [...rows, merged];
      });
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.savingProfileId.set(null);
    }
  }

  /** Select nativo (sin FormsModule, mismo criterio que unassigned-mechanics-catalog.component.html) — "" = sin decidir. */
  onRequiresDefensiveChange(abilityId: number, raw: string): void {
    void this.setRequiresDefensive(abilityId, raw === '' ? null : raw === 'true');
  }

  // --- asignaciones de defensivo por spec ---

  onDraftClassChange(raw: string): void {
    this.updateAssignmentDraft({ class: raw });
  }
  onDraftSpecChange(raw: string): void {
    this.updateAssignmentDraft({ spec: raw });
  }
  onDraftDefensiveChange(raw: string): void {
    this.updateAssignmentDraft({ defensiveSpellId: raw ? Number(raw) : null });
  }
  onDraftPrewarnChange(raw: string): void {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) this.updateAssignmentDraft({ prewarnSeconds: n });
  }
  onDraftTriggerTypeChange(raw: string): void {
    this.updateAssignmentDraft({ triggerType: raw === 'time' ? 'time' : 'bossmod' });
  }
  onDraftBossmodSpellIdChange(raw: string): void {
    this.updateAssignmentDraft({ bossmodSpellId: raw });
  }
  onDraftNotesChange(raw: string): void {
    this.updateAssignmentDraft({ notes: raw });
  }

  openAssignmentDraft(abilityId: number, existing?: MechanicDefensiveAssignmentRow): void {
    const cls = existing?.class ?? this.allClasses[0];
    this.assignmentDraft.set({
      abilityId,
      class: cls,
      spec: existing?.spec ?? specsForClass(cls)[0] ?? '',
      defensiveSpellId: existing?.defensive_spell_id ?? null,
      prewarnSeconds: existing?.prewarn_seconds ?? 5,
      triggerType: existing?.trigger_type ?? 'bossmod',
      bossmodSpellId: existing?.bossmod_spell_id != null ? String(existing.bossmod_spell_id) : '',
      notes: existing?.notes ?? '',
      assignedGroups: existing?.assigned_groups ?? [],
    });
  }

  /** Toggle chip 1-6, mismo patrón que specsForDevensive/toggleDefensiveSpec en defensive-catalog. */
  toggleDraftGroup(group: number): void {
    const current = this.assignmentDraft();
    if (!current) return;
    const next = current.assignedGroups.includes(group) ? current.assignedGroups.filter((g) => g !== group) : [...current.assignedGroups, group].sort((a, b) => a - b);
    this.updateAssignmentDraft({ assignedGroups: next });
  }

  closeAssignmentDraft(): void {
    this.assignmentDraft.set(null);
  }

  updateAssignmentDraft(patch: Partial<AssignmentDraft>): void {
    const current = this.assignmentDraft();
    if (!current) return;
    const next = { ...current, ...patch };
    // cambiar de clase invalida la spec elegida si ya no existe en la nueva clase
    if (patch.class && !specsForClass(patch.class).includes(next.spec)) next.spec = specsForClass(patch.class)[0] ?? '';
    this.assignmentDraft.set(next);
  }

  specsForDraftClass(): string[] {
    const draft = this.assignmentDraft();
    return draft ? specsForClass(draft.class) : [];
  }

  defensivesForDraft(): CooldownCatalogRow[] {
    const draft = this.assignmentDraft();
    if (!draft) return [];
    return this.templateDefensivesForSpec(draft.class, draft.spec);
  }

  private templateDefensivesForSpec(cls: string, spec: string): CooldownCatalogRow[] {
    return defensivesForSpec(this.cooldownCatalog(), cls, spec).filter((defensive) =>
      defensive.category === 'personal_defensive' ||
      (this.includeSemiInTemplateAuto() && defensive.category === 'semi_defensive'),
    );
  }

  async submitAssignmentDraft(): Promise<void> {
    const draft = this.assignmentDraft();
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (!draft || bossId == null || !difficulty || draft.defensiveSpellId == null) {
      this.error.set('Elige un defensivo antes de guardar la asignación.');
      return;
    }
    this.savingAssignment.set(true);
    this.error.set(null);
    try {
      await this.edgeFunctions.saveMechanicDefensiveAssignment({
        bossId: String(bossId),
        difficulty,
        abilityId: draft.abilityId,
        class: draft.class,
        spec: draft.spec,
        defensiveSpellId: draft.defensiveSpellId,
        prewarnSeconds: draft.prewarnSeconds,
        triggerType: draft.triggerType,
        bossmodSpellId: draft.bossmodSpellId.trim() ? Number(draft.bossmodSpellId.trim()) : null,
        notes: draft.notes.trim() || null,
        assignedGroups: draft.assignedGroups.length ? draft.assignedGroups : null,
      });
      this.closeAssignmentDraft();
      await this.loadRows();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.savingAssignment.set(false);
    }
  }

  requestDeleteAssignment(id: string): void {
    if (this.confirmingDeleteAssignmentId() === id) {
      void this.confirmDeleteAssignment(id);
      return;
    }
    this.confirmingDeleteAssignmentId.set(id);
    setTimeout(() => {
      if (this.confirmingDeleteAssignmentId() === id) this.confirmingDeleteAssignmentId.set(null);
    }, 5000);
  }

  private async confirmDeleteAssignment(id: string): Promise<void> {
    this.confirmingDeleteAssignmentId.set(null);
    this.error.set(null);
    try {
      await this.edgeFunctions.saveMechanicDefensiveAssignment({ id, delete: true });
      this.assignments.update((rows) => rows.filter((r) => r.id !== id));
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  async generateGlobalPlan(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    const boss = this.selectedBoss();
    if (bossId == null || !difficulty || !boss || this.generatingPlan()) return;
    if (!this.preparationPlayers().length) {
      this.error.set('No hay roster disponible para generar el plan. Actualiza WoWAudit/roster y vuelve a intentarlo.');
      return;
    }
    this.generatingPlan.set(true);
    this.error.set(null);
    this.planActionMessage.set(null);
    try {
      const selections = this.planningResourceSelections();
      const result = await this.edgeFunctions.generateDefensivePlan({
        bossId: String(bossId),
        difficulty,
        name: `${boss.bossName} · ${difficulty}`,
        mode: 'full',
        members: this.preparationPlayers().map((player) => ({
          playerName: player.name,
          playerKey: `character:${player.characterId}`,
          included: true,
        })),
        resourceSelections: Object.entries(selections).map(([normalizedName, spellIds]) => ({
          playerName: this.preparationPlayers().find((player) => player.name.toLocaleLowerCase() === normalizedName)?.name ?? normalizedName,
          spellIds,
        })),
        supersedesId: this.activePlanVersion()?.id ?? null,
        notes: 'Generado desde Preparación. Personal seleccionado por defecto; semi/external solo con opt-in explícito.',
      });
      await this.loadRows();
      const solver = result.solver as { diagnostics?: { uncoveredRequired?: unknown[] }; planningQuality?: string };
      const uncovered = solver.diagnostics?.uncoveredRequired?.length ?? 0;
      this.planActionMessage.set(`Borrador generado${uncovered ? ` · ${uncovered} ventanas obligatorias siguen sin cobertura` : ' · cobertura obligatoria completa'}.`);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.generatingPlan.set(false);
    }
  }

  async publishCurrentDraft(): Promise<void> {
    const draft = this.activeDraft();
    if (!draft || this.publishingPlan()) return;
    this.publishingPlan.set(true);
    this.error.set(null);
    this.planActionMessage.set(null);
    try {
      await this.edgeFunctions.publishDefensivePlan(draft.id);
      await this.loadRows();
      this.planActionMessage.set('Plan publicado. Ya puedes exportar la nota MRT dirigida a cada jugador.');
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.publishingPlan.set(false);
    }
  }

  generateSelectedPlayerExport(): void {
    const player = this.selectedPreparationPlayer();
    if (!player?.specName) {
      this.error.set('El jugador necesita una spec observada para filtrar su nota MRT.');
      return;
    }
    void this.generateExport(player.className, player.specName, player.name);
  }

  // --- export MRT ---

  async generateExport(cls: string, spec: string, playerName?: string): Promise<void> {
    const bossId = this.selectedEncounterId();
    const wclDifficultyId = this.selectedDifficultyId();
    if (bossId == null || wclDifficultyId == null) return;
    const mrtDifficultyId = MRT_DIFFICULTY_ID_BY_WCL_DIFFICULTY_ID[wclDifficultyId] ?? wclDifficultyId;

    const publishedPlan = this.planVersions().find((plan) => plan.status === 'published') ?? null;
    if (publishedPlan) {
      try {
        const contents = this.activePlanVersion()?.id === publishedPlan.id
          ? { members: this.planMembers(), slots: this.planSlots() }
          : await this.profileService.getPlanContents(publishedPlan.id);
        const selectedMembers = contents.members.filter((member) =>
          member.included &&
          member.class === cls &&
          member.spec === spec &&
          (playerName == null || member.player_name.toLocaleLowerCase() === playerName.toLocaleLowerCase()),
        );
        if (!selectedMembers.length) throw new Error(playerName ? `${playerName} no forma parte del plan publicado.` : 'La spec no forma parte del plan publicado.');
        const selectedKeys = new Set(selectedMembers.map((member) => member.player_key));
        const selectedSlots = contents.slots.filter((slot) => slot.assigned_player_key != null && selectedKeys.has(slot.assigned_player_key));
        const exported = exportDeployedPlanToMrt(
          {
            id: publishedPlan.id,
            name: publishedPlan.name,
            bossId: Number(bossId),
            difficultyId: mrtDifficultyId,
          },
          selectedMembers.map((member) => ({ playerKey: member.player_key, playerName: member.player_name })),
          selectedSlots.map((slot) => ({
            id: slot.id,
            abilityId: slot.ability_id,
            occurrenceIndex: slot.occurrence_index,
            occurrenceTimeMs: slot.occurrence_time_ms,
            coverageStatus: slot.coverage_status,
            assignedPlayerKey: slot.assigned_player_key,
            defensiveSpellId: slot.defensive_spell_id,
            prewarnMs: slot.prewarn_ms,
            triggerMode: slot.trigger_mode,
            bossmodSpellId: slot.bossmod_spell_id,
            bossmodCounter: slot.bossmod_counter,
            bossmodCounterVerified: slot.bossmod_counter_verified,
            assignedGroups: slot.assigned_groups,
          })),
          new Map(this.candidates().map((candidate) => [candidate.ability_id, candidate.name])),
          new Map(this.cooldownCatalog().map((defensive) => [defensive.spell_id, defensive.name])),
        );
        const slotById = new Map(contents.slots.map((slot) => [slot.id, slot]));
        this.exportResult.set({
          class: cls,
          spec,
          text: exported.text,
          skippedForMissingTiming: [],
          timeFallbacks: exported.timeFallbackSlotIds.map((id) => {
            const slot = slotById.get(id);
            return slot
              ? `${this.candidates().find((candidate) => candidate.ability_id === slot.ability_id)?.name ?? slot.ability_id} #${slot.occurrence_index}`
              : id;
          }),
        });
        this.copyStatus.set('idle');
        this.exportModalOpen.set(true);
        return;
      } catch (err) {
        this.error.set(errorMessage(err));
        return;
      }
    }

    const reminders: MrtReminderInput[] = [];
    const skipped: string[] = [];
    for (const a of this.assignments().filter((x) => x.class === cls && x.spec === spec)) {
      const candidateName = this.candidates().find((c) => c.ability_id === a.ability_id)?.name ?? `Mecánica ${a.ability_id}`;
      const defensiveName = this.cooldownCatalog().find((cd) => cd.spell_id === a.defensive_spell_id)?.name ?? '';

      let trigger: MrtTrigger;
      if (a.trigger_type === 'bossmod') {
        trigger = { type: 'bossmod', timeLeftSeconds: a.prewarn_seconds, spellId: a.bossmod_spell_id ?? a.ability_id };
      } else {
        const offsetMs = median(this.profiles().find((p) => p.ability_id === a.ability_id)?.reference_cast_offset_ms_samples ?? []);
        if (offsetMs == null) {
          skipped.push(candidateName);
          continue;
        }
        trigger = { type: 'pull', delayTimeSeconds: Math.round(offsetMs / 1000) };
      }

      // §"un desplegable para asignar un grupo... 1-6" (feedback real,
      // 2026-08-31): MRT no filtra por grupo de raid (el protocolo
      // validado en real no trae ese campo) — se refleja como texto en el
      // propio mensaje, para que el raider lo lea aunque MRT no lo aplique solo.
      const groupPrefix = a.assigned_groups?.length ? `[Grupo${a.assigned_groups.length > 1 ? 's' : ''} ${a.assigned_groups.join(',')}] ` : '';
      reminders.push({
        uid: `avoid_${bossId}_${mrtDifficultyId}_${a.ability_id}_${cls}_${spec}`.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        name: `${candidateName} - ${spec}`,
        message: `${groupPrefix}${spellTag(a.defensive_spell_id)} ${defensiveName}`.trim(),
        bossId: Number(bossId),
        difficultyId: mrtDifficultyId,
        players: [],
        prewarnSeconds: a.prewarn_seconds,
        trigger,
      });
    }

    if (!reminders.length) {
      this.error.set(skipped.length ? `Sin datos de timing para: ${skipped.join(', ')} — usa trigger "bossmod" o sincroniza primero.` : 'No hay asignaciones que exportar.');
      return;
    }
    const profileName = `Preparación - ${this.selectedBoss()?.bossName ?? ''} ${this.selectedDifficultyName() ?? ''} - ${spec}`;
    this.exportResult.set({ class: cls, spec, text: encodeMrtExport(profileName, reminders), skippedForMissingTiming: skipped, timeFallbacks: [] });
    this.copyStatus.set('idle');
    this.exportModalOpen.set(true);
  }

  closeExportModal(): void {
    this.exportModalOpen.set(false);
  }

  /** §"reubica el botón de crear reminder... que sea útil y accesible" (feedback real, 2026-08-31): reusa la misma pareja clase/spec ya visible en la cabecera en vez de una lista de botones creciendo al final de la página. */
  hasAssignmentsForSelected = computed(() => this.assignments().some((a) => a.class === this.autoAssignClass() && a.spec === this.autoAssignSpec()));

  // --- cronología por spec ---
  // §"cómo podemos ver los huecos que quedan libres... o si ya está
  // asignado antes de esa habilidad" (feedback real, 2026-08-31): mismo
  // recorrido que runCascadeForSpec (ordenado por timeMs, un
  // nextAvailableMs por spellId) pero en modo DIAGNÓSTICO en vez de
  // asignar — marca `conflict` cuando el mismo defensivo ya se habría
  // usado antes y su cooldown no le habría dado tiempo a estar libre de
  // nuevo, y deja huecas (assignment null) las mecánicas de esta spec sin
  // ninguna asignación, para que el hueco se vea a simple vista en el
  // orden cronológico real del fight.
  timelineOpen = signal(false);
  timelineEntries = signal<TimelineEntry[]>([]);

  openTimeline(): void {
    const cls = this.autoAssignClass();
    const spec = this.autoAssignSpec();
    if (this.planSlots().length) {
      const membersByKey = new Map(this.planMembers().map((member) => [member.player_key, member]));
      const selectedPlayer = this.selectedPreparationPlayer();
      const relevantPlayerKeys = new Set(
        this.planMembers()
          .filter((member) => {
            if (!member.included) return false;
            if (this.assignmentView() === 'spec') return member.class === cls && member.spec === spec;
            return Boolean(
              selectedPlayer &&
              (member.character_id === selectedPlayer.characterId ||
                member.player_name.toLocaleLowerCase() === selectedPlayer.name.toLocaleLowerCase()),
            );
          })
          .map((member) => member.player_key),
      );
      const entries: TimelineEntry[] = this.planSlots()
        .filter((slot) =>
          this.assignmentView() === 'spec'
            ? slot.assigned_player_key == null || relevantPlayerKeys.has(slot.assigned_player_key)
            : (slot.assigned_player_key != null && relevantPlayerKeys.has(slot.assigned_player_key)) ||
              (slot.target_player_key != null && relevantPlayerKeys.has(slot.target_player_key)),
        )
        .map((slot) => {
          const member = slot.assigned_player_key ? membersByKey.get(slot.assigned_player_key) : null;
          const defensiveName = slot.defensive_spell_id
            ? this.cooldownCatalog().find((entry) => entry.spell_id === slot.defensive_spell_id)?.name ?? `#${slot.defensive_spell_id}`
            : null;
          return {
            trackKey: `${slot.ability_id}:${slot.occurrence_index}:${slot.slot_index}`,
            abilityId: slot.ability_id,
            name: `${this.candidates().find((candidate) => candidate.ability_id === slot.ability_id)?.name ?? `Mecánica ${slot.ability_id}`} #${slot.occurrence_index}`,
            timeMs: slot.occurrence_time_ms,
            priority: slot.priority,
            assignment: slot.coverage_status === 'uncovered' || slot.coverage_status === 'excluded' ? null : slot,
            defensiveName: defensiveName ? `${member?.player_name ?? slot.assigned_player_key} · ${defensiveName}` : null,
            cooldownMs: slot.effective_cooldown_ms_snapshot,
            conflict: false,
          };
        })
        .sort((left, right) => left.timeMs - right.timeMs || left.abilityId - right.abilityId || left.trackKey.localeCompare(right.trackKey));
      this.timelineEntries.set(entries);
      this.timelineOpen.set(true);
      return;
    }
    if (this.assignmentView() === 'player') {
      // La vista por jugador no fabrica una cascada local desde el catálogo.
      // Hasta que exista un draft v2 global solo puede mostrar el kit resuelto.
      this.timelineEntries.set([]);
      this.timelineOpen.set(true);
      return;
    }
    const role = roleFromSpec(cls, spec);
    const relevant = this.candidates()
      .filter((c) => {
        const profile = this.profiles().find((p) => p.ability_id === c.ability_id) ?? null;
        return profile?.requires_defensive === true && mechanicAppliesToRole(c.responsibility, role);
      })
      .map((c) => {
        const profile = this.profiles().find((p) => p.ability_id === c.ability_id) ?? null;
        return { candidate: c, profile, timeMs: median(profile?.reference_cast_offset_ms_samples ?? []) };
      })
      .filter((e): e is { candidate: BossMechanicCandidateRow; profile: BossMechanicDefensiveProfileRow | null; timeMs: number } => e.timeMs != null)
      .sort((a, b) => a.timeMs - b.timeMs);

    const nextAvailableMs = new Map<number, number>();
    const entries: TimelineEntry[] = relevant.map((e) => {
      const assignment = this.assignments().find((a) => a.ability_id === e.candidate.ability_id && a.class === cls && a.spec === spec) ?? null;
      const base = { abilityId: e.candidate.ability_id, name: e.candidate.name, timeMs: e.timeMs, priority: e.profile?.priority ?? null };
      if (!assignment) return { ...base, trackKey: String(e.candidate.ability_id), assignment: null, defensiveName: null, cooldownMs: null, conflict: false };
      const cd = this.cooldownCatalog().find((c) => c.spell_id === assignment.defensive_spell_id);
      const cooldownMs = cd?.base_cooldown_ms ?? null;
      const prevAvailable = nextAvailableMs.get(assignment.defensive_spell_id) ?? 0;
      const conflict = cooldownMs != null && prevAvailable > e.timeMs;
      // solo se actualiza el próximo disponible si de verdad se pudo usar
      // aquí — si hay conflicto, el cast no pudo pasar de verdad, así que
      // el próximo hueco disponible sigue siendo el de antes (el conflicto
      // se arrastra hasta que pase suficiente tiempo, como en la realidad).
      if (!conflict && cooldownMs != null) nextAvailableMs.set(assignment.defensive_spell_id, e.timeMs + cooldownMs);
      return { ...base, trackKey: String(e.candidate.ability_id), assignment, defensiveName: cd?.name ?? `#${assignment.defensive_spell_id}`, cooldownMs, conflict };
    });
    this.timelineEntries.set(entries);
    this.timelineOpen.set(true);
  }

  closeTimeline(): void {
    this.timelineOpen.set(false);
  }

  timelineTitle(): string {
    const player = this.selectedPreparationPlayer();
    return this.assignmentView() === 'player'
      ? `Cronología — ${player?.name ?? 'sin jugador'}`
      : `Cronología — ${this.autoAssignClass()} · ${this.autoAssignSpec()}`;
  }

  formatFightTime(ms: number): string {
    const totalSeconds = Math.round(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // --- auto-asignación en cascada ---
  // §"la app ya sabe los cooldown... puede autogenerar una nota sabiendo en
  // qué momento empieza una habilidad o mecánica de boss... empezando en
  // cascada: primero en las que más pico hace a toda la raid" (feedback
  // real, 2026-08-31): impactScore = mediana de daño SIN mitigar (ya
  // reconstruido por sync-mechanic-defensive-profile, sin sesgo de logs
  // ya bien jugados) × reference_avg_players_hit (ya calculado por
  // sync-boss-mechanics con correlación real por-cast) — "cuánto daño cae
  // sobre la raid de una vez", la métrica de raid-wide que pedías. El
  // algoritmo en sí (greedy, respeta cooldowns reales a lo largo del
  // fight) vive en auto-assign-cascade.util.ts, testeado aparte.
  autoAssignClass = signal<string>(this.allClasses[0]);
  autoAssignSpec = signal<string>(specsForClass(this.allClasses[0])[0] ?? '');
  autoAssigning = signal(false);
  autoAssignResult = signal<{ assigned: number; candidates: number } | null>(null);

  onAutoAssignClassChange(cls: string): void {
    this.autoAssignClass.set(cls);
    this.autoAssignSpec.set(specsForClass(cls)[0] ?? '');
  }
  onAutoAssignSpecChange(spec: string): void {
    this.autoAssignSpec.set(spec);
  }
  specsForAutoAssignClass(): string[] {
    return specsForClass(this.autoAssignClass());
  }

  private impactScore(candidate: BossMechanicCandidateRow, profile: BossMechanicDefensiveProfileRow | null): number {
    const unmitigatedMedian = median(profile?.reference_unmitigated_damage_samples ?? []) ?? 0;
    return unmitigatedMedian * (candidate.reference_avg_players_hit ?? 1);
  }

  /** Motor de la cascada para UNA spec. Solo rellena huecos; las asignaciones humanas existentes son inmutables y reservan su cooldown. */
  private async runCascadeForSpec(bossId: string, difficulty: string, cls: string, spec: string): Promise<{ assigned: number; candidates: number }> {
    const role = roleFromSpec(cls, spec);
    const profilesByAbilityId = new Map(this.profiles().map((p) => [p.ability_id, p]));
    const timeByAbilityId = new Map(
      this.candidates().map((candidate) => [
        candidate.ability_id,
        median(profilesByAbilityId.get(candidate.ability_id)?.reference_cast_offset_ms_samples ?? []),
      ]),
    );

    const existingForSpec = this.assignments().filter((a) => a.class === cls && a.spec === spec);
    const alreadyAssignedAbilityIds = new Set(existingForSpec.map((a) => a.ability_id));

    const mechanicInputs = this.candidates()
      .filter((candidate) => {
        const profile = profilesByAbilityId.get(candidate.ability_id) ?? null;
        return (
          profile?.requires_defensive === true &&
          mechanicAppliesToRole(candidate.responsibility, role) &&
          !alreadyAssignedAbilityIds.has(candidate.ability_id)
        );
      })
      .map((candidate) => ({
        abilityId: candidate.ability_id,
        name: candidate.name,
        timeMs: timeByAbilityId.get(candidate.ability_id) ?? null,
        impactScore: this.impactScore(candidate, profilesByAbilityId.get(candidate.ability_id) ?? null),
      }));

    const reservationsBySpellId = new Map<number, number[]>();
    const blockedBecauseTimingUnknown = new Set<number>();
    for (const assignment of existingForSpec) {
      const timeMs = timeByAbilityId.get(assignment.ability_id) ?? null;
      if (timeMs == null) {
        // Si ya hay un uso manual cuyo momento no podemos situar, ese spell
        // no es seguro para nuevas asignaciones automáticas.
        blockedBecauseTimingUnknown.add(assignment.defensive_spell_id);
        continue;
      }
      const reservations = reservationsBySpellId.get(assignment.defensive_spell_id) ?? [];
      reservations.push(timeMs);
      reservationsBySpellId.set(assignment.defensive_spell_id, reservations);
    }

    const defensiveInputs = this.templateDefensivesForSpec(cls, spec)
      .filter((cd) => !blockedBecauseTimingUnknown.has(cd.spell_id))
      .map((cd) => ({
        spellId: cd.spell_id,
        survivalType: cd.survival_type,
        baseCooldownMs: cd.base_cooldown_ms,
        reservedTimesMs: reservationsBySpellId.get(cd.spell_id) ?? [],
      }));

    const result = autoAssignCascade(mechanicInputs, defensiveInputs);
    for (const assignment of result) {
      await this.edgeFunctions.saveMechanicDefensiveAssignment({
        bossId,
        difficulty,
        abilityId: assignment.abilityId,
        class: cls,
        spec,
        defensiveSpellId: assignment.defensiveSpellId,
        prewarnSeconds: 5,
        triggerType: 'bossmod',
      });
    }
    return { assigned: result.length, candidates: mechanicInputs.filter((m) => m.timeMs != null).length };
  }

  async onAutoAssign(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    const spec = this.autoAssignSpec();
    if (bossId == null || !difficulty || !spec || this.autoAssigning()) return;
    this.autoAssigning.set(true);
    this.autoAssignResult.set(null);
    this.error.set(null);
    try {
      // §"esto tiene que reactualizar bien, si cambiamos un defensivo (cd)
      // tiene que recalcularlo de verdad" (feedback real, 2026-08-31):
      // cooldownCatalog() se carga UNA vez al entrar en la pantalla — si
      // editaste un CD en Ajustes en otra pestaña sin recargar Preparación,
      // la cascada usaría el valor viejo. Refrescar aquí siempre, no confiar
      // en que el usuario haya recargado la página.
      await this.loadCooldownCatalog();
      const r = await this.runCascadeForSpec(String(bossId), difficulty, this.autoAssignClass(), spec);
      this.autoAssignResult.set(r);
      await this.loadRows();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.autoAssigning.set(false);
    }
  }

  /** §"un botón para auto-asignar la clase (en lugar de tener que elegir spec)" (feedback real, 2026-08-31): corre la misma cascada para cada spec real de la clase elegida, una detrás de otra. */
  async onAutoAssignClass(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    const cls = this.autoAssignClass();
    if (bossId == null || !difficulty || this.autoAssigning()) return;
    this.autoAssigning.set(true);
    this.autoAssignResult.set(null);
    this.error.set(null);
    try {
      await this.loadCooldownCatalog();
      let assigned = 0;
      let candidates = 0;
      for (const spec of specsForClass(cls)) {
        const r = await this.runCascadeForSpec(String(bossId), difficulty, cls, spec);
        assigned += r.assigned;
        candidates += r.candidates;
      }
      this.autoAssignResult.set({ assigned, candidates });
      await this.loadRows();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.autoAssigning.set(false);
    }
  }

  // --- restablecer (limpiar asignaciones viejas antes de recascadear) ---
  // §"un botón de restablecer... o un botón de restablecer clase, por si hay
  // inconsistencias o hay que limpiar lo viejo para poner lo nuevo"
  // (feedback real, 2026-08-31): borrado secuencial reusando el mismo
  // endpoint de borrado por id que ya usa requestDeleteAssignment — son
  // borrados de fila normales (no llamadas a WCL), no hay cuota real de
  // CPU/WORKER_RESOURCE_LIMIT que cuidar aquí como sí pasa con el reanálisis.
  confirmingResetClass = signal(false);
  confirmingResetAll = signal(false);
  resetting = signal(false);

  requestResetClass(): void {
    if (this.confirmingResetClass()) {
      void this.doReset(this.assignments().filter((a) => a.class === this.autoAssignClass()));
      return;
    }
    this.confirmingResetClass.set(true);
    setTimeout(() => this.confirmingResetClass.set(false), 5000);
  }

  requestResetAll(): void {
    if (this.confirmingResetAll()) {
      void this.doReset(this.assignments());
      return;
    }
    this.confirmingResetAll.set(true);
    setTimeout(() => this.confirmingResetAll.set(false), 5000);
  }

  private async doReset(rows: MechanicDefensiveAssignmentRow[]): Promise<void> {
    this.confirmingResetClass.set(false);
    this.confirmingResetAll.set(false);
    if (!rows.length) return;
    this.resetting.set(true);
    this.error.set(null);
    try {
      for (const row of rows) {
        await this.edgeFunctions.saveMechanicDefensiveAssignment({ id: row.id, delete: true });
      }
      await this.loadRows();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.resetting.set(false);
    }
  }

  /**
   * §"si actualiza un defensivo tendrá también que sacar ahí alguna clase
   * de aviso" (feedback real, 2026-08-31) + bug real encontrado en vivo
   * (2026-08-31, "el mistweaver no tiene ese defensivo" — Dampen Harm
   * asignado a Mistweaver 2 minutos ANTES de que se corrigiera
   * spec_override para excluirla): la comparación de fechas por sí sola no
   * detectaba esto — solo miraba defensivos que SIGUEN siendo válidos para
   * la spec, así que un defensivo que dejó de aplicar (spec_override
   * cambiado, no solo cooldown/duración editados) desaparecía de esa
   * lista y su updated_at nunca llegaba a compararse. Primero se comprueba
   * lo más fuerte y objetivo: ¿algún defensivo YA ASIGNADO ya no es
   * siquiera válido para esta spec? Si es así, es inequívocamente viejo,
   * sin necesitar comparar fechas.
   */
  assignmentsStaleFor(cls: string, spec: string): boolean {
    const relevantAssignments = this.assignments().filter((a) => a.class === cls && a.spec === spec);
    if (!relevantAssignments.length) return false;
    const validSpellIds = new Set(this.templateDefensivesForSpec(cls, spec).map((cd) => cd.spell_id));
    if (relevantAssignments.some((a) => !validSpellIds.has(a.defensive_spell_id))) return true;
    const oldestAssignmentEdit = relevantAssignments.map((a) => a.updated_at).sort()[0];
    const catalogEdits = this.templateDefensivesForSpec(cls, spec)
      .map((cd) => cd.updated_at)
      .filter((t): t is string => !!t);
    if (!catalogEdits.length) return false;
    return catalogEdits.some((t) => t > oldestAssignmentEdit);
  }

  roleFraction(breakdown: { tank: number; healer: number; dps: number }, key: 'tank' | 'healer' | 'dps'): number {
    const total = breakdown.tank + breakdown.healer + breakdown.dps;
    return total > 0 ? breakdown[key] / total : 0;
  }

  /** Nombre+tooltip de Wowhead en vez del spellId crudo en la tabla de asignaciones — null si el catálogo aún no ha cargado esa fila (no debería pasar salvo carrera de carga). */
  defensiveFor(spellId: number): CooldownCatalogRow | null {
    return this.cooldownCatalog().find((cd) => cd.spell_id === spellId) ?? null;
  }

  async copyExport(): Promise<void> {
    const result = this.exportResult();
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
      this.copyStatus.set('copied');
      setTimeout(() => this.copyStatus.set('idle'), 2500);
    } catch {
      this.copyStatus.set('error');
    }
  }

  // --- helpers de plantilla ---

  difficultyLabel(id: number): string {
    return WCL_DIFFICULTY_NAME_BY_ID[id] ?? `Dificultad ${id}`;
  }

  median(values: number[]): number | null {
    return median(values);
  }
}
