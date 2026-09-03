// Colocar en: src/app/features/defensive-catalog/defensive-catalog.component.ts
// §"pantalla nueva para clasificar defensivos (sustain, defensivo, absorb,
// etc)... parecida a la de mecánicas de bosses pero para defensivos... se
// clasifican por clase" (feedback real): mismo patrón EXACTO que
// manifest.component.ts (mecánicas), pero el eje de navegación es la clase
// en vez de boss+dificultad, y el catálogo base (nombre, spec, cooldown,
// duración) ya llega solo desde cooldown_catalog — aquí solo se confirma
// survival_type.
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import {
  EdgeFunctionsService,
  type DefensiveReanalysisJobRef,
  type DefensiveReanalysisQueueStatusResult,
} from '../../core/edge-functions.service';
import { DefensiveCatalogService } from '../../core/defensive-catalog.service';
import { ClassIconComponent } from '../../shared/class-icon.component';
import { CLASS_DISPLAY_NAME, SURVIVAL_TYPE_KEYS, classDisplayName, safeSpellName, survivalTypeMeta } from '../../shared/format.util';
import { specsForClass } from '../../shared/spec-role.util';
import { MechanicInfoIconComponent } from '../../shared/mechanic-info-icon.component';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import type { CooldownCatalogRow } from '../../shared/models/domain';
import { errorMessage } from '../../shared/error-message.util';

// Mismo orden que CLASS_COLORS/CLASS_DISPLAY_NAME (format.util.ts) — las 13
// clases del juego siempre visibles como pestañas, tenga o no el catálogo
// filas suyas todavía (mismo criterio que standardDifficultyIds en
// manifest.component.ts: no ocultar una clase solo porque el extractor de
// WoWAnalyzer no le haya encontrado nada aún).
const CLASSES = Object.keys(CLASS_DISPLAY_NAME);

@Component({
  selector: 'app-defensive-catalog',
  standalone: true,
  imports: [ClassIconComponent, MechanicInfoIconComponent, WowheadLinkComponent],
  templateUrl: './defensive-catalog.component.html',
  styleUrl: './defensive-catalog.component.scss',
})
export class DefensiveCatalogComponent implements OnInit, OnDestroy {
  private edgeFunctions = inject(EdgeFunctionsService);
  private defensiveCatalogService = inject(DefensiveCatalogService);

  readonly classes = CLASSES;
  readonly survivalTypes = SURVIVAL_TYPE_KEYS;
  readonly defensiveCategories: CooldownCatalogRow['category'][] = ['personal_defensive', 'semi_defensive', 'external_defensive', 'utility'];
  readonly defensiveTargetingModes: CooldownCatalogRow['targeting_mode'][] = ['self', 'ally', 'both', 'raid', 'unknown'];
  readonly classDisplayName = classDisplayName;
  readonly survivalTypeMeta = survivalTypeMeta;
  readonly safeSpellName = safeSpellName;

  selectedClass = signal<string | null>(null);
  defensives = signal<CooldownCatalogRow[]>([]);
  loadingDefensives = signal(false);
  savingSpellId = signal<number | null>(null);
  error = signal<string | null>(null);
  /** §"se calculan de nuevo?" (feedback real, 2026-08-29): resultado del
   * reanálisis automático que dispara editar cooldown/duración — visible en
   * vez de mudo, para que quede claro que sí se propaga. Progreso en vivo
   * mientras corre (done/total) y resumen final (failed) cuando termina.
   *
   * §bug real en producción (2026-08-29, verificado con Fortifying
   * Brew/47 pulls de Monk): reanalizar los pulls DENTRO de un edge function
   * (bucle propio, o encadenando invocaciones vía fetch+waitUntil) agota su
   * cuota de CPU a mitad de camino (WORKER_RESOURCE_LIMIT) y muere en
   * silencio. La ejecución sigue haciendo una invocación por pull desde el
   * cliente, pero la lista ya queda persistida como batch+jobs en Supabase:
   * cerrar la pestaña no pierde lo pendiente y la siguiente sesión lo reanuda. */
  lastReanalysis = signal<{ spellName: string; total: number; done: number; failed: number; running: boolean } | null>(null);
  reanalysisQueueWarning = signal<string | null>(null);
  queueHealth = signal<'checking' | 'healthy' | 'running' | 'failed' | 'unreachable'>('checking');
  queueStatus = signal<DefensiveReanalysisQueueStatusResult | null>(null);
  queueHealthError = signal<string | null>(null);
  queueDetailsOpen = signal(false);
  queueRetrying = signal(false);
  queueActionMessage = signal<string | null>(null);

