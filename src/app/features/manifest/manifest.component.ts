// Colocar en: src/app/features/manifest/manifest.component.ts
// Tarea manual #1 de la hoja de ruta (§5), pero acelerada: la clasificación
// editorial (avoidable, categoría, umbral) sigue siendo humana, pero el
// candidato en sí sale de sync-boss-mechanics (Blizzard Journal + Wago DB2),
// cero texto tecleado para nombres/IDs.
import { Component, computed, inject, signal } from '@angular/core';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { ManifestService, type ObservedHitStat } from '../../core/manifest.service';
import { ReportsService, type KnownBoss } from '../../core/reports.service';
import { WCL_DIFFICULTY_NAME_BY_ID } from '../../shared/format.util';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import type { BossMechanicCandidateRow } from '../../shared/models/domain';

const CATEGORIES = ['tankbuster', 'raid-damage', 'avoidable-ground', 'debuff-stack', 'interrupt', 'soak', 'spread', 'healing-absorb'] as const;

@Component({
  selector: 'app-manifest',
  standalone: true,
  imports: [WowheadLinkComponent],
  templateUrl: './manifest.component.html',
  styleUrl: './manifest.component.scss',
})
export class ManifestComponent {
  private edgeFunctions = inject(EdgeFunctionsService);
  private manifestService = inject(ManifestService);
  private reportsService = inject(ReportsService);

  readonly categories = CATEGORIES;

  bosses = signal<KnownBoss[]>([]);
  selectedEncounterId = signal<number | null>(null);
  selectedDifficultyId = signal<number | null>(null);
  candidates = signal<BossMechanicCandidateRow[]>([]);
  hitStats = signal<Map<number, ObservedHitStat>>(new Map());

  loadingBosses = signal(true);
  syncing = signal(false);
  deepSyncing = signal(false);
  loadingCandidates = signal(false);
  savingAbilityId = signal<number | null>(null);
  error = signal<string | null>(null);
  lastSyncSummary = signal<string | null>(null);

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
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loadingBosses.set(false);
    }
  }

  selectBoss(encounterId: number): void {
    this.selectedEncounterId.set(encounterId);
    const boss = this.bosses().find((b) => b.encounterId === encounterId);
    this.selectedDifficultyId.set(boss?.difficulties[0] ?? null);
    this.candidates.set([]);
    void this.loadCandidates();
  }

  selectDifficulty(difficultyId: number): void {
    this.selectedDifficultyId.set(difficultyId);
    void this.loadCandidates();
  }

  async loadCandidates(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty) return;
    this.loadingCandidates.set(true);
    this.error.set(null);
    try {
      const [candidates, hitStats] = await Promise.all([
        this.manifestService.listCandidates(String(bossId), difficulty),
        this.manifestService.listObservedHitStats(String(bossId), difficulty),
      ]);
      this.candidates.set(candidates);
      this.hitStats.set(hitStats);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loadingCandidates.set(false);
    }
  }

  async onSync(deepSync = false): Promise<void> {
    const bossId = this.selectedEncounterId();
    if (bossId == null) return;
    if (deepSync) this.deepSyncing.set(true);
    else this.syncing.set(true);
    this.error.set(null);
    this.lastSyncSummary.set(null);
    try {
      const result = await this.edgeFunctions.syncBossMechanics(String(bossId), undefined, deepSync);
      this.lastSyncSummary.set(
        `${result.candidates} candidatas del Journal, ${result.upserts} sincronizadas` +
          (deepSync ? ' (sync profundo, hasta 20 logs de referencia por dificultad)' : '') +
          `. ` +
          result.difficulties.map((d) => `${d.difficulty}: ${d.mappingStatus}`).join(' · '),
      );
      await this.loadCandidates();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.syncing.set(false);
      this.deepSyncing.set(false);
    }
  }

  async onEdit(
    candidate: BossMechanicCandidateRow,
    patch: Partial<Pick<BossMechanicCandidateRow, 'category' | 'avoidable' | 'severity_threshold' | 'reviewed'>>,
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
        category: patch.category ?? candidate.category,
        avoidable: patch.avoidable ?? candidate.avoidable,
        expectedResponse: candidate.expected_response,
        severityThreshold: patch.severity_threshold ?? candidate.severity_threshold,
        reviewed: patch.reviewed ?? true,
      });
      this.candidates.update((list) => list.map((c) => (c.ability_id === candidate.ability_id ? { ...c, ...patch, reviewed: patch.reviewed ?? true } : c)));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.savingAbilityId.set(null);
    }
  }

  difficultyLabel(id: number): string {
    return WCL_DIFFICULTY_NAME_BY_ID[id] ?? `Dificultad ${id}`;
  }

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
}
