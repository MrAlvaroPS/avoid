// Colocar en: src/app/features/night-player-dossier/night-player-dossier.component.ts
// §"un resumen de una noche... para dirigir a uno o varios raiders... un
// poco como un dosier de personaje de una noche concreta" (feedback real).
// Ruta /report/:code/player/:name — toda la agregación vive en
// night-player-summary.service.ts, este componente solo pinta.
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { NightPlayerSummaryService, type NightPlayerSummary } from '../../core/night-player-summary.service';
import { EdgeFunctionsService } from '../../core/edge-functions.service';
import { mapBrief } from '../../core/pull-analysis.service';
import { formatDuration, formatPct, mechanicCategoryMeta, mechanicDisplayName, rootCauseMeta } from '../../shared/format.util';
import { RoleIconComponent } from '../../shared/role-icon.component';
import { WowheadLinkComponent } from '../../shared/wowhead-link.component';
import { EmptyPanelComponent } from '../../shared/empty-panel.component';
import { MechanicInfoIconComponent } from '../../shared/mechanic-info-icon.component';
import { LlmAnalysisCardComponent } from '../live-pull/llm-analysis-card.component';
import { EMPTY_BRIEF_ENTITIES, type BriefEntities } from '../../shared/brief-text.component';
import type { DeathCause, MechanicCategory } from '../../shared/models/domain';
import type { LlmPullAnalysis } from '../../shared/models/ui';
import { errorMessage } from '../../shared/error-message.util';

function toneForScore(score: number | null): 'danger' | 'warning' | 'success' | null {
  if (score == null) return null;
  return score < 50 ? 'danger' : score < 75 ? 'warning' : 'success';
}

@Component({
  selector: 'app-night-player-dossier',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink, RoleIconComponent, WowheadLinkComponent, EmptyPanelComponent, MechanicInfoIconComponent, LlmAnalysisCardComponent],
  templateUrl: './night-player-dossier.component.html',
  styleUrl: './night-player-dossier.component.scss',
})
export class NightPlayerDossierComponent {
  private summaryService = inject(NightPlayerSummaryService);
  private edgeFunctions = inject(EdgeFunctionsService);

  reportCode = input.required<string>();
  playerName = input.required<string>();