  /** Serializa también operaciones iniciadas mientras otra cola sigue viva. */
  private reanalysisQueueTail: Promise<void> = Promise.resolve();
  private scheduledReanalysisJobIds = new Set<string>();
  private pendingReanalysisResumeStarted = false;
  private queueHealthPoll: ReturnType<typeof setTimeout> | null = null;
  private queueHealthDestroyed = false;

  /** §"botón... para limpiar sus defensivos y volver a calcularlos con el prompt, porque alguno se desactualiza" (feedback real, 2026-08-31) */
  confirmingResetClassId = signal<string | null>(null);
  resettingClass = signal(false);
  lastClassReset = signal<{ className: string; resetCount: number } | null>(null);

  // §"un desplegable para poner el tipo de defensivo que es (que también
  // deberá rellenarse solo o a través de un prompt)" (feedback real): mismo
  // patrón de dos pasos que el panel de IA de manifest.component.ts —
  // copiar prompt / pegar respuesta.
  //
  // §"la cantidad de habilidades defensivas no es desorbitante, ¿no podemos
  // hacer un único prompt que clasifique todas las specs a la vez y rellene
  // toda la tabla de golpe?" (feedback real, contrastado: 60 filas en total
  // en las 13 clases — cabe de sobra en un solo prompt): classifyScope
  // decide si el prompt actual cubre solo la clase seleccionada o el
  // catálogo entero. 'all' se manda al backend como class:null.
  classifyScope = signal<string | 'all' | null>(null);
  classifyPanelOpen = signal(false);
  loadingClassifyPrompt = signal(false);
  classifyPromptError = signal<string | null>(null);
  classifySystemPrompt = signal<string | null>(null);
  classifyUserMessage = signal<string | null>(null);
  classifyDefensiveCount = signal(0);
  classifyPromptVersion = signal<number | null>(null);
  classifyGameBuild = signal<string | null>(null);
  classifyCopied = signal(false);
  classifyPasteText = signal('');
  classifySubmitting = signal(false);
  classifySubmitError = signal<string | null>(null);
  classifyResult = signal<{
    applied: { spellId: number; name: string; survivalType: string; category: string; targetingMode: string }[];
    skippedLowConfidence: { spellId: number; name: string; survivalType: string | null; notes: string }[];
    skippedUndetermined: { spellId: number; name: string }[];
    suggestedExclusions: { spellId: number; name: string; class: string; notes: string }[];
    invalid: { spellId: unknown; reason: string }[];
  } | null>(null);

  classCounts = computed(() => {
    // Contador rápido "N sin clasificar" por si en el futuro se quiere
    // pintar en la pestaña — hoy solo se usa para la clase seleccionada,
    // pero se deja como computed único en vez de recalcularlo en el template.
    const list = this.defensives();
    return { total: list.length, unclassified: list.filter((d) => !d.survival_type).length };
  });

  ngOnInit(): void {
    void this.initializeReanalysisQueue();
  }

  ngOnDestroy(): void {
    this.queueHealthDestroyed = true;
    if (this.queueHealthPoll) clearTimeout(this.queueHealthPoll);
  }

  selectClass(className: string): void {
    this.selectedClass.set(className);
    this.closeClassifyPanel();
    void this.loadDefensives();
  }

  // §"quiero enseñar icono de la habilidad defensiva en la tabla de
  // defensivos" (feedback real, 2026-09-03): mismo mecanismo que ya usa
  // night-player-infographic.component.ts (loadSpellIcons) — sin servicio
  // compartido todavía, así que se repite aquí en vez de bloquear esto a que
  // exista uno.
  readonly iconUrls = signal<Record<number, string>>({});

  iconUrl(spellId: number | null): string | null {
    return spellId ? (this.iconUrls()[spellId] ?? null) : null;
  }

