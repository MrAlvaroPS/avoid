// Colocar en: src/app/shared/charts/mechanic-swimlane.component.ts
// Sustituye a raid-damage-chart.component.ts (feedback real: "no me termina
// de convencer los datos que muestran [la curva de daño], quizá un timeline
// como el de lorrgs tendría más sentido"). En vez de una curva de valor con
// marcadores flotando encima, esto es un swimlane de verdad: una fila FIJA
// por mecánica distinta, sus ocurrencias en su propia fila a lo largo del
// tiempo — se lee el patrón de un vistazo ("esta mecánica cada 45s", "estas
// dos se solapan siempre") sin depender de interpretar una curva agregada.
// Mismo dato de siempre (d.timeline), cero pipeline nuevo — solo cambia la
// presentación.
import { Component, computed, input, output, signal } from '@angular/core';
import type { TimelineChip } from '../models/ui';
import type { BackgroundMechanicSummary } from '../../core/pull-analysis.service';
import { formatTimeLabel, mechanicCategoryMeta } from '../format.util';

const VIEW_W = 1000;
const TICK_STEPS_MS = [5_000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000, 300_000, 600_000, 900_000];

function buildTicks(durationMs: number): number[] {
  const step = TICK_STEPS_MS.find((s) => durationMs / s <= 8) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
  const ticks: number[] = [];
  for (let t = 0; t <= durationMs; t += step) ticks.push(t);
  return ticks;
}

interface SwimlaneRow {
  key: string;
  label: string;
  wowheadSpellId: number | null;
  category: TimelineChip['category'];
  chips: TimelineChip[];
}

