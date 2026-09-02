import { Component, inject, input, output, signal } from '@angular/core';
import { PullAnalysisService } from '../../core/pull-analysis.service';
import { formatDuration } from '../../shared/format.util';
import { errorMessage } from '../../shared/error-message.util';
import type { PullEvaluationContextContract } from '../../../../supabase/functions/_shared/combat-evaluation-contract';

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
  context = input<PullEvaluationContextContract | null>(null);
  statusChanged = output<void>();
  detailsOpen = signal(false);
  toggling = signal(false);
  reason = signal('');
  error = signal<string | null>(null);

  async toggle(): Promise<void> {
    if (this.context()) return this.apply(this.context()!.ninjaStatus === 'confirmed' ? 'mark_valid' : 'confirm_ninja');
    this.toggling.set(true);
    this.error.set(null);
    try {
      await this.pullAnalysis.setNinjaPullStatus(this.pullId(), !this.excluded());
      this.statusChanged.emit();
    } catch (err) { this.error.set(errorMessage(err)); }
    finally { this.toggling.set(false); }
  }

  async apply(action: 'confirm_ninja' | 'mark_valid' | 'mark_probable_ninja'): Promise<void> {
    this.toggling.set(true);
    this.error.set(null);
    try {
      await this.pullAnalysis.setPullEvaluationContext({
        pullId: this.pullId(), action,
        ...(this.reason().trim() ? { reason: this.reason().trim() } : {}),
      });
      this.statusChanged.emit();
    } catch (err) { this.error.set(errorMessage(err)); }
    finally { this.toggling.set(false); }
  }

  statusLabel(): string {
    const status = this.context()?.ninjaStatus;
    if (status === 'confirmed') return 'Ninja confirmado · no evaluable';
    if (status === 'probable') return 'Probable ninja · pendiente de revisión y todavía evaluable';
    if (status === 'valid') return 'Intento válido confirmado';
    return this.excluded() ? 'Ninja confirmado (legacy)' : 'Estado insuficiente';
  }

  signalLines(): string[] {
    const s = this.signals();
    const lines: string[] = [];
    if (typeof s['durationMs'] === 'number') lines.push(`El pull duró ${formatDuration(s['durationMs'])}.`);
    if (typeof s['engagedPlayerCount'] === 'number' && typeof s['raidSize'] === 'number') lines.push(`${s['engagedPlayerCount']} de ${s['raidSize']} jugadores llegaron a engancharse.`);
    if (typeof s['engagedFraction'] === 'number') lines.push(`${Math.round(s['engagedFraction'] * 100)}% de la raid se enganchó.`);
    return lines;
  }
}