  data = signal<NightPlayerSummary | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);

  categoryMeta = mechanicCategoryMeta;
  formatDuration = formatDuration;
  formatPct = formatPct;
  mechanicDisplayName = mechanicDisplayName;

  copyStatus = signal<'idle' | 'copied' | 'error'>('idle');

  // §"que dentro del dosier pueda hacer consulta IA con informe completo...
  // orientado a mejorar como RL" (feedback real): mismo patrón que el brief
  // de un pull — generatingBrief separado de `error` a propósito (un fallo
  // al pedir el análisis no debe borrar el resto del dosier ya cargado).
  generatingBrief = signal(false);
  briefError = signal<string | null>(null);

  // §"pintar cada jugador de su clase, mecánicas con tooltip+nota" (feedback
  // real): un solo jugador en este ámbito, pero mismas mecánicas ya
  // calculadas para las tres tablas del dosier — nada que pedir aparte.
  briefEntities = computed<BriefEntities>(() => {
    const d = this.data();
    if (!d) return EMPTY_BRIEF_ENTITIES;
    const players = new Map<string, string>();
    if (d.gearSnapshot?.class) players.set(d.playerName, d.gearSnapshot.class);
    const mechanics = new Map<string, { spellId: number | null; note: string | null }>();
    for (const death of d.deaths) mechanics.set(mechanicDisplayName(death.mechanicName), { spellId: death.mechanicId, note: death.aiNote });
    for (const fail of d.mechanicFails) mechanics.set(mechanicDisplayName(fail.mechanicName), { spellId: fail.mechanicId, note: fail.aiNote });
    for (const p of d.repeatedPatterns) mechanics.set(mechanicDisplayName(p.mechanicName), { spellId: p.mechanicId, note: p.aiNote });
    return { players, mechanics };
  });

  reliabilityTone = computed<'danger' | 'warning' | 'success' | null>(() => toneForScore(this.data()?.reliability?.overall ?? null));
  // §"fiabilidad debería tener 2 valores: 60 días y de la noche" (feedback real).
  nightReliabilityTone = computed<'danger' | 'warning' | 'success' | null>(() => toneForScore(this.data()?.nightReliability?.overall ?? null));

  // §bug real ya visto en LivePullComponent/BossHistoryComponent: leer un
  // input() (incluido el vinculado por ruta) DENTRO del constructor revienta
  // con NG0950 — Angular lo asigna DESPUÉS de construir la instancia.
  constructor() {
    effect(() => {
      const code = this.reportCode();
      const name = this.playerName();
      void this.load(code, name);
    });
  }

  private async load(reportCode: string, playerName: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.data.set(await this.summaryService.load(reportCode, playerName));
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }

  // §"limpiar todo eso que pone 'sin clasificar' y que de hecho, esté
  // clasificado" (feedback real): rootCause y categoría son dos ejes
  // distintos a propósito — rootCause 'unclassified' es honesto sobre no
  // saber el MECANISMO exacto (self_positioning/no_healing_received/etc.,
  // ver computeRootCause en analyze-report), no significa que la mecánica
  // en sí no tenga categoría confirmada. Antes esto se leía como
  // contradictorio (tag "RAID" confirmado junto a "Sin clasificar" en la
  // misma fila) — si hay categoría, se enseña su nombre en vez de un "no lo
  // sé" plano; el "Sin clasificar" real queda solo para cuando NINGUNO de
  // los dos ejes tiene dato.
  rootCauseLabel(cause: DeathCause['rootCause'], category: MechanicCategory | null): string {
    if (cause !== 'unclassified') return rootCauseMeta(cause)?.label ?? cause;
    return mechanicCategoryMeta(category)?.label ?? rootCauseMeta('unclassified')!.label;
  }

  async onGenerateBrief(): Promise<void> {
    const d = this.data();
    if (!d) return;
    this.generatingBrief.set(true);
    this.briefError.set(null);
    try {
      const res = await this.edgeFunctions.generateNightPlayerBrief(d.reportCode, d.playerName);
      this.data.set({ ...d, brief: mapBrief(res.brief) });
    } catch (err) {
      this.briefError.set(errorMessage(err));
    } finally {
      this.generatingBrief.set(false);
    }
  }

  onManualBriefSaved(brief: LlmPullAnalysis): void {
    const d = this.data();
    if (!d) return;
    this.data.set({ ...d, brief });
  }

  async copySummary(): Promise<void> {
    const d = this.data();
    if (!d) return;
    const dateLabel = d.reportDate ? new Date(d.reportDate).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' }) : d.reportTitle;
    const lines = [
      `📋 Dosier de ${d.playerName} — ${dateLabel}`,
      `Pulls: ${d.pulls.length} · Muertes: ${d.totalDeaths} · Mecánicas falladas: ${d.totalMechanicFails}`,
      d.reliability ? `Fiabilidad general: ${d.reliability.overall}/100` : null,
      '',
    ].filter((l): l is string => l != null);

    if (d.repeatedPatterns.length) {
      lines.push('⚠️ Patrones repetidos esa noche:');
      lines.push(...d.repeatedPatterns.map((p) => `- ${p.mechanicName}: ${p.instanceCount} veces en ${p.distinctBossCount} boss${p.distinctBossCount === 1 ? '' : 'es'} (${p.bossNames.join(', ')})`));
      lines.push('');
    }
    if (d.deaths.length) {
      lines.push('💀 Muertes:');
      lines.push(
        ...d.deaths.map((death) => `- ${death.bossName} #${death.pullNumber} (${this.formatDuration(death.timeMs)}): ${death.mechanicName ?? 'sin identificar'}${death.isWipeCall ? ' [wipe call]' : death.statisticalExclusionReason ? ' [mención no evaluable: melee del boss sin tank]' : ''}`),
      );
    }

    try {
      await navigator.clipboard.writeText(lines.join('\n').trim());
      this.copyStatus.set('copied');
      setTimeout(() => this.copyStatus.set('idle'), 2000);
    } catch {
      this.copyStatus.set('error');
      setTimeout(() => this.copyStatus.set('idle'), 2000);
    }
  }
}
