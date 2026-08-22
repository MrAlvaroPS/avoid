// Colocar en: src/app/features/live-pull/metric-card.component.ts
// "Tonto a propósito" (spec §15.1): solo pinta lo que le dan, no deriva nada.
import { Component, computed, input, output } from '@angular/core';
import type { MetricDelta } from '../../shared/models/ui';
import { GaugeComponent, type GaugeTone } from '../../shared/charts/gauge.component';

@Component({
  selector: 'app-metric-card',
  standalone: true,
  imports: [GaugeComponent],
  templateUrl: './metric-card.component.html',
  styleUrl: './metric-card.component.scss',
})
export class MetricCardComponent {
  label = input.required<string>();
  value = input.required<string>();
  delta = input<MetricDelta | null>(null);
  loading = input(false);
  icon = input<string>('');
  iconTone = input<'accent' | 'danger' | 'warning' | 'gold'>('accent');
  gaugeValue = input<number | undefined>(undefined);

  activated = output<void>();

  // El gauge toma el tono de la delta si la hay (así "va mejor/peor" se ve
  // en el propio color del arco, no solo en el texto de abajo) — sin delta
  // (primer pull de la noche), neutral.
  gaugeTone = computed<GaugeTone>(() => {
    const d = this.delta();
    if (!d) return 'neutral';
    if (d.tone === 'success') return 'success';
    if (d.tone === 'danger') return 'danger';
    if (d.tone === 'warning') return 'warning';
    return 'neutral';
  });
}
