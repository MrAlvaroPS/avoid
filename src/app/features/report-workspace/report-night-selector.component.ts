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
//
// §PR5 del plan (Entrega 5 del spec: "conservación de contexto entre
// noches"): elegir una noche desde aquí es el ÚNICO punto de la app
// alcanzable desde las tres vistas preservables (Raid/Informe/Dosier) a la
// vez — RaidLandingComponent/HistoryComponent/RaidSessionComponent.onImport
// siguen aterrizando siempre en Raid sin cambios, porque ninguno de ellos se
// abre nunca DESDE un Dosier. Por eso toda la lógica de preservación vive
// aquí y en ningún otro sitio.
import { Component, computed, inject, output, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { ReportsService } from '../../core/reports.service';
import { ReportParticipantsService } from '../../core/report-participants.service';
import { extractReportCode } from '../../shared/wcl-code.util';
import { errorMessage } from '../../shared/error-message.util';
import {
  filterReportItems,
  groupReportsByMonth,
  type ReportHistoryItem,
} from './report-history-grouping.util';
import {
  resolveCurrentPreservedView,
  resolveReportSwitchTarget,
} from './report-switch-navigation.util';

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
  private participantsService = inject(ReportParticipantsService);
  private edgeFunctions = inject(EdgeFunctionsService);
  private router = inject(Router);
  // El ActivatedRoute inyectado aquí es el de ReportWorkspaceComponent
  // (report/:reportCode) — este selector vive dentro de su template igual
  // que ReportSidebarComponent (PR3), así que .firstChild es la misma ruta
  // hija activa (raid | '' | player/:playerName) que ya usa activePlayerName.
  private route = inject(ActivatedRoute);

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

  /**
   * Clic normal (botón izquierdo, sin modificadores) intercepta la
   * navegación nativa del enlace para poder resolver el destino REAL
   * (preservando Dosier si aplica) antes de navegar — un Ctrl/Cmd/clic
   * central se deja pasar tal cual (abre en pestaña nueva el href estático
   * del enlace, que siempre apunta a Raid; no vale la pena replicar aquí la
   * preservación solo para ese caso minoritario).
   */
  onRowClick(event: MouseEvent, code: string): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    void this.goToReport(code);
  }

  /** Incrementado en cada intento de cambio — un clic más reciente siempre gana sobre uno anterior que todavía está resolviendo participantes (§PR5: "avoid navigation races when the new report is still loading"). */
  private switchToken = 0;

  private async goToReport(code: string): Promise<void> {
    const token = ++this.switchToken;
    const currentView = resolveCurrentPreservedView(this.currentViewSnapshot());

    let targetParticipantNames = new Set<string>();
    if (currentView?.kind === 'dossier') {
      try {
        const participants = await this.participantsService.list(code);
        targetParticipantNames = new Set(participants.map((p) => p.name));
      } catch {
        // Si falla la consulta, se degrada a "no encontrado" — cae a Raid con
        // el aviso, igual que si el jugador de verdad no estuviera. Nunca
        // bloquea el cambio de noche por esto.
      }
    }
    if (token !== this.switchToken) return; // un clic posterior ya está resolviendo o resolvió — este ya no manda

    const target = resolveReportSwitchTarget(code, currentView, targetParticipantNames);
    void this.router.navigate(
      target.commands,
      target.playerMissingName
        ? { queryParams: { playerMissing: target.playerMissingName } }
        : undefined,
    );
    this.closed.emit();
  }

  /** §mismo cuidado que ReportSidebarComponent.currentPlayerName: .snapshot
   * de un hijo activo puede tardar en comprometerse — nunca se asume. */
  private currentViewSnapshot(): { path: string | null; playerName: string | null } | null {
    const child = this.route.firstChild;
    if (!child?.snapshot) return null;
    return {
      path: child.snapshot.routeConfig?.path ?? null,
      playerName: child.snapshot.paramMap.get('playerName'),
    };
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
      // los dos casos aplica"). Pasa por el mismo goToReport que las filas de
      // la lista — importar desde un Dosier también intenta preservarlo
      // (poco probable que un report recién importado tenga al mismo
      // jugador, pero la regla no distingue el origen del cambio).
      await this.goToReport(code);
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
