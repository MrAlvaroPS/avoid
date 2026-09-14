// §detailed-kpi-explainer (2026-09-10, feedback real): "una explicación detallada de los 3 KPI pero que
// puedan ser verificables y demostrables... sin inventar nada, solo datos reales y que el raider pueda ver
// en warcraftlogs lo mismo que le estamos diciendo nosotros". Proyector puro: toma exactamente lo que la
// generación canónica ya publicó (episodios + applicableCandidates, la misma evidencia que decide Reacción/
// Response) y lo convierte en algo legible — nunca reinterpreta prosa, nunca inventa un spellId/timestamp que
// no esté ya en episode.applicableCandidates/decisiveSpellIds/coveredBySpellId. El link de WCL usa solo
// reportCode+fightId (nunca un timestamp adivinado) — el pico se da como texto (mm:ss) para que el raider
// navegue dentro de ese pull, no como un parámetro de URL que podríamos tener mal.
import type { NightCanonicalDefensiveSummary } from '../../core/night-player-summary.service';
import type { ResponseVerdict } from '../../../../supabase/functions/_shared/defensive-episode-kpis';
import { buildDefensiveKitBreakdown, type DefensiveKitBreakdownEntry } from '../../core/defensive-kit-breakdown';

export type DefensiveKitMemberExplainer = DefensiveKitBreakdownEntry;

export interface CriticalWindowExplainer {
  episodeId: string;
  pullId: string;
  pullNumber: number;
  bossId: string;
  bossName: string;
  difficulty: string;
  peakLabel: string;
  peakMs: number;
  verdict: ResponseVerdict;
  verdictLabel: string;
  decisiveSpellNames: string[];
  coveredBySpellName: string | null;
  usedSpellNames: string[];
  wclUrl: string;
}

export interface DefensiveKpiExplainer {
  reaction: { label: string; status: string; score: number | null; engaged: number; evaluable: number };
  response: { label: string; status: string; score: number | null; covered: number; evaluable: number; missedReady: number; missedMistimed: number };
  usage: { label: string; status: string; score: number | null; actualCasts: number; theoreticalMax: number; mode: 'plan' | 'generic_usage' };
  kit: DefensiveKitMemberExplainer[];
  /** Solo los episodios con veredicto evaluable (covered_verified/missed_ready/missed_due_to_mistime) — los
   * mismos que ya cuentan para Reacción/Response, nunca un superconjunto que "parezca" más completo. */
  criticalWindows: CriticalWindowExplainer[];
}

const VERDICT_LABELS: Record<string, string> = {
  covered_verified: 'Cubierto',
  missed_ready: 'Sin cubrir — estaba listo',
  missed_due_to_mistime: 'Sin cubrir — mal timing demostrado',
};

function formatPeak(peakMs: number): string {
  const totalSeconds = Math.round(peakMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function spellName(spellId: number, spellNameById: ReadonlyMap<number, string>): string {
  return spellNameById.get(spellId) ?? `Spell ${spellId}`;
}

export function buildDefensiveKpiExplainer(
  canonical: NightCanonicalDefensiveSummary,
  /** episode.bossName/difficulty/pullNumber ya vienen enriquecidos (CanonicalDefensiveEpisodeView) — lo
   * único que falta para un link real de WCL es el fightId, que no viaja en el episodio. */
  fightIdByPullId: ReadonlyMap<string, number>,
  reportCode: string,
  spellNameById: ReadonlyMap<number, string>,
): DefensiveKpiExplainer {
  const evaluableVerdicts = new Set(['covered_verified', 'missed_ready', 'missed_due_to_mistime']);
  const criticalWindows: CriticalWindowExplainer[] = [];

  for (const episode of canonical.episodes) {
    if (!evaluableVerdicts.has(episode.responseVerdict)) continue;
    const fightId = fightIdByPullId.get(episode.pullId);
    if (fightId == null) continue; // §nunca fabricar un link de WCL — sin fightId real, se excluye de la lista verificable
    criticalWindows.push({
      episodeId: episode.episodeId,
      pullId: episode.pullId,
      pullNumber: episode.pullNumber,
      bossId: episode.bossId,
      bossName: episode.bossName,
      difficulty: episode.difficulty,
      peakMs: episode.peakMs,
      peakLabel: formatPeak(episode.peakMs),
      verdict: episode.responseVerdict,
      verdictLabel: VERDICT_LABELS[episode.responseVerdict] ?? episode.responseVerdict,
      decisiveSpellNames: episode.decisiveSpellIds.map((id) => spellName(id, spellNameById)),
      coveredBySpellName: episode.coveredBySpellId != null ? spellName(episode.coveredBySpellId, spellNameById) : null,
      usedSpellNames: episode.usedSpellIds.map((id) => spellName(id, spellNameById)),
      wclUrl: `https://www.warcraftlogs.com/reports/${reportCode}#fight=${fightId}&type=damage-taken`,
    });
  }

  criticalWindows.sort((a, b) => a.pullNumber - b.pullNumber || a.peakMs - b.peakMs);

  return {
    reaction: {
      label: 'Reacción',
      status: canonical.usage.status,
      score: canonical.usage.score,
      engaged: canonical.usage.engaged,
      evaluable: canonical.usage.evaluable,
    },
    response: {
      label: 'Respuesta',
      status: canonical.response.status,
      score: canonical.response.score,
      covered: canonical.response.covered,
      evaluable: canonical.response.evaluable,
      missedReady: canonical.response.missedReady,
      missedMistimed: canonical.response.missedMistimed,
    },
    usage: {
      label: canonical.management.mode === 'generic_usage' ? 'Uso' : 'Gestión',
      status: canonical.management.status,
      score: canonical.management.score,
      actualCasts: canonical.management.fulfilled,
      theoreticalMax: canonical.management.evaluable,
      mode: canonical.management.mode,
    },
    kit: buildDefensiveKitBreakdown(canonical.kit, canonical.episodes, spellNameById),
    criticalWindows,
  };
}
