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
