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
export async function resyncMechanicCategory(supabase: SupabaseClient, bossId: string, difficulty: string, mechanicName: string, category: string): Promise<void> {
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
  responsibility: string,
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

/** Mantiene el indicador evitable de los históricos alineado con Ajustes. */
export async function resyncMechanicAvoidable(
  supabase: SupabaseClient,
  bossId: string,
  difficulty: string,
  mechanicName: string,
  avoidable: boolean,
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