  onIconError(event: Event): void {
    (event.currentTarget as HTMLImageElement).style.display = 'none';
  }

  private async loadSpellIcons(spellIds: number[]): Promise<void> {
    const entries = await Promise.all(
      spellIds.map(async (spellId): Promise<[number, string] | null> => {
        try {
          const response = await fetch(`https://nether.wowhead.com/tooltip/spell/${spellId}`);
          if (!response.ok) return null;
          const payload = (await response.json()) as { icon?: string };
          return payload.icon
            ? [spellId, `https://wow.zamimg.com/images/wow/icons/large/${payload.icon}.jpg`]
            : null;
        } catch {
          return null;
        }
      }),
    );
    this.iconUrls.update((current) => ({
      ...current,
      ...Object.fromEntries(entries.filter((entry): entry is [number, string] => entry != null)),
    }));
  }

  async loadDefensives(): Promise<void> {
    const className = this.selectedClass();
    if (!className) return;
    this.loadingDefensives.set(true);
    this.error.set(null);
    try {
      const rows = await this.defensiveCatalogService.listByClass(className);
      this.defensives.set(rows);
      void this.loadSpellIcons(rows.map((row) => row.spell_id));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loadingDefensives.set(false);
    }
  }

  async onEdit(
    row: CooldownCatalogRow,
    patch: Partial<Pick<CooldownCatalogRow, 'category' | 'targeting_mode' | 'survival_type' | 'reviewed' | 'base_cooldown_ms' | 'base_duration_ms' | 'spec_override' | 'excluded'>>,
  ): Promise<void> {
    const className = this.selectedClass();
    if (!className) return;
    this.savingSpellId.set(row.spell_id);
    this.lastReanalysis.set(null); // limpia el aviso anterior mientras se guarda el nuevo — save-defensive-edit decide de verdad si hace falta reanalizar
    try {
      const res = await this.edgeFunctions.saveDefensiveEdit({
        class: className,
        spellId: row.spell_id,
        survivalType: 'survival_type' in patch ? patch.survival_type : row.survival_type,
        ...('category' in patch ? { category: patch.category } : {}),
        ...('targeting_mode' in patch ? { targetingMode: patch.targeting_mode } : {}),
        reviewed: patch.reviewed ?? true,
        // Solo se mandan si de verdad se están editando — save-defensive-edit
        // los deja tal cual cuando la clave no viene en el body, así una
        // edición de solo survival_type/reviewed nunca borra un CD/spec_override ya puestos.
        ...('base_cooldown_ms' in patch ? { baseCooldownMs: patch.base_cooldown_ms } : {}),
        ...('base_duration_ms' in patch ? { baseDurationMs: patch.base_duration_ms } : {}),
        ...('spec_override' in patch ? { specOverride: patch.spec_override } : {}),
        ...('excluded' in patch ? { excluded: patch.excluded } : {}),
      });
      this.defensives.update((list) => list.map((d) => (d.spell_id === row.spell_id ? { ...d, ...patch, reviewed: patch.reviewed ?? true } : d)));
      // §"se calculan de nuevo?" (feedback real, 2026-08-29) + "el dosier no
      // se actualiza con Ardent Defender" (feedback real, 2026-08-31):
      // save-defensive-edit ya decide con el valor ANTERIOR real si cd/
      // duración/survival_type/spec_override cambiaron de verdad — aquí solo
      // se confía en pullIds, nunca se vuelve a decidir en el cliente qué
      // "cuenta" como cambio de timing.
      this.showQueueFallbackWarning(res.reanalysisQueueError);
      if (res.pullIds?.length) {
        void this.runReanalysisQueue(row.name, res.pullIds, res.reanalysisJobs);
      }
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.savingSpellId.set(null);
    }
  }