@Component({
  selector: 'app-mechanic-swimlane',
  standalone: true,
  template: `
    @if (loading()) {
      <div class="skeleton" aria-hidden="true"></div>
      <span class="sr-only">Calculando la línea temporal…</span>
    } @else if (!rows().length) {
      <p class="empty-state">Sin mecánicas clasificadas todavía para este pull.</p>
    } @else {
      <div class="legend" aria-hidden="true">
        <span class="legend-item"><i class="dot tone-clean"></i>Limpia</span>
        <span class="legend-item"><i class="dot tone-partial"></i>Aviso</span>
        <span class="legend-item"><i class="dot tone-fail"></i>Fallo</span>
      </div>

      <div class="lanes">
        @for (row of rows(); track row.key) {
          <div class="lane-row">
            <div class="lane-label">
              @if (row.wowheadSpellId) {
                <a
                  class="lane-icon"
                  [href]="'https://www.wowhead.com/spell=' + row.wowheadSpellId"
                  target="_blank"
                  rel="noopener"
                  [attr.data-wowhead]="'spell=' + row.wowheadSpellId"
                ></a>
              }
              <span class="lane-name">{{ row.label }}</span>
              @if (categoryMeta(row.category); as meta) {
                <span class="lane-cat" [title]="meta.label">{{ meta.short }}</span>
              }
            </div>
            <div class="lane-track" #laneTrack (mousemove)="onLaneHover($event, laneTrack, row)" (mouseleave)="hover.set(null)">
              @for (chip of row.chips; track chip.timeMs) {
                <a
                  class="lane-mark"
                  [class]="'tone-' + chip.outcome"
                  [style.left.%]="pct(chip.timeMs)"
                  [href]="chip.wowheadSpellId ? 'https://www.wowhead.com/spell=' + chip.wowheadSpellId : null"
                  target="_blank"
                  rel="noopener"
                  [attr.data-wowhead]="chip.wowheadSpellId ? 'spell=' + chip.wowheadSpellId : null"
                  (click)="chipSelected.emit(chip)"
                ></a>
              }
              @if (hover(); as h) {
                @if (h.row === row) {
                  <div class="hover-tooltip" [class.flip]="pct(h.chip.timeMs) > 60" [style.left.%]="pct(h.chip.timeMs)">
                    <span class="tt-time tabular">{{ h.chip.timeLabel }}</span>
                    <span class="tt-desc">{{ h.chip.description }}</span>
                  </div>
                }
              }
            </div>
          </div>
        }

        <div class="axis-row">
          <div class="lane-label"></div>
          <div class="axis-track">
            @for (tick of ticks(); track tick.leftPct) {
              <span class="tick-label tabular" [style.left.%]="tick.leftPct">{{ tick.label }}</span>
            }
          </div>
        </div>
      </div>

      @for (note of notes(); track note.description) {
        <p class="note">{{ note.description }}</p>
      }

      @if (background().length) {
        <p class="background-summary">
          Además, sin incidentes:
          @for (bg of background(); track bg.wowheadSpellId; let last = $last) {
            <a class="ability-ref" [href]="'https://www.wowhead.com/spell=' + bg.wowheadSpellId" target="_blank" rel="noopener" [attr.data-wowhead]="'spell=' + bg.wowheadSpellId"
              >{{ bg.label }} ×{{ bg.count }}</a
            >{{ last ? '' : ', ' }}
          }
        </p>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .legend {
        display: flex;
        gap: 14px;
        margin-bottom: 10px;
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 10.5px;
        color: var(--text-faint);
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        display: inline-block;
      }
      .tone-clean {
        background: var(--success);
      }
      .tone-partial {
        background: var(--warning);
      }
      .tone-fail {
        background: var(--danger);
      }
      .tone-neutral {
        background: var(--text-faint);
      }

      .lanes {
        display: flex;
        flex-direction: column;
      }

      .lane-row {
        display: grid;
        grid-template-columns: 168px 1fr;
        align-items: center;
        gap: 10px;
        min-height: 26px;
        border-top: 1px solid var(--surface-2);

        &:first-child {
          border-top: none;
        }
      }

      .lane-label {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        overflow: hidden;
      }
      .lane-icon {
        flex-shrink: 0;
        width: 16px;
        height: 16px;
        border-radius: 3px;
        display: block;
        overflow: hidden;

        img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
      }
      .lane-name {
        font-size: 11.5px;
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .lane-cat {
        flex-shrink: 0;
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.03em;
        color: var(--accent);
        background: var(--accent-soft);
        border-radius: 4px;
        padding: 1px 4px;
      }

      .lane-track {
        position: relative;
        height: 22px;
        cursor: crosshair;
      }

      .lane-mark {
        position: absolute;
        top: 50%;
        width: 12px;
        height: 12px;
        border-radius: 3px;
        transform: translate(-50%, -50%);
        border: 1.5px solid var(--surface);
        cursor: pointer;
        display: block;
        text-decoration: none;
        transition:
          width 0.1s ease,
          height 0.1s ease;

        &.tone-clean {
          background: var(--success);
        }
        &.tone-partial_fail {
          background: var(--warning);
        }
        &.tone-fail {
          background: var(--danger);
        }
        &.tone-neutral {
          background: var(--text-faint);
        }

        &:hover,
        &:focus-visible {
          width: 16px;
          height: 16px;
          z-index: 2;
        }

        img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
      }

      .hover-tooltip {
        position: absolute;
        top: -6px;
        transform: translate(8px, -100%);
        min-width: 140px;
        max-width: 240px;
        background: var(--surface-2);
        border: 1px solid var(--card-border);
        border-radius: 8px;
        box-shadow: var(--shadow-card);
        padding: 7px 9px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        pointer-events: none;
        z-index: 3;
      }
      .hover-tooltip.flip {
        transform: translate(calc(-100% - 8px), -100%);
      }
      .tt-time {
        font-size: 10px;
        color: var(--text-faint);
      }
      .tt-desc {
        font-size: 11.5px;
        color: var(--text);
        line-height: 1.35;
      }

      .axis-row {
        display: grid;
        grid-template-columns: 168px 1fr;
        gap: 10px;
        margin-top: 6px;
        padding-top: 8px;
        border-top: 1px solid var(--border-bright);
      }
      .axis-track {
        position: relative;
        height: 12px;
      }
      .tick-label {
        position: absolute;
        transform: translateX(-50%);
        font-size: 9.5px;
        color: var(--text-faint);
        white-space: nowrap;
      }

      .note {
        margin: 8px 2px 0;
        font-size: 11.5px;
        color: var(--warning);
      }

      .background-summary {
        margin: 10px 2px 0;
        font-size: 11px;
        color: var(--text-faint);
        line-height: 1.6;

        .ability-ref {
          color: var(--text-muted);
          border-bottom: 1px dotted var(--text-faint);
          cursor: help;
          text-decoration: none;

          &:hover {
            color: var(--accent);
            border-bottom-color: var(--accent);
          }
        }
      }

      .empty-state {
        font-size: 12px;
        color: var(--text-faint);
        margin: 0;
        padding: 20px 0;
        text-align: center;
      }

      .skeleton {
        height: 160px;
        border-radius: 8px;
        background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-hover) 37%, var(--surface-2) 63%);
        background-size: 400% 100%;
        animation: shimmer 1.4s ease infinite;
      }
      @keyframes shimmer {
        0% {
          background-position: 100% 50%;
        }
        100% {
          background-position: 0 50%;
        }
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
    `,
  ],
})
export class MechanicSwimlaneComponent {
  chips = input.required<TimelineChip[]>();
  background = input<BackgroundMechanicSummary[]>([]);
  durationMs = input<number | null>(null);
  loading = input(false);
  chipSelected = output<TimelineChip>();

