import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

// §"un botón para copiar el prompt completo... como si hubiese sido a
// través de la API": factorizado desde generate-pull-brief/index.ts para
// que manual-pull-brief construya EXACTAMENTE el mismo pullContext — si
// esto viviera duplicado en dos sitios, un cambio futuro en uno y no en el
// otro haría que "el prompt que copias" mintiera sobre lo que la llamada
// automática de verdad envía.
//
// §"que pasarle un prompt a la IA y que me diga eso, no aporta nada... o
// faltan datos o faltan decisiones" (feedback real, con el prompt real
// adjunto: solo llevaba wipePct/durationMs/deaths (un número)/
// avoidableDamageTotal/previousPulls — nada sobre QUIÉN murió, A QUÉ, ni
// qué otras mecánicas fallaron sin matar a nadie). Ampliado con lo mismo
// que ya usan las tarjetas "a quién dirigir" y "racha del problema" en la
// UI — nada nuevo que calcular, solo dejar de recortarlo antes de
// mandárselo al LLM. Acotado a listas cortas (no se manda pull_mechanic_events
// entero) para que el prompt siga siendo barato y legible a mano.
export interface PullBriefDeath {
  player: string;
  timeLabel: string;
  mechanic: string;
  category: string | null;
  rootCause: string;
  /** true = tenía un defensivo disponible y sin usar en el momento de morir — la señal más accionable para "nextPullActions". null = sin catálogo/dato para juzgarlo. */
  hadDefensiveAvailableUnused: boolean | null;
}

export interface PullBriefMechanicFail {
  mechanic: string;
  category: string | null;
  outcome: 'partial_fail' | 'fail';
  playersHit: number;
}

export interface PullBriefRepeatedIssue {
  mechanic: string;
  failedPulls: number;
  totalPulls: number;
}

export interface PullBriefContext {
  pullNumber: number;
  wipePct: number | null;
  durationMs: number | null;
  deaths: PullBriefDeath[];
  /** Mecánicas falladas (partial_fail/fail) que NO mataron a nadie — sin esto el LLM solo veía un número de muertes, nunca "casi 20 golpeados por Malevolent Presence" cuando nadie murió de eso. */
  mechanicFails: PullBriefMechanicFail[];
  avoidableDamageTotal: number;
  previousPulls: { pullNumber: number; wipePct: number | null; durationMs: number | null; deaths: number }[];
  /** Misma mecánica fallando en pulls consecutivos de este boss+dificultad (>=2 de >=2 vistos) — el patrón que de verdad justifica un "seguís fallando X", no solo el pull actual aislado. */
  repeatedIssues: PullBriefRepeatedIssue[];
}

interface DeathCauseRow {
  mechanicId: number;
  mechanicName: string | null;
  category: string | null;
  rootCause: string;
  timeMs: number;
  defensiveOptions?: { status: string }[];
}

// §"los que sean unknown ability pon: unknown cause - WC porque quizá es un
// wipe call" (feedback real, 2026-08-24): "Unknown Ability" es el literal
// interno de analyze-report (mechanicId=0, WCL sin spellId en el golpe de
// muerte — típico de caídas al vacío/entorno) — el LLM no debe citarlo tal
// cual en inglés, ni confundirlo con una mecánica real sin clasificar.
// Mismo texto que shared/format.util.ts (Angular) — duplicado aquí porque
// Deno no comparte módulo con el bundle del navegador.
function mechanicDisplayName(name: string | null): string {
  if (!name) return 'Sin identificar';
  if (name === 'Unknown Ability') return 'Causa desconocida (posible wipe call / entorno)';
  return name;
}

function formatTimeLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Mismo umbral/criterio que buildMechanicFailurePatterns en
// pull-analysis.service.ts (cliente) — un solo fallo suelto no es un
// "patrón", es ruido. No se importa el módulo del cliente porque Deno y el
// bundle de Angular no comparten runtime; se repite la misma regla aquí.
const REPEATED_ISSUE_LOOKBACK_PULLS = 5;

