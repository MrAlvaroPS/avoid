import { ChangeDetectionStrategy, Component, ViewEncapsulation, input } from '@angular/core';
import type {
  RaiderInfographicMetric,
  RaiderInfographicViewModel,
} from '../../core/raider-infographic-view-model';

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

  /** Relleno del donut de hero-metric. Solo "ALTA"/"PARCIAL"/etc. (calidad
   * de evidencia) no son un %; para esos se pinta el anillo completo — el
   * color del tono ya distingue la categoría, no hace falta un arco parcial
   * sin significado numérico. */
  metricRingPct(metric: RaiderInfographicMetric): number {
    const match = /^(\d+(?:[.,]\d+)?)%$/.exec(metric.value.trim());
    if (!match) return 100;
    const value = parseFloat(match[1].replace(',', '.'));
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 100;
  }

  // §"que sea un rosco que se rellena de color, siendo el verde el 100% y
  // bajando la parte rellenada progresivamente al igual que los colores
  // hasta llegar al 0%" (feedback real, 2026-09-03): solo para métricas con
  // % real (ejecución/gestión defensiva) — null para las categóricas
  // (calidad de evidencia: ALTA/PARCIAL/LIMITADA), que siguen pintándose con
  // el --tone fijo de su categoría (ver [data-tone] en el scss) porque no
  // hay un "más o menos" numérico que degradar.
  metricRingColor(metric: RaiderInfographicMetric): string | null {
    const match = /^(\d+(?:[.,]\d+)?)%$/.exec(metric.value.trim());
    if (!match) return null;
    const value = parseFloat(match[1].replace(',', '.'));
    if (!Number.isFinite(value)) return null;
    const pct = Math.max(0, Math.min(100, value));
    // 0% = rojo (hue 0) → 100% = verde (hue 120), saturación/luminosidad
    // fijas para que combine con el resto de la paleta oscura del lienzo.
    return `hsl(${(pct / 100) * 120}, 68%, 50%)`;
  }
}