  categoryMeta = mechanicCategoryMeta;
  readonly VIEW_W = VIEW_W;

  hover = signal<{ row: SwimlaneRow; chip: TimelineChip } | null>(null);

  private effectiveDurationMs = computed(() => {
    const explicit = this.durationMs();
    if (explicit && explicit > 0) return explicit;
    const maxChip = Math.max(0, ...this.chips().map((c) => c.timeMs ?? 0));
    return maxChip > 0 ? maxChip : null;
  });

  /** El único chip con timeMs:null real es "sin mecánicas clasificadas" (hito sin instante) — se enseña como nota de texto. */
  notes = computed(() => this.chips().filter((c) => c.timeMs == null));

  rows = computed<SwimlaneRow[]>(() => {
    const plottable = this.chips().filter((c) => c.timeMs != null && c.provenance != null);
    const byKey = new Map<string, SwimlaneRow>();
    for (const chip of plottable) {
      const key = chip.wowheadSpellId != null ? `id:${chip.wowheadSpellId}` : `label:${chip.description.split(' · ')[0]}`;
      let row = byKey.get(key);
      if (!row) {
        row = { key, label: chip.description.split(' · ')[0], wowheadSpellId: chip.wowheadSpellId, category: chip.category, chips: [] };
        byKey.set(key, row);
      }
      row.chips.push(chip);
    }
    return [...byKey.values()].sort((a, b) => (a.chips[0].timeMs ?? 0) - (b.chips[0].timeMs ?? 0));
  });

  ticks = computed(() => {
    const durationMs = this.effectiveDurationMs();
    if (!durationMs) return [];
    return buildTicks(durationMs).map((t) => ({ leftPct: Math.min(100, (t / durationMs) * 100), label: formatTimeLabel(t) }));
  });

  pct(timeMs: number | null): number {
    const durationMs = this.effectiveDurationMs();
    if (!durationMs || timeMs == null) return 0;
    return Math.min(100, (timeMs / durationMs) * 100);
  }

  onLaneHover(event: MouseEvent, el: HTMLElement, row: SwimlaneRow): void {
    const rect = el.getBoundingClientRect();
    if (!rect.width) return;
    const frac = (event.clientX - rect.left) / rect.width;
    // Marca más cercana al ratón dentro de esta fila — el hover "engancha"
    // a la ocurrencia real más próxima, no a un punto arbitrario del eje.
    let closest: TimelineChip | null = null;
    let closestDist = Infinity;
    for (const chip of row.chips) {
      const chipFrac = this.pct(chip.timeMs) / 100;
      const dist = Math.abs(chipFrac - frac);
      if (dist < closestDist) {
        closestDist = dist;
        closest = chip;
      }
    }
    if (closest && closestDist < 0.03) this.hover.set({ row, chip: closest });
    else this.hover.set(null);
  }
}
