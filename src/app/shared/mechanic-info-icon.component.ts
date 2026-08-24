// Colocar en: src/app/shared/mechanic-info-icon.component.ts
// §"en todos los informes y lados donde venga una mecánica de boss... poner
// una 'I' de información junto a la mecánica con la nota descriptiva que
// haya traído la IA al análisis en Ajustes... solo la nota, no las fuentes"
// + "quiero que sea un tipo tooltip al pasar el ratón por encima, no tener
// que abrirlo" (feedback real, 2026-08-24). Puro CSS :hover/:focus-within —
// sin signal ni click handler: en varios sitios donde se usa
// (coaching-callout-list) la fila entera YA es un <button>, y un click aquí
// dentro competiría con el suyo. Con hover no hace falta stopPropagation
// porque hover nunca dispara el (click) del padre.
import { Component, input } from '@angular/core';

@Component({
  selector: 'app-mechanic-info-icon',
  standalone: true,
  template: `
    @if (note(); as n) {
      <span class="mechanic-info-icon-wrap" tabindex="0">
        <span class="mechanic-info-icon" [class.mechanic-info-icon-label]="label()" aria-hidden="true">{{ label() ?? 'ⓘ' }}</span>
        <div class="mechanic-info-panel" role="tooltip">{{ n }}</div>
      </span>
    }
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      .mechanic-info-icon-wrap {
        position: relative;
        display: inline-flex;
        outline: none;
      }
      .mechanic-info-icon {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--surface-2);
        color: var(--accent);
        font-size: 10px;
        cursor: help;
      }
      // Variante con texto (ej. "IA (alta confianza)" en el manifiesto) en vez
      // del glifo redondo — mismo hover, forma de píldora en vez de círculo.
      .mechanic-info-icon-label {
        width: auto;
        height: auto;
        padding: 2px 8px;
        border-radius: 20px;
        font-size: 10.5px;
        font-weight: 600;
        white-space: nowrap;
      }
      .mechanic-info-icon-wrap:hover .mechanic-info-icon,
      .mechanic-info-icon-wrap:focus-within .mechanic-info-icon {
        background: var(--accent-soft);
      }
      .mechanic-info-panel {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        z-index: 30;
        width: max-content;
        max-width: 300px;
        padding: 8px 10px;
        background: var(--surface-2);
        border: 1px solid var(--card-border);
        border-radius: 6px;
        box-shadow: var(--shadow-card);
        font-size: 11px;
        line-height: 1.4;
        color: var(--text-muted);
        white-space: normal;
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.1s ease;
      }
      .mechanic-info-icon-wrap:hover .mechanic-info-panel,
      .mechanic-info-icon-wrap:focus-within .mechanic-info-panel {
        opacity: 1;
        visibility: visible;
      }
    `,
  ],
})
export class MechanicInfoIconComponent {
  /** Solo la nota (ai_classification.notes) — nunca las fuentes, a propósito (feedback real). Null/vacío = no se pinta nada (mecánica sin clasificar por IA todavía). */
  note = input<string | null>(null);
  /** Texto a mostrar en vez del glifo "ⓘ" (ej. "IA (alta confianza)" en el manifiesto). Null = el glifo por defecto. */
  label = input<string | null>(null);
}
