import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { WowheadRefreshService } from './core/wowhead-refresh.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  // Solo hace falta instanciarlo (providedIn: 'root', singleton) para que
  // arranque su MutationObserver — ver wowhead-refresh.service.ts para el
  // porqué (sin esto, los tooltips de Wowhead nunca aparecían en contenido
  // renderizado por Angular, aunque el script cargara bien).
  private readonly wowheadRefresh = inject(WowheadRefreshService);
}
