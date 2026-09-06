// Colocar en: src/app/features/raid-landing/raid-landing.component.ts
// PR2 del plan IRIS (Report Workspace): '/' deja de ser una segunda forma de
// ver Raid — raidLandingRedirectGuard ya redirige a report/:reportCode/raid
// en cuanto hay una noche activa (query param o persistida), así que este
// componente SOLO se monta cuando de verdad no hay ninguna: es la landing
// "elige o importa un report" sin nada de picker/live-refresh/night-summary.
// Lógica de importación/recientes calcada de RaidSessionComponent.onImport
// /runAnalyze — la diferencia es el destino: en vez de cargar pulls en sitio,
// navega al workspace, que es quien de verdad los carga.
import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { ReportsService } from '../../core/reports.service';
import type { ReportRow } from '../../shared/models/domain';
import { extractReportCode } from '../../shared/wcl-code.util';
import { errorMessage } from '../../shared/error-message.util';

const RECENT_REPORTS_LIMIT = 10;

@Component({
  selector: 'app-raid-landing',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './raid-landing.component.html',
  styleUrl: './raid-landing.component.scss',
})
export class RaidLandingComponent {
  private edgeFunctions = inject(EdgeFunctionsService);
  private reportsService = inject(ReportsService);
  private router = inject(Router);

  reportCodeInput = signal('');
  importing = signal(false);
  importProgress = signal<string | null>(null);
  error = signal<string | null>(null);
  // §"la noche duplicada... dos personas subieron el mismo log" (bug real,
  // arreglado a mano el 2026-08-23): mismo aviso que RaidSessionComponent,
  // sigue siendo relevante en el punto de importar.
  duplicateWarning = signal<string | null>(null);

  recentReports = signal<{ report: ReportRow; bossesAttempted: string[] }[]>([]);

  constructor() {
    this.reportsService
      .listAllReports()
      .then((rows) => this.recentReports.set(rows.slice(0, RECENT_REPORTS_LIMIT)))
      .catch(() => {}); // best-effort, no bloquea el resto de la pantalla
  }

  reportDateLabel(startTime: number): string {
    return new Date(startTime).toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  async onImport(): Promise<void> {
    const code = extractReportCode(this.reportCodeInput());
    if (!code) return;
    this.importing.set(true);
    this.error.set(null);
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
      // El workspace (ReportWorkspaceService) y RaidSessionComponent son
      // quienes de verdad cargan pulls/metadata al llegar — este componente
      // nunca tuvo un report "activo" propio que mantener.
      void this.router.navigate(['/report', code, 'raid']);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.importing.set(false);
      this.importProgress.set(null);
    }
  }
}
