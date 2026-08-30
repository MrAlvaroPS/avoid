// Colocar en: src/app/shared/spec-role.util.ts
// §"cómo se clasifica la gente... Mechavalec sale de dps cuando el log pone
// 'guerrero protección' que es tank" (feedback real): mapa class+spec (tal
// cual los guarda WCL en player_pull_records — subType/spec, sin espacios en
// el nombre de clase, CON espacio en "Beast Mastery") -> rol de raid. Fuente
// de verdad real (combate), usado para corregir el role de wowaudit cuando
// está desactualizado — ver wowaudit-roster.service.ts.
import type { RaidRole } from './role-icon.component';

const SPEC_ROLE: Record<string, Record<string, RaidRole>> = {
  Warrior: { Protection: 'Tank', Arms: 'Melee', Fury: 'Melee' },
  Paladin: { Protection: 'Tank', Holy: 'Heal', Retribution: 'Melee' },
  DeathKnight: { Blood: 'Tank', Frost: 'Melee', Unholy: 'Melee' },
  Druid: { Guardian: 'Tank', Restoration: 'Heal', Balance: 'Ranged', Feral: 'Melee' },
  Monk: { Brewmaster: 'Tank', Mistweaver: 'Heal', Windwalker: 'Melee' },
  DemonHunter: { Vengeance: 'Tank', Havoc: 'Melee' },
  Priest: { Holy: 'Heal', Discipline: 'Heal', Shadow: 'Ranged' },
  Shaman: { Restoration: 'Heal', Elemental: 'Ranged', Enhancement: 'Melee' },
  Evoker: { Preservation: 'Heal', Devastation: 'Ranged', Augmentation: 'Ranged' },
  Rogue: { Assassination: 'Melee', Outlaw: 'Melee', Subtlety: 'Melee' },
  Hunter: { 'Beast Mastery': 'Ranged', Marksmanship: 'Ranged', Survival: 'Melee' },
  Mage: { Arcane: 'Ranged', Fire: 'Ranged', Frost: 'Ranged' },
  Warlock: { Affliction: 'Ranged', Demonology: 'Ranged', Destruction: 'Ranged' },
};

/** null = clase/spec no reconocida (spec nuevo del juego, typo de WCL...) — nunca se inventa un rol sin mapeo real. */
export function roleFromSpec(wclClass: string | null, spec: string | null): RaidRole | null {
  if (!wclClass || !spec) return null;
  return SPEC_ROLE[wclClass]?.[spec] ?? null;
}

/** Las 13 clases reales tal cual las guarda WCL — para poblar un desplegable de clase sin tecleo. */
export const ALL_CLASSES: string[] = Object.keys(SPEC_ROLE);

/** Specs reales de una clase (mismos nombres que cd.spec en cooldown_catalog/defensive-cooldowns.ts) — [] si la clase no se reconoce. */
export function specsForClass(wclClass: string): string[] {
  return Object.keys(SPEC_ROLE[wclClass] ?? {});
}

/**
 * §"Preparación" (ver plan guardado): puente entre el vocabulario de rol de
 * raid de ESTA app (RaidRole: Tank/Heal/Melee/Ranged, el que usa el roster)
 * y el de BossMechanicCandidateRow.responsibility (tank/dps/healer/raid/
 * personal, el que usa el catálogo de mecánicas) — dos ejes con
 * granularidad distinta a propósito (Melee/Ranged solo importan para DAÑO
 * recibido, nunca para "esta mecánica exige respuesta"), así que Melee y
 * Ranged colapsan a 'dps' aquí. 'raid'/'personal' aplican a cualquiera,
 * nunca se filtran por rol.
 */
export function mechanicAppliesToRole(responsibility: string | null, role: RaidRole | null): boolean {
  if (responsibility === 'raid' || responsibility === 'personal' || responsibility == null) return true;
  if (!role) return true; // rol sin resolver — no ocultar por precaución, mismo criterio que talentAllows en defensive-cooldowns.ts
  if (responsibility === 'tank') return role === 'Tank';
  if (responsibility === 'healer') return role === 'Heal';
  if (responsibility === 'dps') return role === 'Melee' || role === 'Ranged';
  return true;
}
