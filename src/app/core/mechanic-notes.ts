// Colocar en: src/app/core/mechanic-notes.ts
// §"poner una 'I' de información junto a la mecánica con la nota
// descriptiva que haya traído la IA al análisis en Ajustes... solo la nota,
// no las fuentes" (feedback real). Mismo cruce por NOMBRE que ya rige todo
// lo demás en este pipeline (resync-mechanic-category.ts, notesByMechanicName
// de pull-analysis.service.ts): el ability_id del manifiesto casi nunca
// coincide con el real de WCL, así que la única clave fiable es el nombre.
// Factorizado aquí porque pull-analysis.service.ts ya construye su propia
// versión acotada a un solo boss+dificultad — esta es la variante para
// pantallas que abarcan VARIOS bosses a la vez (dosier de noche, informe de
// noche), donde hace falta consultar boss_id in (...) en vez de uno solo.
import type { SupabaseClient } from '@supabase/supabase-js';
import { withSupabaseRelationFallback } from '../shared/supabase-query.util';

export interface MechanicCoaching {
  /** Nota descriptiva procedente de la clasificación revisada. */
  note: string | null;
  /** Instrucción práctica persistida en Ajustes; null si aún no se ha contrastado. */
  resolution: string | null;
}

/**
 * Clave exacta de coaching. A diferencia del mapa histórico por nombre, esta
 * incluye boss+dificultad: una habilidad homónima puede resolverse de forma
 * distinta en otro encuentro o dificultad y la infografía no puede mezclarla.
 */
export function mechanicCoachingKey(
  bossId: string,
  difficulty: string,
  mechanicName: string,
): string {
  return `${bossId}|${difficulty}|${mechanicName.trim().toLocaleLowerCase('en-US')}`;
}

/**
 * Variante estricta para superficies de coaching (en especial la infografía
 * que recibe el raider). Solo devuelve texto realmente guardado en el
 * manifiesto y conserva el ámbito boss+dificultad; nunca rellena una
 * resolución ausente con consejos genéricos.
 */
export async function loadMechanicCoachingByKey(
  client: SupabaseClient,
  bossIds: string[],
): Promise<Map<string, MechanicCoaching>> {
  const uniqueBossIds = [...new Set(bossIds)];
  const map = new Map<string, MechanicCoaching>();
  if (!uniqueBossIds.length) return map;

  const query = (relation: string) =>
    client
      .from(relation)
      .select('boss_id, difficulty, name, ai_classification, resolution')
      .in('boss_id', uniqueBossIds);
  const { data, error } = await withSupabaseRelationFallback(
    'applicable_boss_mechanics_candidates',
    () => query('applicable_boss_mechanics_candidates'),
    () => query('boss_mechanics_candidates'),
  );
  if (error) throw error;

  for (const row of (data ?? []) as {
    boss_id: string;
    difficulty: string;
    name: string;
    ai_classification: { notes?: string } | null;
    resolution: string | null;
  }[]) {
    const note = row.ai_classification?.notes?.trim() || null;
    const resolution = row.resolution?.trim() || null;
    map.set(mechanicCoachingKey(row.boss_id, row.difficulty, row.name), {
      note,
      resolution,
    });
  }
  return map;
}

/** Exact key for the ability-id variant — boss+difficulty+ability_id, never a name (§ability_id join below). */
export function mechanicCatalogKeyByAbility(bossId: string, difficulty: string, abilityId: number): string {
  return `${bossId}|${difficulty}|${abilityId}`;
}

