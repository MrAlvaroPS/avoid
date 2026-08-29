import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getFightEvents, getReportActors, getReportFights, type WclActor } from '../_shared/wcl-client.ts';
import { computeDamageProfile } from '../_shared/damage-profile.ts';
import { detectWipeCall, WIPE_CALL_CONFIDENCE_THRESHOLD, type WipeCallThroughputEvent } from '../_shared/wipe-call-detection.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';

// §"Hay que ver la manera de centralizar esta información y, sobretodo, en
// hacerla fiable" (feedback real, 2026-08-28): analyze-report solo procesa
// fights NUEVOS (report_code+fight_id > last_processed_fight_id) — no hay
// forma hoy de corregir un pull ya analizado cuando el propio algoritmo de
// detección de wipe call cambia (caso real: Pandokie quedó fuera del
// cluster por un fallo del algoritmo anterior, ver
// _shared/wipe-call-detection.ts). Esta función vuelve a pedir a WCL SOLO
// lo que hace falta para recalcular el veredicto de wipe call de un pull
// concreto — deaths/healing/damage, no todo el pipeline de mecánicas/gear/
// consumibles — y actualiza en su sitio pulls.wipe_call_* y
// player_pull_records.wipe_call_cluster, SIN insertar una fila nueva ni
// tocar report_code/fight_id/pull_number/last_processed_fight_id.
//
// §"nunca se sobreescribe en un re-análisis del mismo pull salvo que
// cambie el propio wipe_call_confidence" (comentario original de
// wipe_call_excluded, 20260823160000_wipe_call_detection.sql): si el RL ya
// editó a mano wipe_call_excluded vía set-wipe-call-status y la confianza
// recalculada es LA MISMA, esa decisión manual se respeta — solo se toca
// wipe_call_excluded cuando la detección en sí cambió.
//
// §"que todo sea consistente" (feedback real, 2026-08-29, sobre el backfill
// de reanalyze-defensive-pressure): a diferencia de esa función hermana,
// ESTA a propósito NO resuelve spec ni talentos — detectWipeCall trabaja
// sobre daño/curación/muertes agregados del pull entero, nunca cruza contra
// el catálogo de defensivos de una clase concreta, así que no hay ningún
// resultado aquí que dependa de qué talentó cada jugador. No es un corte de
// esquina por coste (talent_spell_lookup ya está cacheado por build, es
// barato) — es que el dato no aplica a lo que calcula esta función.

interface DeathEvent {
  timestamp?: number;
  targetID?: number;
  killingAbilityGameID?: number;
}
interface DamageEvent {
  timestamp?: number;
  targetID?: number;
  amount?: number;
  hitPoints?: number;
  maxHitPoints?: number;
  resources?: { hitPoints?: number; maxHitPoints?: number } | null;
}
interface HealingEvent {
  timestamp?: number;
  targetID?: number;
  amount?: number;
}

