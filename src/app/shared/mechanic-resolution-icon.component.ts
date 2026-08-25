import { Component, input } from '@angular/core';

/**
 * Vista compacta de la resolución investigada de una mecánica. A diferencia
 * de MechanicInfoIcon, este tooltip se centra solo en la instrucción útil.
 * Las fuentes contrastadas ya viven en la clasificación general de IA.
 */
@Component({
  selector: 'app-mechanic-resolution-icon',
  standalone: true,
  template: `
    @if (resolution(); as value) {
      <span class="resolution-wrap" tabindex="0" aria-label="Ver cómo resolver esta mecánica">
        <span class="resolution-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>
          Resolución
        </span>
        <span class="resolution-panel" role="tooltip">
          <strong>Cómo resolverlo</strong>
          <span class="resolution-copy">{{ value }}</span>
        </span>
      </span>
    } @else {
      <span class="resolution-empty" title="Todavía no hay una resolución contrastada con dos fuentes">—</span>
    }
  `,
  styles: [
    `
      :host { display: inline-flex; }
      .resolution-wrap { position: relative; display: inline-flex; outline: none; }
      .resolution-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 8px;
        border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
        border-radius: 20px;
        background: color-mix(in srgb, var(--success) 9%, var(--surface-2));
        color: var(--success);
        font-size: 10.5px;
        font-weight: 650;
        white-space: nowrap;
        cursor: help;
      }
      .resolution-badge svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.3; stroke-linecap: round; stroke-linejoin: round; }
      .resolution-wrap:hover .resolution-badge,
      .resolution-wrap:focus-within .resolution-badge { filter: brightness(1.15); }
      .resolution-panel {
        position: absolute;
        top: calc(100% + 5px);
        left: 0;
        z-index: 40;
        display: flex;
        width: min(380px, 70vw);
        flex-direction: column;
        gap: 7px;
        padding: 11px 12px;
        border: 1px solid var(--border-bright);
        border-radius: 8px;
        background: var(--surface-2);
        box-shadow: var(--shadow-card);
        color: var(--text-muted);
        font-size: 11.5px;
        line-height: 1.48;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.1s ease;
      }
      .resolution-panel strong { color: var(--text); font-size: 12px; }
      .resolution-copy { white-space: normal; }
      .resolution-wrap:hover .resolution-panel,
      .resolution-wrap:focus-within .resolution-panel { opacity: 1; visibility: visible; }
      .resolution-empty { color: var(--text-faint); font-size: 10.5px; }
    `,
  ],
})
export class MechanicResolutionIconComponent {
  resolution = input<string | null>(null);
}
