import { encodeMrtExport, spellTag, type MrtReminderInput, type MrtTrigger } from './mrt-reminder-codec';

export interface DeployedMrtPlan {
  id: string;
  name: string;
  bossId: number;
  difficultyId: number;
}

export interface DeployedMrtMember {
  playerKey: string;
  playerName: string;
}

export interface DeployedMrtSlot {
  id: string;
  abilityId: number;
  occurrenceIndex: number;
  occurrenceTimeMs: number;
  coverageStatus: 'covered' | 'partial' | 'uncovered' | 'excluded';
  assignedPlayerKey: string | null;
  defensiveSpellId: number | null;
  prewarnMs: number;
  triggerMode: 'time' | 'bossmod';
  bossmodSpellId: number | null;
  bossmodCounter: string | null;
  bossmodCounterVerified: boolean;
  assignedGroups: number[] | null;
}

export interface DeployedMrtExport {
  text: string;
  reminders: MrtReminderInput[];
  timeFallbackSlotIds: string[];
}

function safeUidPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/**
 * La entrada no admite templates: por diseño solo puede convertir slots ya
 * desplegados. Un bossmod sin counter verificado degrada a tiempo de pull.
 */
export function exportDeployedPlanToMrt(
  plan: DeployedMrtPlan,
  members: DeployedMrtMember[],
  slots: DeployedMrtSlot[],
  mechanicNames: ReadonlyMap<number, string>,
  defensiveNames: ReadonlyMap<number, string>,
): DeployedMrtExport {
  const memberByKey = new Map(members.map((member) => [member.playerKey, member]));
  const timeFallbackSlotIds: string[] = [];
  const reminders = [...slots]
    .filter((slot) => slot.coverageStatus === 'covered' || slot.coverageStatus === 'partial')
    .sort(
      (left, right) =>
        left.occurrenceTimeMs - right.occurrenceTimeMs ||
        left.abilityId - right.abilityId ||
        left.occurrenceIndex - right.occurrenceIndex ||
        left.id.localeCompare(right.id),
    )
    .map((slot): MrtReminderInput => {
      if (!slot.assignedPlayerKey || !slot.defensiveSpellId) {
        throw new Error(`El slot desplegado ${slot.id} está marcado como cubierto pero no tiene jugador/spell.`);
      }
      const member = memberByKey.get(slot.assignedPlayerKey);
      if (!member) throw new Error(`El slot desplegado ${slot.id} referencia un miembro que no existe en el snapshot.`);
      const verifiedOccurrenceTrigger =
        slot.triggerMode === 'bossmod' &&
        slot.bossmodCounterVerified &&
        slot.bossmodSpellId != null &&
        Boolean(slot.bossmodCounter?.trim());
      let trigger: MrtTrigger;
      if (verifiedOccurrenceTrigger) {
        trigger = {
          type: 'bossmod',
          timeLeftSeconds: slot.prewarnMs / 1000,
          spellId: slot.bossmodSpellId!,
          counter: slot.bossmodCounter!.trim(),
        };
      } else {
        trigger = { type: 'pull', delayTimeSeconds: slot.occurrenceTimeMs / 1000 };
        if (slot.triggerMode === 'bossmod') timeFallbackSlotIds.push(slot.id);
      }
      const mechanicName = mechanicNames.get(slot.abilityId) ?? `Mecánica ${slot.abilityId}`;
      const defensiveName = defensiveNames.get(slot.defensiveSpellId) ?? `#${slot.defensiveSpellId}`;
      const groupPrefix = slot.assignedGroups?.length
        ? `[Grupo${slot.assignedGroups.length > 1 ? 's' : ''} ${slot.assignedGroups.join(',')}] `
        : '';
      return {
        uid: safeUidPart(`avoid_${plan.id}_${slot.id}`),
        name: `${mechanicName} #${slot.occurrenceIndex} - ${member.playerName}`,
        message: `${groupPrefix}${spellTag(slot.defensiveSpellId)} ${defensiveName}`,
        bossId: plan.bossId,
        difficultyId: plan.difficultyId,
        players: [member.playerName],
        prewarnSeconds: slot.prewarnMs / 1000,
        trigger,
      };
    });

  if (!reminders.length) throw new Error('El plan desplegado no contiene slots asignados exportables.');
  return {
    text: encodeMrtExport(plan.name, reminders),
    reminders,
    timeFallbackSlotIds,
  };
}
