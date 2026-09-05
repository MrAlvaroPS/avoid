import { describe, expect, it } from 'vitest';
import {
  buildDamageDescriptor,
  buildDebuffIntervals,
  combatTableVerdictFor,
  decodeSchoolMask,
  deliveryTagsForHit,
  describeHitType,
  isSourceAffectedBySpellAt,
  mergeAbilityCombatTableObservations,
  tallyAbilityCombatTableObservations,
  WCL_HIT_TYPE_MEANING,
  type AbilityCombatTableCounts,
  type DecodedSchoolMask,
} from '../../../supabase/functions/_shared/damage-descriptor-wcl';

// §Todos los valores de referencia en este fichero son reales, verificados
// contra WCL en vivo el 2026-09-04 (report 7GbANtw1J2pjZzH9 de la guild +
// filterExpression missType cruzado contra hitType numérico en 5 fights
// distintos) — ver damage-descriptor-wcl.ts y el registro de avance del
// plan. No son valores inventados para que el test pase.

describe('decodeSchoolMask — bitmask real de masterData.abilities[].type', () => {
  it('bits simples verificados contra abilities reales', () => {
    expect(decodeSchoolMask('1')).toEqual({ schoolMask: 1, schools: ['Physical'] }); // "Melee"
    expect(decodeSchoolMask('2')).toEqual({ schoolMask: 2, schools: ['Holy'] }); // "Devotion Aura"
    expect(decodeSchoolMask('4')).toEqual({ schoolMask: 4, schools: ['Fire'] }); // "Immolation Aura"
    expect(decodeSchoolMask('8')).toEqual({ schoolMask: 8, schools: ['Nature'] }); // "Mark of the Wild"
    expect(decodeSchoolMask('16')).toEqual({ schoolMask: 16, schools: ['Frost'] }); // "Breath of Sindragosa"
    expect(decodeSchoolMask('32')).toEqual({ schoolMask: 32, schools: ['Shadow'] }); // "Fel Armor"
    expect(decodeSchoolMask('64')).toEqual({ schoolMask: 64, schools: ['Arcane'] }); // "Arcane Intellect"
  });

  it('combos reales verificados — nunca se reduce a una sola school', () => {
    expect(decodeSchoolMask('6')).toEqual({ schoolMask: 6, schools: ['Holy', 'Fire'] }); // "Wake of Ashes"
    expect(decodeSchoolMask('124')).toEqual({ schoolMask: 124, schools: ['Fire', 'Nature', 'Frost', 'Shadow', 'Arcane'] }); // "Eye Beam"/"Metamorphosis" (DH "Chaos")
    expect(decodeSchoolMask('127')).toEqual({
      schoolMask: 127,
      schools: ['Physical', 'Holy', 'Fire', 'Nature', 'Frost', 'Shadow', 'Arcane'],
    });
  });

  it('acepta number además de string (masterData a veces ya viene tipado)', () => {
    expect(decodeSchoolMask(16)).toEqual({ schoolMask: 16, schools: ['Frost'] });
  });

  it('mask=0/ausente/no numérico → null en ambos campos, nunca un array vacío que finja "sin school"', () => {
    expect(decodeSchoolMask('0')).toEqual({ schoolMask: null, schools: null });
    expect(decodeSchoolMask(null)).toEqual({ schoolMask: null, schools: null });
    expect(decodeSchoolMask(undefined)).toEqual({ schoolMask: null, schools: null });
    expect(decodeSchoolMask('not-a-number')).toEqual({ schoolMask: null, schools: null });
  });
});

