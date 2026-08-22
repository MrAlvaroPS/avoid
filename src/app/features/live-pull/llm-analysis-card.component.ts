// Colocar en: src/app/features/live-pull/llm-analysis-card.component.ts
import { Component, input, output } from '@angular/core';
import type { LlmPullAnalysis } from '../../shared/models/ui';

@Component({
  selector: 'app-llm-analysis-card',
  standalone: true,
  templateUrl: './llm-analysis-card.component.html',
  styleUrl: './llm-analysis-card.component.scss',
})
export class LlmAnalysisCardComponent {
  analysis = input.required<LlmPullAnalysis | null>();
  generating = input(false);
  error = input<string | null>(null);
  generateRequested = output<void>();
}
