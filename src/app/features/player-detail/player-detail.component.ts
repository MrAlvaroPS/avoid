// Colocar en: src/app/features/player-detail/player-detail.component.ts
// §"detalle de jugador con su tendencia en el tiempo": ruta /player/:name —
// toda la agregación vive en player-detail.service.ts, este componente solo
// pinta. Mismo patrón que boss-history.component.ts (ruta con input
// vinculado, effect() en el constructor por NG0950).
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { PlayerDetailService, type PlayerDetail } from '../../core/player-detail.service';
import { mechanicCategoryMeta, rootCauseMeta } from '../../shared/format.util';
import { TrendBarsComponent, type TrendBar } from '../../shared/charts/trend-bars.component';
import { RoleIconComponent } from '../../shared/role-icon.component';
import { EmptyPanelComponent } from '../../shared/empty-panel.component';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { MechanicInfoIconComponent } from '../../shared/mechanic-info-icon.component';
import type { DeathCause, MechanicCategory } from '../../shared/models/domain';
import { errorMessage } from '../../shared/error-message.util';

@Component({
  selector: 'app-player-detail',
  standalone: true,
  imports: [DatePipe, RouterLink, TrendBarsComponent, RoleIconComponent, EmptyPanelComponent, WowheadLinkComponent, MechanicInfoIconComponent],
  templateUrl: './player-detail.component.html',
  styleUrl: './player-detail.component.scss',
})
export class PlayerDetailComponent {
  private playerDetailService = inject(PlayerDetailService);

  name = input.required<string>();

  data = signal<PlayerDetail | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);

  categoryMeta = mechanicCategoryMeta;

  weeklyBars = computed<TrendBar[]>(() => {
    const d = this.data();
    if (!d) return [];
    return d.weeklyScores.map((w) => ({
      label: w.weekStartLabel,
      value: w.score ?? 0,
      // Reuso de is-kill como "semana buena" (>=75) — no es literalmente un
      // kill, pero es el mismo lenguaje visual (verde = bien) sin construir
      // un componente nuevo solo para esto.
      isKill: w.score != null && w.score >= 75,
      isCurrent: w.isCurrent,
      tooltip: w.sampleSize === 0 ? `Semana del ${w.weekStartLabel}: sin pulls` : `Semana del ${w.weekStartLabel}: ${w.score}/100 (${w.sampleSize} pull${w.sampleSize === 1 ? '' : 's'})`,
    }));
  });

  weeklyConsistencyBars = computed<TrendBar[]>(() => {
    const d = this.data();
    if (!d) return [];
    return d.weeklyScores.map((week) => ({
      label: week.weekStartLabel,
      value: week.consistencyScore ?? 0,
      isKill: week.consistencyScore != null && week.consistencyScore >= 75,
      isCurrent: week.isCurrent,
      tooltip: week.consistencyScore == null
        ? `Semana del ${week.weekStartLabel}: hacen falta al menos 5 pulls para medir consistencia`
        : `Semana del ${week.weekStartLabel}: consistencia ${week.consistencyScore}/100 (${week.sampleSize} pulls)`,
    }));
  });

  constructor() {
    effect(() => {
      const name = this.name();
      void this.load(name);
    });
  }

  private async load(name: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.data.set(await this.playerDetailService.load(name));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  // §"limpiar todo eso que pone 'sin clasificar' y que de hecho, esté
  // clasificado" (feedback real, mismo criterio que night-player-dossier):
  // rootCause 'unclassified' es honesto sobre no saber el MECANISMO exacto,
  // no significa que la mecánica no tenga categoría — si la tiene, se enseña.
  rootCauseLabel(cause: DeathCause['rootCause'], category: MechanicCategory | null): string {
    if (cause !== 'unclassified') return rootCauseMeta(cause)?.label ?? cause;
    return mechanicCategoryMeta(category)?.label ?? rootCauseMeta('unclassified')!.label;
  }

  defensiveLabel(preventable: boolean | null): string {
    if (preventable == null) return 'Sin dato';
    return preventable ? 'Sí, tenía uno disponible' : 'No';
  }
}
