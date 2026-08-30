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
import { DecimalPipe, PercentPipe } from '@angular/common';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { ManifestService } from '../../core/manifest.service';
import { BossMechanicDefensiveProfileService } from '../../core/boss-mechanic-defensive-profile.service';
import { DefensiveCatalogService } from '../../core/defensive-catalog.service';
import { ReportsService, type KnownBoss } from '../../core/reports.service';
import { STANDARD_DIFFICULTY_IDS, WCL_DIFFICULTY_NAME_BY_ID } from '../../shared/format.util';
import { ALL_CLASSES, specsForClass } from '../../shared/spec-role.util';
import { defensivesForSpec } from '../../shared/defensive-spec-match.util';
import { encodeMrtExport, spellTag, type MrtReminderInput, type MrtTrigger } from '../../shared/mrt/mrt-reminder-codec';
import { errorMessage } from '../../shared/error-message.util';
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
}

interface ExportResult {
  class: string;
  spec: string;
  text: string;
  skippedForMissingTiming: string[];
}

@Component({
  selector: 'app-boss-prep',
  standalone: true,
  imports: [DecimalPipe, PercentPipe],
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

  expandedAbilityId = signal<number | null>(null);
  savingProfileId = signal<number | null>(null);
  assignmentDraft = signal<AssignmentDraft | null>(null);
  savingAssignment = signal(false);
  confirmingDeleteAssignmentId = signal<string | null>(null);

  exportResult = signal<ExportResult | null>(null);
  copyStatus = signal<'idle' | 'copied' | 'error'>('idle');

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

  /** Cada (clase, spec) con al menos una asignación en este boss+dificultad — son los botones "Crear reminder MRT" que tiene sentido ofrecer. */
  specsWithAssignments = computed(() => {
    const seen = new Map<string, { class: string; spec: string }>();
    for (const a of this.assignments()) seen.set(`${a.class}|${a.spec}`, { class: a.class, spec: a.spec });
    return [...seen.values()].sort((a, b) => a.class.localeCompare(b.class) || a.spec.localeCompare(b.spec));
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
      const [candidates, profiles, assignments] = await Promise.all([
        this.manifestService.listCandidates(String(bossId), difficulty),
        this.profileService.listProfiles(String(bossId), difficulty),
        this.profileService.listAssignments(String(bossId), difficulty),
      ]);
      this.candidates.set(candidates);
      this.profiles.set(profiles);
      this.assignments.set(assignments);
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
      this.syncSummary.set(
        r ? `${r.mechanicsProfiled} mecánicas perfiladas contra ${r.referenceFightsUsed} logs de referencia.` : 'Sin resultado — revisa que el boss tenga mecánicas curadas en Ajustes → Mecánicas.',
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
    this.assignmentDraft.set(null);
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
    });
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

      reminders.push({
        uid: `avoid_${bossId}_${mrtDifficultyId}_${a.ability_id}_${cls}_${spec}`.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        name: `${candidateName} - ${spec}`,
        message: `${spellTag(a.defensive_spell_id)} ${defensiveName}`.trim(),
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
