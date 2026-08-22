// Puente entre "candidatas del Journal de Blizzard" y "eventos reales de
// WCL": verificado en real el 2026-08-22 que el ability_id del Journal casi
// NUNCA coincide con el abilityGameID que WCL usa de verdad en Casts/
// DamageTaken/Deaths para el mismo boss (0 de 54 candidatas de un boss
// concreto salían como observed_in_logs=true comparando IDs). El nombre
// mostrado SÍ coincide casi siempre (es el mismo texto que ve un jugador en
// el juego) — así que el cruce fiable es por nombre normalizado, no por ID.
// Cuando hay varias entradas de log con el mismo nombre (fases/variantes),
// se devuelven TODAS: mejor sobre-incluir que perder la coincidencia.

export function normalizeAbilityName(name: string): string {
  return name.trim().toLowerCase();
}

/** name normalizado -> lista de gameID reales que WCL asocia a ese nombre en un report. */
export function buildAbilityIdsByName(abilities: { gameID: number; name: string }[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const a of abilities) {
    const key = normalizeAbilityName(a.name);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(a.gameID);
  }
  return map;
}
