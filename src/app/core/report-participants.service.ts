// Colocar en: src/app/core/report-participants.service.ts
// §33/§35 del plan IRIS (Report Workspace): representación ligera de "quién
// participó realmente en esta noche", para el sidebar/navegador de
// jugadores — nunca carga boss analysis/deaths/mechanics/wipe calls/
// defensive metrics/scores (eso sigue siendo trabajo de NightReportService/
// NightPlayerSummaryService, sin tocar). El rol/clase ya vienen resueltos
// por ReportsService.listNightPlayers (evidencia de ESTA noche) — este
// servicio NUNCA vuelve a llamar roleFromSpec, solo rellena con
// wowaudit_roster lo que la noche no pudo resolver por sí sola (Sin
// roster/spec desconocida) y aporta rank/avatar, que la noche no tiene.
import { Injectable, inject } from '@angular/core';
import { ReportsService } from './reports.service';
import { WowauditRosterService } from './wowaudit-roster.service';
import type { RaidRole } from '../shared/role-icon.component';

export interface ReportParticipant {
  name: string;
  className: string | null;
  spec: string | null;
  role: RaidRole;
  /** null = no está en wowaudit_roster (§19: badge "Sin roster" en el sidebar, nunca se oculta). */
  rank: 'Main' | 'Trial' | null;
  avatarUrl: string | null;
}

@Injectable({ providedIn: 'root' })
export class ReportParticipantsService {
  private reportsService = inject(ReportsService);
  private wowauditRoster = inject(WowauditRosterService);

  async list(reportCode: string): Promise<ReportParticipant[]> {
    const [observed, roster] = await Promise.all([
      this.reportsService.listNightPlayers(reportCode),
      this.wowauditRoster.listRoster(),
    ]);
    const rosterByName = new Map(roster.map((entry) => [entry.name, entry]));

    return observed
      .map((o): ReportParticipant => {
        const entry = rosterByName.get(o.name);
        return {
          name: o.name,
          // El roster nunca pisa una clase observada válida — solo rellena el hueco.
          className: o.className ?? entry?.class ?? null,
          spec: o.spec,
          // El rol de ESTA noche manda; wowaudit (que puede llevar el rol
          // corregido por la spec observada más reciente A NIVEL GLOBAL, no
          // de esta noche concreta) es solo el fallback.
          role: o.role ?? entry?.role ?? null,
          rank: entry?.rank ?? null,
          avatarUrl: entry?.avatarUrl ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }
}
