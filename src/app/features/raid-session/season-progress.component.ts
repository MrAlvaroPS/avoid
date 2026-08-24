// Colocar en: src/app/features/raid-session/season-progress.component.ts
// §7.3: "bosses matados / totales de la instancia" — antes bloqueado por no
// tener un catálogo de "todos los bosses" en ningún sitio; known_raid_bosses
// (§9.1, sync-season-bosses) ya lo da. Mismo lenguaje visual que
// metric-card.component (cifra grande, tarjeta con gradiente) para que se
// lea como parte de la misma familia de widgets, no un elemento suelto.
import { Component, computed, inject, signal } from '@angular/core';
import { ReportsService } from '../../core/reports.service';

@Component({
  selector: 'app-season-progress',
  standalone: true,
  template: `
    @if (!loading() && total() > 0) {
      <div class="season-progress" role="status">
        <span class="label">Progreso de temporada</span>
        <div class="body">
          <span class="value">{{ killed() }}<span class="value-of">/{{ total() }}</span></span>
          <div class="gauge-track"><div class="gauge-fill" [style.width.%]="pct()"></div></div>
        </div>
        <span class="sub">bosses matados</span>
      </div>
    }
  `,
  styles: [
    `
      .season-progress {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px 16px;
        background: linear-gradient(180deg, var(--surface-2) 0%, var(--surface) 100%);
        border: 1px solid var(--card-border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-card), var(--shadow-inset-top);
      }
      .label {
        font-size: 10.5px;
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .body {
        display: flex;
        align-items: baseline;
        gap: 10px;
      }
      .value {
        font-size: 24px;
        font-weight: 700;
        line-height: 1;
        color: var(--text);
        font-family: var(--font-mono);
      }
      .value-of {
        font-size: 15px;
        font-weight: 600;
        color: var(--text-faint);
      }
      .gauge-track {
        flex: 1;
        height: 5px;
        background: var(--surface-2);
        border-radius: 3px;
        overflow: hidden;
      }
      .gauge-fill {
        height: 100%;
        background: var(--gold);
        border-radius: 3px;
        min-width: 2px;
      }
      .sub {
        font-size: 10.5px;
        color: var(--text-faint);
      }
    `,
  ],
})
export class SeasonProgressComponent {
  private reportsService = inject(ReportsService);

  killed = signal(0);
  total = signal(0);
  loading = signal(true);

  pct = computed(() => (this.total() > 0 ? (this.killed() / this.total()) * 100 : 0));

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const { killed, total } = await this.reportsService.getSeasonProgress();
      this.killed.set(killed);
      this.total.set(total);
    } catch {
      // Silencioso a propósito: es un widget secundario junto al picker
      // principal — si known_raid_bosses no está sincronizado todavía, no
      // tiene sentido tapar el resto de la pantalla con un error por esto.
    } finally {
      this.loading.set(false);
    }
  }
}