interface Body {
  pullId: string;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.pullId) {
    return jsonResponse({ ok: false, error: 'pullId es obligatorio' }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, // service_role: salta RLS, solo vive aquí
  );

  try {
    const { data: pull, error: pullFetchError } = await supabase
      .from('pulls')
      .select('id, report_code, fight_id, wipe_call_confidence, wipe_call_excluded')
      .eq('id', body.pullId)
      .maybeSingle();
    if (pullFetchError) return jsonResponse({ ok: false, error: pullFetchError.message }, 500);
    if (!pull) return jsonResponse({ ok: false, error: `Pull ${body.pullId} no encontrado` }, 404);

    const reportDetail = await getReportFights(pull.report_code);
    const fight = reportDetail.fights.find((f) => f.id === pull.fight_id);
    if (!fight) return jsonResponse({ ok: false, error: `Fight ${pull.fight_id} no encontrado en el report ${pull.report_code}` }, 404);

    const actors = await getReportActors(pull.report_code);
    const actorById = new Map<number, WclActor>(actors.map((a) => [a.id, a]));

    const [deathEvents, damageEvents, damageDoneEvents, healingEvents] = await Promise.all([
      getFightEvents({ code: pull.report_code, fightId: fight.id, dataType: 'Deaths', startTime: fight.startTime, endTime: fight.endTime }),
      getFightEvents({ code: pull.report_code, fightId: fight.id, dataType: 'DamageTaken', startTime: fight.startTime, endTime: fight.endTime, includeResources: true }),
      getFightEvents({ code: pull.report_code, fightId: fight.id, dataType: 'DamageDone', startTime: fight.startTime, endTime: fight.endTime }),
      getFightEvents({ code: pull.report_code, fightId: fight.id, dataType: 'Healing', startTime: fight.startTime, endTime: fight.endTime }),
    ]);

    const deathByTarget = new Map<number, { timestamp: number; killingAbilityGameID: number }>();
    for (const raw of deathEvents) {
      const e = raw as DeathEvent;
      if (typeof e.targetID === 'number') {
        deathByTarget.set(e.targetID, { timestamp: e.timestamp ?? 0, killingAbilityGameID: e.killingAbilityGameID ?? 0 });
      }
    }

    const damageEventsByTarget = new Map<number, DamageEvent[]>();
    for (const raw of damageEvents) {
      const e = raw as DamageEvent;
      if (typeof e.targetID !== 'number') continue;
      if (!damageEventsByTarget.has(e.targetID)) damageEventsByTarget.set(e.targetID, []);
      damageEventsByTarget.get(e.targetID)!.push(e);
    }

    const healingEventsByTarget = new Map<number, { timestamp: number; amount: number }[]>();
    for (const raw of healingEvents) {
      const e = raw as HealingEvent;
      if (typeof e.targetID === 'number' && typeof e.timestamp === 'number') {
        if (!healingEventsByTarget.has(e.targetID)) healingEventsByTarget.set(e.targetID, []);
        healingEventsByTarget.get(e.targetID)!.push({ timestamp: e.timestamp, amount: e.amount ?? 0 });
      }
    }

    const wipeCallDetection = detectWipeCall({
      fight,
      deaths: [...deathByTarget.entries()].map(([actorId, d]) => ({ actorId, timestamp: d.timestamp, killingAbilityGameID: d.killingAbilityGameID })),
      healingEvents: [...healingEventsByTarget.values()].flat(),
      damageDoneEvents: damageDoneEvents as WipeCallThroughputEvent[],
      damageProfileOf: (actorId, timestamp) => computeDamageProfile(damageEventsByTarget.get(actorId) ?? [], timestamp).damageProfile,
    });

    const newConfidence = wipeCallDetection?.confidence ?? null;
    const confidenceChanged = newConfidence !== pull.wipe_call_confidence;
    const pullPatch: Record<string, unknown> = {
      wipe_call_confidence: newConfidence,
      wipe_call_signals: wipeCallDetection?.signals ?? null,
      // §"esto aplica a varias partes de la app... roster tampoco se está
      // corrigiendo" (feedback real, 2026-08-28): roster-snapshot-cache.
      // service.ts solo invalida su snapshot cacheado si cambió el último
      // pull/report/roster — un reanálisis retroactivo como este no mueve
      // ninguna de esas señales, así que sin bumpear updated_at el roster
      // se queda enseñando el veredicto viejo indefinidamente aunque la
      // base de datos ya esté corregida.
      updated_at: new Date().toISOString(),
    };
    // Solo se toca la decisión editable a mano cuando la detección en sí
    // cambió — así una edición manual previa del RL (set-wipe-call-status)
    // sobre una confianza que sigue siendo la misma no se pisa en silencio.
    if (confidenceChanged) {
      pullPatch.wipe_call_excluded = newConfidence != null && newConfidence >= WIPE_CALL_CONFIDENCE_THRESHOLD;
    }
    const { error: pullUpdateError } = await supabase.from('pulls').update(pullPatch).eq('id', pull.id);
    if (pullUpdateError) return jsonResponse({ ok: false, error: pullUpdateError.message }, 500);

    const { data: existingRecords, error: recordsFetchError } = await supabase
      .from('player_pull_records')
      .select('player_name, wipe_call_cluster')
      .eq('pull_id', pull.id);
    if (recordsFetchError) return jsonResponse({ ok: false, error: recordsFetchError.message }, 500);

    const nameByActorId = new Map(fight.friendlyPlayers.map((actorId) => [actorId, actorById.get(actorId)?.name]).filter((entry): entry is [number, string] => Boolean(entry[1])));
    const actorIdByName = new Map([...nameByActorId.entries()].map(([actorId, name]) => [name, actorId]));

    const clusterChanges: { playerName: string; before: boolean; after: boolean }[] = [];
    for (const record of (existingRecords ?? []) as { player_name: string; wipe_call_cluster: boolean }[]) {
      const actorId = actorIdByName.get(record.player_name);
      const after = actorId != null && (wipeCallDetection?.clusterActorIds.has(actorId) ?? false);
      if (after === record.wipe_call_cluster) continue;
      clusterChanges.push({ playerName: record.player_name, before: record.wipe_call_cluster, after });
      const { error: recordUpdateError } = await supabase
        .from('player_pull_records')
        .update({ wipe_call_cluster: after })
        .eq('pull_id', pull.id)
        .eq('player_name', record.player_name);
      if (recordUpdateError) return jsonResponse({ ok: false, error: recordUpdateError.message }, 500);
    }

    return jsonResponse({
      ok: true,
      pullId: pull.id,
      before: { confidence: pull.wipe_call_confidence, excluded: pull.wipe_call_excluded },
      after: { confidence: newConfidence, excluded: pullPatch.wipe_call_excluded ?? pull.wipe_call_excluded, signals: wipeCallDetection?.signals ?? null },
      excludedDecisionPreserved: !confidenceChanged,
      clusterChanges,
    });
  } catch (err) {
    console.error('reanalyze-wipe-call error:', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
