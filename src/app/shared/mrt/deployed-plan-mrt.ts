import { encodeMrtExport, spellTag, type MrtReminderInput, type MrtTrigger } from './mrt-reminder-codec';

export interface DeployedMrtPlan {
  id: string;
  name: string;
  /** journal_encounter_id de Blizzard — nunca el encounter_id de WCL. Ver comentario en MrtReminderInput.bossId. */
  bossId: number;
  difficultyId: number;
  /** known_raid_bosses.blizzard_zone_id, si está sembrado para esta raid. */
  zoneId?: number | null;
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
  /**
   * §"un cast debe cubrir toda su ventana de duración (no un recordatorio
   * por cada ocurrencia cercana)" (feedback real, 2026-09-03). false =
   * este slot ya está protegido por la duración de un cast anterior del
   * mismo jugador+defensivo (ver defensive-plan-solver.ts); no se exporta
   * un segundo recordatorio de MRT para pulsar el mismo botón otra vez.
   * Ausente/true = comportamiento histórico, siempre exporta.
   */
  needsFreshCast?: boolean;
}

export interface DeployedMrtExport {
  text: string;
  reminders: MrtReminderInput[];
  timeFallbackSlotIds: string[];
  /** Slots cubiertos que no generaron recordatorio propio: la duración de un cast anterior ya los protege. */
  durationCoveredSlotIds: string[];
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
  // §"las mecánicas de soak/rotación deberían decir 'posible defensivo', no
  // una asignación dura" (feedback real, 2026-09-03): soak reparte el daño
  // entre quien esté cerca — no es "tu" hueco exclusivo como un tankbuster o
  // un personal-target, así que el reminder no debe sonar a orden fija.
  // Solo texto: no cambia coverageStatus ni entra en scoring.
  soakAbilityIds: ReadonlySet<number> = new Set(),
): DeployedMrtExport {
  const memberByKey = new Map(members.map((member) => [member.playerKey, member]));
  const timeFallbackSlotIds: string[] = [];
  const durationCoveredSlotIds = slots
    .filter((slot) => (slot.coverageStatus === 'covered' || slot.coverageStatus === 'partial') && slot.needsFreshCast === false)
    .map((slot) => slot.id);
  const reminders = [...slots]
    .filter((slot) => slot.coverageStatus === 'covered' || slot.coverageStatus === 'partial')
    // needsFreshCast === false: la duración de un cast anterior ya cubre este slot — no repetir el mismo press.
    .filter((slot) => slot.needsFreshCast !== false)
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
      const soakPrefix = soakAbilityIds.has(slot.abilityId) ? 'Posible defensivo: ' : '';
      return {
        uid: safeUidPart(`avoid_${plan.id}_${slot.id}`),
        name: `${mechanicName} #${slot.occurrenceIndex} - ${member.playerName}`,
        message: `${groupPrefix}${soakPrefix}${spellTag(slot.defensiveSpellId)} ${defensiveName}`,
        bossId: plan.bossId,
        difficultyId: plan.difficultyId,
        zoneId: plan.zoneId,
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
    durationCoveredSlotIds,
  };
}
