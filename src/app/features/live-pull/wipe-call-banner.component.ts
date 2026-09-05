import { Component, computed, inject, input, output, signal } from '@angular/core';
import { PullAnalysisService } from '../../core/pull-analysis.service';
import { errorMessage } from '../../shared/error-message.util';
import type { TimelineChip } from '../../shared/models/ui';
import type { PullEvaluationContextContract } from '../../../../supabase/functions/_shared/combat-evaluation-contract';

@Component({
  selector: 'app-wipe-call-banner',
  standalone: true,
  templateUrl: './wipe-call-banner.component.html',
  styleUrl: './wipe-call-banner.component.scss',
})
export class WipeCallBannerComponent {
  private pullAnalysis = inject(PullAnalysisService);

  pullId = input.required<string>();
  confidence = input.required<number>();
  excluded = input.required<boolean>();
  signals = input.required<Record<string, number | boolean | null>>();
  context = input<PullEvaluationContextContract | null>(null);
  durationMs = input.required<number>();
  timeline = input<TimelineChip[]>([]);
  statusChanged = output<void>();

  detailsOpen = signal(false);
  toggling = signal(false);
  reanalyzing = signal(false);
  reanalyzeMessage = signal<string | null>(null);
  error = signal<string | null>(null);
  boundarySeconds = signal<number | null>(null);
  reason = signal('');

  activeBoundaryMs = computed(() => this.context()?.wipeCallAtMs ?? (this.excluded() ? this.numberSignal('wipeCallStartMs') : null));
  candidateBoundaryMs = computed(() => this.numberSignal('wipeCallStartMs'));

  async toggle(): Promise<void> {
    this.toggling.set(true);
    this.error.set(null);
    try {
      await this.pullAnalysis.setWipeCallStatus(this.pullId(), !this.excluded());
      this.statusChanged.emit();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.toggling.set(false);
    }
  }

  async apply(action: 'confirm_wipe' | 'move_wipe_boundary' | 'clear_wipe' | 'accept_inferred_wipe'): Promise<void> {
    this.toggling.set(true);
    this.error.set(null);
    try {
      const needsBoundary = action === 'confirm_wipe' || action === 'move_wipe_boundary';
      const fallbackMs = this.activeBoundaryMs() ?? this.candidateBoundaryMs() ?? this.durationMs();
      const boundaryMs = Math.round((this.boundarySeconds() ?? fallbackMs / 1000) * 1000);
      await this.pullAnalysis.setPullEvaluationContext({
        pullId: this.pullId(),
        action,
        ...(needsBoundary ? { boundaryMs } : {}),
        ...(this.reason().trim() ? { reason: this.reason().trim() } : {}),
      });
      this.statusChanged.emit();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.toggling.set(false);
    }
  }

  async reanalyze(): Promise<void> {
    this.reanalyzing.set(true);
    this.error.set(null);
    this.reanalyzeMessage.set(null);
    try {
      const result = await this.pullAnalysis.reanalyzeWipeCall(this.pullId());
      const changed = result.clusterChanges.length;
      this.reanalyzeMessage.set(changed ? `Candidato recalculado: ${changed} jugadores cambiaron de cluster.` : 'Candidato recalculado sin cambios de cluster.');
      this.statusChanged.emit();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.reanalyzing.set(false);
    }
  }

  markerPct(timeMs: number | null): number {
    if (timeMs == null || this.durationMs() <= 0) return 0;
    return Math.max(0, Math.min(100, (timeMs / this.durationMs()) * 100));
  }

  deaths(side: 'pre' | 'post'): number {
    const boundary = this.activeBoundaryMs() ?? this.candidateBoundaryMs();
    if (boundary == null) return 0;
    return this.timeline().filter((chip) => {
      if (chip.timeMs == null || !/muerte/i.test(chip.description)) return false;
      return side === 'pre' ? chip.timeMs < boundary : chip.timeMs >= boundary;
    }).length;
  }

  boundaryLabel(): string {
    const value = this.activeBoundaryMs() ?? this.candidateBoundaryMs();
    if (value == null) return 'sin límite';
    const seconds = Math.round(value / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  sourceLabel(): string {
    const source = this.context()?.wipeCallSource;
    if (source === 'manual_rl') return 'manual RL';
    if (source === 'instrumented') return 'instrumentado';
    if (source === 'inferred') return 'inferido';
    return this.candidateBoundaryMs() != null ? 'candidato inferido' : 'sin candidato';
  }

  signalLines(): string[] {
    const s = this.signals();
    const lines: string[] = [];
    if (s['earlyMassDeath'] === true) lines.push('Muerte masiva durante los primeros 10 segundos.');
    if (typeof s['simultaneityFraction'] === 'number') lines.push(`${Math.round(s['simultaneityFraction'] * 100)}% de los vivos murieron casi a la vez.`);
    if (typeof s['abilityDiversity'] === 'number') lines.push(s['abilityDiversity'] > 0.5 ? 'Causas de muerte diversas.' : 'Predomina una misma habilidad.');
    if (typeof s['healingCollapseRatio'] === 'number') lines.push(`Actividad de sanación posterior: ${Math.round(s['healingCollapseRatio'] * 100)}% del ritmo previo.`);
    if (typeof s['triggerDeathsKept'] === 'number' && s['triggerDeathsKept'] > 0) lines.push(`Las primeras ${s['triggerDeathsKept']} muertes quedan antes del candidato.`);
    return lines;
  }

  private numberSignal(key: string): number | null {
    const value = this.signals()[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
}
