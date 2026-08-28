// Colocar en: src/app/features/live-pull/coaching-callout-list.component.ts
// §"A quién dirigir": dos pestañas — Mecánicas (falló algo sin morir) y
// Muertes — en vez de una única tabla mezclando ambas. Feedback real: "la
// tabla que has hecho con infinitos iconos de habilidades no es nada
// práctica... solo había que meter de forma ordenada los datos que te
// comenté, no llenar todo de iconos o convertirlo en una tabla 100%" — así
// que cada fila lleva UN icono (el de la mecánica), el resto es texto plano
// bien alineado en columnas fijas (grid, no <table>).
import { Component, computed, effect, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import type { CoachingCallout, MechanicFailRow, ProvenanceEntry } from '../../shared/models/ui';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { ClassIconComponent } from '../../shared/class-icon.component';
import { MechanicInfoIconComponent } from '../../shared/mechanic-info-icon.component';
import { mechanicCategoryMeta } from '../../shared/format.util';
import type { ExecutionIncidentSummary } from '../../shared/pull-consistency.util';

@Component({
  selector: 'app-coaching-callout-list',
  standalone: true,
  imports: [DecimalPipe, WowheadLinkComponent, ClassIconComponent, MechanicInfoIconComponent],
  templateUrl: './coaching-callout-list.component.html',
  styleUrl: './coaching-callout-list.component.scss',
})
export class CoachingCalloutListComponent {
  callouts = input.required<CoachingCallout[]>(); // pestaña Muertes
  mechanicFails = input.required<MechanicFailRow[]>(); // pestaña Mecánicas
  incidentSummary = input.required<ExecutionIncidentSummary>();
  provenanceRequested = output<ProvenanceEntry>();

  activeTab = signal<'mechanics' | 'deaths'>('mechanics');
  expanded = signal(false);
  private tabChosenManually = false;

  // §"no debería... contar como muerte, marcado como wipe call": una fila
  // wipe-call se SIGUE mostrando (el RL quiere verla) pero no infla el
  // contador de la pestaña — mismo criterio que ya excluye estas filas de
  // deathsCard/fiabilidad/racha en pull-analysis.service.ts.
  deathCount = computed(() => this.callouts().filter((c) => c.severity === 'critical' && !c.isWipeCall && !c.statisticalExclusionReason).length);
  streakCount = computed(() => this.callouts().filter((c) => c.severity === 'positive').length);
  deathRows = computed(() => this.callouts().filter((callout) => callout.severity === 'critical'));
  positiveRows = computed(() => this.callouts().filter((callout) => callout.severity === 'positive'));
  visibleMechanicFails = computed(() => (this.expanded() ? this.mechanicFails() : this.mechanicFails().slice(0, 5)));
  visibleDeaths = computed(() => (this.expanded() ? this.deathRows() : this.deathRows().slice(0, 5)));
  hiddenRowCount = computed(() => {
    const total = this.activeTab() === 'mechanics' ? this.mechanicFails().length : this.deathRows().length;
    return this.expanded() ? 0 : Math.max(0, total - 5);
  });

  constructor() {
    effect(() => {
      const mechanics = this.mechanicFails().length;
      const deaths = this.deathCount();
      if (this.tabChosenManually) return;
      this.activeTab.set(mechanics > 0 ? 'mechanics' : deaths > 0 ? 'deaths' : 'mechanics');
    });
  }

  selectTab(tab: 'mechanics' | 'deaths'): void {
    this.tabChosenManually = true;
    this.expanded.set(false);
    this.activeTab.set(tab);
  }

  categoryMeta = mechanicCategoryMeta;

  outcomeLabel(outcome: MechanicFailRow['outcome']): string {
    return outcome === 'fail' ? 'Fallo' : 'Aviso';
  }

  availableDefensiveNames(callout: CoachingCallout): string {
    return callout.defensivesAvailable.map((defensive) => defensive.name).join(', ');
  }
}
