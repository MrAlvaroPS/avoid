// Cliente de Wago DB2 (dumps CSV de las tablas del cliente del juego). Fuente
// SIN autenticación, pública. Basado en
// server/knowledge/providers/wago-db2-journal-difficulty-v1.mjs del repo
// original (probado en real: https://wago.tools/db2/Difficulty/csv?build=X).
//
// Para qué sirve: WCL numera sus dificultades con IDs propios (1=LFR, 3=Normal,
// 4=Heroic, 5=Mythic) que NO coinciden con los IDs de la tabla `Difficulty` de
// Blizzard (ahí Normal=1, Heroic=2...). Sin este cruce, no hay forma fiable de
// saber "esta mecánica solo aplica en Heroic+" — es justo el hueco que el
// README de este proyecto dejaba marcado como sin resolver.

import { fetchWithTimeout } from './http.ts';

const BASE_URL = 'https://wago.tools/db2';
const MAX_BYTES = 3_000_000;
const MAX_ROWS = 20_000;
const FETCH_TIMEOUT_MS = 8000;

/** Convierte el namespace de Blizzard ("static-12.1.0_68914-eu") al formato de build que pide Wago ("12.1.0.68914"). */
export function buildFromBlizzardNamespace(namespace: string): string {
  const match = namespace.match(/^static-(\d+)\.(\d+)\.(\d+)_(\d+)-[a-z0-9-]+$/i);
  if (match) return `${match[1]}.${match[2]}.${match[3]}.${match[4]}`;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(namespace)) return namespace;
  throw new Error(`Formato de build/namespace no reconocido: ${namespace}`);
}

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      pushField();
      continue;
    }
    if (ch === '\n') {
      pushRow();
      continue;
    }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field.length || row.length) pushRow();
  const nonEmpty = rows.filter((values) => values.some((v) => v !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0].map((h) => h.trim());
  return {
    headers,
    rows: nonEmpty.slice(1).map((values) => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))),
  };
}

