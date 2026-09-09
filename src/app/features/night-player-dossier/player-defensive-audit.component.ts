import { Component, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { errorMessage } from '../../shared/error-message.util';
import type {
  DefensiveAuditDiscordSendResult,
  DefensiveNightAudit,
} from '../../../../supabase/functions/_shared/player-defensive-audit-contract';
import { defensiveAuditDiscordSendDisabled } from '../../../../supabase/functions/_shared/player-defensive-audit-contract';

@Component({
  selector: 'app-player-defensive-audit',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './player-defensive-audit.component.html',
  styleUrl: './player-defensive-audit.component.scss',
})
export class PlayerDefensiveAuditComponent {
  private edgeFunctions = inject(EdgeFunctionsService);

  audit = input.required<DefensiveNightAudit>();
  rosterCharacterId = input<number | null>(null);
  hasDiscordChannel = input(false);

  sendStatus = signal<'idle' | 'sending' | 'sent' | 'partial_error' | 'error'>('idle');
  sendError = signal<string | null>(null);
  sendProgress = signal<{ sent: number; total: number } | null>(null);
  private resumeAt = 0;

  sendLabel(): string {
    const audit = this.audit();
    if (audit.state !== 'available') return 'Esperando evaluación defensiva…';
    if (this.sendStatus() === 'sending') return 'Enviando…';
    if (this.sendStatus() === 'sent') return '✓ Enviado';
    if (this.sendStatus() === 'partial_error') {
      const progress = this.sendProgress();
      return progress ? `Enviadas ${progress.sent}/${progress.total} partes · completar envío` : 'Completar envío';
    }
    return 'Enviar a Discord';
  }

  sendDisabled(): boolean {
    return defensiveAuditDiscordSendDisabled(
      this.audit(),
      this.rosterCharacterId(),
      this.hasDiscordChannel(),
      this.sendStatus(),
    );
  }

  async sendToDiscord(): Promise<void> {
    if (this.sendDisabled()) return;
    const characterId = this.rosterCharacterId();
    if (characterId == null) return;
    this.sendStatus.set('sending');
    this.sendError.set(null);
    try {
      const result: DefensiveAuditDiscordSendResult = await this.edgeFunctions.sendPlayerDefensiveAuditToDiscord({
        rosterCharacterId: characterId,
        playerName: this.audit().playerName,
        parts: this.audit().discordParts,
        startPartIndex: this.resumeAt,
      });
      if (result.ok) {
        this.resumeAt = 0;
        this.sendProgress.set({ sent: result.parts, total: result.parts });
        this.sendStatus.set('sent');
        setTimeout(() => this.sendStatus.set('idle'), 3000);
        return;
      }
      this.sendProgress.set({ sent: result.sentParts, total: result.parts });
      this.resumeAt = result.failedPartIndex ?? result.sentParts;
      this.sendError.set(result.error ?? 'Discord no aceptó una de las partes.');
      this.sendStatus.set(result.sentParts > 0 ? 'partial_error' : 'error');
    } catch (err) {
      this.sendError.set(errorMessage(err));
      this.sendStatus.set('error');
    }
  }
}
