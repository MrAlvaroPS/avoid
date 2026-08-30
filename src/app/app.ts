import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { WowheadRefreshService } from './core/wowhead-refresh.service';
import { SeasonProgressComponent } from './features/raid-session/season-progress.component';
import { ViewportService } from './core/viewport.service';
import { MobileBlockComponent } from './features/mobile-block/mobile-block.component';
import { AuthService } from './core/auth.service';

// §"página independiente... sin cabecera de la app ni ningún botón
// perteneciente a la app" (feedback real, 2026-08-30): rutas que se sirven
// SIN el app-shell (nav/guild-tag) ni el bloqueo de móvil — pensadas para
// compartir por enlace fuera de la guild (raiders sin login), donde lo
// normal es abrirlas desde el móvil (un enlace de Discord). Lista explícita
// en vez de "todo lo que no tiene nav" para no esconder por accidente una
// ruta real de la app el día que se añada otra sin querer.
const ISOLATED_ROUTE_PREFIXES = ['/guia-infografia'];

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

  // §ver ISOLATED_ROUTE_PREFIXES arriba. Reactivo (no solo location.pathname
  // al construir) por si algún día se navega hacia/desde esta ruta con el
  // Router en vez de una carga de página nueva — hoy no ocurre (la guía no
  // tiene ningún routerLink, es un callejón sin salida a propósito), pero
  // más barato dejarlo bien hecho que confiar en que nunca cambie.
  private readonly router = inject(Router);
  protected readonly isIsolatedPage = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => ISOLATED_ROUTE_PREFIXES.some((prefix) => e.urlAfterRedirects.startsWith(prefix))),
      startWith(ISOLATED_ROUTE_PREFIXES.some((prefix) => this.router.url.startsWith(prefix))),
    ),
    { initialValue: ISOLATED_ROUTE_PREFIXES.some((prefix) => this.router.url.startsWith(prefix)) },
  );
}
