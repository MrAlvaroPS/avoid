import { Component, effect, inject, input, output, signal } from '@angular/core';
import {
  CausalMaterializationOperatorService,
  type CausalMaterializationOperatorStatus,
  type EnqueueCausalBackfillResult,
  type ProcessCausalQueueBatchResult,
} from '../../core/causal-materialization-operator.service';
import { errorMessage } from '../../shared/error-message.util';

@Component({
  selector: 'app-night-player-causal-operator',
  standalone: true,
  templateUrl: './night-player-causal-operator.component.html',
  styleUrl: './night-player-causal-operator.component.scss',
})
export class NightPlayerCausalOperatorComponent {
  private readonly operator = inject(CausalMaterializationOperatorService);

  reportCode = input.required<string>();
  playerName = input.required<string>();
  changed = output<void>();

  protected readonly status = signal<CausalMaterializationOperatorStatus | null>(null);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly enqueueResult = signal<EnqueueCausalBackfillResult | null>(null);
  protected readonly processResult = signal<ProcessCausalQueueBatchResult | null>(null);

  constructor() {
    effect(() => {
      void this.reload(this.reportCode(), this.playerName());
    });
  }

  protected async enqueue(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.processResult.set(null);
    try {
      const result = await this.operator.enqueue(this.reportCode(), this.playerName());
      this.enqueueResult.set(result);
      await this.reload(this.reportCode(), this.playerName(), false);
      this.changed.emit();
    } catch (caught) {
      this.error.set(errorMessage(caught));
    } finally {
      this.busy.set(false);
    }
  }

  protected async processBatch(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.enqueueResult.set(null);
    try {
      const result = await this.operator.processBatch(10);
      this.processResult.set(result);
      await this.reload(this.reportCode(), this.playerName(), false);
      this.changed.emit();
    } catch (caught) {
      this.error.set(errorMessage(caught));
    } finally {
      this.busy.set(false);
    }
  }

  protected refresh(): void {
    void this.reload(this.reportCode(), this.playerName());
  }

  private async reload(reportCode: string, playerName: string, manageLoading = true): Promise<void> {
    if (manageLoading) this.loading.set(true);
    this.error.set(null);
    try {
      this.status.set(await this.operator.status(reportCode, playerName));
    } catch (caught) {
      this.status.set(null);
      this.error.set(errorMessage(caught));
    } finally {
      if (manageLoading) this.loading.set(false);
    }
  }
}
