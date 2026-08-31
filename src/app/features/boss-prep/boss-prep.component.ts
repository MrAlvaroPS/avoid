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
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { ManifestService } from '../../core/manifest.service';
import { BossMechanicDefensiveProfileService } from '../../core/boss-mechanic-defensive-profile.service';
import { DefensiveCatalogService } from '../../core/defensive-catalog.service';
import { DefensivePlanningService, type DefensivePlanningReference, type StoredDefensivePlan } from '../../core/defensive-planning.service';
import { ReportsService, type KnownBoss } from '../../core/reports.service';
import { STANDARD_DIFFICULTY_IDS, WCL_DIFFICULTY_NAME_BY_ID } from '../../shared/format.util';
import { ALL_CLASSES, specsForClass, mechanicAppliesToRole, roleFromSpec } from '../../shared/spec-role.util';
import { defensivesForSpec } from '../../shared/defensive-spec-match.util';
import { encodeMrtExport, spellTag, type MrtReminderInput, type MrtTrigger } from '../../shared/mrt/mrt-reminder-codec';
import { buildDamageWindowTimeline, type DamageWindow } from '../../shared/mrt/damage-window-timeline.util';
import { resolveEffectiveDefensives, defensiveLoadoutHash, type EffectiveDefensiveResolution } from '../../shared/mrt/effective-defensive-resolver.util';
import { planRosterCooldowns } from '../../shared/mrt/roster-cooldown-planner.util';
import { errorMessage } from '../../shared/error-message.util';
import { classColor } from '../../shared/format.util';
import { ClassIconComponent } from '../../shared/class-icon.component';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { MechanicResolutionIconComponent } from '../../shared/mechanic-resolution-icon.component';
import type { BossMechanicCandidateRow, BossMechanicDefensiveProfileRow, MechanicDefensiveAssignmentRow, CooldownCatalogRow, DefensivePlanAssignmentRow, PlayerLatestLoadoutRow } from '../../shared/models/domain';

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
}

interface TimelineEntry {
  key: string;
  abilityId: number;
  name: string;
  timeMs: number;
  priority: number | null;
  assignment: MechanicDefensiveAssignmentRow | DefensivePlanAssignmentRow | null;
  defensiveName: string | null;
  cooldownMs: number | null;
  /** El mismo defensivo ya se habría usado antes en esta cronología y su cooldown no le habría dado tiempo a estar libre de nuevo aquí. */
  conflict: boolean;
  cooldownExplanation: string | null;
  locked: boolean;
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
  private defensivePlanningService = inject(DefensivePlanningService);
  private reportsService = inject(ReportsService);

  readonly standardDifficultyIds = STANDARD_DIFFICULTY_IDS;
  readonly allClasses = ALL_CLASSES;
  readonly raidGroups = RAID_GROUPS;
  readonly classColor = classColor;

  bosses = signal<KnownBoss[]>([]);
  loadingBosses = signal(true);
  selectedEncounterId = signal<number | null>(null);
  selectedDifficultyId = signal<number | null>(null);

  candidates = signal<BossMechanicCandidateRow[]>([]);
  profiles = signal<BossMechanicDefensiveProfileRow[]>([]);
  assignments = signal<MechanicDefensiveAssignmentRow[]>([]);
  loadingRows = signal(false);
  error = signal<string | null>(null);

  cooldownCatalog = signal<CooldownCatalogRow[]>([]);
  planningReference = signal<DefensivePlanningReference | null>(null);
  storedPlans = signal<StoredDefensivePlan[]>([]);
  selectedPlannerCharacterId = signal<number | null>(null);
  planningReferenceLoading = signal(false);

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
  selectedEffectiveResolution = computed(() => {
    const player = this.selectedPlannerPlayer();
    const reference = this.planningReference();
    if (!player?.spec || !player.talent_build || !reference?.allTalentSpellIds) return null;
    return resolveEffectiveDefensives({
      player,
      catalog: this.cooldownCatalog(),
      specProfiles: reference.specProfiles,
      modifierRules: reference.modifierRules,
      allTalentSpellIds: reference.allTalentSpellIds,
    });
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
    const assignedAbilityIds = new Set([
      ...this.assignments().map((a) => a.ability_id),
      ...this.storedPlans().flatMap((plan) => plan.assignments.flatMap((assignment) => assignment.ability_ids)),
    ]);
    return this.mechanicRows().filter((r) => r.profile?.requires_defensive === true && !assignedAbilityIds.has(r.candidate.ability_id));
  });

