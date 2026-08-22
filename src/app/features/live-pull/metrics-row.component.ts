// Colocar en: src/app/features/live-pull/metrics-row.component.ts
import { Component, input, output } from '@angular/core';
import { MetricCardComponent } from './metric-card.component';
import type { MetricCardData, ProvenanceEntry } from '../../shared/models/ui';

@Component({
  selector: 'app-metrics-row',
  standalone: true,
  imports: [MetricCardComponent],
  templateUrl: './metrics-row.component.html',
  styleUrl: './metrics-row.component.scss',
})
export class MetricsRowComponent {
  metrics = input.required<MetricCardData[]>();
  loading = input(false);
  provenanceRequested = output<ProvenanceEntry>();
}
