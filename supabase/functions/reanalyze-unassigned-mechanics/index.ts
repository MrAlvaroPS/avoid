import { createClient } from 'jsr:@supabase/supabase-js@2';
import { getFightEvents, getReportActors, getReportFights, type WclActor } from '../_shared/wcl-client.ts';
import { detectUnassignedMechanicOccurrences, type UnassignedMechanicCatalogEntry, type ActorLite, type GenericEvent } from '../_shared/unassigned-mechanics.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { requireOfficer } from '../_shared/require-officer.ts';

// §"la raid debe hacerlo... no marca a nadie a propósito" (feedback real,
// 2026-08-29): analyze-report solo calcula unassigned_mechanic_occurrences
// para fights NUEVOS a partir de su despliegue — igual que
// reanalyze-defensive-pressure/reanalyze-wipe-call, esta función recalcula
// esa misma columna para un pull YA importado, sin tocar report_code/
// fight_id/pull_number/death_cause/nada más de la fila. Hace falta también
// para el caso normal de "se añade una fila nueva al catálogo" (ej. se
// descubre que otro boss tiene huevos parecidos): sin esto, los pulls
// antiguos de ESE boss se quedarían sin el dato aunque el catálogo ya lo
// cubra, igual que pasaba con defensive_pressure_windows antes de que
// existiera su función hermana.
//
// A propósito NO resuelve spec/talentos/gear (a diferencia de
// reanalyze-defensive-pressure): la detección aquí no depende de la clase ni
// del build de cada jugador, solo de qué actorId casteó/golpeó/recibió qué
// evento — mismo criterio "el dato no aplica" que ya documenta
// reanalyze-wipe-call para su propio recorte.
//
// unassigned_mechanic_occurrences vive en `pulls` (a nivel de RAID, no de
// jugador — ver comentario de la columna en la migración
// 20260829030000_unassigned_mechanics.sql), así que aquí no hace falta
// tocar player_pull_records en absoluto: un único UPDATE sobre `pulls`.

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const guard = await requireOfficer(req);
  if (guard instanceof Response) return guard;

  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);

  let body: { pullId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Body JSON inválido' }, 400);
  }
  if (!body.pullId) return jsonResponse({ ok: false, error: 'pullId es obligatorio' }, 400);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    const { data: pull, error: pullFetchError } = await supabase
      .from('pulls')
      .select('id, report_code, fight_id, boss_id, difficulty, unassigned_mechanic_occurrences')
      .eq('id', body.pullId)
      .maybeSingle();
    if (pullFetchError) return jsonResponse({ ok: false, error: pullFetchError.message }, 500);
    if (!pull) return jsonResponse({ ok: false, error: `Pull ${body.pullId} no encontrado` }, 404);

    // Igual invariante que analyze-report: si este boss+dificultad no tiene
    // NINGUNA fila en el catálogo, no se toca la columna — null sigue
    // significando "nunca evaluado (sin catálogo)", distinto de un array
    // vacío real ("evaluado, nadie la resolvió este pull").
    // §verificado 2026-08-29 (ver migración 20260829040000): mismo filtro
    // que analyze-report — solo catálogo con detección CONFIRMADA contra
    // datos reales entra aquí.
    const { data: unassignedMechanicRows, error: catalogError } = await supabase
      .from('unassigned_mechanic_catalog')
      .select('id,ability_id,actor_name_pattern,name,detection_type,applied_by')
      .eq('boss_id', pull.boss_id)
      .eq('difficulty', pull.difficulty)
      .eq('has_confirmed_detection', true)
      .returns<
        { id: string; ability_id: number | null; actor_name_pattern: string | null; name: string; detection_type: UnassignedMechanicCatalogEntry['detectionType']; applied_by: UnassignedMechanicCatalogEntry['appliedBy'] }[]
      >();
    if (catalogError) return jsonResponse({ ok: false, error: catalogError.message }, 500);
    const catalog: UnassignedMechanicCatalogEntry[] = (unassignedMechanicRows ?? []).map((r) => ({
      id: r.id,
      abilityId: r.ability_id,
      actorNamePattern: r.actor_name_pattern,
      name: r.name,
      detectionType: r.detection_type,
      appliedBy: r.applied_by,
    }));
    if (!catalog.length) {
      return jsonResponse({
        ok: true,
        pullId: pull.id,
        skipped: true,
        reason: `Sin catálogo de mecánicas sin asignar para boss ${pull.boss_id} (${pull.difficulty})`,
        catalogSize: 0,
      });
    }

    const reportDetail = await getReportFights(pull.report_code);
    const fight = reportDetail.fights.find((f) => f.id === pull.fight_id);
    if (!fight) return jsonResponse({ ok: false, error: `Fight ${pull.fight_id} no encontrado en el report ${pull.report_code}` }, 404);

    const actors = await getReportActors(pull.report_code);
    const actorById = new Map<number, WclActor>(actors.map((a) => [a.id, a]));

    const needsDebuffEvents = catalog.some((e) => e.detectionType === 'debuff_applied');
    const needsBuffEvents = catalog.some((e) => e.detectionType === 'buff_applied');

    const [friendlyCastEvents, damageDoneEvents, debuffEvents, buffEvents] = await Promise.all([
      getFightEvents({ code: pull.report_code, fightId: fight.id, dataType: 'Casts', startTime: fight.startTime, endTime: fight.endTime, hostilityType: 'Friendlies' }),
      getFightEvents({ code: pull.report_code, fightId: fight.id, dataType: 'DamageDone', startTime: fight.startTime, endTime: fight.endTime }),
      needsDebuffEvents
        ? getFightEvents({ code: pull.report_code, fightId: fight.id, dataType: 'Debuffs', startTime: fight.startTime, endTime: fight.endTime })
        : Promise.resolve([] as Record<string, unknown>[]),
      needsBuffEvents
        ? getFightEvents({ code: pull.report_code, fightId: fight.id, dataType: 'Buffs', startTime: fight.startTime, endTime: fight.endTime })
        : Promise.resolve([] as Record<string, unknown>[]),
    ]);

    const occurrences = detectUnassignedMechanicOccurrences({
      catalog,
      fightStartTime: fight.startTime,
      castEvents: friendlyCastEvents as GenericEvent[],
      damageDoneEvents: damageDoneEvents as GenericEvent[],
      debuffEvents: debuffEvents as GenericEvent[],
      buffEvents: buffEvents as GenericEvent[],
      actorById: actorById as unknown as Map<number, ActorLite>,
      playerActorIds: new Set(fight.friendlyPlayers),
    });

    const { error: updateError } = await supabase
      .from('pulls')
      .update({
        unassigned_mechanic_occurrences: occurrences,
        // §"que todo sea consistente" (mismo motivo que reanalyze-wipe-call):
        // es la señal que lee NightPlayerSummaryCacheService.fingerprint()
        // para saber "hay que recalcular, no sirvas el caché".
        updated_at: new Date().toISOString(),
      })
      .eq('id', pull.id);
    if (updateError) return jsonResponse({ ok: false, error: updateError.message }, 500);

    return jsonResponse({
      ok: true,
      pullId: pull.id,
      catalogSize: catalog.length,
      before: Array.isArray(pull.unassigned_mechanic_occurrences) ? pull.unassigned_mechanic_occurrences.length : 0,
      after: occurrences.length,
      occurrences,
    });
  } catch (err) {
    console.error('reanalyze-unassigned-mechanics error:', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