  /**
   * Encola la ejecución local tras cualquier cola ya activa. Si hay jobs
   * persistidos se conserva cada ID (incluso si dos batches contienen el
   * mismo pull); si el alta durable falló, pullIds mantiene el fallback
   * compatible con despliegues anteriores.
   */
  private runReanalysisQueue(
    spellName: string,
    pullIds: string[],
    jobs: DefensiveReanalysisJobRef[] = [],
  ): Promise<void> {
    const unscheduledJobs = jobs.filter((job) => !this.scheduledReanalysisJobIds.has(job.id));
    const items = jobs.length
      ? unscheduledJobs.map((job) => ({ pullId: job.pullId, jobId: job.id }))
      : [...new Set(pullIds)].map((pullId) => ({ pullId, jobId: undefined }));
    if (!items.length) return Promise.resolve();
    for (const item of items) {
      if (item.jobId) this.scheduledReanalysisJobIds.add(item.jobId);
    }
    if (items.some((item) => item.jobId)) this.queueHealth.set('running');

    const task = this.reanalysisQueueTail.then(() => this.executeReanalysisQueue(spellName, items));
    const settled = task.finally(() => {
      for (const item of items) {
        if (item.jobId) this.scheduledReanalysisJobIds.delete(item.jobId);
      }
    });
    this.reanalysisQueueTail = settled.catch(() => undefined);
    return settled;
  }

  /** Una invocación por pull, siempre secuencial para no crear una ráfaga contra WCL. */
  private async executeReanalysisQueue(
    spellName: string,
    items: { pullId: string; jobId?: string }[],
  ): Promise<void> {
    this.lastReanalysis.set({ spellName, total: items.length, done: 0, failed: 0, running: true });
    let done = 0;
    let failed = 0;
    for (const item of items) {
      try {
        await this.edgeFunctions.reanalyzeDefensivePressure(item.pullId, item.jobId);
        done++;
      } catch (err) {
        failed++;
        console.error(`No se pudo reanalizar el pull ${item.pullId} tras editar ${spellName}:`, err);
      }
      this.lastReanalysis.set({ spellName, total: items.length, done, failed, running: true });
    }
    this.lastReanalysis.set({ spellName, total: items.length, done, failed, running: false });
    await this.refreshQueueHealth();
  }

  private async initializeReanalysisQueue(): Promise<void> {
    const status = await this.refreshQueueHealth();
    if (status && status.pendingCount > 0) await this.resumePendingReanalysisQueue();
  }

  private async refreshQueueHealth(): Promise<DefensiveReanalysisQueueStatusResult | null> {
    try {
      const status = await this.edgeFunctions.defensiveReanalysisQueueStatus();
      this.queueStatus.set(status);
      this.queueHealth.set(status.health);
      this.queueHealthError.set(null);
      this.scheduleQueueHealthPoll(status.health === 'running');
      return status;
    } catch (err) {
      const detail = errorMessage(err);
      console.error('No se pudo comprobar la salud de la cola defensiva:', err);
      this.queueStatus.set(null);
      this.queueHealth.set('unreachable');
      this.queueHealthError.set(detail);
      this.scheduleQueueHealthPoll(false);
      return null;
    }
  }

  onDefensiveCategoryChange(row: CooldownCatalogRow, category: CooldownCatalogRow['category']): void {
    const targetingMode: CooldownCatalogRow['targeting_mode'] =
      category === 'personal_defensive'
        ? 'self'
        : category === 'semi_defensive'
          ? 'both'
          : category === 'external_defensive'
            ? (row.targeting_mode === 'ally' || row.targeting_mode === 'raid' ? row.targeting_mode : 'unknown')
            : row.targeting_mode;
    void this.onEdit(row, { category, targeting_mode: targetingMode });
  }

  defensiveCategoryLabel(category: CooldownCatalogRow['category']): string {
    if (category === 'personal_defensive') return 'Personal';
    if (category === 'semi_defensive') return 'Semi';
    if (category === 'external_defensive') return 'External';
    return 'Utility';
  }

  private scheduleQueueHealthPoll(active: boolean): void {
    if (this.queueHealthPoll) clearTimeout(this.queueHealthPoll);
    this.queueHealthPoll = null;
    if (!active || this.queueHealthDestroyed) return;
    this.queueHealthPoll = setTimeout(async () => {
      const status = await this.refreshQueueHealth();
      const resumable = (status?.counts.queued ?? 0) + (status?.counts.retryableErrors ?? 0);
      if (resumable > 0 && this.scheduledReanalysisJobIds.size === 0) {
        this.pendingReanalysisResumeStarted = false;
        await this.resumePendingReanalysisQueue();
      }
    }, 5000);
  }

