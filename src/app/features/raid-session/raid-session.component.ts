// Colocar en: src/app/features/raid-session/raid-session.component.ts
// La pantalla única (§1, §15): pegas el report, eliges el pull, ves la vista
// Live Pull. Un botón "Importar"/"Actualizar" cubre tanto un log histórico
// cerrado como uno en vivo — analyze-report se comporta igual en los dos
// casos (§10/§11), así que no hace falta un flujo separado para "en vivo".
//
// Persistencia (§11 exige que "en vivo" sobreviva a navegar por la app):
// el código del report activo se guarda en localStorage, así que ir a
// Ajustes y volver a Raid no obliga a pegar la URL otra vez. session_state
// (tabla en Supabase) queda reservada para cuando el propio backend necesite
// saber qué report vigilar (un poller server-side, Fase D) — esto de aquí es
// puramente "qué estaba mirando este navegador", un problema distinto.
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { ReportsService, type PullListItem } from '../../core/reports.service';
import { extractReportCode } from '../../shared/wcl-code.util';
import { formatDuration, formatPct } from '../../shared/format.util';
import { LivePullComponent } from '../live-pull/live-pull.component';

export interface PullGroup {
  key: string;
  bossName: string;
  difficulty: string;
  pulls: PullListItem[];
  attemptCount: number;
  killCount: number;
  bestWipePct: number | null;
}

const STORAGE_KEY = 'avoid.currentReportCode';
const AUTO_REFRESH_MS = 25_000; // dentro del rango 20-30s que recomienda §11

function readStoredReportCode(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // navegación privada / storage bloqueado: se degrada a "sin persistencia", no rompe nada
  }
}

function writeStoredReportCode(code: string | null): void {
  try {
    if (code) localStorage.setItem(STORAGE_KEY, code);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // idem — si no se puede persistir, la sesión sigue funcionando en memoria
  }
}

@Component({
  selector: 'app-raid-session',
  standalone: true,
  imports: [LivePullComponent],
  templateUrl: './raid-session.component.html',
  styleUrl: './raid-session.component.scss',
})
export class RaidSessionComponent {
  private edgeFunctions = inject(EdgeFunctionsService);
  private reportsService = inject(ReportsService);
  private destroyRef = inject(DestroyRef);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  reportCodeInput = signal('');
  importing = signal(false);
  importProgress = signal<string | null>(null);
  error = signal<string | null>(null);

  currentReportCode = signal<string | null>(null);
  pulls = signal<PullListItem[]>([]);
  selectedPullId = signal<string | null>(null);
  autoRefresh = signal(false);
  lastCheckedAt = signal<string | null>(null);

  hasPulls = computed(() => this.pulls().length > 0);
  hasReportLoaded = computed(() => this.currentReportCode() !== null);

  // §"lo que ocupan las primeras líneas con los bosses, toda la pantalla —
  // no es sostenible": con 4+ bosses cada uno con sus intentos, la tira
  // agrupada por sí sola ya llenaba el viewport. Solo el grupo del boss
  // seleccionado se enseña expandido por defecto; el resto colapsa a una
  // fila compacta — un clic la vuelve a abrir (manualExpanded gana sobre el
  // "expandido por defecto" tanto para abrir como para cerrar a mano).
  manualExpanded = signal<Set<string>>(new Set());

  isGroupExpanded(group: PullGroup): boolean {
    if (this.manualExpanded().has(group.key)) return true;
    if (this.manualExpanded().has('!' + group.key)) return false; // cerrado a mano
    return group.pulls.some((p) => p.id === this.selectedPullId());
  }

  toggleGroup(group: PullGroup): void {
    const expanded = this.isGroupExpanded(group);
    this.manualExpanded.update((set) => {
      const next = new Set(set);
      next.delete(group.key);
      next.delete('!' + group.key);
      next.add(expanded ? '!' + group.key : group.key);
      return next;
    });
  }

