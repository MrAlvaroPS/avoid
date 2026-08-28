import { Component, HostListener, input, output } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { PlayerReliability } from '../../core/reliability.service';
import { RoleIconComponent } from '../../shared/role-icon.component';
import type { RosterPlayerView } from './roster-view.util';

@Component({
  selector: 'app-roster-player-drawer',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink, RoleIconComponent],
  templateUrl: './roster-player-drawer.component.html',
  styleUrl: './roster-player-drawer.component.scss',
})
export class RosterPlayerDrawerComponent {
  view = input.required<RosterPlayerView>();
  close = output<void>();

  @HostListener('document:keydown.escape')
  closeOnEscape(): void {
    this.close.emit();
  }

  confidenceLabel(view: RosterPlayerView): string {
    switch (view.evidenceLevel) {
      case 'high':
        return 'Evidencia alta';
      case 'medium':
        return 'Evidencia media';
      case 'low':
        return 'Evidencia inicial';
      default:
        return 'Sin evidencia';
    }
  }

  trendLabel(trend: PlayerReliability['trend']): string {
    if (trend === 'up') return 'Mejorando';
    if (trend === 'down') return 'A la baja';
    if (trend === 'flat') return 'Estable';
    return 'Sin comparación';
  }

  axisTone(score: number | null): 'good' | 'warning' | 'danger' | 'empty' {
    if (score == null) return 'empty';
    if (score < 50) return 'danger';
    if (score < 75) return 'warning';
    return 'good';
  }
}