  toggleQueueDetails(): void {
    this.queueDetailsOpen.update((open) => !open);
  }

  /** Reintenta sin recargar y sin crear otro batch; conserva los jobs ya completados. */
  async retryReanalysisQueue(): Promise<void> {
    if (this.queueRetrying()) return;
    this.queueRetrying.set(true);
    this.queueActionMessage.set(null);
    try {
      if (this.queueHealth() === 'failed') {
        const result = await this.edgeFunctions.retryDefensiveReanalysisQueue();
        this.queueActionMessage.set(
          result.retriedCount
            ? `${result.retriedCount} job${result.retriedCount === 1 ? '' : 's'} reencolado${result.retriedCount === 1 ? '' : 's'} en su batch original.`
            : 'No había jobs fallidos que reencolar.',
        );
      }
      this.pendingReanalysisResumeStarted = false;
      const status = await this.refreshQueueHealth();
      if (status && status.pendingCount > 0) await this.resumePendingReanalysisQueue();
    } catch (err) {
      const detail = errorMessage(err);
      this.queueHealth.set('unreachable');
      this.queueHealthError.set(detail);
      this.queueActionMessage.set(null);
    } finally {
      this.queueRetrying.set(false);
    }
  }

  formatQueueTimestamp(value: string | null): string {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('es-ES');
  }

  /** Recupera trabajo abandonado por otra pestaña/sesión, incluidos errores con intentos disponibles. */
  private async resumePendingReanalysisQueue(): Promise<void> {
    if (this.pendingReanalysisResumeStarted) return;
    this.pendingReanalysisResumeStarted = true;
    try {
      // Cada vuelta consume una página. Un error vuelve a aparecer hasta
      // agotar sus tres intentos; el límite evita un bucle ante datos rotos.
      for (let page = 0; page < 100; page++) {
        const pending = await this.edgeFunctions.pendingDefensiveReanalysisJobs(undefined, 100);
        if (!pending.jobs.length) {
          if (pending.blockedCount > 0) {
            this.reanalysisQueueWarning.set(
              `${pending.blockedCount} reanálisis defensivo agotó ${pending.maxAttempts} intentos y requiere revisión manual.`,
            );
          }
          return;
        }
        await this.runReanalysisQueue(
          'cola persistente recuperada',
          pending.jobs.map((job) => job.pullId),
          pending.jobs,
        );
      }
      this.reanalysisQueueWarning.set('La reanudación se detuvo tras 100 lotes; quedan jobs pendientes para la próxima sesión.');
    } catch (err) {
      console.error('No se pudo reanudar la cola persistente de reanálisis defensivo:', err);
      this.reanalysisQueueWarning.set(`No se pudo consultar/reanudar la cola persistente: ${errorMessage(err)}`);
    } finally {
      await this.refreshQueueHealth();
    }
  }

  private showQueueFallbackWarning(queueError: string | null | undefined): void {
    this.reanalysisQueueWarning.set(
      queueError
        ? `El cambio se guardó, pero la cola no pudo persistirse (${queueError}). El reanálisis continuará mientras esta pestaña siga abierta.`
        : null,
    );
    if (queueError) {
      this.queueHealth.set('unreachable');
      this.queueHealthError.set(queueError);
    }
  }

  /** Doble clic en 5s, mismo patrón que requestDeleteAssignment/discord-settings.component.ts. */
  requestResetClassDefensives(className: string): void {
    if (this.confirmingResetClassId() === className) {
      void this.confirmResetClassDefensives(className);
      return;
    }
    this.confirmingResetClassId.set(className);
    setTimeout(() => {
      if (this.confirmingResetClassId() === className) this.confirmingResetClassId.set(null);
    }, 5000);
  }

  private async confirmResetClassDefensives(className: string): Promise<void> {
    this.confirmingResetClassId.set(null);
    this.resettingClass.set(true);
    this.error.set(null);
    this.lastClassReset.set(null);
    try {
      const res = await this.edgeFunctions.resetClassDefensives(className);
      this.lastClassReset.set({ className, resetCount: res.resetCount });
      if (this.selectedClass() === className) await this.loadDefensives();
      this.showQueueFallbackWarning(res.reanalysisQueueError);
      if (res.pullIds.length) void this.runReanalysisQueue(`${classDisplayName(className)} (clase entera)`, res.pullIds, res.reanalysisJobs);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.resettingClass.set(false);
    }
  }

