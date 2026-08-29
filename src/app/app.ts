import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { WowheadRefreshService } from './core/wowhead-refresh.service';
import { SeasonProgressComponent } from './features/raid-session/season-progress.component';
import { ViewportService } from './core/viewport.service';
import { MobileBlockComponent } from './features/mobile-block/mobile-block.component';
import { AuthService } from './core/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, SeasonProgressComponent, MobileBlockComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  // Solo hace falta instanciarlo (providedIn: 'root', singleton) para que
  // arranque su MutationObserver — ver wowhead-refresh.service.ts para el
  // porqué (sin esto, los tooltips de Wowhead nunca aparecían en contenido
  // renderizado por Angular, aunque el script cargara bien).
  private readonly wowheadRefresh = inject(WowheadRefreshService);

  // §"pantalla básica... si se intenta entrar desde el móvil" (feedback
  // real, 2026-08-29): gate en la raíz, antes que nada más — ver
  // ViewportService y app.html.
  protected readonly isMobile = inject(ViewportService).isMobile;

  // §"proteger todos los datos y rutas salvo que esté logeado un oficial"
  // (feedback real, 2026-08-29): el nav (Raid/Roster/Histórico/Ajustes) no
  // tiene sentido mostrarlo en /login ni mientras no se sabe si quien
  // mira es Oficial — solo aparece con officerStatus() === 'officer' (ver
  // app.html). Instanciarlo aquí (fuera de cualquier ruta) es lo que hace
  // que arranque el chequeo de sesión/rol en cuanto carga la app.
  protected readonly auth = inject(AuthService);
}
