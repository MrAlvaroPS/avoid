import { Component } from '@angular/core';

// §"pantalla básica y sencilla por si se intenta entrar desde el móvil...
// un mensaje indicando que esta aplicación no está preparada para ser vista
// desde un navegador móvil" (feedback real, 2026-08-29): sin navegación ni
// funcionalidad — sustituye por completo al router-outlet en app.html
// cuando ViewportService.isMobile() es true, para que ninguna ruta ni
// llamada a Supabase llegue a ejecutarse en un layout que no está pensado
// para esto.
@Component({
  selector: 'app-mobile-block',
  standalone: true,
  imports: [],
  templateUrl: './mobile-block.component.html',
  styleUrl: './mobile-block.component.scss',
})
export class MobileBlockComponent {}
