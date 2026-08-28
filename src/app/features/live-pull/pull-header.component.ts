// Colocar en: src/app/features/live-pull/pull-header.component.ts
import { Component, computed, input } from '@angular/core';
import type { PullDifficulty, PullResult, ReferencePacing } from '../../shared/models/ui';
import type { AttemptComparison } from '../../shared/pull-consistency.util';

const DIFFICULTY_LABEL: Record<PullDifficulty, string> = {
  lfr: 'LFR',
  normal: 'Normal',
  heroic: 'Heroic',
  mythic: 'Mythic',
};

@Component({
  selector: 'app-pull-header',
  standalone: true,
  templateUrl: './pull-header.component.html',
  styleUrl: './pull-header.component.scss',
})
export class PullHeaderComponent {
  encounterName = input.required<string>();
  difficulty = input.required<PullDifficulty>();
  attemptNumber = input.required<number | null>();
  rawPullNumber = input.required<number>();
  durationLabel = input.required<string>();
  bossHpRemainingPct = input.required<number>();
  result = input.required<PullResult>();
  attemptComparison = input<AttemptComparison | null>(null);
  /** Ritmo vs. el mejor kill público — null si no hay benchmark todavía o el pull no fue kill. */
  referencePacing = input<ReferencePacing | null>(null);
  /** §"fases de encuentro... en todos los sitios donde corresponda": "Fase X/N — Nombre", null si el boss no tiene fases. */
  phaseLabel = input<string | null>(null);

  difficultyLabel = computed(() => DIFFICULTY_LABEL[this.difficulty()]);
  resultLabel = computed(() => (this.result() === 'kill' ? 'Kill' : 'Wipe'));

  comparisonLabel = computed(() => {
    const comparison = this.attemptComparison();
    if (!comparison) return null;
    const verdict = {
      improved: 'Mejoró',
      regressed: 'Empeoró',
      mixed: 'Resultado mixto',
      unchanged: 'Sin cambios',
    }[comparison.verdict];
    return `${verdict} vs. intento válido #${comparison.previousAttemptNumber}`;
  });

  signed(value: number, suffix: string): string {
    const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return `${value > 0 ? '+' : ''}${rounded}${suffix}`;
  }
}
