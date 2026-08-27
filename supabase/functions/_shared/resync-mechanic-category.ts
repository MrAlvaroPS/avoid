import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

// §"Uncoiling sale sin clasificar en 'a quién dirigir' pero confirmada en
// la tabla de Ajustes... falta ahí cruce de datos, ese cruce está
// arruinando varias partes de la app" (feedback real, investigado a fondo):
// pull_mechanic_events.category y player_pull_records.death_cause.category
// se escriben UNA SOLA VEZ en analyze-report, en el momento de analizar
// cada pull — son una foto fija de la categoría que existía ENTONCES.
// Clasificar una mecánica en Ajustes DESPUÉS de analizar pulls (el caso
// normal) no tocaba ninguna de las dos.
//
// §segundo bug real encontrado verificando el primer arreglo: el
// ability_id del MANIFIESTO (sacado del Journal de Blizzard) casi nunca
// coincide con el ability_id REAL que WCL usa en los eventos — Uncoiling
// es 1290003 en boss_mechanics_candidates pero 1292315 en
// pull_mechanic_events/death_cause de verdad (mismo fenómeno ya visto con
// Malevolent Presence: 1295449 vs 1295450). analyze-report ya lo resuelve
// en el momento de analizar cruzando por NOMBRE (ver realIdsByName/
// normalizeAbilityName) — así que mechanic_name/death_cause.mechanicName
// SÍ quedan consistentes con el nombre del candidato, aunque el ID no lo
// esté. Re-marcar por ability_id (como hacía la primera versión de esta
// función) fallaba en silencio para cualquier mecánica con IDs
// distintos — exactamente el caso de Uncoiling. Se re-marca por NOMBRE.
export async function resyncMechanicCategory(supabase: SupabaseClient, bossId: string, difficulty: string, mechanicName: string, category: string | null): Promise<void> {
  const { data: pullRows } = await supabase.from('pulls').select('id').eq('boss_id', bossId).eq('difficulty', difficulty);
  const pullIds = ((pullRows ?? []) as { id: string }[]).map((p) => p.id);
  if (!pullIds.length) return;

  await supabase.from('pull_mechanic_events').update({ category }).eq('mechanic_name', mechanicName).in('pull_id', pullIds);

  const { data: deathRows } = await supabase.from('player_pull_records').select('id, death_cause').in('pull_id', pullIds);
  for (const r of (deathRows ?? []) as { id: string; death_cause: Record<string, unknown> | null }[]) {
    if (!r.death_cause || r.death_cause.mechanicName !== mechanicName) continue;
    // Mismo criterio de prioridad que computeRootCause() en analyze-report
    // — solo SUBE de precisión (de 'unclassified' a algo real basado en la
    // categoría nueva), nunca pisa un rootCause ya calculado con evidencia
    // propia (no_healing_received depende del perfil de daño, no de la
    // categoría — no se toca).
    let rootCause = r.death_cause.rootCause;
    if (rootCause === 'unclassified') {
      if (category === 'avoidable-ground' || category === 'spread') rootCause = 'self_positioning';
      else if (category === 'soak') rootCause = 'unsoaked_mechanic';
    }
    await supabase
      .from('player_pull_records')
      .update({ death_cause: { ...r.death_cause, category, categoryIsInferred: false, rootCause } })
      .eq('id', r.id);
  }
}

/** Propaga la responsabilidad confirmada a eventos y muertes históricos. */
export async function resyncMechanicResponsibility(
  supabase: SupabaseClient,
  bossId: string,
  difficulty: string,
  mechanicName: string,
  responsibility: string | null,
): Promise<void> {
  const { data: pullRows } = await supabase.from('pulls').select('id').eq('boss_id', bossId).eq('difficulty', difficulty);
  const pullIds = ((pullRows ?? []) as { id: string }[]).map((pull) => pull.id);
  if (!pullIds.length) return;

  await supabase
    .from('pull_mechanic_events')
    .update({ responsibility })
    .eq('mechanic_name', mechanicName)
    .in('pull_id', pullIds);

  const { data: deathRows } = await supabase.from('player_pull_records').select('id, death_cause').in('pull_id', pullIds);
  for (const row of (deathRows ?? []) as { id: string; death_cause: Record<string, unknown> | null }[]) {
    if (!row.death_cause || row.death_cause.mechanicName !== mechanicName) continue;
    await supabase
      .from('player_pull_records')
      .update({ death_cause: { ...row.death_cause, responsibility } })
      .eq('id', row.id);
  }
}