export async function buildPullBriefContext(supabase: SupabaseClient, pullId: string): Promise<{ pull: Record<string, unknown>; pullContext: PullBriefContext } | null> {
  const { data: pull } = await supabase.from('pulls').select('*').eq('id', pullId).maybeSingle();
  if (!pull) return null;

  const [{ data: records }, { data: mechEvents }, { data: priorPulls }] = await Promise.all([
    supabase.from('player_pull_records').select('player_name,died,death_cause,avoidable_damage_taken,wipe_call_cluster').eq('pull_id', pullId),
    supabase.from('pull_mechanic_events').select('mechanic_name,category,outcome,players_hit').eq('pull_id', pullId).neq('outcome', 'clean'),
    supabase
      .from('pulls')
      .select('id,pull_number,wipe_pct,duration_ms')
      .eq('boss_id', pull.boss_id)
      .eq('difficulty', pull.difficulty)
      .lt('pull_number', pull.pull_number)
      .order('pull_number', { ascending: false })
      .limit(REPEATED_ISSUE_LOOKBACK_PULLS),
  ]);

  const recordRows = (records ?? []) as { player_name: string; died: boolean; death_cause: DeathCauseRow | null; avoidable_damage_taken: number | null; wipe_call_cluster: boolean }[];
  const avoidableDamageTotal = recordRows.reduce((sum, r) => sum + Number(r.avoidable_damage_taken ?? 0), 0);

  // §"esa gente no debería... contar como muerte, marcado como wipe call":
  // el LLM no debe leer estas muertes como fallos individuales reales.
  const deaths: PullBriefDeath[] = recordRows
    .filter((r) => r.died && r.death_cause && !(r.wipe_call_cluster && pull.wipe_call_excluded))
    .map((r) => {
      const dc = r.death_cause!;
      const options = dc.defensiveOptions ?? [];
      return {
        player: r.player_name,
        timeLabel: formatTimeLabel(dc.timeMs),
        mechanic: dc.mechanicName ? mechanicDisplayName(dc.mechanicName) : `Hechizo #${dc.mechanicId} (sin clasificar)`,
        category: dc.category ?? null,
        rootCause: dc.rootCause,
        hadDefensiveAvailableUnused: options.length ? options.some((o) => o.status === 'available_unused') : null,
      };
    });

  const mechanicFails: PullBriefMechanicFail[] = ((mechEvents ?? []) as { mechanic_name: string; category: string | null; outcome: 'partial_fail' | 'fail'; players_hit: number }[])
    .map((ev) => ({ mechanic: ev.mechanic_name, category: ev.category, outcome: ev.outcome, playersHit: ev.players_hit }))
    .sort((a, b) => b.playersHit - a.playersHit)
    .slice(0, 8); // acotado: la lista completa puede tener docenas de instancias de la misma mecánica repitiéndose (ticks), no aporta más al LLM que las top-N más golpeadas

  const priorPullRows = (priorPulls ?? []) as { id: string; pull_number: number; wipe_pct: number | null; duration_ms: number | null }[];
  let previousPulls: PullBriefContext['previousPulls'] = [];
  let repeatedIssues: PullBriefRepeatedIssue[] = [];
  if (priorPullRows.length) {
    const priorPullIds = priorPullRows.map((p) => p.id);
    const [{ data: priorDeathRows }, { data: priorMechEvents }] = await Promise.all([
      supabase.from('player_pull_records').select('pull_id,died').in('pull_id', priorPullIds),
      supabase.from('pull_mechanic_events').select('pull_id,mechanic_name,outcome').in('pull_id', priorPullIds),
    ]);
    const deathsByPullId = new Map<string, number>();
    for (const r of (priorDeathRows ?? []) as { pull_id: string; died: boolean }[]) {
      if (r.died) deathsByPullId.set(r.pull_id, (deathsByPullId.get(r.pull_id) ?? 0) + 1);
    }
    previousPulls = priorPullRows.map((p) => ({ pullNumber: p.pull_number, wipePct: p.wipe_pct, durationMs: p.duration_ms, deaths: deathsByPullId.get(p.id) ?? 0 }));

    // Mismo criterio que mechanicFailurePatterns del cliente: >=2 pulls
    // vistos Y >=2 fallos entre el pull actual y los anteriores traídos.
    const byMechanic = new Map<string, { pullIds: Set<string>; failedPullIds: Set<string> }>();
    const allEvents = [
      ...((mechEvents ?? []) as { mechanic_name: string; outcome: string }[]).map((e) => ({ pull_id: pullId, mechanic_name: e.mechanic_name, outcome: e.outcome })),
      ...((priorMechEvents ?? []) as { pull_id: string; mechanic_name: string; outcome: string }[]),
    ];
    for (const ev of allEvents) {
      if (!byMechanic.has(ev.mechanic_name)) byMechanic.set(ev.mechanic_name, { pullIds: new Set(), failedPullIds: new Set() });
      const entry = byMechanic.get(ev.mechanic_name)!;
      entry.pullIds.add(ev.pull_id);
      if (ev.outcome !== 'clean') entry.failedPullIds.add(ev.pull_id);
    }
    repeatedIssues = [...byMechanic.entries()]
      .map(([mechanic, e]) => ({ mechanic, failedPulls: e.failedPullIds.size, totalPulls: e.pullIds.size }))
      .filter((e) => e.totalPulls >= 2 && e.failedPulls >= 2)
      .sort((a, b) => b.failedPulls / b.totalPulls - a.failedPulls / a.totalPulls);
  }

  const pullContext: PullBriefContext = {
    pullNumber: pull.pull_number,
    wipePct: pull.wipe_pct,
    durationMs: pull.duration_ms,
    deaths,
    mechanicFails,
    avoidableDamageTotal,
    previousPulls,
    repeatedIssues,
  };

  return { pull, pullContext };
}