/**
 * Variant of loadMechanicCoachingByKey keyed by the real WCL ability id instead of name. Needed for surfaces
 * that only have an ability id and no reliable name of their own (e.g. a canonical DefensiveEpisode's
 * `dominantAbilityGameId`).
 *
 * §Bug real (2026-09-07, "han desaparecido algunos nombres de mecánicas y sale solo el id con #"): esto
 * cruzaba antes por `boss_mechanics_candidates.ability_id` directamente. Ese ability_id es el ID del Journal
 * de Blizzard, NUNCA el abilityGameID real de WCL — sync-boss-mechanics.ts ya lo documenta y lo verificó en
 * real (0/54 candidatas de un boss casaban por ID). `episode.dominantAbilityGameId` SIEMPRE es el ID real de
 * WCL, así que ese cruce fallaba casi siempre y la infografía v3 caía al fallback `#<id>` para la mayoría de
 * mecánicas (introducido en el cutover v3 del 2026-09-05, commit "infografic v3 KPI" — antes de eso el
 * desglose de mecánicas usaba el pipeline v2, que sí lleva el nombre pegado al evento).
 *
 * `pull_mechanic_events.ability_id` sí es el abilityGameID real de WCL — mechanic-event-materialization.ts lo
 * graba directamente desde `abilityGameID`/`extraAbilityGameID`/`killingAbilityGameID`. Se usa esa tabla para
 * resolver el ability_id real -> nombre, y luego se cruza ese nombre (no el ability_id) contra
 * `boss_mechanics_candidates` para traer nota/resolución — mismo cruce por NOMBRE que ya rige el resto del
 * pipeline (ver cabecera del archivo). pull_mechanic_events solo tiene outcome!=clean (rows donde alguien fue
 * golpeado): sigue sin cubrir en el 100% de los casos una mecánica que este boss+dificultad SIEMPRE esquivó en
 * toda la historia registrada, pero eso es un hueco raro y de fallo silencioso (`#<id>`), no un cruce roto que
 * falla casi siempre.
 */
export async function loadMechanicCatalogByAbilityId(
  client: SupabaseClient,
  bossIds: string[],
): Promise<Map<string, { name: string; note: string | null; resolution: string | null }>> {
  const uniqueBossIds = [...new Set(bossIds)];
  const map = new Map<string, { name: string; note: string | null; resolution: string | null }>();
  if (!uniqueBossIds.length) return map;

  const { data: pullRows, error: pullError } = await client
    .from('pulls')
    .select('id, boss_id, difficulty')
    .in('boss_id', uniqueBossIds);
  if (pullError) throw pullError;
  const pullMeta = new Map(
    ((pullRows ?? []) as { id: string; boss_id: string; difficulty: string }[]).map((p) => [
      p.id,
      { bossId: p.boss_id, difficulty: p.difficulty },
    ]),
  );
  const pullIds = [...pullMeta.keys()];
  if (!pullIds.length) return map;

  const { data: eventRows, error: eventError } = await client
    .from('pull_mechanic_events')
    .select('pull_id, ability_id, mechanic_name')
    .in('pull_id', pullIds);
  if (eventError) throw eventError;

  const nameByKey = new Map<string, string>();
  for (const row of (eventRows ?? []) as { pull_id: string; ability_id: number; mechanic_name: string }[]) {
    const meta = pullMeta.get(row.pull_id);
    if (!meta) continue;
    // Primera aparición gana — si un mismo ability_id llegó alguna vez con dos textos distintos (typo/rename
    // histórico), no vale la pena resolverlo aquí; ninguna variante es más "correcta" que otra sin más contexto.
    const key = mechanicCatalogKeyByAbility(meta.bossId, meta.difficulty, row.ability_id);
    if (!nameByKey.has(key)) nameByKey.set(key, row.mechanic_name);
  }
  if (!nameByKey.size) return map;

  const query = (relation: string) =>
    client
      .from(relation)
      .select('boss_id, difficulty, name, ai_classification, resolution')
      .in('boss_id', uniqueBossIds);
  const { data, error } = await withSupabaseRelationFallback(
    'applicable_boss_mechanics_candidates',
    () => query('applicable_boss_mechanics_candidates'),
    () => query('boss_mechanics_candidates'),
  );
  if (error) throw error;

  const coachingByNameKey = new Map<string, { note: string | null; resolution: string | null }>();
  for (const row of (data ?? []) as {
    boss_id: string;
    difficulty: string;
    name: string;
    ai_classification: { notes?: string } | null;
    resolution: string | null;
  }[]) {
    coachingByNameKey.set(mechanicCoachingKey(row.boss_id, row.difficulty, row.name), {
      note: row.ai_classification?.notes?.trim() || null,
      resolution: row.resolution?.trim() || null,
    });
  }

  for (const [key, name] of nameByKey) {
    const [bossId, difficulty] = key.split('|');
    const coaching = coachingByNameKey.get(mechanicCoachingKey(bossId, difficulty, name));
    map.set(key, { name, note: coaching?.note ?? null, resolution: coaching?.resolution ?? null });
  }
  return map;
}