async function fetchTable(table: string, build: string): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const url = new URL(`${BASE_URL}/${table}/csv`);
  url.searchParams.set('build', build);
  const res = await fetchWithTimeout(
    url,
    { headers: { Accept: 'text/csv,*/*;q=0.5', 'User-Agent': 'AvoiD-RL/0.1 journal-difficulty' } },
    FETCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`Wago DB2 HTTP ${res.status} para ${table}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error(`${table} supera el límite de seguridad de ${MAX_BYTES} bytes`);
  const text = await res.text();
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error(`${table} supera el límite de seguridad de ${MAX_BYTES} bytes`);
  const parsed = parseCsv(text);
  if (parsed.rows.length > MAX_ROWS) throw new Error(`${table} supera el límite de seguridad de ${MAX_ROWS} filas`);
  return parsed;
}

function optionalInt(value: string | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

export interface JournalDifficultySnapshot {
  build: string;
  /** journalSectionId -> Set de db2 difficultyId que restringen esa sección. */
  sectionDifficultyIds: Map<number, Set<number>>;
  /** journalEncounterId -> Set de db2 difficultyId que restringen todo el encounter. */
  encounterDifficultyIds: Map<number, Set<number>>;
  difficulties: { difficultyId: number; name: string; minPlayers: number | null; maxPlayers: number | null }[];
}

/** Trae y cruza JournalSectionXDifficulty + JournalEncounterXDifficulty + Difficulty para un build concreto. */
export async function fetchJournalDifficultySnapshot(build: string): Promise<JournalDifficultySnapshot> {
  const [sections, encounters, difficulties] = await Promise.all([
    fetchTable('JournalSectionXDifficulty', build),
    fetchTable('JournalEncounterXDifficulty', build),
    fetchTable('Difficulty', build),
  ]);

  const sectionDifficultyIds = new Map<number, Set<number>>();
  for (const row of sections.rows) {
    const sectionId = optionalInt(row.JournalEncounterSectionID ?? row.JournalSectionID);
    const difficultyId = optionalInt(row.DifficultyID);
    if (!sectionId || !difficultyId) continue;
    if (!sectionDifficultyIds.has(sectionId)) sectionDifficultyIds.set(sectionId, new Set());
    sectionDifficultyIds.get(sectionId)!.add(difficultyId);
  }

  const encounterDifficultyIds = new Map<number, Set<number>>();
  for (const row of encounters.rows) {
    const encounterId = optionalInt(row.JournalEncounterID);
    const difficultyId = optionalInt(row.DifficultyID);
    if (!encounterId || !difficultyId) continue;
    if (!encounterDifficultyIds.has(encounterId)) encounterDifficultyIds.set(encounterId, new Set());
    encounterDifficultyIds.get(encounterId)!.add(difficultyId);
  }

  const difficultyRows = difficulties.rows
    .map((row) => ({
      difficultyId: optionalInt(row.ID),
      name: (row.Name_lang ?? row.Name ?? '').trim(),
      minPlayers: optionalInt(row.MinPlayers),
      maxPlayers: optionalInt(row.MaxPlayers),
    }))
    .filter((row): row is { difficultyId: number; name: string; minPlayers: number | null; maxPlayers: number | null } =>
      row.difficultyId != null && row.name !== '',
    );

  return { build, sectionDifficultyIds, encounterDifficultyIds, difficulties: difficultyRows };
}

export interface TalentSpellLookup {
  build: string;
  /** talentTree[].id que da WCL en combatantInfo (== TraitNodeEntry.ID) -> spell ID real de Blizzard. */
  entryIdToSpellId: Map<number, number>;
  /**
   * §E2.1 (2026-09-04, corrección de build-provenance tras la auditoría de
   * roster completo): TODOS los TraitNodeEntry.ID que existen de verdad en el
   * DB2 de este build, resuelvan o no a un spell — entryIdToSpellId por sí
   * solo NO distingue "entry real sin spell" (nodo estructural — p. ej. el
   * selector del árbol de Hero Talents) de "entry que no se pudo resolver".
   * Confirmado real: TODOS los jugadores del roster auditado tienen
   * exactamente UN nodo seleccionado de este tipo, sin spell, en un rango de
   * ID estrecho y consistente por clase — no es dato faltante, es un nodo
   * legítimo sin spellId. Nunca se le inventa un spellId; este set es lo que
   * permite al resolver distinguirlo de un talento genuinamente sin resolver.
   */
  knownEntryIds: Set<number>;
}

/**
 * Resuelve cada nodo de talento que WCL da en `combatantInfo.talentTree[].id`
 * a un spell ID real de Blizzard, cruzando TraitNodeEntry + TraitDefinition.
 * Cadena verificada a mano con datos reales de un log:
 *   talentTree[].id === TraitNodeEntry.ID
 *   -> TraitNodeEntry.TraitDefinitionID
 *   -> TraitDefinition.ID (== ese TraitDefinitionID)
 *   -> TraitDefinition.SpellID
 * (ej.: entry 91425 -> defID 96427 -> spellID 452902, confirmado real).
 * Con el spell ID, Wowhead resuelve solo nombre/icono/descripción vía
 * data-wowhead="spell=X" — no hace falta guardar nombres aquí.
 */
export async function fetchTalentSpellLookup(build: string): Promise<TalentSpellLookup> {
  const [entries, definitions] = await Promise.all([
    fetchTable('TraitNodeEntry', build),
    fetchTable('TraitDefinition', build),
  ]);

  const spellIdByDefinitionId = new Map<number, number>();
  for (const row of definitions.rows) {
    const definitionId = optionalInt(row.ID);
    if (definitionId == null) continue;
    // Casi todos los talentos llevan su propio SpellID; algunos (los que
    // sustituyen a otro hechizo base) solo llevan OverridesSpellID.
    const spellId = optionalInt(row.SpellID) || optionalInt(row.OverridesSpellID);
    if (spellId) spellIdByDefinitionId.set(definitionId, spellId);
  }

  const entryIdToSpellId = new Map<number, number>();
  const knownEntryIds = new Set<number>();
  for (const row of entries.rows) {
    const entryId = optionalInt(row.ID);
    if (entryId == null) continue;
    // §E2.1: se registra COMO CONOCIDO independientemente de si resuelve a un
    // spell — ver comentario de knownEntryIds en TalentSpellLookup. No
    // condicionar esto a `definitionId != null`: un entry sin TraitDefinitionID
    // sigue siendo un entry real del DB2 de este build.
    knownEntryIds.add(entryId);
    const definitionId = optionalInt(row.TraitDefinitionID);
    if (definitionId == null) continue;
    const spellId = spellIdByDefinitionId.get(definitionId);
    if (spellId) entryIdToSpellId.set(entryId, spellId);
  }

  return { build, entryIdToSpellId, knownEntryIds };
}
