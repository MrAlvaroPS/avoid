// Colocar en: src/app/features/live-pull/wipe-call-banner.component.ts
// §"cuándo se determina un wipe global... que autoexcluya pero que permita
// también editarlo... para restaurar los valores" (feedback real): banner
// visible solo cuando analyze-report detectó un cluster de muertes casi
// simultáneas — muestra la confianza y la evidencia (mismo espíritu que
// inferred_category_reasons del manifiesto: nunca una caja negra) y deja
// confirmar/revertir con un clic. El toggle recarga el pull entero porque
// el cambio afecta a demasiados cálculos derivados (deaths, mechFails,
// racha, defensivos, fiabilidad) como para recomputarlos en el cliente.
import { Component, inject, input, output, signal } from '@angular/core';
import { PullAnalysisService } from '../../core/pull-analysis.service';
import { errorMessage } from '../../shared/error-message.util';

@Component({
  selector: 'app-wipe-call-banner',
  standalone: true,
  templateUrl: './wipe-call-banner.component.html',
  styleUrl: './wipe-call-banner.component.scss',
})
export class WipeCallBannerComponent {
  private pullAnalysis = inject(PullAnalysisService);

  pullId = input.required<string>();
  confidence = input.required<number>();
  excluded = input.required<boolean>();
  signals = input.required<Record<string, number | boolean | null>>();
  statusChanged = output<void>();

  detailsOpen = signal(false);
  toggling = signal(false);
  reanalyzing = signal(false);
  reanalyzeMessage = signal<string | null>(null);
  error = signal<string | null>(null);

  async toggle(): Promise<void> {
    this.toggling.set(true);
    this.error.set(null);
    try {
      await this.pullAnalysis.setWipeCallStatus(this.pullId(), !this.excluded());
      this.statusChanged.emit();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.toggling.set(false);
    }
  }

  // §"Hay que ver la manera de centralizar esta información y, sobretodo,
  // en hacerla fiable" (feedback real, 2026-08-28): vuelve a pedir a WCL
  // este pull y recalcula el veredicto con el algoritmo actual — para
  // cuando el algoritmo cambia después de que este pull ya se analizara
  // (caso real: Pandokie quedó fuera del cluster por un fallo del
  // algoritmo anterior). Si había una decisión manual (toggle() arriba) y
  // la confianza recalculada es la misma, esa decisión se respeta.
  async reanalyze(): Promise<void> {
    this.reanalyzing.set(true);
    this.error.set(null);
    this.reanalyzeMessage.set(null);
    try {
      const result = await this.pullAnalysis.reanalyzeWipeCall(this.pullId());
      const changed = result.clusterChanges.length;
      this.reanalyzeMessage.set(
        changed
          ? `Recalculado: ${changed} jugador${changed === 1 ? '' : 'es'} cambiaron de estado (confianza ${result.before.confidence ?? '—'}% → ${result.after.confidence ?? '—'}%).`
          : 'Recalculado: sin cambios respecto al análisis anterior.',
      );
      this.statusChanged.emit();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.reanalyzing.set(false);
    }
  }

  // Traducción a lenguaje llano de las señales crudas — para que "revisar
  // la evidencia" no exija leer nombres de campo en inglés.
  signalLines(): string[] {
    const s = this.signals();
    const lines: string[] = [];
    if (s['earlyMassDeath'] === true) lines.push('murió al menos el 60% de la party durante los primeros 10s: se trata como reset/wipe call temprano');
    if (typeof s['simultaneityFraction'] === 'number') lines.push(`${Math.round(s['simultaneityFraction'] * 100)}% de los vivos murieron casi a la vez`);
    if (typeof s['abilityDiversity'] === 'number') {
      lines.push(
        s['abilityDiversity'] > 0.5
          ? 'cada uno murió a una causa distinta (no una única mecánica)'
          : 'la mayoría murió a la misma habilidad (más típico de una mecánica real)',
      );
    }
    if (typeof s['healingCollapseRatio'] === 'number') {
      lines.push(
        s['healingCollapseRatio'] < 0.3
          ? 'la sanación de la raid casi desapareció después de las muertes desencadenantes'
          : 'la raid siguió sanando después de las muertes desencadenantes',
      );
    }
    if (typeof s['sustainedDeathFraction'] === 'number' && s['sustainedDeathFraction'] > 0.5) {
      lines.push('la mayoría no murió a un golpe único, se fueron apagando');
    }
    // §"los primeros 2-3-4 que mueren no suelen ser parte de ese wipe
    // call... es mecánica fallida seguramente" (feedback real): las
    // primeras muertes del cluster NUNCA se excluyen (se asume que son la
    // causa, no la consecuencia) — se deja explícito aquí para que no
    // parezca que todo el cluster se perdonó por igual.
    if (typeof s['triggerDeathsKept'] === 'number' && s['triggerDeathsKept'] > 0) {
      lines.push(`las primeras ${s['triggerDeathsKept']} muertes del grupo siguen contando como fallo real — solo se excluye el resto (probablemente ya dado por perdido)`);
    }
    if (typeof s['wipeCallStartMs'] === 'number') {
      const seconds = Math.round(s['wipeCallStartMs'] / 1000);
      lines.push(`el límite estadístico empieza en ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}; todo lo anterior sigue contando`);
    }
    return lines;
  }
}
