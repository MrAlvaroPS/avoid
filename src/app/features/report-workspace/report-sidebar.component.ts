// Colocar en: src/app/features/report-workspace/report-sidebar.component.ts
// PR2 del plan IRIS (Report Workspace) — alcance de la Entrega 2 del spec:
// SOLO cabecera de la noche + selector Raid/Informe. Sin lista de
// jugadores (PR3), sin selector de noches (PR4) todavía — §14/§41: el
// sidebar es navegación, nunca un dashboard (nada de score/muertes/%
// defensivo/mecánicas aquí).
import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ReportWorkspaceService } from '../../core/report-workspace.service';

@Component({
  selector: 'app-report-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './report-sidebar.component.html',
  styleUrl: './report-sidebar.component.scss',
})
export class ReportSidebarComponent {
  // Mismo ReportWorkspaceService que provee el ReportWorkspaceComponent
  // padre (component-scoped, ver report-workspace.service.ts) — este
  // sidebar nunca abre su propio report, solo lee el que ya está activo.
  protected workspace = inject(ReportWorkspaceService);

  reportDateLabel(startTime: number): string {
    return new Date(startTime).toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }
}