export async function loadMechanicNotesByName(client: SupabaseClient, bossIds: string[]): Promise<Map<string, string>> {
  const uniqueBossIds = [...new Set(bossIds)];
  const map = new Map<string, string>();
  if (!uniqueBossIds.length) return map;

  const query = (relation: string) => client
    .from(relation)
    .select('name, difficulty, ai_classification')
    .in('boss_id', uniqueBossIds)
    .not('ai_classification', 'is', null);
  const { data } = await withSupabaseRelationFallback(
    'applicable_boss_mechanics_candidates',
    () => query('applicable_boss_mechanics_candidates'),
    () => query('boss_mechanics_candidates'),
  );

  // §"esa mecanica la descripcion dice que se usa deliberadamente para
  // limpiar, asi que no deberia contar como fallo" (feedback real,
  // 2026-08-27) — caso real: Slithering Flame en Nek'zali the Soulcoiler
  // tiene 3 filas (una por dificultad) con notas DISTINTAS ("en Normal
  // castiga a quienes no soakean" vs "en Heroic/Mythic se usa
  // deliberadamente para limpiar cadáveres"). Investigado a fondo: el
  // fallo en sí SÍ era correcto para ese pull concreto (era Normal, y el
  // catálogo ya tenía avoidable=true ahí — nada que corregir en la
  // clasificación). El bug real era que este mapa se indexaba solo por
  // NOMBRE — con notas distintas por fila, la que devolviera la query
  // primero ganaba para TODAS las dificultades, así que un pull de Normal
  // podía enseñar la nota de Heroic/Mythic sin avisar. Threading
  // difficulty por los ~8 sitios que ya consumen Map<string,string> (dosier,
  // informe de noche, historial de boss, detalle de jugador) es un cambio
  // mucho más grande que el problema — en vez de eso: si todas las
  // dificultades de un nombre comparten la misma nota (el caso normal, la
  // mayoría), no cambia nada; si DIFIEREN, se combinan con su dificultad
  // por delante, para no enseñar nunca la de otra dificultad como si fuera
  // universal. pull-analysis.service.ts NO tiene este bug — ya filtra por
  // boss_id+difficulty de un pull concreto, no agrega varios bosses/noches.
  const notesByNameAndDifficulty = new Map<string, Map<string, string>>();
  for (const row of (data ?? []) as { name: string; difficulty: string; ai_classification: { notes?: string } | null }[]) {
    const notes = row.ai_classification?.notes;
    if (!notes) continue;
    if (!notesByNameAndDifficulty.has(row.name)) notesByNameAndDifficulty.set(row.name, new Map());
    notesByNameAndDifficulty.get(row.name)!.set(row.difficulty, notes);
  }
  for (const [name, byDifficulty] of notesByNameAndDifficulty) {
    const uniqueNotes = new Set(byDifficulty.values());
    map.set(
      name,
      uniqueNotes.size === 1
        ? uniqueNotes.values().next().value!
        : [...byDifficulty.entries()].map(([difficulty, note]) => `${difficulty}: ${note}`).join(' · '),
    );
  }
  return map;
}