// §bug real encontrado (2026-08-27): los tres campos aceptan `null` a
// propósito. `category`/`responsibility` vuelven a "sin decidir" al
// corregir una clasificación equivocada, y `avoidable` es tri-estado de
// verdad (true/false/null = mezcla no demostrable, §A.11.5) — antes los tres
// llamadores solo invocaban esto cuando el valor nuevo era truthy/boolean,
// así que "volver a poner en null" actualizaba el candidato en Ajustes pero
// nunca llegaba a pull_mechanic_events/death_cause: la clasificación vieja
// se quedaba viva ahí para siempre, exactamente el mismo cruce roto que el
// comentario de arriba ya documentó una vez para category.

/** Mantiene el indicador evitable de los históricos alineado con Ajustes. */
export async function resyncMechanicAvoidable(
  supabase: SupabaseClient,
  bossId: string,
  difficulty: string,
  mechanicName: string,
  avoidable: boolean | null,
): Promise<void> {
  const { data: pullRows } = await supabase.from('pulls').select('id').eq('boss_id', bossId).eq('difficulty', difficulty);
  const pullIds = ((pullRows ?? []) as { id: string }[]).map((pull) => pull.id);
  if (!pullIds.length) return;

  await supabase
    .from('pull_mechanic_events')
    .update({ avoidable })
    .eq('mechanic_name', mechanicName)
    .in('pull_id', pullIds);

  const { data: deathRows } = await supabase.from('player_pull_records').select('id, death_cause').in('pull_id', pullIds);
  for (const row of (deathRows ?? []) as { id: string; death_cause: Record<string, unknown> | null }[]) {
    if (!row.death_cause || row.death_cause.mechanicName !== mechanicName) continue;
    await supabase
      .from('player_pull_records')
      .update({ death_cause: { ...row.death_cause, avoidable } })
      .eq('id', row.id);
  }
}

// §"Daño evitable de toda la noche — solo hay cobertura en 1 de 3
// combinaciones boss/dificultad" (feedback real, investigado): el número no
// estaba mal calculado — measuredBossScopes/totalBossScopes ya reflejaban
// la cobertura real en el momento de generar el informe. El problema es que
// generate-night-full-report solo recalcula cuando cambia schemaVersion o
// se pide "Actualizar" a mano: clasificar más mecánicas en Ajustes DESPUÉS
// de generar un informe (el caso normal, un boss se cura poco a poco) no
// invalida el caché. Verificado en real: el informe cacheado de
// W9AfGbRhmPkXMapx seguía en "2/3" con boss_mechanics_candidates ya en
// "3/3" — quien lo abriera vería una cobertura peor de la real hasta pulsar
// "Actualizar" a mano, sin saber que hacía falta.
//
// No se recalcula el informe aquí (sería lento y bloquearía el guardado en
// Ajustes) — se borra la fila cacheada, igual que un cache-invalidate-on-write
// normal: la próxima vez que alguien abra ese informe, generate-night-full-report
// no encuentra caché y lo reconstruye ya con la clasificación al día.
export async function invalidateNightFullReportsForBossDifficulty(supabase: SupabaseClient, bossId: string, difficulty: string): Promise<void> {
  const { data: pullRows } = await supabase.from('pulls').select('report_code').eq('boss_id', bossId).eq('difficulty', difficulty);
  const reportCodes = [...new Set(((pullRows ?? []) as { report_code: string }[]).map((p) => p.report_code))];
  if (!reportCodes.length) return;
  await supabase.from('night_full_reports').delete().in('report_code', reportCodes).then(
    () => {},
    (err) => console.error('No se pudo invalidar night_full_reports tras reclasificar (no bloqueante):', err),
  );
}
