// Colocar en: src/app/core/wowhead-refresh.service.ts
//
// BUG real encontrado en real (2026-08-22, capturas del usuario): los
// tooltips de Wowhead se resaltaban en hover (eso es solo el :hover de
// nuestro propio CSS) pero el tooltip en sí NUNCA aparecía. Verificado con
// Playwright: window.$WowheadPower existe y tooltips.js carga bien (200), no
// hay ningún error — pero el script de Wowhead solo escanea el DOM una vez,
// nada más cargar. Cualquier elemento con data-wowhead que Angular inserte
// DESPUÉS de ese escaneo inicial (es decir, prácticamente todo, porque
// Angular renderiza los datos reales ~segundos después de que tooltips.js ya
// haya corrido) no tiene el listener de hover enganchado — de ahí "se
// ilumina pero no sale el tooltip" (el color SÍ lo pone whTooltips en el
// primer escaneo o queda de nuestro propio CSS, pero el popup necesita el
// listener, que nunca se añadió a ese nodo).
//
// La propia API de Wowhead expone `$WowheadPower.refreshLinks()` para
// exactamente este caso (apps de una sola página con contenido dinámico) —
// hay que llamarlo cada vez que se inserta contenido nuevo con data-wowhead.
// En vez de acordarse de llamarlo a mano en cada componente que use
// WowheadLinkComponent o [attr.data-wowhead] (y olvidarlo en el siguiente
// componente nuevo, como ha pasado hasta ahora), un único MutationObserver
// centralizado en toda la app lo hace automático y a prueba de futuro.
import { Injectable } from '@angular/core';

declare global {
  interface Window {
    $WowheadPower?: { refreshLinks: () => void; setScales?: (...args: unknown[]) => void };
  }
}

@Injectable({ providedIn: 'root' })
export class WowheadRefreshService {
  private observer: MutationObserver | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.start();
  }

  private start(): void {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return; // SSR/build-time: no-op

    // Primer intento nada más arrancar (cubre el primer render de la app).
    this.scheduleRefresh();

    this.observer = new MutationObserver((mutations) => {
      const touchedWowheadNode = mutations.some((m) =>
        Array.from(m.addedNodes).some((node) => {
          if (!(node instanceof Element)) return false;
          return node.hasAttribute('data-wowhead') || node.querySelector('[data-wowhead]') != null;
        }),
      );
      if (touchedWowheadNode) this.scheduleRefresh();
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  // Debounce: Angular suele insertar decenas de nodos data-wowhead de golpe
  // (una tabla entera, una lista de callouts) — no tiene sentido llamar a
  // refreshLinks() una vez por nodo.
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      window.$WowheadPower?.refreshLinks();
    }, 150);
  }
}