  // §"agrupar los pulls de un boss": una tira plana con TODOS los pulls de
  // TODOS los bosses mezclados no da con qué comparar de un vistazo (para
  // eso ya sirve la comparación "vs anterior" que hace pull-analysis.service
  // por boss+dificultad — el problema real es que la tira no lo enseñaba
  // agrupado). orden = primera aparición de cada boss+dificultad (Map
  // preserva orden de inserción), pulls dentro del grupo en su orden real.
  pullGroups = computed<PullGroup[]>(() => {
    const groups = new Map<string, PullGroup>();
    for (const pull of this.pulls()) {
      const key = `${pull.boss_id}|${pull.difficulty}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, bossName: pull.bossName, difficulty: pull.difficulty, pulls: [], attemptCount: 0, killCount: 0, bestWipePct: null };
        groups.set(key, group);
      }
      group.pulls.push(pull);
      group.attemptCount++;
      if (pull.kill) group.killCount++;
      const pct = pull.wipe_pct ?? 100;
      if (group.bestWipePct == null || pct < group.bestWipePct) group.bestWipePct = pct;
    }
    return [...groups.values()];
  });

  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Prioridad: ?report= (venir del Histórico, un report que puede que
    // todavía no tenga pulls clasificados) > localStorage (volver de Ajustes
    // en medio de la misma sesión, ya con pulls seguro).
    const fromQueryParam = this.route.snapshot.queryParamMap.get('report');
    const code = fromQueryParam ?? readStoredReportCode();
    if (code) {
      this.reportCodeInput.set(code);
      void this.loadExisting(code, /* analyzeIfEmpty */ !!fromQueryParam);
    }
    if (fromQueryParam) {
      // Limpia el query param de la URL tras consumirlo — así un refresh no
      // vuelve a forzar la ruta "vino del histórico" innecesariamente.
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    }
    this.destroyRef.onDestroy(() => this.stopAutoRefresh());
  }

  /** Recarga desde Supabase lo que ya hay guardado, sin llamar a WCL — instantáneo al volver de otra pantalla. */
  private async loadExisting(code: string, analyzeIfEmpty = false): Promise<void> {
    try {
      const pulls = await this.reportsService.listPulls(code);
      if (!pulls.length) {
        // Venimos del Histórico (sync-reports solo trae metadata, nunca
        // pulls) o el código guardado ya no tiene datos — en ambos casos,
        // analizarlo de verdad es lo que el usuario espera al abrirlo.
        if (analyzeIfEmpty) await this.runAnalyze(code, true);
        return;
      }
      this.currentReportCode.set(code);
      this.pulls.set(pulls);
      this.selectedPullId.set(pulls.at(-1)?.id ?? null);
    } catch {
      // si falla (ej. Supabase no disponible un instante), no bloquea: el usuario puede pulsar Importar
    }
  }

  async onImport(): Promise<void> {
    const code = extractReportCode(this.reportCodeInput());
    if (!code) return;
    await this.runAnalyze(code, true);
  }

  private async runAnalyze(code: string, isManual: boolean): Promise<void> {
    if (isManual) {
      this.importing.set(true);
      this.error.set(null);
      this.importProgress.set('Consultando WCL…');
    }
    try {
      let processedTotal = 0;
      const newestPullId = await this.edgeFunctions.analyzeReportFully(code, (r) => {
        processedTotal += r.processed;
        if (isManual) {
          this.importProgress.set(
            r.remaining > 0 ? `Procesados ${processedTotal} pulls, quedan ${r.remaining}…` : `Procesados ${processedTotal} pulls.`,
          );
        }
      });
      this.currentReportCode.set(code);
      writeStoredReportCode(code);
      this.lastCheckedAt.set(new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }));
      const pulls = await this.reportsService.listPulls(code);
      this.pulls.set(pulls);
      // Solo saltamos al pull recién procesado si de verdad hay uno nuevo — un
      // ciclo de auto-refresh sin novedades no debe robarte la selección actual.
      if (newestPullId) this.selectedPullId.set(newestPullId);
      else if (!this.selectedPullId()) this.selectedPullId.set(pulls.at(-1)?.id ?? null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (isManual) {
        this.importing.set(false);
        this.importProgress.set(null);
      }
    }
  }

  toggleAutoRefresh(): void {
    this.autoRefresh.update((v) => !v);
    if (this.autoRefresh()) this.startAutoRefresh();
    else this.stopAutoRefresh();
  }

  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.autoRefreshTimer = setInterval(() => {
      const code = this.currentReportCode();
      if (code && !this.importing()) void this.runAnalyze(code, false);
    }, AUTO_REFRESH_MS);
  }

  private stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  selectPull(pull: PullListItem): void {
    this.selectedPullId.set(pull.id);
  }

  pullLabel(pull: PullListItem): string {
    return `#${pull.pull_number}`;
  }

  pullSubLabel(pull: PullListItem): string {
    return pull.kill ? `Kill · ${formatDuration(pull.duration_ms)}` : `Wipe ${formatPct(pull.wipe_pct)} · ${formatDuration(pull.duration_ms)}`;
  }

  groupSummary(group: PullGroup): string {
    const attempts = `${group.attemptCount} intento${group.attemptCount === 1 ? '' : 's'}`;
    if (group.killCount > 0) return `${attempts} · ${group.killCount} kill${group.killCount === 1 ? '' : 's'}`;
    return `${attempts} · mejor ${formatPct(group.bestWipePct)}`;
  }
}
