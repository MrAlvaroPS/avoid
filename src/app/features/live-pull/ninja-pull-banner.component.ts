// Colocar en: src/app/features/live-pull/ninja-pull-banner.component.ts
// §"un ninja pull... también cuenta en la estadística de wipes... habría
// que clasificarlo de otra manera para saberlo" (feedback real): mismo
// patrón que wipe-call-banner.component.ts — banner visible solo cuando
// analyze-report evaluó la heurística de ninja pull en este pull, muestra
// las señales (nunca una caja negra) y deja confirmar/revertir con un
// clic. El toggle recarga el pull entero por el mismo motivo que el de
// wipe call: la exclusión afecta a fiabilidad, histórico de boss e informe
// de noche, no solo a la vista actual.
import { Component, inject, input, output, signal } from '@angular/core';
import { PullAnalysisService } from '../../core/pull-analysis.service';
import { formatDuration } from '../../shared/format.util';
import { errorMessage } from '../../shared/error-message.util';

@Component({
  selector: 'app-ninja-pull-banner',
  standalone: true,
  templateUrl: './ninja-pull-banner.component.html',
  styleUrl: './ninja-pull-banner.component.scss',
})
export class NinjaPullBannerComponent {
  private pullAnalysis = inject(PullAnalysisService);

  pullId = input.required<string>();
  excluded = input.required<boolean>();
  signals = input.required<Record<string, number | boolean | null>>();
  statusChanged = output<void>();

  detailsOpen = signal(false);
  toggling = signal(false);
  error = signal<string | null>(null);

  async toggle(): Promise<void> {
    this.toggling.set(true);
    this.error.set(null);
    try {
      await this.pullAnalysis.setNinjaPullStatus(this.pullId(), !this.excluded());
      this.statusChanged.emit();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.toggling.set(false);
    }
  }

  signalLines(): string[] {
    const s = this.signals();
    const lines: string[] = [];
    if (typeof s['durationMs'] === 'number') lines.push(`el pull duró ${formatDuration(s['durationMs'])}`);
    if (typeof s['engagedPlayerCount'] === 'number' && typeof s['raidSize'] === 'number') {
      lines.push(`solo ${s['engagedPlayerCount']} de ${s['raidSize']} jugadores llegaron a recibir daño o morir`);
    }
    if (typeof s['engagedFraction'] === 'number') lines.push(`${Math.round(s['engagedFraction'] * 100)}% de la raid se enganchó al pull`);
    return lines;
  }
}
