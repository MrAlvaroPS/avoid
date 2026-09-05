// Colocar en: src/app/core/report-workspace.service.ts
// §30/§31 del plan IRIS (Report Workspace): estado compartido de "qué noche
// estoy viendo" para el sidebar y las pantallas que cuelgan de
// report/:reportCode. Deliberadamente ligero — NO calcula métricas
// defensivas, no analiza mecánicas, no genera dossiers/infografías (eso
// sigue siendo NightReportService/NightPlayerSummaryService, sin tocar).
//
// Sin `providedIn: 'root'` a propósito: es estado con ciclo de vida propio
// (el de una noche abierta), no un singleton de toda la app — el futuro
// ReportWorkspaceComponent lo instancia en sus `providers`, así que salir de
// report/:reportCode/* lo destruye y una nueva entrada arranca en limpio.
// Tampoco toca localStorage: dentro del workspace la URL es la fuente de
// verdad de qué report está activo (§45 del plan) — la persistencia de
// RaidSessionComponent es un problema aparte (su seguimiento en vivo), sin
// tocar en esta PR.
import { Injectable, inject, signal } from '@angular/core';
import { ReportsService } from './reports.service';
import { ReportParticipantsService, type ReportParticipant } from './report-participants.service';
import type { ReportRow } from '../shared/models/domain';
import { errorMessage } from '../shared/error-message.util';

@Injectable()
export class ReportWorkspaceService {
  private reportsService = inject(ReportsService);
  private participantsService = inject(ReportParticipantsService);

  readonly reportCode = signal<string | null>(null);
  readonly report = signal<ReportRow | null>(null);
  readonly participants = signal<ReportParticipant[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** Incrementado en cada open() — una respuesta tardía de una llamada ya
   * superada por otra más reciente (change de report casi simultáneo) nunca
   * debe pisar el estado de la llamada vigente, ni en éxito ni en error. */
  private requestToken = 0;

  async open(code: string): Promise<void> {
    const token = ++this.requestToken;
    this.loading.set(true);
    this.error.set(null);
    this.reportCode.set(code);
    // Limpia YA, antes de esperar la respuesta — así ningún dato del report
    // ANTERIOR queda visible bajo la etiqueta del nuevo mientras carga, ni
    // si la carga del nuevo termina en error.
    this.report.set(null);
    this.participants.set([]);
    try {
      const [report, participants] = await Promise.all([
        this.reportsService.getReport(code),
        this.participantsService.list(code),
      ]);
      if (token !== this.requestToken) return; // superado por un open() posterior mientras esperábamos
      if (!report) {
        // getReport() === null (código de report que no existe) es un fallo
        // de carga, no un "éxito" con report vacío — mismo mensaje de estado
        // de error que el spec (§44) pide para "no se pudo cargar esta noche".
        this.error.set('No se pudo cargar esta noche.');
        return;
      }
      this.report.set(report);
      this.participants.set(participants);
    } catch (err) {
      if (token !== this.requestToken) return;
      this.error.set(errorMessage(err));
    } finally {
      if (token === this.requestToken) this.loading.set(false);
    }
  }
}
