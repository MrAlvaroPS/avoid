import { Injectable, signal } from '@angular/core';

// §"pantalla básica... no está preparada para ser vista desde un navegador
// móvil" (feedback real, 2026-08-29): mismo breakpoint que ya usa el nav
// real para adaptarse en móvil (@media max-width: 700px en app.scss) — no
// se inventa un umbral nuevo, es el mismo punto en el que la propia app ya
// reconoce que su layout cambia de registro.
const MOBILE_BREAKPOINT = '(max-width: 700px)';

@Injectable({ providedIn: 'root' })
export class ViewportService {
  readonly isMobile = signal(this.matches());

  constructor() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(MOBILE_BREAKPOINT);
    query.addEventListener('change', (event) => this.isMobile.set(event.matches));
  }

  private matches(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(MOBILE_BREAKPOINT).matches;
  }
}
