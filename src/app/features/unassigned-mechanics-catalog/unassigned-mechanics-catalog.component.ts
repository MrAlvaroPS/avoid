// Colocar en: src/app/features/unassigned-mechanics-catalog/unassigned-mechanics-catalog.component.ts
// §"UI en Ajustes para gestionar el catálogo a mano" (feedback real,
// 2026-08-29): mismo patrón EXACTO que defensive-catalog.component.ts
// (navegación propia + tabla editable + reanálisis en cola tras un cambio
// que afecta a detección), pero el eje de navegación es boss+dificultad
// (como manifest.component.ts) en vez de clase — sin el panel de
// clasificación por IA a propósito (fase aparte, todavía sin decidir cómo
// automatizarla — ver conversación real 2026-08-29).
import { Component, computed, inject, signal } from '@angular/core';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { UnassignedMechanicCatalogService } from '../../core/unassigned-mechanic-catalog.service';
import { ReportsService, type KnownBoss } from '../../core/reports.service';
import { STANDARD_DIFFICULTY_IDS, WCL_DIFFICULTY_NAME_BY_ID } from '../../shared/format.util';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import type { UnassignedMechanicCatalogRow } from '../../shared/models/domain';
import { errorMessage } from '../../shared/error-message.util';

const DETECTION_TYPES = ['npc_interaction', 'cast', 'debuff_applied', 'buff_applied'] as const;
const DETECTION_TYPE_LABEL: Record<(typeof DETECTION_TYPES)[number], string> = {
  npc_interaction: 'Interacción con NPC-objeto (Casts/DamageDone)',
  cast: 'Cast real del jugador',
  debuff_applied: 'Debuff aplicado al jugador',
  buff_applied: 'Buff aplicado al jugador',
};
const ROLE_OPTIONS = ['Tank', 'Healer', 'Melee', 'Ranged'];

interface DraftRow {
  bossId: string;
  difficulty: string;
  name: string;
  detectionType: (typeof DETECTION_TYPES)[number];
  abilityId: string;
  actorNamePattern: string;
  appliedBy: 'npc' | 'self' | '';
  eligibleRoles: string[];
}

function emptyDraft(bossId: string, difficulty: string): DraftRow {
  return { bossId, difficulty, name: '', detectionType: 'debuff_applied', abilityId: '', actorNamePattern: '', appliedBy: 'npc', eligibleRoles: [] };
}

@Component({
  selector: 'app-unassigned-mechanics-catalog',
  standalone: true,
  imports: [WowheadLinkComponent],
  templateUrl: './unassigned-mechanics-catalog.component.html',
  styleUrl: './unassigned-mechanics-catalog.component.scss',
})
export class UnassignedMechanicsCatalogComponent {
  private edgeFunctions = inject(EdgeFunctionsService);
  private catalogService = inject(UnassignedMechanicCatalogService);
  private reportsService = inject(ReportsService);

  readonly detectionTypes = DETECTION_TYPES;
  readonly detectionTypeLabel = DETECTION_TYPE_LABEL;
  readonly roleOptions = ROLE_OPTIONS;
  readonly standardDifficultyIds = STANDARD_DIFFICULTY_IDS;

  bosses = signal<KnownBoss[]>([]);
  loadingBosses = signal(true);
  selectedEncounterId = signal<number | null>(null);
  selectedDifficultyId = signal<number | null>(null);
  rows = signal<UnassignedMechanicCatalogRow[]>([]);
  loadingRows = signal(false);
  error = signal<string | null>(null);
  savingId = signal<string | 'new' | null>(null);
  confirmingDeleteId = signal<string | null>(null);

  addFormOpen = signal(false);
  draft = signal<DraftRow | null>(null);

  /** §"se calculan de nuevo?" (mismo motivo que defensive-catalog.component.ts): reanalyze-unassigned-mechanics ya existe y ya soporta esto — orquestado aquí en el cliente, nunca en bucle dentro de un edge function (WORKER_RESOURCE_LIMIT, ver memoria del proyecto). */
  lastReanalysis = signal<{ mechanicName: string; total: number; done: number; failed: number; running: boolean } | null>(null);