describe('describeHitType — verificado vía missType filterExpression real', () => {
  it('los 7 valores verificados', () => {
    expect(describeHitType(0)).toBe('miss');
    expect(describeHitType(1)).toBe('hit');
    expect(describeHitType(2)).toBe('crit');
    expect(describeHitType(4)).toBe('block');
    expect(describeHitType(7)).toBe('dodge');
    expect(describeHitType(8)).toBe('parry');
    expect(describeHitType(10)).toBe('immune');
    expect(Object.keys(WCL_HIT_TYPE_MEANING)).toHaveLength(7);
  });

  it('cualquier hitType no verificado se deja sin interpretar (null) — nunca se adivina', () => {
    expect(describeHitType(3)).toBeNull();
    expect(describeHitType(5)).toBeNull();
    expect(describeHitType(6)).toBeNull();
    expect(describeHitType(9)).toBeNull();
    expect(describeHitType(99)).toBeNull();
    expect(describeHitType(null)).toBeNull();
    expect(describeHitType(undefined)).toBeNull();
  });
});

describe('tallyAbilityCombatTableObservations / mergeAbilityCombatTableObservations', () => {
  it('cuenta dodge/parry/block por abilityGameID desde hits crudos', () => {
    const observations = tallyAbilityCombatTableObservations([
      { abilityGameID: 1, hitType: 7 }, // dodge
      { abilityGameID: 1, hitType: 8 }, // parry
      { abilityGameID: 1, hitType: 1 }, // hit normal, no cuenta
      { abilityGameID: 99, blocked: 1500 }, // block vía campo directo
      { abilityGameID: 99, hitType: 1, blocked: undefined }, // hit normal sin block
    ]);
    expect(observations.get(1)).toEqual({ dodgeCount: 1, parryCount: 1, blockCount: 0 });
    expect(observations.get(99)).toEqual({ dodgeCount: 0, parryCount: 0, blockCount: 1 });
  });

  it('un hitType no verificado (ej. 3) no se cuenta como ningún resultado — nunca se adivina', () => {
    const observations = tallyAbilityCombatTableObservations([{ abilityGameID: 1, hitType: 3 }]);
    expect(observations.has(1)).toBe(false);
  });

  it('merge es puramente aditivo (pull local ∪ cache cross-pull)', () => {
    const pullLocal = new Map<number, AbilityCombatTableCounts>([[1, { dodgeCount: 1, parryCount: 0, blockCount: 0 }]]);
    const cache = new Map<number, AbilityCombatTableCounts>([[1, { dodgeCount: 2, parryCount: 1, blockCount: 3 }]]);
    const merged = mergeAbilityCombatTableObservations(pullLocal, cache);
    expect(merged.get(1)).toEqual({ dodgeCount: 3, parryCount: 1, blockCount: 3 });
  });

  it('combatTableVerdictFor: yes con evidencia positiva, unknown (null) sin ninguna — nunca false', () => {
    const observations = new Map<number, AbilityCombatTableCounts>([[1, { dodgeCount: 1, parryCount: 0, blockCount: 0 }]]);
    expect(combatTableVerdictFor(1, observations)).toEqual({ dodgeable: true, parryable: null, blockable: null });
    expect(combatTableVerdictFor(2, observations)).toEqual({ dodgeable: null, parryable: null, blockable: null });
    expect(combatTableVerdictFor(undefined, observations)).toEqual({ dodgeable: null, parryable: null, blockable: null });
  });
});

describe('deliveryTagsForHit', () => {
  it('isAoE/tick se leen directos del evento', () => {
    expect(deliveryTagsForHit({ isAoE: true, tick: false })).toEqual(['aoe', 'direct']);
    expect(deliveryTagsForHit({ isAoE: false, tick: true })).toEqual(['single_target', 'periodic']);
  });

  it('tick ausente se trata como direct (WCL solo marca tick:true en ticks, nunca tick:false explícito)', () => {
    expect(deliveryTagsForHit({ isAoE: false })).toEqual(['single_target', 'direct']);
  });

  it('isAoE ausente no aporta tag de target_scope (no se inventa)', () => {
    expect(deliveryTagsForHit({ tick: true })).toEqual(['periodic']);
  });

  it('abilityGameID===1 (sentinel WCL "Melee") añade el tag melee — único caso demostrable de método de entrega', () => {
    expect(deliveryTagsForHit({ abilityGameID: 1, isAoE: false })).toEqual(['single_target', 'direct', 'melee']);
  });

  it('cualquier otra abilityGameID no aporta tag de método de entrega (ranged/spell/environmental no son demostrables hoy)', () => {
    expect(deliveryTagsForHit({ abilityGameID: 123456, isAoE: false })).toEqual(['single_target', 'direct']);
  });
});

