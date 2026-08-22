// Colocar en: src/app/shared/charts/gauge.component.ts
// "Baremo" tipo velocímetro (medio círculo) — dataviz §"choosing a form":
// un único valor 0-100 contra un umbral = gauge, no una tabla de números.
// El color es de ESTADO (bueno/aviso/mal), nunca identidad categórica — por
// eso usa los tokens --success/--warning/--danger ya reservados en toda la
// app, no la paleta categórica del donut (esa es para "qué es", esta es
// "qué tal va").
import { Component, computed, input } from '@angular/core';

export type GaugeTone = 'success' | 'warning' | 'danger' | 'neutral';

@Component({
  selector: 'app-gauge',
  standalone: true,
  template: `
    <div class="gauge-wrap">
      <svg viewBox="0 0 100 58" class="gauge-svg" role="img" [attr.aria-label]="label() + ': ' + centerValue()">
        <!-- Pivote de giro explícito en coordenadas del viewBox (rotate(180
             50 50), SVG nativo) — un transform CSS en el <svg> gira sobre el
             centro de SU CAJA (100x58, o sea (50,29)), no sobre el centro
             real del círculo (50,50): verificado en real que eso desplazaba
             el arco entero fuera del viewBox y solo se veían los extremos
             redondeados sueltos, sin arco visible. -->
        <g transform="rotate(180 50 50)">
          <circle class="track" cx="50" cy="50" r="42" [attr.stroke-dasharray]="trackDash" />
          <circle class="value-arc" cx="50" cy="50" r="42" [style.stroke]="strokeColor()" [attr.stroke-dasharray]="valueDash()" />
        </g>
      </svg>
      @if (centerValue()) {
        <div class="gauge-center">
          <span class="gauge-value tabular">{{ centerValue() }}</span>
          @if (centerUnit()) {
            <span class="gauge-unit">{{ centerUnit() }}</span>
          }
        </div>
      }
    </div>
    <span class="gauge-label">{{ label() }}</span>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
      }
      :host {
        width: 100%;
      }
      .gauge-wrap {
        position: relative;
        width: 100%;
      }
      .gauge-svg {
        width: 100%;
        display: block;
      }
      .track {
        fill: none;
        stroke: var(--surface-2);
        stroke-width: 9;
        stroke-linecap: round;
      }
      .value-arc {
        fill: none;
        stroke-width: 9;
        stroke-linecap: round;
        transition: stroke-dasharray 0.4s ease;
      }
      .gauge-center {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 2px;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .gauge-value {
        font-size: 15px;
        font-weight: 700;
        color: var(--text);
        line-height: 1;
      }
      .gauge-unit {
        font-size: 7px;
        color: var(--text-faint);
        text-transform: uppercase;
        letter-spacing: 0.03em;
        margin-top: 1px;
      }
      .gauge-label {
        font-size: 9px;
        color: var(--text-faint);
        text-transform: uppercase;
        letter-spacing: 0.02em;
        text-align: center;
      }
    `,
  ],
})
export class GaugeComponent {
  /** 0-100. */
  value = input.required<number>();
  label = input<string>('');
  centerValue = input<string>('');
  centerUnit = input<string>('');
  tone = input<GaugeTone>('neutral');

  // r=42 -> semicircunferencia = π·42 ≈ 131.95. rotate(180deg) pone el
  // origen del trazo en las 9 en punto; dibujar en sentido horario desde
  // ahí recorre exactamente el semicírculo superior (9 -> 12 -> 3).
  private readonly HALF_CIRCUMFERENCE = Math.PI * 42;
  readonly trackDash = `${this.HALF_CIRCUMFERENCE} ${this.HALF_CIRCUMFERENCE}`;

  valueDash = computed(() => {
    const clamped = Math.max(0, Math.min(100, this.value()));
    const length = (clamped / 100) * this.HALF_CIRCUMFERENCE;
    return `${length} ${this.HALF_CIRCUMFERENCE * 2}`;
  });

  strokeColor = computed(() => {
    switch (this.tone()) {
      case 'success':
        return 'var(--chart-positive)';
      case 'warning':
        return 'var(--warning)';
      case 'danger':
        return 'var(--danger)';
      default:
        return 'var(--accent-solid)';
    }
  });
}
