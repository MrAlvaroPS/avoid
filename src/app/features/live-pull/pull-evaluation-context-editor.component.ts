import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PullAnalysisService } from '../../core/pull-analysis.service';
import { errorMessage } from '../../shared/error-message.util';
import type { PullEvaluationContextContract } from '../../../../supabase/functions/_shared/combat-evaluation-contract';

@Component({
  selector: 'app-pull-evaluation-context-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './pull-evaluation-context-editor.component.html',
  styleUrl: './pull-evaluation-context-editor.component.scss',
})
export class PullEvaluationContextEditorComponent {
  private pullAnalysis = inject(PullAnalysisService);

  pullId = input.required<string>();
  durationMs = input.required<number>();
  context = input.required<PullEvaluationContextContract>();
  contextChanged = output<void>();

  isOpen = signal(false);
  isSaving = signal(false);
  error = signal<string | null>(null);
  
  // Editor form state
  evaluationEligible = signal(false);
  evaluationStartSec = signal(0);
  evaluationEndSec = signal(0);
  wipeCallAtSec = signal<number | null>(null);
  wipeBoundaryVerified = signal(false);
  ninjaConfirmed = signal(false);
  overrideReason = signal('');

  // Computed display properties
  evaluableIntervalMs = computed(() => {
    const ctx = this.context();
    return {
      startMs: ctx.evaluationStartMs,
      endMs: ctx.evaluationEndMs,
      durationMs: ctx.evaluationEndMs - ctx.evaluationStartMs,
    };
  });

  evaluationEligibilityLabel = computed(() => {
    const ctx = this.context();
    if (ctx.ninjaStatus === 'confirmed') return 'Ninja confirmado (no evaluable)';
    if (ctx.ninjaStatus === 'probable') return 'Probable ninja (pendiente revisión)';
    if (!ctx.evaluationEligible) return 'No evaluable (inválido)';
    return 'Evaluable';
  });

  openEditor(): void {
    const ctx = this.context();
    this.evaluationEligible.set(ctx.evaluationEligible);
    this.evaluationStartSec.set(ctx.evaluationStartMs / 1000);
    this.evaluationEndSec.set(ctx.evaluationEndMs / 1000);
    this.wipeCallAtSec.set(ctx.wipeCallAtMs ? ctx.wipeCallAtMs / 1000 : null);
    this.wipeBoundaryVerified.set(ctx.wipeCallVerified);
    this.ninjaConfirmed.set(ctx.ninjaStatus === 'confirmed');
    this.overrideReason.set('');
    this.error.set(null);
    this.isOpen.set(true);
  }

  closeEditor(): void {
    this.isOpen.set(false);
  }

  async saveOverride(): Promise<void> {
    if (!this.overrideReason().trim()) {
      this.error.set('Debes proporcionar una razón para el cambio.');
      return;
    }

    this.isSaving.set(true);
    this.error.set(null);

    try {
      const ctx = this.context();
      const startMs = Math.round(this.evaluationStartSec() * 1000);
      const endMs = Math.round(this.evaluationEndSec() * 1000);
      const wipeMs = this.wipeCallAtSec() != null ? Math.round(this.wipeCallAtSec()! * 1000) : null;

      // Validate bounds
      if (startMs < 0 || endMs < startMs || endMs > this.durationMs()) {
        this.error.set(`Intervalo inválido: [${startMs}, ${endMs}] no está dentro de [0, ${this.durationMs()}].`);
        return;
      }

      if (wipeMs != null && (wipeMs < startMs || wipeMs > endMs)) {
        this.error.set(`Límite de wipe inválido: ${wipeMs}ms debe estar dentro del intervalo evaluable.`);
        return;
      }

      await this.pullAnalysis.setPullEvaluationContext({
        pullId: this.pullId(),
        action: 'override_context',
        evaluationEligible: this.evaluationEligible(),
        evaluationStartMs: startMs,
        evaluationEndMs: endMs,
        wipeCallAtMs: wipeMs,
        wipeCallVerified: this.wipeBoundaryVerified(),
        ninjaConfirmed: this.ninjaConfirmed(),
        reason: this.overrideReason().trim(),
      });

      this.contextChanged.emit();
      this.closeEditor();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.isSaving.set(false);
    }
  }

  formatSeconds(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  getWipeCallCandidateBoundaryMs(): number {
    const evidence = this.context().evidence;
    const candidate = evidence && typeof evidence === 'object' && 'wipeCallCandidate' in evidence
      ? (evidence as Record<string, any>)['wipeCallCandidate']
      : null;
    return candidate && typeof candidate.boundaryMs === 'number' ? candidate.boundaryMs : 0;
  }

  onOverrideReasonInput(event: Event): void {
    const textarea = event.target as HTMLTextAreaElement;
    this.overrideReason.set(textarea.value);
  }

  formatContextChange(): string {
    const ctx = this.context();
    const changes: string[] = [];
    
    if (this.evaluationStartSec() * 1000 !== ctx.evaluationStartMs) {
      changes.push(`inicio: ${this.formatSeconds(this.evaluationStartSec())}`);
    }
    if (this.evaluationEndSec() * 1000 !== ctx.evaluationEndMs) {
      changes.push(`fin: ${this.formatSeconds(this.evaluationEndSec())}`);
    }
    if ((this.wipeCallAtSec() != null ? Math.round(this.wipeCallAtSec()! * 1000) : null) !== ctx.wipeCallAtMs) {
      if (this.wipeCallAtSec() != null) {
        changes.push(`wipe en: ${this.formatSeconds(this.wipeCallAtSec()!)}`);
      } else {
        changes.push('limpiar wipe');
      }
    }
    if (this.ninjaConfirmed() !== (ctx.ninjaStatus === 'confirmed')) {
      changes.push(this.ninjaConfirmed() ? 'confirmar ninja' : 'restaurar de ninja');
    }

    return changes.length > 0 ? changes.join(', ') : 'sin cambios';
  }
}
