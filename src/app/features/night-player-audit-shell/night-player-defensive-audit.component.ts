import { Component, effect, inject, input, signal } from '@angular/core';
import {
  NightPlayerDefensiveAuditService,
  type NightPlayerDefensiveAudit,
  type NightPlayerDefensiveEpisodeAudit,
  type NightPlayerDefensiveResponseVerdict,
} from '../../core/night-player-defensive-audit.service';
import { errorMessage } from '../../shared/error-message.util';
import { formatDuration, formatPct } from '../../shared/format.util';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import type { AuditClaim, AuditClaimStatus } from '../../shared/models/night-player-audit';

@Component({
  selector: 'app-night-player-defensive-audit',
  standalone: true,
  imports: [WowheadLinkComponent],
  templateUrl: './night-player-defensive-audit.component.html',
  styleUrl: './night-player-defensive-audit.component.scss',
})
export class NightPlayerDefensiveAuditComponent {
  private readonly auditService = inject(NightPlayerDefensiveAuditService);

  reportCode = input.required<string>();
  playerName = input.required<string>();

  protected readonly data = signal<NightPlayerDefensiveAudit | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly expandedEpisodeId = signal<string | null>(null);

  protected readonly formatDuration = formatDuration;

  constructor() {
    effect(() => {
      const reportCode = this.reportCode();
      const playerName = this.playerName();
      void this.load(reportCode, playerName);
    });
  }

  protected toggleEpisode(episode: NightPlayerDefensiveEpisodeAudit): void {
    this.expandedEpisodeId.update((current) =>
      current === episode.episodeId ? null : episode.episodeId,
    );
  }

  protected claimValue(claim: AuditClaim<number>): string {
    return claim.value == null ? 'N/D' : formatPct(claim.value);
  }

  protected claimFraction(claim: AuditClaim<number>): string {
    if (claim.denominator == null || claim.denominator === 0) return 'Sin denominador evaluable';
    return `${claim.numerator ?? 0}/${claim.denominator}`;
  }

  protected claimStatusLabel(status: AuditClaimStatus): string {
    switch (status) {
      case 'canonical':
        return 'Canónico';
      case 'direct':
        return 'Directo';
      case 'derived':
        return 'Derivado';
      case 'partial':
        return 'Parcial';
      case 'not_evaluable':
        return 'N/D';
      case 'incompatible':
        return 'Incompatible';
    }
  }

  protected stateLabel(data: NightPlayerDefensiveAudit): string {
    switch (data.integrity) {
      case 'complete':
        return 'Canónico completo';
      case 'partial':
        return 'Canónico parcial';
      case 'unavailable':
        return 'Sin generación publicada';
      case 'incompatible':
        return 'Generación incompatible';
      case 'error':
        return 'Error de lectura';
    }
  }

  protected responseLabel(verdict: NightPlayerDefensiveResponseVerdict): string {
    switch (verdict) {
      case 'covered_verified':
        return 'Cubierto';
      case 'missed_ready':
        return 'Fallado · listo';
      case 'missed_due_to_mistime':
        return 'Fallado · timing';
      case 'unavailable_legitimate':
        return 'No disponible legítimo';
      case 'no_applicable_resource':
        return 'Sin recurso aplicable';
      case 'uncertain':
        return 'Incierto';
      case 'excluded':
        return 'Excluido';
    }
  }

  protected responseTone(verdict: NightPlayerDefensiveResponseVerdict): string {
    if (verdict === 'covered_verified') return 'positive';
    if (verdict === 'missed_ready' || verdict === 'missed_due_to_mistime') return 'negative';
    if (verdict === 'uncertain') return 'warning';
    return 'neutral';
  }

  protected usageLabel(episode: NightPlayerDefensiveEpisodeAudit): string {
    if (!episode.usageEvaluable) return 'N/D';
    return episode.usageEngaged ? 'Usó' : 'No usó';
  }

  protected usageTone(episode: NightPlayerDefensiveEpisodeAudit): string {
    if (!episode.usageEvaluable) return 'neutral';
    return episode.usageEngaged ? 'positive' : 'negative';
  }

  protected shortId(value: string | null | undefined): string {
    if (!value) return 'N/D';
    return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
  }

  private async load(reportCode: string, playerName: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.expandedEpisodeId.set(null);
    try {
      this.data.set(await this.auditService.load(reportCode, playerName));
    } catch (error) {
      this.data.set(null);
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }
}
