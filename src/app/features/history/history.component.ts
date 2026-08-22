// Colocar en: src/app/features/history/history.component.ts
// §16 de la hoja de ruta: "history/ -- navegador de raids/pulls pasados".
// También es la única superficie de UI para sync-reports (§4/§5) — la
// función ya existía desplegada pero sin ningún botón que la invocara.
import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { ReportsService } from '../../core/reports.service';
import type { ReportRow } from '../../shared/models/domain';

@Component({
  selector: 'app-history',
  standalone: true,
  templateUrl: './history.component.html',
  styleUrl: './history.component.scss',
})
export class HistoryComponent {
  private reportsService = inject(ReportsService);
  private edgeFunctions = inject(EdgeFunctionsService);
  private router = inject(Router);

  reports = signal<{ report: ReportRow; bossesAttempted: string[] }[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  // Prellenado con lo que ya sabemos de la guild — sigue siendo editable por
  // si algún día hace falta otra guild/servidor.
  guildName = signal('Avoid');
  serverSlug = signal('sanguino');
  serverRegion = signal('eu');
  syncing = signal(false);
  syncSummary = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.reports.set(await this.reportsService.listAllReports());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  async onSync(): Promise<void> {
    this.syncing.set(true);
    this.error.set(null);
    this.syncSummary.set(null);
    try {
      const result = await this.edgeFunctions.syncReports({
        guildName: this.guildName().trim(),
        serverSlug: this.serverSlug().trim(),
        serverRegion: this.serverRegion().trim(),
      });
      this.syncSummary.set(
        `${result.reportsUpserted} reports de raid sincronizados (${result.skippedNonRaid} descartados por no ser de raid)` +
          (result.remaining > 0 ? ` — quedan ${result.remaining} más, pulsa Sincronizar otra vez para seguir.` : '.'),
      );
      await this.load();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.syncing.set(false);
    }
  }

  open(code: string): void {
    void this.router.navigate(['/'], { queryParams: { report: code } });
  }

  formatDate(startTimeMs: number): string {
    return new Date(startTimeMs).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
  }
}
