// Colocar en: src/app/features/report-workspace/report-workspace.component.ts
// PR2 del plan IRIS (Report Workspace): el shell persistente alrededor de
// las pantallas que comparten reportCode — Raid, Informe, Dosier (§36 del
// spec). Provee ReportWorkspaceService a nivel de componente (no
// providedIn:'root', ver report-workspace.service.ts) — una instancia por
// entrada a report/:reportCode/*, reutilizada entre las tres vistas del
// MISMO reportCode, destruida al salir del árbol de rutas.
import { Component, effect, inject, input } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ReportWorkspaceService } from '../../core/report-workspace.service';
import { ReportSidebarComponent } from './report-sidebar.component';

@Component({
  selector: 'app-report-workspace',
  standalone: true,
  imports: [RouterOutlet, ReportSidebarComponent],
  providers: [ReportWorkspaceService],
  templateUrl: './report-workspace.component.html',
  styleUrl: './report-workspace.component.scss',
})
export class ReportWorkspaceComponent {
  reportCode = input.required<string>();

  protected workspace = inject(ReportWorkspaceService);

  constructor() {
    // §bug real ya visto en varios sitios: leer un input() de ruta dentro
    // del constructor revienta con NG0950 — Angular lo asigna DESPUÉS de
    // construir (mismo patrón que night-report.component.ts). Cambiar de
    // reportCode mientras el shell sigue montado (misma ruta, otro param) lo
    // reabre limpio: ReportWorkspaceService.open() ya es race-safe (PR1).
    effect(() => {
      const code = this.reportCode();
      void this.workspace.open(code);
    });
  }
}
