import { Component, computed, HostListener, input, output } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { effectiveAxisWeights, type DefensiveDeathEvidence, type PlayerReliability } from '../../core/reliability.service';
import { RoleIconComponent } from '../../shared/role-icon.component';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import type { RosterPlayerView } from './roster-view.util';

@Component({
  selector: 'app-roster-player-drawer',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink, RoleIconComponent, WowheadLinkComponent],
  templateUrl: './roster-player-drawer.component.html',
  styleUrl: './roster-player-drawer.component.scss',
})
export class RosterPlayerDrawerComponent {
  view = input.required<RosterPlayerView>();
  close = output<void>();

  // §"venir sin la preparación penaliza si no se hace... no cuenta para
  // sumar" (feedback real, 2026-08-30): el peso de Mecánica que se enseña
  // en la rejilla de ejes ya no es un "44%" fijo — sale de
  // effectiveAxisWeights porque preparación puede quedar fuera del blend.
  axisWeights = computed(() => effectiveAxisWeights(this.view().player.breakdown));

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

  wclUrl(evidence: DefensiveDeathEvidence): string {
    return `https://www.warcraftlogs.com/reports/${evidence.reportCode}#fight=${evidence.fightId}&type=deaths`;
  }

  cooldownSeconds(milliseconds: number | null): string {
    if (milliseconds == null) return 'en cooldown';
    return `${Math.max(1, Math.ceil(milliseconds / 1000))} s restantes`;
  }
}
