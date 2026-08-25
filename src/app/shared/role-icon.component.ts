import { Component, computed, input } from '@angular/core';

export type RaidRole = 'Tank' | 'Heal' | 'Melee' | 'Ranged' | null;

@Component({
  selector: 'app-role-icon',
  standalone: true,
  template: `
    <span class="role-icon" [class]="'role-' + kind()" [attr.title]="label()" [attr.aria-label]="label()">
      @if (iconUrl(); as src) {
        <img [src]="src" alt="" aria-hidden="true" />
      } @else {
        <span class="role-unknown">—</span>
      }
    </span>
  `,
  styles: [
    `
      .role-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        flex-shrink: 0;
      }
      .role-icon img {
        display: block;
        width: 22px;
        height: 22px;
        object-fit: contain;
        filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.55));
      }
      .role-unknown {
        color: var(--text-faint);
        font-size: 11px;
      }
    `,
  ],
})
export class RoleIconComponent {
  role = input<RaidRole>(null);

  kind = computed<'tank' | 'heal' | 'melee' | 'ranged' | 'unknown'>(() => {
    switch (this.role()) {
      case 'Tank':
        return 'tank';
      case 'Heal':
        return 'heal';
      case 'Melee':
        return 'melee';
      case 'Ranged':
        return 'ranged';
      default:
        return 'unknown';
    }
  });

  label = computed(() => {
    switch (this.role()) {
      case 'Tank':
        return 'Tank';
      case 'Heal':
        return 'Healer';
      case 'Melee':
        return 'DPS cuerpo a cuerpo';
      case 'Ranged':
        return 'DPS a distancia';
      default:
        return 'Rol desconocido';
    }
  });

  iconUrl = computed(() => {
    const kind = this.kind();
    return kind === 'unknown' ? null : `/assets/${kind}.png`;
  });
}
