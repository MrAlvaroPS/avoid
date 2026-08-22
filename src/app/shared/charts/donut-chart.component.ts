// Colocar en: src/app/shared/charts/donut-chart.component.ts
// "Rosco" genérico y reutilizable — dataviz §"choosing a form": composición
// de pocas categorías (<=8) = donut con leyenda directa (nunca solo color,
// ver marks-and-anatomy.md). Paleta categórica de 8 huecos, validada de
// verdad contra la superficie oscura real de la app (no a ojo):
//   node scripts/validate_palette.js "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767" --mode dark --surface "#080810"
//   -> ALL CHECKS PASS (lightness band, chroma floor, CVD ΔE 8.4, normal-vision ΔE 19.3, contraste 3:1).
//
// Interactivo de verdad (feedback real: "los roscos siguen sin ser
// interactivos, no puedo leer los datos") — el <title> nativo de SVG exige
// esperar ~1s sin mover el ratón y el navegador decide cuándo/si lo pinta;
// esto es un tooltip propio, visible al instante al pasar por un segmento O
// por su fila de leyenda (las dos cosas resaltan la misma entidad), más un
// clic en la leyenda para pedir el desglose completo en el drawer de
// provenance ya existente en toda la app — "alguna opción para ver más
// detalles" sin inventar un mecanismo nuevo de UI.
import { Component, computed, input, output, signal } from '@angular/core';

export interface DonutSegment {
  label: string;
  value: number;
  /** Color YA resuelto por quien construye los segmentos — un hueco fijo de CATEGORY_PALETTE (identidad categórica) o un token de estado (--success/--warning/...) cuando el segmento representa un estado, no una categoría. Nunca se decide aquí dentro para que la misma entidad siempre pinte igual (dataviz: "color follows the entity, never its rank"). */
  color: string;
  /** §"alguna opción para ver más detalles": de qué está hecho ESTE segmento, listo para el drawer de provenance — sin esto un clic no tenía nada más que enseñar que el propio número ya visible. */
  detailLines?: string[];
}

interface RenderedSegment extends DonutSegment {
  pct: number;
  dashArray: string;
  dashOffset: number;
}

