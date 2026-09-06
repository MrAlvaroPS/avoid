// Colocar en: src/app/features/report-workspace/report-sidebar.component.ts
// PR2 del plan IRIS (Report Workspace): cabecera de la noche + selector
// Raid/Informe. PR3 añade el navegador de jugadores (Role → Class → Player,
// búsqueda local, jugador activo derivado de la ruta) — §14/§41: el sidebar
// es navegación, nunca un dashboard (nada de score/muertes/% defensivo/
// mecánicas aquí).
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
} from '@angular/router';
import { filter, map } from 'rxjs';
import { ReportWorkspaceService } from '../../core/report-workspace.service';
import { ClassIconComponent } from '../../shared/class-icon.component';
import {
  filterParticipantGroups,
  groupParticipantsForSidebar,
} from './report-participant-grouping.util';

@Component({
  selector: 'app-report-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, ClassIconComponent],
  templateUrl: './report-sidebar.component.html',
  styleUrl: './report-sidebar.component.scss',
})
export class ReportSidebarComponent {
  // Mismo ReportWorkspaceService que provee el ReportWorkspaceComponent
  // padre (component-scoped, ver report-workspace.service.ts) — este
  // sidebar nunca abre su propio report, solo lee el que ya está activo.
  protected workspace = inject(ReportWorkspaceService);

  private router = inject(Router);
  // El ActivatedRoute que llega aquí por inyección es el de
  // ReportWorkspaceComponent (report/:reportCode) — este sidebar no es un
  // componente enrutado, hereda el injector de su padre. `.firstChild` es la
  // ruta hija ACTIVA (raid | '' | player/:playerName) sea cual sea el
  // router-outlet que la pinte, así que sirve para derivar "qué jugador está
  // abierto" sin guardar ese dato en ningún sitio nuevo (§PR3: nada de
  // selectedPlayer en ReportWorkspaceService).
  private route = inject(ActivatedRoute);

  private currentPlayerName(): string | null {
    return this.route.firstChild?.snapshot.paramMap.get('playerName') ?? null;
  }

  // Mismo patrón que app.ts (isIsolatedPage): toSignal + NavigationEnd +
  // un valor inicial calculado igual, para que el primer render ya sea
  // correcto y el back/forward del navegador (que también dispara
  // NavigationEnd) lo mantenga así.
  protected activePlayerName = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.currentPlayerName()),
    ),
    { initialValue: this.currentPlayerName() },
  );

  protected search = signal('');

  private groups = computed(() => groupParticipantsForSidebar(this.workspace.participants()));
  protected filteredGroups = computed(() => filterParticipantGroups(this.groups(), this.search()));

  reportDateLabel(startTime: number): string {
    return new Date(startTime).toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }
}
