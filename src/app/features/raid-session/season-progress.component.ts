// Colocar en: src/app/features/raid-session/season-progress.component.ts
// §7.3 original: "bosses matados / totales de la instancia". §"quita la
// card de progreso de temporada de portada y pon el progreso en la
// cabecera, a la derecha junto con Sanguino EU... recuerda que el progreso
// va por dificultad" (feedback real, 2026-08-27): dos cambios a la vez —
//  1. Vive ahora en app.html (cabecera global, visible en toda la app), ya
//     no en raid-session.component.html — por eso el template pasa de una
//     card grande con gauge a una tira compacta de una sola línea, es lo
//     único que cabe junto a los tabs de navegación y el guild-tag.
//  2. getSeasonProgress() ahora agrupa por dificultad (antes "matado" =
//     cualquier dificultad, contrastado en real que eso mentía: Normal 8/8
//     y Heroic 3/8 a la vez se enseñaban como un solo "8/8"). Solo se listan
//     las dificultades con algún pull real — así no aparece un "0/8"
//     permanente en Mythic/LFR mientras nadie las ha intentado todavía.
import { Component, inject, signal } from '@angular/core';
import { ReportsService } from '../../core/reports.service';

@Component({
  selector: 'app-season-progress',
  standalone: true,
  template: `
    @if (!loading() && entries().length) {
      <div class="season-progress" role="status" aria-label="Progreso de temporada por dificultad">
        @for (e of entries(); track e.difficulty) {
          <span class="diff-pill" [class.cleared]="e.killed === total()">
            <span class="diff-name">{{ e.difficulty }}</span>
            <span class="diff-count">{{ e.killed }}/{{ total() }}</span>
          </span>
        }
      </div>
    }
  `,
  styles: [
    `
      .season-progress {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .diff-pill {
        display: flex;
        align-items: baseline;
        gap: 4px;
        padding: 3px 9px;
        border-radius: 999px;
        background: var(--surface-2);
        border: 1px solid var(--card-border);
        line-height: 1;

        &.cleared {
          border-color: var(--success);
        }
      }
      .diff-name {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.02em;
        color: var(--text-faint);
      }
      .diff-count {
        font-size: 11.5px;
        font-weight: 700;
        font-family: var(--font-mono);
        color: var(--text-muted);
      }
      .cleared .diff-count {
        color: var(--success);
      }
    `,
  ],
})
export class SeasonProgressComponent {
  private reportsService = inject(ReportsService);

  total = signal(0);
  entries = signal<{ difficulty: string; killed: number }[]>([]);
  loading = signal(true);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    try {
      const { total, byDifficulty } = await this.reportsService.getSeasonProgress();
      this.total.set(total);
      this.entries.set(byDifficulty);
    } catch {
      // Silencioso a propósito: es un widget secundario de cabecera — si
      // known_raid_bosses no está sincronizado todavía, no tiene sentido
      // tapar el resto de la app con un error por esto.
    } finally {
      this.loading.set(false);
    }
  }
}