  // §"no puedo editar el campo de cd (poder editarlo para que sea en
  // segundos)" (feedback real, 2026-08-29): el input trabaja en segundos
  // (más natural, así es como lo da Wowhead — "3 min cooldown", "Lasts 20
  // sec"), la conversión a ms (unidad real de la columna) vive aquí, un
  // único sitio. Cadena vacía = "sin resolver" (null), no 0 — un cooldown de
  // 0 sería un dato falso, no "no lo sé".
  onCooldownSecondsInput(row: CooldownCatalogRow, raw: string): void {
    const trimmed = raw.trim();
    const seconds = trimmed === '' ? null : Number(trimmed);
    if (seconds != null && (!Number.isFinite(seconds) || seconds < 0)) return;
    void this.onEdit(row, { base_cooldown_ms: seconds == null ? null : Math.round(seconds * 1000) });
  }

  onDurationSecondsInput(row: CooldownCatalogRow, raw: string): void {
    const trimmed = raw.trim();
    const seconds = trimmed === '' ? null : Number(trimmed);
    if (seconds != null && (!Number.isFinite(seconds) || seconds < 0)) return;
    void this.onEdit(row, { base_duration_ms: seconds == null ? null : Math.round(seconds * 1000) });
  }

  /**
   * §"un tank de paladin me comentó que una habilidad la tenemos puesta
   * como suya pero ya no la tiene... poder seleccionar las specs con
   * toggles, igual que hacemos con los roles de mecánicas voluntarias"
   * (feedback real, 2026-08-31): specsForDefensive() da el estado EFECTIVO
   * (spec_override si existe, si no lo que ya implicaba `spec`) — los chips
   * se pintan contra esto, nunca contra `row.spec` directamente, para que
   * el toggle parta siempre de lo que se ve en pantalla ahora mismo.
   */
  specsForDefensive(row: CooldownCatalogRow): string[] {
    if (row.spec_override != null) return row.spec_override;
    if (row.spec == null) return specsForClass(row.class);
    return row.spec.split('/').map((s) => s.trim());
  }

  toggleDefensiveSpec(row: CooldownCatalogRow, spec: string): void {
    const current = this.specsForDefensive(row);
    const next = current.includes(spec) ? current.filter((s) => s !== spec) : [...current, spec];
    void this.onEdit(row, { spec_override: next });
  }

  /** Vuelve a lo que dice `spec` (extractor/IA) — deshace la corrección manual. */
  resetDefensiveSpecOverride(row: CooldownCatalogRow): void {
    void this.onEdit(row, { spec_override: null });
  }

  // §"el greater invisibility del mago ya no es un defensivo... no tengo
  // opción de quitarlo de ninguna manera" (feedback real, 2026-08-31):
  // excluir es más consecuente que un toggle cualquiera (deja de contar en
  // TODA la app — Preparación, defensive_pressure_windows futuros...) —
  // doble clic en 5s, mismo patrón que requestDeleteAssignment. Restaurar
  // no lleva confirmación: es la dirección "deshacer", nunca destructiva.
  confirmingExcludeSpellId = signal<number | null>(null);

  requestToggleExcluded(row: CooldownCatalogRow): void {
    if (row.excluded) {
      void this.onEdit(row, { excluded: false });
      return;
    }
    if (this.confirmingExcludeSpellId() === row.spell_id) {
      void this.onEdit(row, { excluded: true });
      this.confirmingExcludeSpellId.set(null);
      return;
    }
    this.confirmingExcludeSpellId.set(row.spell_id);
    setTimeout(() => {
      if (this.confirmingExcludeSpellId() === row.spell_id) this.confirmingExcludeSpellId.set(null);
    }, 5000);
  }

  /** §sugerencia de la IA (stillDefensive:false) — nunca se aplica sola, este es el único sitio que de verdad escribe `excluded`. confirmedSuggestions solo es UI local (qué botón ya se pulsó en esta sesión), la fuente de verdad sigue siendo cooldown_catalog.excluded. */
  confirmedSuggestions = signal<Set<number>>(new Set());

