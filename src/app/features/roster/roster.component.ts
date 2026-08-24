// Colocar en: src/app/features/roster/roster.component.ts
// §12 de la hoja de ruta (auditoría v2): "un valor único de 1 a 100 junto al
// nombre del jugador... con detalle al pasar el ratón o pulsar". 3 de los 4
// ejes ya construidos (ver reliability.service.ts) — preparación sigue sin
// dato fiable, no es un olvido. Icono de rol + Main/Trial vienen del roster
// real de wowaudit (wowaudit-roster.service.ts vía reliability.service.ts).
import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ReliabilityService, type PlayerReliability } from '../../core/reliability.service';
import { OffendersService, type RepeatOffenderRow } from '../../core/offenders.service';
import { mechanicCategoryMeta } from '../../shared/format.util';
import { EmptyPanelComponent } from '../../shared/empty-panel.component';
import { RoleIconComponent } from '../../shared/role-icon.component';

@Component({
  selector: 'app-roster',
  standalone: true,
  imports: [DecimalPipe, DatePipe, RouterLink, EmptyPanelComponent, RoleIconComponent],
  templateUrl: './roster.component.html',
  styleUrl: './roster.component.scss',
})
export class RosterComponent {
  private reliabilityService = inject(ReliabilityService);
  private offendersService = inject(OffendersService);

  players = signal<PlayerReliability[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  expandedPlayer = signal<string | null>(null);

  // §"atascos constantes... a través de todos los bosses": carga aparte,
  // silenciosa si falla (best-effort) — que la vista de repeat offenders
  // aún no tenga migración desplegada en un entorno concreto no debe tumbar
  // el roster entero, que es el contenido principal de esta pantalla.
  offenders = signal<RepeatOffenderRow[]>([]);
  offendersLoading = signal(true);
  categoryMeta = mechanicCategoryMeta;

  hasAnyData = computed(() => this.players().length > 0);

  constructor() {
    void this.load();
    void this.loadOffenders();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.players.set(await this.reliabilityService.listPlayerReliability());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  async loadOffenders(): Promise<void> {
    this.offendersLoading.set(true);
    try {
      this.offenders.set(await this.offendersService.listRepeatOffenders());
    } catch {
      // best-effort, ver comentario en la declaración de `offenders`
    } finally {
      this.offendersLoading.set(false);
    }
  }

  toggle(playerName: string): void {
    this.expandedPlayer.update((current) => (current === playerName ? null : playerName));
  }

  tone(score: number): 'danger' | 'warning' | 'success' {
    if (score < 50) return 'danger';
    if (score < 75) return 'warning';
    return 'success';
  }

}
