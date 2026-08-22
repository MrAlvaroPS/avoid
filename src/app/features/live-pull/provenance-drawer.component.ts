// Colocar en: src/app/features/live-pull/provenance-drawer.component.ts
// §8 de la hoja de ruta: cualquier métrica es clicable y abre esto — de
// dónde salió, qué fórmula se aplicó, y un enlace directo al pull en
// warcraftlogs.com cuando el origen es un evento de WCL.
import { Component, input, output } from '@angular/core';
import type { ProvenanceEntry } from '../../shared/models/ui';

@Component({
  selector: 'app-provenance-drawer',
  standalone: true,
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
}
