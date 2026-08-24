import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { getCharacterAvatarUrl } from '../_shared/blizzard-client.ts';

// §"la API de wowaudit... roster de verdad en lugar de deducirlo" (feedback
// real): antes el roster se deducía de "quién ha aparecido en algún pull" —
// esto trae el roster CANÓNICO real (nombre, clase, rol de raid Tank/Heal/
// Melee/Ranged, Main/Trial) más la asistencia agregada que wowaudit ya
// calcula (attended_percentage), exactamente el dato que le faltaba al eje
// "asistencia" de fiabilidad (§12, documentado como bloqueado hasta ahora
// por "roster canónico sin construir" — ver reliability.service.ts).
// wowaudit no da spec — eso ya lo trae WCL con más precisión (por pull, no
// un valor fijo por personaje que puede cambiar de talento entre pulls).

interface WowauditCharacter {
  id: number;
  name: string;
  realm: string;
  class: string;
  role: string;
  rank: string;
  status: string;
}

interface WowauditAttendanceEntry {
  id: number;
  attended_amount_of_raids: number;
  total_amount_of_raids: number;
  attended_percentage: number;
}

async function wowauditFetch<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`https://wowaudit.com${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`wowaudit ${path} devolvió ${res.status}: ${await res.text()}`);
  return res.json();
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const apiKey = Deno.env.get('WOWAUDIT_API_KEY');
  if (!apiKey) return jsonResponse({ ok: false, error: 'Falta WOWAUDIT_API_KEY.' }, 500);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  try {
    // §"la asistencia debe ser solo para la season actual" (feedback real):
    // una ventana fija de 60 días mezclaba temporadas/tiers si el guild
    // llevaba tiempo raideando — /v1/period da el inicio REAL de la season
    // vigente (current_season.start_date), que es el corte correcto: cuánto
    // ha asistido cada uno DESDE que empezó a contar lo que se está jugando
    // ahora, no un número arbitrario de días hacia atrás.
    const period = await wowauditFetch<{ current_season: { start_date: string } }>('/v1/period', apiKey);
    const seasonStartDate = period.current_season.start_date;

    // §"la asistencia sigue saliendo rara" (feedback real): se guarda la
    // fecha de inicio de season aparte — attendance.service.ts la usa para
    // calcular asistencia sobre reports REALMENTE importados en Avoid, no
    // sobre el calendario propio de wowaudit (ver migración 20260823150000).
    await supabase.from('wowaudit_season').upsert({ id: true, start_date: seasonStartDate, synced_at: new Date().toISOString() }, { onConflict: 'id' });

    const [characters, attendance] = await Promise.all([
      wowauditFetch<WowauditCharacter[]>('/v1/characters', apiKey),
      wowauditFetch<{ characters: WowauditAttendanceEntry[] }>(`/v1/attendance?start_date=${seasonStartDate}`, apiKey),
    ]);

    const attendanceById = new Map(attendance.characters.map((a) => [a.id, a]));
    const synced_at = new Date().toISOString();
    const trackedCharacters = characters.filter((c) => c.status === 'tracking'); // no traer personajes que la guild ya dejó de seguir

    // §"un dosier de personaje... una foto suya de perfil si podemos
    // tenerla" (feedback real): retrato vía Character Media API — solo se
    // pide para quien todavía no tiene uno guardado (los avatares no
    // cambian casi nunca, y esto evita ~30 llamadas externas en CADA sync
    // en vez de solo la primera vez o cuando alguien nuevo entra al roster).
    const { data: existingAvatarRows } = await supabase.from('wowaudit_roster').select('character_id, avatar_url');
    const avatarByCharacterId = new Map(((existingAvatarRows ?? []) as { character_id: number; avatar_url: string | null }[]).map((r) => [r.character_id, r.avatar_url]));

    const needsAvatar = trackedCharacters.filter((c) => !avatarByCharacterId.get(c.id));
    const AVATAR_BATCH_SIZE = 5;
    for (let i = 0; i < needsAvatar.length; i += AVATAR_BATCH_SIZE) {
      const batch = needsAvatar.slice(i, i + AVATAR_BATCH_SIZE);
      const results = await Promise.all(batch.map((c) => getCharacterAvatarUrl(c.realm, c.name)));
      batch.forEach((c, idx) => avatarByCharacterId.set(c.id, results[idx]));
    }

    const rows = trackedCharacters.map((c) => {
      const att = attendanceById.get(c.id);
      return {
        character_id: c.id,
        name: c.name,
        realm: c.realm,
        class: c.class,
        role: c.role,
        rank: c.rank,
        status: c.status,
        attended_amount_of_raids: att?.attended_amount_of_raids ?? 0,
        total_amount_of_raids: att?.total_amount_of_raids ?? 0,
        attended_percentage: att?.attended_percentage ?? null,
        avatar_url: avatarByCharacterId.get(c.id) ?? null,
        synced_at,
      };
    });

    if (rows.length) {
      const { error } = await supabase.from('wowaudit_roster').upsert(rows, { onConflict: 'character_id' });
      if (error) throw error;
    }

    // Deja de rastrear en nuestra tabla lo que wowaudit ya no rastrea
    // (personaje dado de baja de la guild) — evita un roster que solo crece.
    const trackedIds = rows.map((r) => r.character_id);
    if (trackedIds.length) {
      await supabase.from('wowaudit_roster').delete().not('character_id', 'in', `(${trackedIds.join(',')})`);
    }

    return jsonResponse({ ok: true, charactersSynced: rows.length });
  } catch (err) {
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
