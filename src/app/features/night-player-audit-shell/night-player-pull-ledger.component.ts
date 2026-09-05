import { Component, effect, inject, input, signal } from '@angular/core';
import {
  NightPlayerPullLedgerService,
  type NightPlayerPullLedger,
  type NightPlayerPullLedgerRow,
} from '../../core/night-player-pull-ledger.service';
import { errorMessage } from '../../shared/error-message.util';
import { formatDuration, formatPct, wclParseTier } from '../../shared/format.util';
import type { AuditClaimStatus, EvidenceRef } from '../../shared/models/night-player-audit';

@Component({
  selector: 'app-night-player-pull-ledger',
  standalone: true,
  templateUrl: './night-player-pull-ledger.component.html',
  styleUrl: './night-player-pull-ledger.component.scss',
})
export class NightPlayerPullLedgerComponent {
  private readonly ledgerService = inject(NightPlayerPullLedgerService);

  reportCode = input.required<string>();
  playerName = input.required<string>();

  protected readonly data = signal<NightPlayerPullLedger | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly expandedPullId = signal<string | null>(null);

  protected readonly formatDuration = formatDuration;
  protected readonly formatPct = formatPct;

  constructor() {
    effect(() => {
      const reportCode = this.reportCode();
      const playerName = this.playerName();
      void this.load(reportCode, playerName);
    });
  }

  protected toggleRow(row: NightPlayerPullLedgerRow): void {
    this.expandedPullId.update((current) => (current === row.pull.pullId ? null : row.pull.pullId));
  }

  protected resultLabel(row: NightPlayerPullLedgerRow): string {
    if (row.result.value === 'kill') return 'Kill';
    if (row.result.value === 'wipe') {
      return row.wipePct == null ? 'Wipe' : `Wipe · ${this.formatPct(row.wipePct)}`;
    }
    return 'N/D';
  }

  protected parseTier(value: number | null): string {
    return wclParseTier(value) ?? 'none';
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

  protected evidenceLabel(evidence: EvidenceRef): string {
    switch (evidence.kind) {
      case 'wcl_pull':
        return 'Warcraft Logs · fight exacto';
      case 'wcl_event':
        return `Warcraft Logs · ${evidence.eventType}`;
      case 'player_pull_record':
        return `player_pull_records.${evidence.field}`;
      case 'defensive_episode':
        return `DefensiveEpisode ${evidence.episodeId}`;
      case 'execution_ledger':
        return `Execution event ${evidence.eventId}`;
      case 'mechanic_event':
        return `Mechanic ${evidence.mechanicKey}`;
      case 'reliability':
        return 'Reliability projection';
      case 'catalog':
        return `Catalog ${evidence.catalogKey}`;
      case 'gear':
        return 'CombatantInfo / gear';
    }
  }

  protected evidenceHref(evidence: EvidenceRef): string | null {
    return evidence.kind === 'wcl_pull' || evidence.kind === 'wcl_event' ? evidence.locator : null;
  }

  private async load(reportCode: string, playerName: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.expandedPullId.set(null);
    try {
      this.data.set(await this.ledgerService.load(reportCode, playerName));
    } catch (error) {
      this.data.set(null);
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }
}