  constructor() {
    void this.loadBosses();
    void this.loadCooldownCatalog();
    void this.loadPlanningReference();
  }

  async loadPlanningReference(): Promise<void> {
    this.planningReferenceLoading.set(true);
    try {
      this.planningReference.set(await this.defensivePlanningService.loadReference());
      this.ensureSelectedPlannerPlayer();
    } catch (err) {
      this.error.set(`No se pudo cargar el resolver de defensivos efectivos: ${errorMessage(err)}`);
    } finally {
      this.planningReferenceLoading.set(false);
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
  }

  async loadRows(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty) return;
    this.loadingRows.set(true);
    this.error.set(null);
    try {
      const [candidates, profiles, assignments, syncState, storedPlans] = await Promise.all([
        this.manifestService.listCandidates(String(bossId), difficulty),
        this.profileService.listProfiles(String(bossId), difficulty),
        this.profileService.listAssignments(String(bossId), difficulty),
        this.profileService.getSyncState(String(bossId), difficulty),
        this.defensivePlanningService.listPlans(String(bossId), difficulty),
      ]);
      this.candidates.set(candidates);
      this.profiles.set(profiles);
      this.assignments.set(assignments);
      this.syncState.set(syncState);
      this.storedPlans.set(storedPlans);
      this.ensureSelectedPlannerPlayer();
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
      const r = res.results[0];
      // §"muchos muchos muchos logs" (feedback real, 2026-08-31): cada
      // sync trae la SIGUIENTE tanda, no repite — totalFightsConsumed es
      // la muestra acumulada real, no solo esta tanda. exhausted avisa
      // cuando el leaderboard ya no tiene más logs nuevos que dar.
      this.syncSummary.set(
        r
          ? `+${r.referenceFightsUsed} logs nuevos (${r.mechanicsProfiled} mecánicas actualizadas) — ${r.totalFightsConsumed} acumulados en total.` +
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
    return defensivesForSpec(this.cooldownCatalog(), draft.class, draft.spec);
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

  // --- export MRT ---

  generateExport(cls: string, spec: string): void {
    const bossId = this.selectedEncounterId();
    const wclDifficultyId = this.selectedDifficultyId();
    if (bossId == null || wclDifficultyId == null) return;
    const mrtDifficultyId = MRT_DIFFICULTY_ID_BY_WCL_DIFFICULTY_ID[wclDifficultyId] ?? wclDifficultyId;

    const reminders: MrtReminderInput[] = [];
    const skipped: string[] = [];
    const storedPlan = this.selectedStoredPlan();
    if (storedPlan && storedPlan.run.class === cls && storedPlan.run.spec === spec) {
      for (const assignment of storedPlan.assignments) {
        const defensiveName = this.cooldownCatalog().find((cd) => cd.spell_id === assignment.defensive_spell_id)?.name ?? `#${assignment.defensive_spell_id}`;
        const trigger: MrtTrigger = assignment.trigger_type === 'bossmod'
          ? {
              type: 'bossmod',
              timeLeftSeconds: assignment.prewarn_seconds,
              spellId: assignment.bossmod_spell_id ?? assignment.primary_ability_id,
              ...(assignment.bossmod_counter == null ? {} : { counter: assignment.bossmod_counter }),
            }
          : { type: 'pull', delayTimeSeconds: Math.round(assignment.planned_time_ms / 1000) };
        const windowName = assignment.ability_names.join(' + ');
        reminders.push({
          uid: `avoid_v2_${bossId}_${mrtDifficultyId}_${storedPlan.run.character_id}_${assignment.window_key}`.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
          name: `${windowName} - ${storedPlan.run.player_name}`,
          message: `${spellTag(assignment.defensive_spell_id)} ${defensiveName}`,
          bossId: Number(bossId),
          difficultyId: mrtDifficultyId,
          players: [storedPlan.run.player_name],
          prewarnSeconds: assignment.prewarn_seconds,
          trigger,
        });
      }
      if (!reminders.length) {
        this.error.set(`El plan de ${storedPlan.run.player_name} no contiene ninguna asignación exportable.`);
        return;
      }
      const profileName = `Preparación - ${this.selectedBoss()?.bossName ?? ''} ${this.selectedDifficultyName() ?? ''} - ${storedPlan.run.player_name}`;
      this.exportResult.set({ class: cls, spec: `${spec} · ${storedPlan.run.player_name}`, text: encodeMrtExport(profileName, reminders), skippedForMissingTiming: [] });
      this.copyStatus.set('idle');
      this.exportModalOpen.set(true);
      return;
    }
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
    this.exportResult.set({ class: cls, spec, text: encodeMrtExport(profileName, reminders), skippedForMissingTiming: skipped });
    this.copyStatus.set('idle');
    this.exportModalOpen.set(true);
  }

  closeExportModal(): void {
    this.exportModalOpen.set(false);
  }

  /** §"reubica el botón de crear reminder... que sea útil y accesible" (feedback real, 2026-08-31): reusa la misma pareja clase/spec ya visible en la cabecera en vez de una lista de botones creciendo al final de la página. */
  hasAssignmentsForSelected = computed(
    () => !!this.selectedStoredPlan()?.assignments.length || this.assignments().some((a) => a.class === this.autoAssignClass() && a.spec === this.autoAssignSpec()),
  );

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
    const player = this.selectedPlannerPlayer();
    const storedPlan = this.selectedStoredPlan();
    if (player && storedPlan) {
      const windows = this.buildWindowsForPlayer(player);
      const entries: TimelineEntry[] = windows.map((window) => {
        const assignment = storedPlan.assignments.find((row) => row.window_key === window.key) ?? null;
        const defensive = assignment ? this.cooldownCatalog().find((row) => row.spell_id === assignment.defensive_spell_id) : null;
        return {
          key: window.key,
          abilityId: window.occurrences[0]?.abilityId ?? 0,
          name: window.occurrences.map((occurrence) => `${occurrence.name} #${occurrence.occurrenceIndex}`).join(' + '),
          timeMs: window.timeMs,
          priority: window.priority,
          assignment,
          defensiveName: assignment ? (defensive?.name ?? `#${assignment.defensive_spell_id}`) : null,
          cooldownMs: assignment?.effective_cooldown_ms ?? null,
          conflict: false,
          cooldownExplanation: assignment?.cooldown_explanation ?? null,
          locked: assignment?.locked ?? false,
        };
      });
      this.timelineEntries.set(entries);
      this.timelineOpen.set(true);
      return;
    }

    const cls = this.autoAssignClass();
    const spec = this.autoAssignSpec();
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
      const base = { key: String(e.candidate.ability_id), abilityId: e.candidate.ability_id, name: e.candidate.name, timeMs: e.timeMs, priority: e.profile?.priority ?? null };
      if (!assignment) return { ...base, assignment: null, defensiveName: null, cooldownMs: null, conflict: false, cooldownExplanation: null, locked: false };
      const cd = this.cooldownCatalog().find((c) => c.spell_id === assignment.defensive_spell_id);
      const cooldownMs = cd?.base_cooldown_ms ?? null;
      const prevAvailable = nextAvailableMs.get(assignment.defensive_spell_id) ?? 0;
      const conflict = cooldownMs != null && prevAvailable > e.timeMs;
      // solo se actualiza el próximo disponible si de verdad se pudo usar
      // aquí — si hay conflicto, el cast no pudo pasar de verdad, así que
      // el próximo hueco disponible sigue siendo el de antes (el conflicto
      // se arrastra hasta que pase suficiente tiempo, como en la realidad).
      if (!conflict && cooldownMs != null) nextAvailableMs.set(assignment.defensive_spell_id, e.timeMs + cooldownMs);
      return { ...base, assignment, defensiveName: cd?.name ?? `#${assignment.defensive_spell_id}`, cooldownMs, conflict, cooldownExplanation: cooldownMs == null ? null : `${cooldownMs / 1000} s del catálogo legacy`, locked: true };
    });
    this.timelineEntries.set(entries);
    this.timelineOpen.set(true);
  }

