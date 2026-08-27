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

export async function loadMechanicNotesByName(client: SupabaseClient, bossIds: string[]): Promise<Map<string, string>> {
  const uniqueBossIds = [...new Set(bossIds)];
  const map = new Map<string, string>();
  if (!uniqueBossIds.length) return map;

  const query = (relation: string) => client
    .from(relation)
    .select('name, ai_classification')
    .in('boss_id', uniqueBossIds)
    .not('ai_classification', 'is', null);
  const { data } = await withSupabaseRelationFallback(
    'applicable_boss_mechanics_candidates',
    () => query('applicable_boss_mechanics_candidates'),
    () => query('boss_mechanics_candidates'),
  );

  for (const row of (data ?? []) as { name: string; ai_classification: { notes?: string } | null }[]) {
    const notes = row.ai_classification?.notes;
    if (notes && !map.has(row.name)) map.set(row.name, notes);
  }
  return map;
}
