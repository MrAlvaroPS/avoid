// Colocar en: src/app/shared/class-icon.component.ts
// §"pon icono de clase junto al nombre en 'a quién dirigir'" (feedback
// real): icono oficial de clase (mismo CDN público que ya usan las
// miniaturas de boss que trae wowaudit — wow.zamimg.com), no un dibujo
// propio — 13 símbolos reales son mucho trabajo para reinventar algo que
// ya existe y todo raider reconoce al instante.
import { Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-class-icon',
  standalone: true,
  template: `
    @if (iconUrl(); as url) {
      <img [src]="url" [attr.alt]="wclClass()" [attr.title]="wclClass()" class="class-icon" />
    }
  `,
  styles: [
    `
      .class-icon {
        width: 16px;
        height: 16px;
        border-radius: 3px;
        vertical-align: middle;
        flex-shrink: 0;
      }
    `,
  ],
})
export class ClassIconComponent {
  /** actor.subType de WCL tal cual ("DeathKnight", "DemonHunter"...) — mismo formato que player_pull_records.class. */
  wclClass = input<string | null>(null);

  iconUrl = computed(() => {
    const cls = this.wclClass();
    return cls ? `https://wow.zamimg.com/images/wow/icons/small/classicon_${cls.toLowerCase()}.jpg` : null;
  });
}
