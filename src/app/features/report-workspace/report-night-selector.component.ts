// Colocar en: src/app/features/report-workspace/report-night-selector.component.ts
// PR4 del plan IRIS (Report Workspace): "modo de selección" temporal del
// sidebar (§8 del spec) — reemplaza la cabecera de noche + Vistas +
// Jugadores mientras está abierto (ReportSidebarComponent lo monta/desmonta
// con un @if). Responsabilidad única: CUÁNDO — elegir o importar otra
// noche. Nunca decide QUIÉN ni QUÉ (eso sigue siendo el resto del sidebar).
//
// Estado deliberadamente local a este componente, no en ReportWorkspaceService
// (§30 del plan: ese servicio es "qué noche activa", no "qué noches hay para
// elegir") — ni un selectedReport paralelo en ningún sitio: el router sigue
// siendo la única fuente de verdad de qué noche está abierta (al elegir una,
// se navega; este componente no "recuerda" nada tras cerrarse).
import { Component, computed, inject, output, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { ReportsService } from '../../core/reports.service';
import { extractReportCode } from '../../shared/wcl-code.util';
import { errorMessage } from '../../shared/error-message.util';
import {
  filterReportItems,
  groupReportsByMonth,
  type ReportHistoryItem,
} from './report-history-grouping.util';

const RECENT_LIMIT = 8;

@Component({
  selector: 'app-report-night-selector',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './report-night-selector.component.html',
  styleUrl: './report-night-selector.component.scss',
})
export class ReportNightSelectorComponent {
  private reportsService = inject(ReportsService);
  private edgeFunctions = inject(EdgeFunctionsService);
  private router = inject(Router);

  /** Pide a ReportSidebarComponent volver al modo normal — este componente nunca decide solo cuándo cerrarse tras seleccionar/importar, siempre a través de este output. */
  closed = output<void>();

  protected search = signal('');
  protected showAll = signal(false);

  protected recentReports = signal<ReportHistoryItem[]>([]);
  protected recentLoading = signal(true);
  protected recentError = signal<string | null>(null);

  // "Ver todas" (o buscar, que necesita el catálogo completo para ser útil —
  // spec §12) carga listAllReports() UNA vez y la cachea aquí; "Recientes"
  // nunca la necesita (usa listRecentReports, más barato — spec §PR4).
  protected allReports = signal<ReportHistoryItem[] | null>(null);
  protected allReportsLoading = signal(false);
  protected allReportsError = signal<string | null>(null);

  protected showImportForm = signal(false);
  protected importInput = signal('');
  protected importing = signal(false);
  protected importError = signal<string | null>(null);
  protected importProgress = signal<string | null>(null);
  protected duplicateWarning = signal<string | null>(null);

  /** §12: buscar exige el catálogo completo (fecha/título/código de CUALQUIER noche, no solo las últimas 8); "Ver todas" también. */
  protected needsFullList = computed(() => this.showAll() || this.search().trim().length > 0);

  protected flatResults = computed<ReportHistoryItem[]>(() => {
    const source = this.needsFullList() ? (this.allReports() ?? []) : this.recentReports();
    return filterReportItems(source, this.search());
  });

  /** §11: agrupado por mes SOLO en "ver todas" sin búsqueda — una búsqueda activa enseña resultados planos (mismo criterio que el mockup del spec §12), y "Recientes" siempre es plano. */
  protected monthGroups = computed(() =>
    this.showAll() && !this.search().trim() ? groupReportsByMonth(this.flatResults()) : null,
  );

  constructor() {
    void this.loadRecent();
  }

  private async loadRecent(): Promise<void> {
    this.recentLoading.set(true);
    this.recentError.set(null);
    try {
      this.recentReports.set(await this.reportsService.listRecentReports(RECENT_LIMIT));
    } catch (err) {
      this.recentError.set(errorMessage(err));
    } finally {
      this.recentLoading.set(false);
    }
  }

  private async loadAllOnce(): Promise<void> {
    if (this.allReports() !== null || this.allReportsLoading()) return;
    this.allReportsLoading.set(true);
    this.allReportsError.set(null);
    try {
      this.allReports.set(await this.reportsService.listAllReports());
    } catch (err) {
      this.allReportsError.set(errorMessage(err));
    } finally {
      this.allReportsLoading.set(false);
    }
  }

  toggleShowAll(): void {
    this.showAll.set(true);
    void this.loadAllOnce();
  }

  onSearchInput(value: string): void {
    this.search.set(value);
    if (value.trim()) void this.loadAllOnce();
  }

  async onImport(): Promise<void> {
    const code = extractReportCode(this.importInput());
    if (!code) return;
    this.importing.set(true);
    this.importError.set(null);
    this.importProgress.set('Consultando WCL…');
    try {
      let processedTotal = 0;
      await this.edgeFunctions.analyzeReportFully(code, (r) => {
        processedTotal += r.processed;
        this.importProgress.set(
          r.remaining > 0
            ? `Procesados ${processedTotal} pulls, quedan ${r.remaining}…`
            : `Procesados ${processedTotal} pulls.`,
        );
        this.duplicateWarning.set(r.possibleDuplicateOf);
      });
      // Ya existía o se acaba de importar — el destino da igual, ambos casos
      // terminan igual (§13: "el usuario no debería necesitar saber cuál de
      // los dos casos aplica"). A diferencia de las filas de la lista (enlaces
      // reales), aquí no hay un href previo que pulsar — la navegación es
      // consecuencia de una acción async, así que sí es imperativa.
      void this.router.navigate(['/report', code, 'raid']);
      this.closed.emit();
    } catch (err) {
      this.importError.set(errorMessage(err));
    } finally {
      this.importing.set(false);
      this.importProgress.set(null);
    }
  }

  reportDateLabel(startTime: number): string {
    return new Date(startTime).toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
}
