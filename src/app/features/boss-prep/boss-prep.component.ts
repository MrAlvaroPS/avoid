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
import { ReportsService, type KnownBoss } from '../../core/reports.service';
import { STANDARD_DIFFICULTY_IDS, WCL_DIFFICULTY_NAME_BY_ID } from '../../shared/format.util';
import { ALL_CLASSES, specsForClass, mechanicAppliesToRole, roleFromSpec } from '../../shared/spec-role.util';
import { defensivesForSpec } from '../../shared/defensive-spec-match.util';
import { encodeMrtExport, spellTag, type MrtReminderInput, type MrtTrigger } from '../../shared/mrt/mrt-reminder-codec';
import { autoAssignCascade } from '../../shared/mrt/auto-assign-cascade.util';
import { errorMessage } from '../../shared/error-message.util';
import { classColor } from '../../shared/format.util';
import { ClassIconComponent } from '../../shared/class-icon.component';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { MechanicResolutionIconComponent } from '../../shared/mechanic-resolution-icon.component';
import type { BossMechanicCandidateRow, BossMechanicDefensiveProfileRow, MechanicDefensiveAssignmentRow, CooldownCatalogRow } from '../../shared/models/domain';

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
  abilityId: number;
  name: string;
  timeMs: number;
  priority: number | null;
  assignment: MechanicDefensiveAssignmentRow | null;
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
    const assignedAbilityIds = new Set(this.assignments().map((a) => a.ability_id));
    return this.mechanicRows().filter((r) => r.profile?.requires_defensive === true && !assignedAbilityIds.has(r.candidate.ability_id));
  });

  constructor() {
    void this.loadBosses();
    void this.loadCooldownCatalog();
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
      const [candidates, profiles, assignments, syncState] = await Promise.all([
        this.manifestService.listCandidates(String(bossId), difficulty),
        this.profileService.listProfiles(String(bossId), difficulty),
        this.profileService.listAssignments(String(bossId), difficulty),
        this.profileService.getSyncState(String(bossId), difficulty),
      ]);
      this.candidates.set(candidates);
      this.profiles.set(profiles);
      this.assignments.set(assignments);
      this.syncState.set(syncState);
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
    const role = roleFromSpec(cls, spec);
    const relevant = this.candidates()
      .filter((c) => mechanicAppliesToRole(c.responsibility, role))
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
      if (!assignment) return { ...base, assignment: null, defensiveName: null, cooldownMs: null, conflict: false };
      const cd = this.cooldownCatalog().find((c) => c.spell_id === assignment.defensive_spell_id);
      const cooldownMs = cd?.base_cooldown_ms ?? null;
      const prevAvailable = nextAvailableMs.get(assignment.defensive_spell_id) ?? 0;
      const conflict = cooldownMs != null && prevAvailable > e.timeMs;
      // solo se actualiza el próximo disponible si de verdad se pudo usar
      // aquí — si hay conflicto, el cast no pudo pasar de verdad, así que
      // el próximo hueco disponible sigue siendo el de antes (el conflicto
      // se arrastra hasta que pase suficiente tiempo, como en la realidad).
      if (!conflict && cooldownMs != null) nextAvailableMs.set(assignment.defensive_spell_id, e.timeMs + cooldownMs);
      return { ...base, assignment, defensiveName: cd?.name ?? `#${assignment.defensive_spell_id}`, cooldownMs, conflict };
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

  /** Motor de la cascada para UNA spec — reutilizado por el botón de spec suelta y por "auto-asignar clase". No guarda progreso propio (lo hace el caller) para poder encadenar varias specs sin pisarse. */
  private async runCascadeForSpec(bossId: string, difficulty: string, cls: string, spec: string): Promise<{ assigned: number; candidates: number }> {
    const role = roleFromSpec(cls, spec);
    const mechanicInputs = this.candidates()
      .filter((c) => mechanicAppliesToRole(c.responsibility, role))
      .map((c) => {
        const profile = this.profiles().find((p) => p.ability_id === c.ability_id) ?? null;
        return { abilityId: c.ability_id, name: c.name, timeMs: median(profile?.reference_cast_offset_ms_samples ?? []), impactScore: this.impactScore(c, profile) };
      });
    const defensiveInputs = defensivesForSpec(this.cooldownCatalog(), cls, spec).map((cd) => ({ spellId: cd.spell_id, survivalType: cd.survival_type, baseCooldownMs: cd.base_cooldown_ms }));
    const result = autoAssignCascade(mechanicInputs, defensiveInputs);
    for (const a of result) {
      await this.edgeFunctions.saveMechanicDefensiveAssignment({ bossId, difficulty, abilityId: a.abilityId, class: cls, spec, defensiveSpellId: a.defensiveSpellId, prewarnSeconds: 5, triggerType: 'bossmod' });
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
