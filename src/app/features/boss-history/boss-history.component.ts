// Colocar en: src/app/features/boss-history/boss-history.component.ts
// §"un 'todos los pulls' que reúna datos de los pulls de ese boss en esa
// dificultad, ver progresos en mecánicas, mejoras, etc" (feedback real).
// Ruta /boss/:bossId/:difficulty — toda la agregación vive en
// boss-history.service.ts, este componente solo pinta.
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { BossHistoryService, type BossHistoryData } from '../../core/boss-history.service';
import { formatDuration, formatPct, mechanicCategoryMeta } from '../../shared/format.util';
import { TrendBarsComponent, type TrendBar } from '../../shared/charts/trend-bars.component';
import { CompareBarRowComponent } from '../live-pull/compare-bar-row.component';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { RoleIconComponent } from '../../shared/role-icon.component';
import { EmptyPanelComponent } from '../../shared/empty-panel.component';
import { MechanicInfoIconComponent } from '../../shared/mechanic-info-icon.component';

@Component({
  selector: 'app-boss-history',
  standalone: true,
  imports: [DatePipe, RouterLink, TrendBarsComponent, CompareBarRowComponent, WowheadLinkComponent, RoleIconComponent, EmptyPanelComponent, MechanicInfoIconComponent],
  templateUrl: './boss-history.component.html',
  styleUrl: './boss-history.component.scss',
})
export class BossHistoryComponent {
  private bossHistoryService = inject(BossHistoryService);

  bossId = input.required<string>();
  difficulty = input.required<string>();

  data = signal<BossHistoryData | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);

  categoryMeta = mechanicCategoryMeta;
  formatDuration = formatDuration;
  formatPct = formatPct;

  progressionBars = computed<TrendBar[]>(() => {
    const d = this.data();
    if (!d) return [];
    return d.progression.map((p) => ({
      label: `#${p.pullNumber}`,
      value: 100 - p.wipePct,
      isKill: p.kill,
      isCurrent: false,
      tooltip: `Intento #${p.pullNumber} · ${p.kill ? 'Kill' : `${p.wipePct.toFixed(1)}% HP restante`}${p.durationMs != null ? ' · ' + formatDuration(p.durationMs) : ''}`,
    }));
  });

  // §bug real ya visto en LivePullComponent: leer un input() (incluido el
  // vinculado por ruta vía withComponentInputBinding) DENTRO del
  // constructor revienta con NG0950 — Angular lo asigna DESPUÉS de
  // construir la instancia, no antes. effect() sí espera a que el input
  // exista, y además re-carga solo si bossId/difficulty cambian (navegar
  // de un boss a otro sin recargar toda la página).
  constructor() {
    effect(() => {
      const bossId = this.bossId();
      const difficulty = this.difficulty();
      void this.load(bossId, difficulty);
    });
  }

  private async load(bossId: string, difficulty: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.data.set(await this.bossHistoryService.load(bossId, difficulty));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  trendLabel(trend: 'improving' | 'worsening' | 'flat' | null): string {
    switch (trend) {
      case 'improving':
        return 'Mejorando';
      case 'worsening':
        return 'Empeorando';
      case 'flat':
        return 'Estable';
      default:
        return 'Muestra insuficiente para comparar';
    }
  }

  reliabilityTone(score: number): 'danger' | 'warning' | 'success' {
    if (score < 50) return 'danger';
    if (score < 75) return 'warning';
    return 'success';
  }
}