describe('buildDebuffIntervals / isSourceAffectedBySpellAt', () => {
  const events = [
    { type: 'applydebuff', timestamp: 1000, targetID: 33, abilityGameID: 999 },
    { type: 'refreshdebuff', timestamp: 1500, targetID: 33, abilityGameID: 999 },
    { type: 'removedebuff', timestamp: 2000, targetID: 33, abilityGameID: 999 },
    { type: 'applydebuff', timestamp: 3000, targetID: 33, abilityGameID: 999 }, // sin remove — sigue abierto
  ];

  it('reconstruye intervalos apply→remove; refreshdebuff no cierra el intervalo', () => {
    const intervals = buildDebuffIntervals(events);
    expect(intervals).toEqual(
      expect.arrayContaining([
        { targetID: 33, spellId: 999, startMs: 1000, endMs: 2000 },
        { targetID: 33, spellId: 999, startMs: 3000, endMs: null },
      ]),
    );
  });

  it('true dentro del intervalo (cerrado o abierto), null fuera — nunca false', () => {
    const intervals = buildDebuffIntervals(events);
    expect(isSourceAffectedBySpellAt(intervals, 33, 999, 1200)).toBe(true);
    expect(isSourceAffectedBySpellAt(intervals, 33, 999, 5000)).toBe(true); // intervalo abierto sigue activo
    expect(isSourceAffectedBySpellAt(intervals, 33, 999, 2500)).toBeNull(); // hueco real entre remove y el siguiente apply
    expect(isSourceAffectedBySpellAt(intervals, 33, 12345, 1200)).toBeNull(); // spellId distinto, nunca observado
    expect(isSourceAffectedBySpellAt(intervals, 99, 999, 1200)).toBeNull(); // targetID distinto
  });
});

describe('buildDamageDescriptor — ensamblaje completo', () => {
  const schoolByAbilityId = new Map<number, DecodedSchoolMask>([
    [1288772, { schoolMask: 16, schools: ['Frost'] }],
    [1, { schoolMask: 1, schools: ['Physical'] }],
  ]);
  const combatTableObservations = new Map<number, AbilityCombatTableCounts>([
    [1, { dodgeCount: 1, parryCount: 1, blockCount: 1 }],
  ]);

  it('combina school + deliveryScopes + combat table en un solo descriptor', () => {
    const descriptor = buildDamageDescriptor(
      { abilityGameID: 1288772, isAoE: true, tick: false, hitType: 1 },
      { schoolByAbilityId, combatTableObservations },
    );
    expect(descriptor.schools).toEqual(['Frost']);
    expect(descriptor.schoolMask).toBe(16);
    expect(descriptor.deliveryScopes).toEqual(['aoe', 'direct']);
    expect(descriptor.dodgeable).toBeNull(); // sin evidencia para esta ability
    expect(descriptor.rawHitType).toBe(1);
    expect(descriptor.sourceAffectedBySpell).toBeNull(); // siempre null aquí — es por-candidato, ver isSourceAffectedBySpellAt
  });

  it('ability con evidencia de combat table (melee sentinel) → dodgeable/parryable/blockable=true', () => {
    const descriptor = buildDamageDescriptor(
      { abilityGameID: 1, isAoE: false, hitType: 1 },
      { schoolByAbilityId, combatTableObservations },
    );
    expect(descriptor.dodgeable).toBe(true);
    expect(descriptor.parryable).toBe(true);
    expect(descriptor.blockable).toBe(true);
    expect(descriptor.deliveryScopes).toEqual(['single_target', 'direct', 'melee']);
  });

  it('ability sin masterData conocida → school queda null, no se inventa', () => {
    const descriptor = buildDamageDescriptor({ abilityGameID: 999999, isAoE: false }, { schoolByAbilityId, combatTableObservations });
    expect(descriptor.schools).toBeNull();
    expect(descriptor.schoolMask).toBeNull();
  });
});
