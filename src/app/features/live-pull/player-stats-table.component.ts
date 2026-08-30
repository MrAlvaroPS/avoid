// Colocar en: src/app/features/live-pull/player-stats-table.component.ts
// No es parte del árbol §15.1 (esa pantalla es solo conclusiones, no datos
// crudos) — es la "vía de verificación" que pide §1: dps/hps/absorciones/
// trinkets están accesibles, pero colapsados por defecto, no compitiendo
// visualmente con la cabecera/métricas/timeline/callouts.
//
// §"la tabla del roster es fea, está descuadrada y es poco práctica"
// (feedback real): la versión anterior metía talentos/trinkets/defensivos/
// consumibles como columnas SIEMPRE visibles, cada una con su propio número
// de líneas de texto — la altura de cada fila la decidía la celda más larga,
// así que dps/hps/percentil (una línea) quedaban flotando arriba de huecos
// enormes en blanco en filas de 5+ líneas. Ahora cada jugador es una fila
// COMPACTA de altura fija (nombre/clase/percentil/dps/hps/absorbido/
// consumibles resumidos) y el detalle pesado (talentos/trinkets/defensivos
// completos) vive en una fila de detalle que se expande a demanda — mismo
// patrón "vistazo vs. verificación" que ya usa el resto de la app.
import { Component, computed, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import type { PlayerStatRow } from '../../core/pull-analysis.service';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { RoleIconComponent } from '../../shared/role-icon.component';
import { formatTimeLabel, percentileTone } from '../../shared/format.util';

@Component({
  selector: 'app-player-stats-table',
  standalone: true,
  imports: [DecimalPipe, WowheadLinkComponent, RoleIconComponent],
  templateUrl: './player-stats-table.component.html',
  styleUrl: './player-stats-table.component.scss',
})
export class PlayerStatsTableComponent {
  players = input.required<PlayerStatRow[]>();
  embedded = input(false);
  open = signal(false);

  // Escala de las mini-barras de DPS/HPS — máximo de ESTE pull, no un valor
  // global fijo (así siempre hay al menos una barra llena y las diferencias
  // relativas se leen de un vistazo, dataviz §"choosing a form": magnitud
  // comparada entre categorías = barras, un único hue, sin eje dual).
  maxDps = computed(() => Math.max(1, ...this.players().map((p) => p.dps)));
  maxHps = computed(() => Math.max(1, ...this.players().map((p) => p.hps)));

  // Una sola fila de detalle por jugador (talentos+trinkets+defensivos a la
  // vez) — antes era un toggle suelto solo para talentos, sin cubrir
  // trinkets/defensivos, que siempre estaban expandidos ocupando espacio.
  expandedPlayers = signal<Set<string>>(new Set());

  toggle(): void {
    this.open.update((v) => !v);
  }

  toggleDetail(playerName: string): void {
    this.expandedPlayers.update((set) => {
      const next = new Set(set);
      if (next.has(playerName)) next.delete(playerName);
      else next.add(playerName);
      return next;
    });
  }

  formatTime(timeMs: number): string {
    return formatTimeLabel(timeMs);
  }

  hasAnyOnCooldown(p: PlayerStatRow): boolean {
    return (p.defensiveStatusAtDeath ?? []).some((o) => o.status === 'on_cooldown');
  }

  // §movido a shared/format.util.ts (2026-08-30): night-report también lo
  // necesita para el percentil medio de la noche — mismo umbral, un único sitio.
  percentileTone = percentileTone;

  // Resumen de UN vistazo para la fila compacta (🪨✓ 🧪✗ estilo) — el
  // desglose completo (cuántas veces, disponibilidad real) sigue en la fila
  // de detalle, esto es solo "¿le faltó algo obvio?".
  consumableSummary(p: PlayerStatRow): { icon: string; ok: boolean; title: string }[] {
    const out: { icon: string; ok: boolean; title: string }[] = [];
    const stone = p.consumables.healthstone;
    if (stone) {
      out.push({
        icon: '🪨',
        ok: stone.used || !stone.available,
        title: stone.used ? `Piedra usada ×${stone.count}` : stone.available ? 'Piedra disponible, sin usar' : 'Sin Warlock en la raid',
      });
    }
    const potion = p.consumables.healthPotion;
    if (potion) {
      out.push({ icon: '🧪', ok: potion.used, title: potion.used ? `Poción usada ×${potion.count}` : 'Poción sin usar' });
    }
    return out;
  }
}
