// Colocar en: src/app/features/live-pull/pull-header.component.ts
import { Component, computed, input } from '@angular/core';
import type { PullDifficulty, PullResult, ReferencePacing } from '../../shared/models/ui';

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
  attemptNumber = input.required<number>();
  durationLabel = input.required<string>();
  bossHpRemainingPct = input.required<number>();
  result = input.required<PullResult>();
  /** Score compuesto de §13 vs. el pull anterior — null si es el primero de la noche sobre este boss. */
  progressDeltaPct = input<number | null>(null);
  /** Ritmo vs. el mejor kill público — null si no hay benchmark todavía o el pull no fue kill. */
  referencePacing = input<ReferencePacing | null>(null);
  /** §"fases de encuentro... en todos los sitios donde corresponda": "Fase X/N — Nombre", null si el boss no tiene fases. */
  phaseLabel = input<string | null>(null);

  difficultyLabel = computed(() => DIFFICULTY_LABEL[this.difficulty()]);
  resultLabel = computed(() => (this.result() === 'kill' ? 'Kill' : 'Wipe'));
}
