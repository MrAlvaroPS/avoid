// Colocar en: src/app/features/live-pull/provenance-drawer.component.ts
// §8 de la hoja de ruta: cualquier métrica es clicable y abre esto — de
// dónde salió, qué fórmula se aplicó, y un enlace directo al pull en
// warcraftlogs.com cuando el origen es un evento de WCL.
import { Component, computed, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import type { ProvenanceEntry } from '../../shared/models/ui';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';

@Component({
  selector: 'app-provenance-drawer',
  standalone: true,
  imports: [DecimalPipe, WowheadLinkComponent],
  templateUrl: './provenance-drawer.component.html',
  styleUrl: './provenance-drawer.component.scss',
})
export class ProvenanceDrawerComponent {
  entry = input<ProvenanceEntry | null>(null);
  closeRequested = output<void>();

  wclUrl(entry: ProvenanceEntry): string | null {
    if (!entry.wclReportCode) return null;
    const fightPart = entry.wclFightId ? `#fight=${entry.wclFightId}` : '';
    return `https://www.warcraftlogs.com/reports/${entry.wclReportCode}${fightPart}`;
  }

  // Escala de las barras del mini-timeline — máximo golpe DE ESTA secuencia,
  // no un valor global fijo (mismo criterio que el resto de barras de la app).
  maxHit = computed(() => Math.max(1, ...(this.entry()?.damageTimeline?.map((h) => h.amount) ?? [1])));
}
