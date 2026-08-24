// Colocar en: src/app/shared/role-icon.component.ts
// §"los roles tienen un icono 'oficial'" (feedback real, con referencia
// visual adjunta — 4 iconos: escudo azul=tank, cruz verde=healer, espada
// roja=melee, arco ámbar=ranged): mismo lenguaje que cualquier UI de raid
// (LFG de Blizzard, WCL, wowaudit, Method) — forma + color van juntos, no
// son intercambiables. Antes Melee/Ranged compartían un único icono de
// "dps" (espadas cruzadas); ahora son 4 iconos distintos de verdad, uno por
// rol real, para que "quién es qué" se lea de un vistazo sin tener que leer
// el tooltip.
import { Component, computed, input } from '@angular/core';

export type RaidRole = 'Tank' | 'Heal' | 'Melee' | 'Ranged' | null;

@Component({
  selector: 'app-role-icon',
  standalone: true,
  template: `
    <span class="role-icon" [class]="'role-' + kind()" [attr.title]="label()" [attr.aria-label]="label()">
      @switch (kind()) {
        @case ('tank') {
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none">
            <path d="M12 2.5 5 5.2v6c0 5 3 8.4 7 9.3 4-.9 7-4.3 7-9.3v-6L12 2.5Z" fill="white" />
          </svg>
        }
        @case ('heal') {
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none">
            <path d="M10.3 4.5h3.4v5.8h5.8v3.4h-5.8v5.8h-3.4v-5.8H4.5v-3.4h5.8V4.5Z" fill="white" />
          </svg>
        }
        @case ('melee') {
          <!-- Una sola espada (no cruzadas) — distingue melee de ranged, que antes compartían el mismo icono de "dps" genérico. -->
          <svg viewBox="0 0 24 24" width="13" height="13" fill="white">
            <g transform="rotate(40 12 12)">
              <path d="M11.2 2.2h1.6l.5 11.3h-2.6l.5-11.3Z" />
              <rect x="8.4" y="13.6" width="7.2" height="1.7" rx="0.4" />
              <rect x="11.05" y="15.3" width="1.9" height="4.3" rx="0.4" />
              <circle cx="12" cy="20.5" r="1.35" />
            </g>
          </svg>
        }
        @case ('ranged') {
          <!-- Arco + flecha — el icono que faltaba: antes ranged se pintaba igual que melee. -->
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="white" stroke-linecap="round">
            <path d="M6.5 3c2.6 3 2.6 15 0 18" stroke-width="1.6" />
            <line x1="6.5" y1="3" x2="6.5" y2="21" stroke-width="1.1" />
            <line x1="6.5" y1="12" x2="20" y2="12" stroke-width="1.5" />
            <path d="M20 12 16 9.3M20 12 16 14.7" stroke-width="1.5" />
            <path d="M6.5 12 9.5 10.2M6.5 12 9.5 13.8" stroke-width="1.2" />
          </svg>
        }
        @default {
          <span class="role-unknown">—</span>
        }
      }
    </span>
  `,
  styles: [
    `
      // §"los roles tienen un icono 'oficial'": distintivo circular con
      // anillo metálico y relleno en degradado — el mismo lenguaje que el
      // icono de rol de Blizzard (LFG/Dungeon Journal), no un cuadrado
      // plano de un solo color. Colores fijos del rol, no --accent — es
      // identidad de categoría (tank/heal/melee/ranged), no estado.
      .role-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 19px;
        height: 19px;
        border-radius: 50%;
        flex-shrink: 0;
        box-shadow:
          0 0 0 1px rgba(0, 0, 0, 0.55),
          0 0 0 2.5px #b9bdc4,
          inset 0 1px 1.5px rgba(255, 255, 255, 0.55),
          inset 0 -1.5px 2px rgba(0, 0, 0, 0.35);
      }
      .role-tank {
        background: radial-gradient(circle at 35% 28%, #7fb0f2 0%, #3f74cc 55%, #234f96 100%);
      }
      .role-heal {
        background: radial-gradient(circle at 35% 28%, #7fd6a3 0%, #349161 55%, #1f6b45 100%);
      }
      .role-melee {
        background: radial-gradient(circle at 35% 28%, #e8827c 0%, #c1483f 55%, #932e27 100%);
      }
      .role-ranged {
        background: radial-gradient(circle at 35% 28%, #e8b26f 0%, #c17f2f 55%, #93591b 100%);
      }
      .role-icon svg {
        filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.5));
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
}
