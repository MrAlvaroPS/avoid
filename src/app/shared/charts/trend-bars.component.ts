// Colocar en: src/app/shared/charts/trend-bars.component.ts
// Progreso entre intentos de este boss+dificultad — dataviz §"choosing a
// form": magnitud a lo largo de una secuencia discreta = barras verticales,
// un solo eje, altura = % de progreso (100 - wipe_pct). Kill/wipe es una
// dimensión de ESTADO (no identidad categórica), así que usa los tokens de
// status ya validados (--success/--text-faint), no la paleta categórica del
// donut — sería el error de "reusar un hue de status para una serie".
import { Component, input } from '@angular/core';

export interface TrendBar {
  label: string; // "#3"
  value: number; // 0-100, progreso (100 = kill)
  isKill: boolean;
  isCurrent: boolean;
  tooltip: string;
}

@Component({
  selector: 'app-trend-bars',
  standalone: true,
  template: `
    <div class="trend" role="img" [attr.aria-label]="'Progreso de los últimos intentos: ' + bars().map((b) => b.label + ' ' + b.value + '%').join(', ')">
      @for (bar of bars(); track bar.label) {
        <div class="bar-col" [class.is-current]="bar.isCurrent">
          <div class="track">
            <div class="fill" [class.is-kill]="bar.isKill" [style.height.%]="bar.value" [title]="bar.tooltip"></div>
          </div>
          <span class="label tabular">{{ bar.label }}</span>
        </div>
      }
      @if (!bars().length) {
        <p class="empty">Sin intentos anteriores todavía.</p>
      }
    </div>
  `,
  styles: [
    `
      // §bug real (reutilizado en boss-history con TODOS los pulls de una
      // season, no solo "los últimos intentos"): flex:1 sin overflow
      // reparte el ancho disponible entre TODAS las barras a partes
      // iguales, así que con 30-40 pulls cada una se queda en una
      // rendija ilegible en vez de mantener un tamaño mínimo — dataviz
      // §"wide content scrolls inside its own container". min-width fijo
      // por columna + overflow-x:auto: con pocas barras se ve exactamente
      // igual que antes (no llenan el ancho, no hay scroll), con muchas
      // hace scroll en vez de aplastarse.
      .trend {
        display: flex;
        align-items: flex-end;
        gap: 10px;
        height: 96px;
        padding-top: 4px;
        // §mismo bug de CSS que las tablas del resto de la app: overflow-x:auto
        // solo hace que overflow-y se compute como 'auto' también — explícito lo desactiva.
        overflow-x: auto;
        overflow-y: visible;
      }
      .bar-col {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 5px;
        flex: 1 0 auto;
        min-width: 22px;
        height: 100%;
      }
      .track {
        position: relative;
        width: 100%;
        max-width: 22px;
        flex: 1;
        background: var(--surface-2);
        border-radius: 4px;
        display: flex;
        align-items: flex-end;
        overflow: hidden;
      }
      .fill {
        width: 100%;
        min-height: 3px;
        border-radius: 4px 4px 0 0;
        background: var(--text-faint);
        transition: height 0.3s ease;

        &.is-kill {
          background: var(--success);
        }
      }
      .is-current .track {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .label {
        font-size: 10px;
        color: var(--text-faint);
      }
      .is-current .label {
        color: var(--accent);
        font-weight: 600;
      }
      .empty {
        color: var(--text-faint);
        font-size: 12px;
        margin: 0;
      }
    `,
  ],
})
export class TrendBarsComponent {
  bars = input.required<TrendBar[]>();
}
