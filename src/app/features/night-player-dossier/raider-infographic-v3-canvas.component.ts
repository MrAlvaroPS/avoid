import { ChangeDetectionStrategy, Component, ViewEncapsulation, input } from '@angular/core';
import type { RaiderInfographicViewModel } from '../../core/raider-infographic-view-model';

@Component({
  selector: 'app-raider-infographic-v3-canvas',
  standalone: true,
  templateUrl: './raider-infographic-v3-canvas.component.html',
  styleUrl: './raider-infographic-v3-canvas.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class RaiderInfographicV3CanvasComponent {
  viewModel = input.required<RaiderInfographicViewModel>();
  iconUrls = input.required<Record<number, string>>();

  iconUrl(spellId: number | null): string | null {
    return spellId == null ? null : (this.iconUrls()[spellId] ?? null);
  }

  bossIconUrl(bossId: string): string {
    return `https://assets.rpglogs.com/img/warcraft/bosses/${bossId}-icon.jpg`;
  }

  onIconError(event: Event): void {
    // Todos los wrappers de icono incluyen debajo un SVG local. Ocultar la
    // imagen fallida evita depender de un segundo CDN para el fallback.
    (event.currentTarget as HTMLImageElement).style.display = 'none';
  }

  onBossIconError(event: Event): void {
    (event.currentTarget as HTMLImageElement).style.display = 'none';
  }
}