  closeTimeline(): void {
    this.timelineOpen.set(false);
  }

  formatFightTime(ms: number): string {
    const totalSeconds = Math.round(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // --- auto-asignación v2: roster + build + ocurrencias ---
  autoAssignClass = signal<string>(this.allClasses[0]);
  autoAssignSpec = signal<string>(specsForClass(this.allClasses[0])[0] ?? '');
  autoAssigning = signal(false);
  autoAssignResult = signal<{ assigned: number; candidates: number } | null>(null);

  onAutoAssignClassChange(cls: string): void {
    this.autoAssignClass.set(cls);
    this.autoAssignSpec.set(specsForClass(cls)[0] ?? '');
    this.ensureSelectedPlannerPlayer();
  }
  onAutoAssignSpecChange(spec: string): void {
    this.autoAssignSpec.set(spec);
    this.ensureSelectedPlannerPlayer();
  }
  specsForAutoAssignClass(): string[] {
    return specsForClass(this.autoAssignClass());
  }

  plannerPlayersForSelectedSpec(): PlayerLatestLoadoutRow[] {
    return (this.planningReference()?.loadouts ?? []).filter(
      (player) => (player.class ?? player.roster_class) === this.autoAssignClass() && player.spec === this.autoAssignSpec(),
    );
  }

  selectedPlannerPlayer(): PlayerLatestLoadoutRow | null {
    const id = this.selectedPlannerCharacterId();
    return this.planningReference()?.loadouts.find((player) => player.character_id === id) ?? null;
  }

  onPlannerPlayerChange(raw: string): void {
    const id = Number(raw);
    this.selectedPlannerCharacterId.set(Number.isFinite(id) ? id : null);
  }

  private ensureSelectedPlannerPlayer(): void {
    const players = this.plannerPlayersForSelectedSpec();
    if (!players.some((player) => player.character_id === this.selectedPlannerCharacterId())) {
      this.selectedPlannerCharacterId.set(players[0]?.character_id ?? null);
    }
  }

  selectedStoredPlan(): StoredDefensivePlan | null {
    const id = this.selectedPlannerCharacterId();
    return this.storedPlans().find((plan) => plan.run.character_id === id) ?? null;
  }

  private currentReferenceVersion(): string | null {
    const reference = this.planningReference();
    const versions = [
      ...this.cooldownCatalog().map((row) => row.updated_at),
      ...(reference?.specProfiles.map((row) => row.updated_at) ?? []),
      ...(reference?.modifierRules.map((row) => row.updated_at) ?? []),
    ].filter((value): value is string => !!value).sort();
    return versions.at(-1) ?? null;
  }

  private currentMechanicProfileVersion(): string | null {
    return this.profiles().map((profile) => profile.updated_at).filter((value): value is string => !!value).sort().at(-1) ?? null;
  }

  selectedPlanStale(): boolean {
    const plan = this.selectedStoredPlan();
    const player = this.selectedPlannerPlayer();
    if (!plan || !player) return false;
    if (plan.run.loadout_hash !== defensiveLoadoutHash(player)) return true;
    const version = this.currentReferenceVersion();
    if (version != null && (plan.run.catalog_version == null || version > plan.run.catalog_version)) return true;
    const mechanicVersion = this.currentMechanicProfileVersion();
    return mechanicVersion != null && (plan.run.mechanic_profile_version == null || mechanicVersion > plan.run.mechanic_profile_version);
  }

  private impactScore(candidate: BossMechanicCandidateRow, profile: BossMechanicDefensiveProfileRow | null): number {
    const unmitigatedMedian = median(profile?.reference_unmitigated_damage_samples ?? []) ?? 0;
    return unmitigatedMedian * (candidate.reference_avg_players_hit ?? 1);
  }

  private buildWindowsForPlayer(player: PlayerLatestLoadoutRow): DamageWindow[] {
    const playerClass = player.class ?? player.roster_class;
    const role = roleFromSpec(playerClass, player.spec);
    const profilesByAbilityId = new Map(this.profiles().map((p) => [p.ability_id, p]));
    const inputs = this.candidates()
      .filter((candidate) => {
        const profile = profilesByAbilityId.get(candidate.ability_id) ?? null;
        return profile?.requires_defensive === true && mechanicAppliesToRole(candidate.responsibility, role);
      })
      .map((candidate) => {
        const profile = profilesByAbilityId.get(candidate.ability_id)!;
        return {
          abilityId: candidate.ability_id,
          name: candidate.name,
          offsetSamplesMs: profile.reference_cast_offset_ms_samples ?? [],
          offsetsByFight: profile.reference_cast_offsets_by_fight ?? [],
          sampleFightCount: profile.reference_sample_fight_count ?? 0,
          impactScore: this.impactScore(candidate, profile),
          priority: profile.priority,
        };
      });
    return buildDamageWindowTimeline(inputs);
  }

  private resolvePlayerKit(player: PlayerLatestLoadoutRow): EffectiveDefensiveResolution {
    const reference = this.planningReference();
    if (!reference) throw new Error('El resolver de defensivos todavía no está cargado.');
    if (!reference.allTalentSpellIds) throw new Error('No hay talent_spell_lookup disponible: no se puede filtrar el build de forma fiable. Analiza un pull reciente primero.');
    if (!player.spec || !player.talent_build) throw new Error(`${player.player_name} no tiene todavía un build observado en CombatantInfo.`);
    return resolveEffectiveDefensives({
      player,
      catalog: this.cooldownCatalog(),
      specProfiles: reference.specProfiles,
      modifierRules: reference.modifierRules,
      allTalentSpellIds: reference.allTalentSpellIds,
    });
  }

  private async runPlannerForPlayer(bossId: string, difficulty: string, player: PlayerLatestLoadoutRow): Promise<{ assigned: number; candidates: number }> {
    const resolution = this.resolvePlayerKit(player);
    const windows = this.buildWindowsForPlayer(player);
    const playerClass = player.class ?? player.roster_class;

    // Las asignaciones manuales v1 siguen intactas. Si son personales y se
    // pueden situar, se importan como reservas bloqueadas en la ventana de
    // mayor impacto de esa ability; externals no se fuerzan sobre uno mismo.
    const locked: { windowKey: string; defensiveSpellId: number }[] = [];
    const lockedWindows = new Set<string>();
    for (const manual of this.assignments().filter((row) => row.class === playerClass && row.spec === player.spec)) {
      const defensive = resolution.defensives.find((row) => row.spellId === manual.defensive_spell_id);
      if (!defensive || (defensive.category !== 'personal_defensive' && defensive.category !== 'semi_defensive')) continue;
      const window = windows
        .filter((candidate) => !lockedWindows.has(candidate.key) && candidate.occurrences.some((occurrence) => occurrence.abilityId === manual.ability_id))
        .sort((a, b) => b.impactScore - a.impactScore || a.timeMs - b.timeMs)[0];
      if (!window) continue;
      locked.push({ windowKey: window.key, defensiveSpellId: manual.defensive_spell_id });
      lockedWindows.add(window.key);
    }

    const planned = planRosterCooldowns({ windows, defensives: resolution.defensives, locked });
    const assignments = planned.map((assignment) => {
      const primary = [...assignment.window.occurrences].sort((a, b) => b.impactScore - a.impactScore || a.abilityId - b.abilityId)[0];
      return {
        windowKey: assignment.window.key,
        plannedTimeMs: assignment.window.timeMs,
        impactScore: assignment.window.impactScore,
        priority: assignment.window.priority,
        abilityIds: assignment.window.occurrences.map((occurrence) => occurrence.abilityId),
        abilityNames: assignment.window.occurrences.map((occurrence) => occurrence.name),
        primaryAbilityId: primary.abilityId,
        occurrenceIndex: primary.occurrenceIndex,
        defensiveSpellId: assignment.defensive.spellId,
        effectiveCooldownMs: assignment.defensive.effectiveCooldownMs!,
        cooldownExplanation: assignment.defensive.explanation,
        prewarnSeconds: 5,
        triggerType: 'bossmod' as const,
        bossmodSpellId: primary.abilityId,
        bossmodCounter: primary.occurrenceIndex,
        locked: assignment.locked,
      };
    });
    await this.edgeFunctions.replaceDefensivePlan({
      bossId,
      difficulty,
      characterId: player.character_id,
      playerName: player.player_name,
      class: playerClass,
      spec: player.spec!,
      talentSpellIds: resolution.talentSpellIds,
      loadoutHash: resolution.loadoutHash,
      loadoutObservedAt: player.loadout_observed_at,
      catalogVersion: this.currentReferenceVersion(),
      mechanicProfileVersion: this.currentMechanicProfileVersion(),
      assignments,
    });
    return { assigned: assignments.length, candidates: windows.length };
  }

  async onAutoAssign(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    const player = this.selectedPlannerPlayer();
    if (bossId == null || !difficulty || !player || this.autoAssigning()) return;
    this.autoAssigning.set(true);
    this.autoAssignResult.set(null);
    this.error.set(null);
    try {
      await this.loadCooldownCatalog();
      await this.loadPlanningReference();
      const r = await this.runPlannerForPlayer(String(bossId), difficulty, player);
      this.autoAssignResult.set(r);
      await this.loadRows();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.autoAssigning.set(false);
    }
  }

  /** Recorre únicamente los personajes reales de esta clase con build observado, no todas las specs teóricas. */
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
      await this.loadPlanningReference();
      let assigned = 0;
      let candidates = 0;
      const players = (this.planningReference()?.loadouts ?? []).filter(
        (player) => (player.class ?? player.roster_class) === cls && player.spec != null && player.talent_build != null,
      );
      if (!players.length) throw new Error(`No hay ningún ${cls} del roster con build observado.`);
      for (const player of players) {
        const r = await this.runPlannerForPlayer(String(bossId), difficulty, player);
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
      void this.doReset(this.assignments().filter((a) => a.class === this.autoAssignClass()), this.autoAssignClass());
      return;
    }
    this.confirmingResetClass.set(true);
    setTimeout(() => this.confirmingResetClass.set(false), 5000);
  }

  requestResetAll(): void {
    if (this.confirmingResetAll()) {
      void this.doReset(this.assignments(), null);
      return;
    }
    this.confirmingResetAll.set(true);
    setTimeout(() => this.confirmingResetAll.set(false), 5000);
  }

  private async doReset(rows: MechanicDefensiveAssignmentRow[], classFilter: string | null): Promise<void> {
    this.confirmingResetClass.set(false);
    this.confirmingResetAll.set(false);
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty) return;
    this.resetting.set(true);
    this.error.set(null);
    try {
      for (const row of rows) {
        await this.edgeFunctions.saveMechanicDefensiveAssignment({ id: row.id, delete: true });
      }
      await this.edgeFunctions.deleteDefensivePlans({ bossId: String(bossId), difficulty, ...(classFilter ? { class: classFilter } : {}) });
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
    const validSpellIds = new Set(defensivesForSpec(this.cooldownCatalog(), cls, spec).map((cd) => cd.spell_id));
    if (relevantAssignments.some((a) => !validSpellIds.has(a.defensive_spell_id))) return true;
    const oldestAssignmentEdit = relevantAssignments.map((a) => a.updated_at).sort()[0];
    const catalogEdits = defensivesForSpec(this.cooldownCatalog(), cls, spec)
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