  async confirmSuggestedExclusion(s: { spellId: number; name: string; class: string; notes: string }): Promise<void> {
    if (!s.class || this.confirmedSuggestions().has(s.spellId)) return;
    this.savingSpellId.set(s.spellId);
    this.error.set(null);
    try {
      const res = await this.edgeFunctions.saveDefensiveEdit({ class: s.class, spellId: s.spellId, excluded: true, reviewed: true });
      this.confirmedSuggestions.update((set) => new Set(set).add(s.spellId));
      if (this.selectedClass() === s.class) this.defensives.update((list) => list.map((d) => (d.spell_id === s.spellId ? { ...d, excluded: true, reviewed: true } : d)));
      this.showQueueFallbackWarning(res.reanalysisQueueError);
      if (res.pullIds?.length) void this.runReanalysisQueue(s.name, res.pullIds, res.reanalysisJobs);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.savingSpellId.set(null);
    }
  }

  specsForClassOf(row: CooldownCatalogRow): string[] {
    return specsForClass(row.class);
  }

  /** Confirma tal cual la sugerencia IA (inferred_survival_type) — mismo botón que confirmInferredCategory en manifest.component.ts. */
  confirmInferredSurvivalType(row: CooldownCatalogRow): void {
    if (!row.inferred_survival_type) return;
    void this.onEdit(row, { survival_type: row.inferred_survival_type });
  }

  /** scope: nombre de una clase concreta; el prompt global se rechaza para evitar respuestas truncadas. */
  async openClassifyPanel(scope: string | 'all'): Promise<void> {
    this.classifyPanelOpen.set(true);
    this.classifyResult.set(null);
    if (this.classifySystemPrompt() != null && this.classifyScope() === scope) return; // ya traído para este alcance, no repetir la llamada
    this.classifyScope.set(scope);
    this.loadingClassifyPrompt.set(true);
    this.classifyPromptError.set(null);
    try {
      const res = await this.edgeFunctions.getDefensiveClassificationPrompt(scope === 'all' ? null : scope);
      this.classifySystemPrompt.set(res.systemPrompt);
      this.classifyUserMessage.set(res.userMessage);
      this.classifyDefensiveCount.set(res.defensiveCount);
      this.classifyPromptVersion.set(res.promptVersion);
      this.classifyGameBuild.set(res.gameBuild);
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
    this.classifyGameBuild.set(null);
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
    const scope = this.classifyScope();
    if (!scope || !this.classifyPasteText().trim()) return;
    this.classifySubmitting.set(true);
    this.classifySubmitError.set(null);
    try {
      const res = await this.edgeFunctions.submitDefensiveClassification(
        scope === 'all' ? null : scope,
        this.classifyPasteText(),
        this.classifyGameBuild(),
      );
      this.classifyPasteText.set('');
      // Mismo orden que manifest.component.ts (bug real ya resuelto ahí):
      // se espera a tener la tabla fresca antes de anunciar éxito, para que
      // el desplegable ya muestre el valor nuevo cuando aparece el banner.
      // Nota: en scope 'all' esto solo refresca la clase visible ahora
      // mismo — el resto se recarga solas al cambiar de pestaña (selectClass
      // siempre vuelve a pedir la lista, nunca sirve caché).
      await this.loadDefensives();
      // La clasificación IA modifica los mismos campos materiales que la
      // edición manual; por tanto usa exactamente la misma cola secuencial
      // de reanálisis antes de dar la operación por terminada.
      this.showQueueFallbackWarning(res.reanalysisQueueError);
      if (res.pullIds.length) {
        await this.runReanalysisQueue(
          scope === 'all' ? 'clasificación IA (catálogo completo)' : `clasificación IA (${classDisplayName(scope)})`,
          res.pullIds,
          res.reanalysisJobs,
        );
      }
      this.classifyResult.set({
        applied: res.applied,
        skippedLowConfidence: res.skippedLowConfidence,
        skippedUndetermined: res.skippedUndetermined,
        suggestedExclusions: res.suggestedExclusions,
        invalid: res.invalid,
      });
    } catch (err) {
      this.classifySubmitError.set(errorMessage(err));
    } finally {
      this.classifySubmitting.set(false);
    }
  }
}