@Component({
  selector: 'app-donut-chart',
  standalone: true,
  template: `
    <div class="donut-wrap">
      <svg viewBox="0 0 100 100" class="donut-svg" role="img" [attr.aria-label]="ariaLabel()">
        <circle class="track" cx="50" cy="50" r="40" />
        @for (seg of renderedSegments(); track seg.label; let i = $index) {
          <circle
            class="segment"
            [class.is-hovered]="hoveredIndex() === i"
            [class.is-dimmed]="hoveredIndex() !== null && hoveredIndex() !== i"
            cx="50"
            cy="50"
            r="40"
            [style.stroke]="seg.color"
            [style.stroke-dasharray]="seg.dashArray"
            [style.stroke-dashoffset]="seg.dashOffset"
            (mouseenter)="hoveredIndex.set(i)"
            (mouseleave)="hoveredIndex.set(null)"
            (click)="segmentSelected.emit(seg)"
          />
        }
      </svg>
      <div class="donut-center">
        @if (hoveredSegment(); as hs) {
          <span class="center-value tabular hovered">{{ hs.value }}</span>
          <span class="center-label">{{ hs.pct }}%</span>
        } @else {
          <span class="center-value tabular">{{ total() }}</span>
          @if (centerLabel()) {
            <span class="center-label">{{ centerLabel() }}</span>
          }
        }
      </div>
    </div>
    <ul class="donut-legend">
      @for (seg of renderedSegments(); track seg.label; let i = $index) {
        <li>
          <button
            type="button"
            class="legend-row"
            [class.is-hovered]="hoveredIndex() === i"
            (mouseenter)="hoveredIndex.set(i)"
            (mouseleave)="hoveredIndex.set(null)"
            (click)="segmentSelected.emit(seg)"
          >
            <span class="swatch" [style.background]="seg.color" aria-hidden="true"></span>
            <span class="legend-label">{{ seg.label }}</span>
            <span class="legend-value tabular">{{ seg.value }}</span>
            <span class="legend-pct tabular">{{ seg.pct }}%</span>
          </button>
        </li>
      }
      @if (!renderedSegments().length) {
        <li class="empty">Sin datos todavía</li>
      }
    </ul>
  `,
  styles: [
    `
      :host {
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .donut-wrap {
        position: relative;
        width: 96px;
        height: 96px;
        flex-shrink: 0;
      }
      .donut-svg {
        width: 100%;
        height: 100%;
        transform: rotate(-90deg);
      }
      .track {
        fill: none;
        stroke: var(--surface-2);
        stroke-width: 12;
      }
      .segment {
        fill: none;
        stroke-width: 12;
        stroke-linecap: butt;
        cursor: pointer;
        transition:
          stroke-dashoffset 0.3s ease,
          stroke-width 0.12s ease,
          opacity 0.12s ease;
      }
      .segment.is-hovered {
        stroke-width: 14;
      }
      .segment.is-dimmed {
        opacity: 0.35;
      }
      .donut-center {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      .center-value {
        font-size: 20px;
        font-weight: 700;
        color: var(--text);
        line-height: 1;
      }
      .center-value.hovered {
        color: var(--accent);
      }
      .center-label {
        font-size: 9px;
        color: var(--text-faint);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-top: 2px;
      }
      .donut-legend {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1;
      }
      .legend-row {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        font-size: 12px;
        background: none;
        border: none;
        padding: 3px 4px;
        border-radius: 5px;
        color: inherit;
        font-family: inherit;
        cursor: pointer;
        text-align: left;

        &:hover,
        &.is-hovered {
          background: var(--surface-hover);
        }
      }
      .swatch {
        width: 8px;
        height: 8px;
        border-radius: 2px;
        flex-shrink: 0;
      }
      .legend-label {
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .legend-value {
        margin-left: auto;
        color: var(--text);
        font-size: 11.5px;
      }
      .legend-pct {
        color: var(--text-faint);
        font-size: 10.5px;
        width: 32px;
        text-align: right;
      }
      .empty {
        color: var(--text-faint);
        font-size: 12px;
      }
    `,
  ],
})
export class DonutChartComponent {
  segments = input.required<DonutSegment[]>();
  centerLabel = input<string>('');
  ariaLabelOverride = input<string | null>(null);
  /** Se emite al clicar un segmento o su fila de leyenda — el padre decide qué hacer (normalmente abrir el drawer de provenance con el desglose). */
  segmentSelected = output<DonutSegment>();

  hoveredIndex = signal<number | null>(null);

  total = computed(() => this.segments().reduce((sum, s) => sum + s.value, 0));
  ariaLabel = computed(() => this.ariaLabelOverride() ?? `Gráfico circular: ${this.segments().map((s) => `${s.label} ${s.value}`).join(', ')}`);
  hoveredSegment = computed(() => {
    const i = this.hoveredIndex();
    return i != null ? (this.renderedSegments()[i] ?? null) : null;
  });

  // Hueco de 2° entre segmentos (dataviz: "2px surface gap between fills")
  // — en un donut se traduce a un pequeño margen angular, no en píxeles.
  private readonly GAP_DEGREES = 2.2;

  renderedSegments = computed<RenderedSegment[]>(() => {
    const segs = this.segments().filter((s) => s.value > 0);
    const total = segs.reduce((sum, s) => sum + s.value, 0);
    if (!total) return [];
    const circumference = 2 * Math.PI * 40; // r=40
    const gapLength = (this.GAP_DEGREES / 360) * circumference;
    let cumulative = 0;
    return segs.map((seg) => {
      const rawLength = (seg.value / total) * circumference;
      const length = segs.length > 1 ? Math.max(0, rawLength - gapLength) : rawLength;
      const dashArray = `${length} ${circumference - length}`;
      const dashOffset = -cumulative;
      cumulative += rawLength;
      return {
        ...seg,
        pct: Math.round((seg.value / total) * 100),
        dashArray,
        dashOffset,
      };
    });
  });
}