  selectedBoss = computed(() => this.bosses().find((b) => b.encounterId === this.selectedEncounterId()) ?? null);
  selectedDifficultyName = computed(() => (this.selectedDifficultyId() != null ? WCL_DIFFICULTY_NAME_BY_ID[this.selectedDifficultyId()!] : null));

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
    this.selectedDifficultyId.set(boss?.difficulties[0] ?? this.standardDifficultyIds[0]);
    this.closeAddForm();
    void this.loadRows();
  }

  selectDifficulty(difficultyId: number): void {
    this.selectedDifficultyId.set(difficultyId);
    this.closeAddForm();
    void this.loadRows();
  }

  async loadRows(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty) return;
    this.loadingRows.set(true);
    this.error.set(null);
    try {
      this.rows.set(await this.catalogService.listByBoss(String(bossId), difficulty));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loadingRows.set(false);
    }
  }

  openAddForm(): void {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty) return;
    this.draft.set(emptyDraft(String(bossId), difficulty));
    this.addFormOpen.set(true);
  }

  closeAddForm(): void {
    this.addFormOpen.set(false);
    this.draft.set(null);
  }

  updateDraft(patch: Partial<DraftRow>): void {
    const current = this.draft();
    if (!current) return;
    this.draft.set({ ...current, ...patch });
  }

  toggleDraftRole(role: string): void {
    const current = this.draft();
    if (!current) return;
    const has = current.eligibleRoles.includes(role);
    this.updateDraft({ eligibleRoles: has ? current.eligibleRoles.filter((r) => r !== role) : [...current.eligibleRoles, role] });
  }

  async submitDraft(): Promise<void> {
    const d = this.draft();
    if (!d || !d.name.trim()) return;
    const abilityId = d.abilityId.trim() ? Number(d.abilityId) : null;
    const actorNamePattern = d.actorNamePattern.trim() || null;
    if (!abilityId && !actorNamePattern) {
      this.error.set('Hace falta ability_id o actor_name_pattern (al menos uno) — ver el tipo de detección elegido.');
      return;
    }
    this.savingId.set('new');
    this.error.set(null);
    try {
      const res = await this.edgeFunctions.saveUnassignedMechanicEdit({
        bossId: d.bossId,
        difficulty: d.difficulty,
        name: d.name.trim(),
        detectionType: d.detectionType,
        abilityId,
        actorNamePattern,
        appliedBy: d.appliedBy || null,
        eligibleRoles: d.eligibleRoles.length ? d.eligibleRoles : null,
        hasConfirmedDetection: false, // §nunca se crea ya confirmada a mano — hace falta verificar contra un report real primero (ver memoria wcl-pickup-mechanics-use-debuff-signal), esto solo da de alta la clasificación.
        reviewed: true,
      });
      this.closeAddForm();
      await this.loadRows();
      if (res.pullIds.length) void this.runReanalysisQueue(d.name.trim(), res.pullIds);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.savingId.set(null);
    }
  }

  async onEdit(
    row: UnassignedMechanicCatalogRow,
    patch: Partial<
      Pick<UnassignedMechanicCatalogRow, 'name' | 'detection_type' | 'ability_id' | 'actor_name_pattern' | 'applied_by' | 'eligible_roles' | 'has_confirmed_detection' | 'reviewed' | 'ai_notes'>
    >,
  ): Promise<void> {
    this.savingId.set(row.id);
    this.error.set(null);
    try {
      const res = await this.edgeFunctions.saveUnassignedMechanicEdit({
        id: row.id,
        ...('name' in patch ? { name: patch.name } : {}),
        ...('detection_type' in patch ? { detectionType: patch.detection_type } : {}),
        ...('ability_id' in patch ? { abilityId: patch.ability_id } : {}),
        ...('actor_name_pattern' in patch ? { actorNamePattern: patch.actor_name_pattern } : {}),
        ...('applied_by' in patch ? { appliedBy: patch.applied_by } : {}),
        ...('eligible_roles' in patch ? { eligibleRoles: patch.eligible_roles } : {}),
        ...('has_confirmed_detection' in patch ? { hasConfirmedDetection: patch.has_confirmed_detection } : {}),
        ...('reviewed' in patch ? { reviewed: patch.reviewed } : {}),
        ...('ai_notes' in patch ? { aiNotes: patch.ai_notes } : {}),
      });
      this.rows.update((list) => list.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
      if (res.pullIds.length) void this.runReanalysisQueue(row.name, res.pullIds);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.savingId.set(null);
    }
  }

  onAbilityIdInput(row: UnassignedMechanicCatalogRow, raw: string): void {
    const trimmed = raw.trim();
    const id = trimmed === '' ? null : Number(trimmed);
    if (id != null && (!Number.isFinite(id) || id <= 0)) return;
    void this.onEdit(row, { ability_id: id });
  }

  toggleRole(row: UnassignedMechanicCatalogRow, role: string): void {
    const current = row.eligible_roles ?? [];
    const next = current.includes(role) ? current.filter((r) => r !== role) : [...current, role];
    void this.onEdit(row, { eligible_roles: next.length ? next : null });
  }

  /** Doble clic en 5s, mismo patrón que discord-settings.component.ts (bulkSendConfirming) — sin diálogo nativo. */
  requestDelete(rowId: string): void {
    if (this.confirmingDeleteId() === rowId) {
      void this.confirmDelete(rowId);
      return;
    }
    this.confirmingDeleteId.set(rowId);
    setTimeout(() => {
      if (this.confirmingDeleteId() === rowId) this.confirmingDeleteId.set(null);
    }, 5000);
  }

  private async confirmDelete(rowId: string): Promise<void> {
    this.confirmingDeleteId.set(null);
    this.savingId.set(rowId);
    this.error.set(null);
    try {
      const res = await this.edgeFunctions.saveUnassignedMechanicEdit({ id: rowId, delete: true });
      this.rows.update((list) => list.filter((r) => r.id !== rowId));
      if (res.pullIds.length) void this.runReanalysisQueue('fila borrada', res.pullIds);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.savingId.set(null);
    }
  }

  private async runReanalysisQueue(mechanicName: string, pullIds: string[]): Promise<void> {
    this.lastReanalysis.set({ mechanicName, total: pullIds.length, done: 0, failed: 0, running: true });
    let done = 0;
    let failed = 0;
    for (const pullId of pullIds) {
      try {
        await this.edgeFunctions.reanalyzeUnassignedMechanics(pullId);
        done++;
      } catch (err) {
        failed++;
        console.error(`No se pudo reanalizar el pull ${pullId} tras editar ${mechanicName}:`, err);
      }
      this.lastReanalysis.set({ mechanicName, total: pullIds.length, done, failed, running: true });
    }
    this.lastReanalysis.set({ mechanicName, total: pullIds.length, done, failed, running: false });
  }

  difficultyLabel(id: number): string {
    return WCL_DIFFICULTY_NAME_BY_ID[id] ?? `Dificultad ${id}`;
  }

  needsAbilityId(type: (typeof DETECTION_TYPES)[number]): boolean {
    return type !== 'npc_interaction';
  }
}
