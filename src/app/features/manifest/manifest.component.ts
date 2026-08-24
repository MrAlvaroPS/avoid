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
import { MechanicInfoIconComponent } from '../../shared/mechanic-info-icon.component';
import type { BossMechanicCandidateRow } from '../../shared/models/domain';

const CATEGORIES = ['tankbuster', 'raid-damage', 'avoidable-ground', 'debuff-stack', 'interrupt', 'soak', 'spread', 'healing-absorb', 'personal-target', 'enrage'] as const;

// §9.1: un boss sembrado por sync-season-bosses pero nunca pulleado no tiene
// dificultades "vistas" que ofrecer (difficulties queda vacío) — se ofrecen
// las 4 estándar del juego para que se pueda elegir a mano cuál sincronizar.
const STANDARD_DIFFICULTY_IDS = [1, 3, 4, 5] as const;

@Component({
  selector: 'app-manifest',
  standalone: true,
  imports: [WowheadLinkComponent, MechanicInfoIconComponent],
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
  otherDifficultyEvidence = signal<Map<number, { difficulty: string; hasEvidence: boolean }[]>>(new Map());

  loadingBosses = signal(true);
  syncing = signal(false);
  deepSyncing = signal(false);
  syncingSeason = signal(false);
  readonly standardDifficultyIds = STANDARD_DIFFICULTY_IDS;
  loadingCandidates = signal(false);
  savingAbilityId = signal<number | null>(null);
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
  classifyCopied = signal(false);
  classifyPasteText = signal('');
  classifySubmitting = signal(false);
  classifySubmitError = signal<string | null>(null);
  classifyResult = signal<{
    applied: { abilityId: number; name: string; category: string }[];
    skippedLowConfidence: { abilityId: number; name: string; category: string | null; notes: string }[];
    skippedUndetermined: { abilityId: number; name: string }[];
    invalid: { abilityId: unknown; reason: string }[];
  } | null>(null);

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
    // Preselecciona una dificultad con pulls propios si hay alguna (es la
    // más probable que se quiera consultar); si no hay ninguna, no se
    // preselecciona nada — las 4 siguen ahí para elegir a mano.
    this.selectedDifficultyId.set(boss?.difficulties[0] ?? null);
    this.candidates.set([]);
    this.closeClassifyPanel();
    if (boss?.difficulties.length) void this.loadCandidates();
  }

  selectDifficulty(difficultyId: number): void {
    this.selectedDifficultyId.set(difficultyId);
    this.closeClassifyPanel();
    void this.loadCandidates();
  }

  async loadCandidates(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty) return;
    this.loadingCandidates.set(true);
    this.error.set(null);
    try {
      const [candidates, hitStats, otherDifficultyEvidence] = await Promise.all([
        this.manifestService.listCandidates(String(bossId), difficulty),
        this.manifestService.listObservedHitStats(String(bossId), difficulty),
        this.manifestService.listOtherDifficultyEvidence(String(bossId), difficulty),
      ]);
      this.candidates.set(candidates);
      this.hitStats.set(hitStats);
      this.otherDifficultyEvidence.set(otherDifficultyEvidence);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loadingCandidates.set(false);
    }
  }

  async onSync(deepSync = false): Promise<void> {
    const bossId = this.selectedEncounterId();
    if (bossId == null) return;
    // Siempre se manda la dificultad elegida a mano en las pestañas, nunca
    // se deja que el servidor la infiera de report_encounters — bug real
    // corregido aquí: con inferencia automática, elegir "Heroic" en un boss
    // que solo tiene pulls propios en Normal sincronizaba Normal en
    // silencio (la única dificultad que el servidor podía deducir),
    // ignorando la pestaña que de verdad estaba seleccionada.
    if (this.selectedDifficultyId() == null) {
      this.error.set('Elige una dificultad primero.');
      return;
    }
    const explicitDifficulties = [this.selectedDifficultyId()!];
    if (deepSync) this.deepSyncing.set(true);
    else this.syncing.set(true);
    this.error.set(null);
    this.lastSyncSummary.set(null);
    try {
      const result = await this.edgeFunctions.syncBossMechanics(String(bossId), explicitDifficulties, deepSync);
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
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.syncingSeason.set(false);
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

  // §"señalar cuándo una mecánica es exclusiva de cierta dificultad —
  // parecen pisarse entre sí": si ESTA dificultad no tiene ninguna
  // evidencia real (ni casts emparejados ni logs de referencia) pero OTRA
  // dificultad del mismo boss sí la tiene, es una pista real de que puede
  // ser exclusiva de esa otra — nunca se oculta la candidata, solo se avisa.
  crossDifficultyNote(candidate: BossMechanicCandidateRow): string | null {
    const hasEvidenceHere = (candidate.reference_occurrences ?? 0) > 0 || candidate.observed_in_logs;
    if (hasEvidenceHere) return null;
    const others = this.otherDifficultyEvidence().get(candidate.ability_id) ?? [];
    const withEvidence = others.filter((o) => o.hasEvidence).map((o) => o.difficulty);
    if (!withEvidence.length) return null;
    return `Sin evidencia aquí, pero sí en ${withEvidence.join('/')} — puede ser exclusiva de esa dificultad`;
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

  // §"un prompt para pasar a la IA y que investigue... clasificar todas las
  // mecánicas de forma semi automática aunque con ayuda manual": el prompt
  // se genera SIEMPRE para el boss+dificultad seleccionados en pantalla —
  // nunca mezcla dificultades, así que "la misma habilidad se comporta
  // ligeramente distinto entre dificultades" queda cubierto de raíz.
  async openClassifyPanel(): Promise<void> {
    this.classifyPanelOpen.set(true);
    this.classifyResult.set(null);
    if (this.classifySystemPrompt() != null) return; // ya traído para este boss+dificultad, no repetir la llamada
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty) return;
    this.loadingClassifyPrompt.set(true);
    this.classifyPromptError.set(null);
    try {
      const res = await this.edgeFunctions.getMechanicClassificationPrompt(String(bossId), difficulty);
      this.classifySystemPrompt.set(res.systemPrompt);
      this.classifyUserMessage.set(res.userMessage);
      this.classifyMechanicCount.set(res.mechanicCount);
    } catch (err) {
      this.classifyPromptError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loadingClassifyPrompt.set(false);
    }
  }

  closeClassifyPanel(): void {
    this.classifyPanelOpen.set(false);
    this.classifySystemPrompt.set(null);
    this.classifyUserMessage.set(null);
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
      this.classifyPromptError.set('No se pudo copiar automáticamente — selecciona el texto a mano. (' + (err instanceof Error ? err.message : String(err)) + ')');
    }
  }

  async submitClassification(): Promise<void> {
    const bossId = this.selectedEncounterId();
    const difficulty = this.selectedDifficultyName();
    if (bossId == null || !difficulty || !this.classifyPasteText().trim()) return;
    this.classifySubmitting.set(true);
    this.classifySubmitError.set(null);
    try {
      const res = await this.edgeFunctions.submitMechanicClassification(String(bossId), difficulty, this.classifyPasteText());
      this.classifyPasteText.set('');
      // §bug real encontrado (2026-08-23, feedback real: "el desplegable
      // 'sin clasificar' no cambia aunque haya sido clasificado"): esto
      // ANTES se hacía después de fijar classifyResult — el banner de
      // "✓ N mecánicas clasificadas" aparecía mientras loadCandidates()
      // todavía estaba en vuelo, así que se veía el éxito y la tabla vieja
      // a la vez (los datos SÍ se guardaban bien, solo llegaban tarde a
      // pantalla). Se espera a tener la tabla fresca antes de anunciar éxito.
      await this.loadCandidates();
      this.classifyResult.set({ applied: res.applied, skippedLowConfidence: res.skippedLowConfidence, skippedUndetermined: res.skippedUndetermined, invalid: res.invalid });
    } catch (err) {
      this.classifySubmitError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.classifySubmitting.set(false);
    }
  }
}
