// Colocar en: src/app/features/live-pull/coaching-callout-list.component.ts
import { Component, input, output } from '@angular/core';
import type { CoachingCallout } from '../../shared/models/ui';

@Component({
  selector: 'app-coaching-callout-list',
  standalone: true,
  templateUrl: './coaching-callout-list.component.html',
  styleUrl: './coaching-callout-list.component.scss',
})
export class CoachingCalloutListComponent {
  callouts = input.required<CoachingCallout[]>();
  loading = input(false);
  calloutSelected = output<CoachingCallout>();

  iconFor(severity: CoachingCallout['severity']): string {
    // switch de 3 casos, tal como pide la spec — el dato no viene de fuera.
    switch (severity) {
      case 'critical':
        return '💀';
      case 'warning':
        return '⏱';
      case 'positive':
        return '✓';
    }
  }

  severityLabel(severity: CoachingCallout['severity']): string {
    switch (severity) {
      case 'critical':
        return 'Crítico';
      case 'warning':
        return 'Aviso';
      case 'positive':
        return 'Mejora';
    }
  }
}
