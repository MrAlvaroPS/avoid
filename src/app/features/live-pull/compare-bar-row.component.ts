// Colocar en: src/app/features/live-pull/compare-bar-row.component.ts
// §7.2: comparativa contra boss_reference_stats como componente visual
// dedicado (dos barras, vuestro pull vs. la mediana pública), en vez de una
// línea de texto suelta en la cabecera — el dato ya se traía y se guardaba
// (ReferencePacing.yourDurationMs/medianDurationMs), solo faltaba el peso
// visual. Solo aparece en un kill con referencia disponible (mismo guard que
// ya aplicaba buildReferencePacing) — un wipe no tiene duración comparable.
import { Component, computed, input } from '@angular/core';
import type { ReferencePacing } from '../../shared/models/ui';
import { formatDuration } from '../../shared/format.util';

@Component({
  selector: 'app-compare-bar-row',
  standalone: true,
  template: `
    @if (pacing(); as p) {
      <section class="compare-panel" aria-labelledby="compare-heading">
        <h2 id="compare-heading" class="widget-heading">Ritmo vs. kills públicas</h2>
        <div class="compare-bar-row">
          <span class="row-label">Vosotros</span>
          <div class="bar-track">
            <div class="bar-fill fill-you" [style.width.%]="yourPct()"></div>
          </div>
          <span class="row-value tabular">{{ formatDuration(p.yourDurationMs) }}</span>
        </div>
        <div class="compare-bar-row">
          <span class="row-label">Mediana pública</span>
          <div class="bar-track">
            <div class="bar-fill fill-median" [style.width.%]="medianPct()"></div>
          </div>
          <span class="row-value tabular">{{ formatDuration(p.medianDurationMs) }}</span>
        </div>
        <p class="compare-note" [class.tone-success]="p.tone === 'success'" [class.tone-warning]="p.tone === 'warning'">
          {{ p.label }}
          @if (p.zeroDeathContext) {
            <span class="zero-death">{{ p.zeroDeathContext }}</span>
          }
        </p>
      </section>
    }
  `,
  styles: [
    `
      .compare-panel {
        background: linear-gradient(180deg, var(--surface-2) 0%, var(--surface) 100%);
        border: 1px solid var(--card-border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-card), var(--shadow-inset-top);
        padding: 16px;
      }
      .widget-heading {
        margin: 0 0 12px;
        font-size: 13px;
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .compare-bar-row {
        display: grid;
        grid-template-columns: 96px 1fr 60px;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
      }
      .row-label {
        font-size: 12px;
        color: var(--text-muted);
      }
      .row-value {
        font-size: 12.5px;
        color: var(--text);
        text-align: right;
      }
      // Pista recesiva + relleno fino de extremo redondeado, anclado al
      // inicio — mismo lenguaje de barra que el resto de la app.
      .bar-track {
        position: relative;
        height: 8px;
        background: var(--surface-2);
        border-radius: 4px;
        overflow: hidden;
      }
      .bar-fill {
        height: 100%;
        border-radius: 4px;
        min-width: 3px;

        &.fill-you {
          background: var(--accent-solid);
        }
        &.fill-median {
          background: var(--text-faint);
        }
      }
      .compare-note {
        margin: 10px 0 0;
        font-size: 12px;
        color: var(--text-muted);

        &.tone-success {
          color: var(--success);
        }
        &.tone-warning {
          color: var(--warning);
        }
      }
      .zero-death {
        display: block;
        margin-top: 3px;
        font-size: 11px;
        color: var(--text-faint);
      }
    `,
  ],
})
export class CompareBarRowComponent {
  pacing = input<ReferencePacing | null>(null);
  formatDuration = formatDuration;

  private maxMs = computed(() => {
    const p = this.pacing();
    return p ? Math.max(p.yourDurationMs, p.medianDurationMs, 1) : 1;
  });
  yourPct = computed(() => {
    const p = this.pacing();
    return p ? (p.yourDurationMs / this.maxMs()) * 100 : 0;
  });
  medianPct = computed(() => {
    const p = this.pacing();
    return p ? (p.medianDurationMs / this.maxMs()) * 100 : 0;
  });
}
