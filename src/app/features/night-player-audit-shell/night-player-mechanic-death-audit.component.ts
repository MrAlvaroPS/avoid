import { Component, effect, inject, input, signal } from '@angular/core';
import {
  NightPlayerMechanicDeathAuditService,
  type CausalMaterializationState,
  type NightPlayerDeathAuditRow,
  type NightPlayerMechanicDeathAudit,
  type NightPlayerMechanicOffenseAudit,
} from '../../core/night-player-mechanic-death-audit.service';
import { errorMessage } from '../../shared/error-message.util';
import { formatDuration } from '../../shared/format.util';
import type { AuditClaim, AuditClaimStatus } from '../../shared/models/night-player-audit';

@Component({
  selector: 'app-night-player-mechanic-death-audit',
  standalone: true,
  templateUrl: './night-player-mechanic-death-audit.component.html',
  styleUrl: './night-player-mechanic-death-audit.component.scss',
})
export class NightPlayerMechanicDeathAuditComponent {
  private readonly auditService = inject(NightPlayerMechanicDeathAuditService);

  reportCode = input.required<string>();
  playerName = input.required<string>();

  protected readonly data = signal<NightPlayerMechanicDeathAudit | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly expandedMechanicEventId = signal<string | null>(null);
  protected readonly expandedDeathEventId = signal<string | null>(null);
  protected readonly formatDuration = formatDuration;

  constructor() {
    effect(() => {
      void this.load(this.reportCode(), this.playerName());
    });
  }

  protected claimValue(claim: AuditClaim<number>): string {
    return claim.value == null ? 'N/D' : String(claim.value);
  }

  protected statusLabel(status: AuditClaimStatus): string {
    switch (status) {
      case 'canonical': return 'Canónico';
      case 'direct': return 'Directo';
      case 'derived': return 'Derivado';
      case 'partial': return 'Parcial';
      case 'not_evaluable': return 'N/D';
      case 'incompatible': return 'Incompatible';
    }
  }

  protected materializationLabel(state: CausalMaterializationState): string {
    switch (state) {
      case 'complete': return 'Materialización completa';
      case 'partial': return 'Materialización parcial';
      case 'unavailable': return 'Backfill no materializado';
      case 'incompatible': return 'Versiones incompatibles';
    }
  }

  protected mechanicRelationshipLabel(value: NightPlayerMechanicOffenseAudit['relationship']): string {
    switch (value) {
      case 'primary_owner': return 'Responsable principal';
      case 'co_owner': return 'Corresponsable';
      case 'assigned_resolver': return 'Asignado';
    }
  }

  protected deathVerdictLabel(row: NightPlayerDeathAuditRow): string {
    if (row.verdict === 'uncertain') return 'Causa incierta';
    if (row.penaltyEligible) return 'Fallo atribuible';
    return 'Contexto no punitivo';
  }

  protected deathTone(row: NightPlayerDeathAuditRow): string {
    if (row.verdict === 'uncertain') return 'warning';
    if (row.penaltyEligible) return 'negative';
    return 'neutral';
  }

  protected toggleMechanic(row: NightPlayerMechanicOffenseAudit): void {
    this.expandedMechanicEventId.update((current) => current === row.eventId ? null : row.eventId);
  }

  protected toggleDeath(row: NightPlayerDeathAuditRow): void {
    this.expandedDeathEventId.update((current) => current === row.eventId ? null : row.eventId);
  }

  protected evidenceJson(value: Record<string, unknown>): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return '{}';
    }
  }

  private async load(reportCode: string, playerName: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.expandedMechanicEventId.set(null);
    this.expandedDeathEventId.set(null);
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
