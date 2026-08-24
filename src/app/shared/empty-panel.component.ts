// Colocar en: src/app/shared/empty-panel.component.ts
// §6 de la auditoría: patrón único de "aquí no hay nada todavía" reutilizado
// en todo el dashboard, en vez de que cada sitio resuelva su propio aviso
// suelto (hoy: el "sin pulls" del manifiesto tiene su propio markup, el
// "sin analizar todavía" de la tarjeta IA otro, etc. — ninguno comparte
// componente). No sustituye esos casos existentes de golpe (cada uno vive
// en su propio archivo, cambiarlos es un cambio a la vez) — es el patrón
// para los NUEVOS estados vacíos, y para migrar los de arriba cuando se
// toquen por otra razón.
import { Component, input } from '@angular/core';

@Component({
  selector: 'app-empty-panel',
  standalone: true,
  template: `
    <div class="empty-panel">
      @if (icon()) {
        <span class="empty-icon" aria-hidden="true">{{ icon() }}</span>
      }
      <p class="empty-message">{{ message() }}</p>
      @if (hint()) {
        <p class="empty-hint">{{ hint() }}</p>
      }
    </div>
  `,
  styles: [
    `
      .empty-panel {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        gap: 6px;
        padding: 32px 20px;
        color: var(--text-faint);
      }
      .empty-icon {
        font-size: 22px;
        opacity: 0.7;
        margin-bottom: 4px;
      }
      .empty-message {
        margin: 0;
        font-size: 13px;
        color: var(--text-muted);
      }
      .empty-hint {
        margin: 0;
        font-size: 11.5px;
        color: var(--text-faint);
        max-width: 42ch;
      }
    `,
  ],
})
export class EmptyPanelComponent {
  icon = input<string | null>(null);
  message = input.required<string>();
  /** Segunda línea, más pequeña — qué hacer al respecto o por qué está vacío, no obligatoria. */
  hint = input<string | null>(null);
}
