import { Component, effect, inject, input, signal } from '@angular/core';
import {
  CausalMechanicAcceptanceService,
  type CausalAcceptanceCheck,
  type CausalMechanicAcceptanceReport,
} from '../../core/causal-mechanic-acceptance.service';
import { errorMessage } from '../../shared/error-message.util';

@Component({
  selector: 'app-night-player-causal-acceptance',
  standalone: true,
  templateUrl: './night-player-causal-acceptance.component.html',
  styleUrl: './night-player-causal-acceptance.component.scss',
})
export class NightPlayerCausalAcceptanceComponent {
  private readonly service = inject(CausalMechanicAcceptanceService);

  reportCode = input.required<string>();
  playerName = input.required<string>();
  refreshToken = input(0);

  protected readonly data = signal<CausalMechanicAcceptanceReport | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const reportCode = this.reportCode();
      const playerName = this.playerName();
      this.refreshToken();
      void this.load(reportCode, playerName);
    });
  }

  protected stateLabel(check: CausalAcceptanceCheck): string {
    switch (check.state) {
      case 'pass': return 'PASS';
      case 'fail': return 'FAIL';
      case 'pending': return 'PENDIENTE';
      case 'warning': return 'REVISAR';
    }
  }

  private async load(reportCode: string, playerName: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.data.set(await this.service.load(reportCode, playerName));
    } catch (caught) {
      this.data.set(null);
      this.error.set(errorMessage(caught));
    } finally {
      this.loading.set(false);
    }
  }
}
