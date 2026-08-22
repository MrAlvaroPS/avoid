// Colocar en: src/app/features/live-pull/player-stats-table.component.ts
// No es parte del árbol §15.1 (esa pantalla es solo conclusiones, no datos
// crudos) — es la "vía de verificación" que pide §1: dps/hps/absorciones/
// trinkets están accesibles, pero colapsados por defecto, no compitiendo
// visualmente con la cabecera/métricas/timeline/callouts.
import { Component, computed, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import type { PlayerStatRow } from '../../core/pull-analysis.service';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { formatTimeLabel } from '../../shared/format.util';

@Component({
  selector: 'app-player-stats-table',
  standalone: true,
  imports: [DecimalPipe, WowheadLinkComponent],
  templateUrl: './player-stats-table.component.html',
  styleUrl: './player-stats-table.component.scss',
})
export class PlayerStatsTableComponent {
  players = input.required<PlayerStatRow[]>();
  open = signal(false);

  // Escala de las mini-barras de DPS/HPS — máximo de ESTE pull, no un valor
  // global fijo (así siempre hay al menos una barra llena y las diferencias
  // relativas se leen de un vistazo, dataviz §"choosing a form": magnitud
  // comparada entre categorías = barras, un único hue, sin eje dual).
  maxDps = computed(() => Math.max(1, ...this.players().map((p) => p.dps)));
  maxHps = computed(() => Math.max(1, ...this.players().map((p) => p.hps)));

  // Fila a fila: la lista completa de talentos (hasta ~80 nodos por
  // jugador) no cabe pintada siempre — se expande solo la fila que se pide,
  // igual que el toggle general de la tabla pero a nivel de jugador.
  expandedTalents = signal<Set<string>>(new Set());

  toggle(): void {
    this.open.update((v) => !v);
  }

  toggleTalents(playerName: string): void {
    this.expandedTalents.update((set) => {
      const next = new Set(set);
      if (next.has(playerName)) next.delete(playerName);
      else next.add(playerName);
      return next;
    });
  }

  timeList(timestampsMs: number[]): string {
    return timestampsMs.map((t) => formatTimeLabel(t)).join(', ');
  }
}
