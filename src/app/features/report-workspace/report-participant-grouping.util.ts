// Colocar en: src/app/features/report-workspace/report-participant-grouping.util.ts
// PR3 del plan IRIS (Report Workspace): agrupación Role → Class → Player
// para el navegador de jugadores del sidebar — pura, sin Angular ni
// Supabase, mismo espíritu que groupRosterViews()/filterRosterViews() en
// features/roster/roster-view.util.ts, pero SOLO con lo que ReportParticipant
// ya trae (role/className/name) — nada de score/muertes/% defensivo/
// patrones (spec §41: el sidebar es navegación, nunca un dashboard).
import type { ReportParticipant } from '../../core/report-participants.service';
import type { RaidRole } from '../../shared/role-icon.component';

export type ParticipantRoleGroupKey = 'tanks' | 'healers' | 'dps' | 'unknown';

export interface ParticipantClassGroup {
  /** null = clase desconocida (ni observada esta noche ni en wowaudit_roster) — se muestra "Clase desconocida", nunca se oculta. */
  className: string | null;
  players: ReportParticipant[];
}

export interface ParticipantRoleGroup {
  key: ParticipantRoleGroupKey;
  label: string;
  /** Jugadores bajo este grupo AHORA MISMO (recalculado tras el filtro de búsqueda) — para la cabecera "TANKS 2". */
  count: number;
  classes: ParticipantClassGroup[];
}

// Orden fijo — nunca por score/muertes/etc (spec §18). Melee+Ranged
// colapsan visualmente en 'dps' (spec §17); el rol sin resolver cae en su
// propio grupo, nunca se descarta (spec §19).
const ROLE_GROUPS: { key: ParticipantRoleGroupKey; label: string; roles: RaidRole[] }[] = [
  { key: 'tanks', label: 'Tanks', roles: ['Tank'] },
  { key: 'healers', label: 'Healers', roles: ['Heal'] },
  { key: 'dps', label: 'DPS', roles: ['Melee', 'Ranged'] },
  { key: 'unknown', label: 'Otros / Rol desconocido', roles: [null] },
];

function roleGroupKey(role: RaidRole): ParticipantRoleGroupKey {
  return ROLE_GROUPS.find((g) => g.roles.includes(role))?.key ?? 'unknown';
}

/** Alfabético, pero la clase desconocida (className vacío/null) siempre al final del grupo — nunca compite por orden con una clase real. */
function compareClassNames(a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, 'es');
}

function buildGroups(participants: ReportParticipant[]): ParticipantRoleGroup[] {
  const classesByGroup = new Map<ParticipantRoleGroupKey, Map<string, ReportParticipant[]>>();
  for (const p of participants) {
    const groupKey = roleGroupKey(p.role);
    const classesMap = classesByGroup.get(groupKey) ?? new Map<string, ReportParticipant[]>();
    classesByGroup.set(groupKey, classesMap);
    const classKey = p.className ?? '';
    classesMap.set(classKey, [...(classesMap.get(classKey) ?? []), p]);
  }

  return ROLE_GROUPS.map(({ key, label }) => {
    const classes = [
      ...(classesByGroup.get(key) ?? new Map<string, ReportParticipant[]>()).entries(),
    ]
      .sort(([a], [b]) => compareClassNames(a, b))
      .map(([className, players]) => ({
        className: className || null,
        players: [...players].sort((a, b) => a.name.localeCompare(b.name, 'es')),
      }));
    return { key, label, count: classes.reduce((sum, c) => sum + c.players.length, 0), classes };
  }).filter((group) => group.classes.length > 0);
}

/** Role → Class → Player, con el orden y las reglas fijas descritas arriba (nada de score, sorting por evidencia, etc.). */
export function groupParticipantsForSidebar(
  participants: ReportParticipant[],
): ParticipantRoleGroup[] {
  return buildGroups(participants);
}

/**
 * §21 del spec: busca por nombre, manteniendo la forma Role → Class mientras
 * existan resultados. `count` se recalcula sobre el resultado YA filtrado —
 * un grupo nunca enseña un número que no corresponda a lo visible debajo.
 */
export function filterParticipantGroups(
  groups: ParticipantRoleGroup[],
  search: string,
): ParticipantRoleGroup[] {
  const query = search.trim().toLocaleLowerCase('es');
  if (!query) return groups;
  return groups
    .map((group) => {
      const classes = group.classes
        .map((cls) => ({
          ...cls,
          players: cls.players.filter((p) => p.name.toLocaleLowerCase('es').includes(query)),
        }))
        .filter((cls) => cls.players.length > 0);
      return { ...group, classes, count: classes.reduce((sum, c) => sum + c.players.length, 0) };
    })
    .filter((group) => group.classes.length > 0);
}
