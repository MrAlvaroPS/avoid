// Colocar en: src/app/shared/wowhead-link.component.ts
// Envuelve cualquier nombre de hechizo/ítem en un enlace con el tooltip
// oficial de Wowhead (icono + descripción al pasar el ratón), vía su script
// de embed público (ver src/index.html) — no es scraping, es el mecanismo
// que Wowhead ofrece a propósito para sitios de terceros.
import { Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-wowhead-link',
  standalone: true,
  template: `<a [href]="href()" [attr.data-wowhead]="dataAttr()" target="_blank" rel="noopener" class="wowhead-link"
    ><ng-content
  /></a>`,
  styles: [
    `
      .wowhead-link {
        color: inherit;
        text-decoration: none;
        border-bottom: 1px dotted var(--text-faint, currentColor);
        cursor: help;
      }
      .wowhead-link:hover {
        border-bottom-color: var(--accent, currentColor);
      }
    `,
  ],
})
export class WowheadLinkComponent {
  type = input.required<'spell' | 'item'>();
  id = input.required<number>();

  href = computed(() => `https://www.wowhead.com/${this.type()}=${this.id()}`);
  dataAttr = computed(() => `${this.type()}=${this.id()}`);
}
