import { describe, expect, it } from 'vitest';
import { chargeAvailabilityAt, defensiveStatusAt, type DefensiveCooldown } from '../../../supabase/functions/_shared/defensive-cooldowns';

// Valores reales curados en defensive_spec_profiles (verificado 2026-09-04):
// Survival Instincts (Druid Guardian) — 2 cargas, 180000ms recarga, 6000ms
// duración. Shield Block (Warrior Protection) — 2 cargas, 16000ms recarga,
// 6000ms duración. Se usan aquí como fixtures reales, no inventados.

function survivalInstincts(overrides: Partial<DefensiveCooldown> = {}): DefensiveCooldown {
  return {
    spellId: 61336,
    name: 'Survival Instincts',
    class: 'Druid',
    spec: 'Guardian',
    specOverride: null,
    category: 'personal_defensive',
    baseCooldownMs: 180_000,
    durationMs: 6_000,
    survivalType: 'emergency',
    ...overrides,
  };
}

function shieldBlock(overrides: Partial<DefensiveCooldown> = {}): DefensiveCooldown {
  return {
    spellId: 2565,
    name: 'Shield Block',
    class: 'Warrior',
    spec: 'Protection',
    specOverride: null,
    category: 'personal_defensive',
    baseCooldownMs: 16_000,
    durationMs: 6_000,
    survivalType: 'mitigation',
    ...overrides,
  };
}

describe('chargeAvailabilityAt — maxCharges<=1 delega EXACTAMENTE en defensiveStatusAt (retrocompatible)', () => {
  it('mismo resultado que defensiveStatusAt para el 100% del catálogo de 1 carga', () => {
    const cd = survivalInstincts({ baseCooldownMs: 60_000, durationMs: 12_000 });
    for (const atMs of [-5000, 0, 5000, 30_000, 65_000]) {
      const base = defensiveStatusAt(cd, [10_000], atMs);
      const charged = chargeAvailabilityAt(cd, 1, null, [10_000], atMs);
      expect(charged.status).toBe(base.status);
      expect(charged.cooldownRemainingMs).toBe(base.cooldownRemainingMs);
    }
  });

  it('maxCharges no entero o <=1 también delega (0, negativo, no-entero)', () => {
    const cd = survivalInstincts();
    expect(chargeAvailabilityAt(cd, 0, 180_000, [], 0).status).toBe('available_unused');
  });
});

describe('chargeAvailabilityAt — fail-closed cuando rechargeMs no es fiable (charges>1)', () => {
  it('rechargeMs null con maxCharges>1 → unknown, nunca inventa disponibilidad (comportamiento que sustituye al placeholder anterior)', () => {
    const result = chargeAvailabilityAt(survivalInstincts(), 2, null, [10_000], 100_000);
    expect(result.status).toBe('unknown');
    expect(result.chargesAvailable).toBeNull();
  });

  it('rechargeMs no entero o <=0 también degrada a unknown — cuando SÍ hace falta el dato (hay un cast previo que reconstruir)', () => {
    expect(chargeAvailabilityAt(survivalInstincts(), 2, 0, [50_000], 100_000).status).toBe('unknown');
    expect(chargeAvailabilityAt(survivalInstincts(), 2, -1000, [50_000], 100_000).status).toBe('unknown');
    expect(chargeAvailabilityAt(survivalInstincts(), 2, 1.5, [50_000], 100_000).status).toBe('unknown');
  });

  it('sin NINGÚN cast previo, la disponibilidad es trivial (todas las cargas libres) y NO exige rechargeMs — no fail-closea de más', () => {
    const result = chargeAvailabilityAt(survivalInstincts(), 2, null, [], 100_000);
    expect(result).toEqual({ status: 'available_unused', chargesAvailable: 2 });
  });
});

describe('chargeAvailabilityAt — reconstrucción real de 2 cargas (Shield Block: 16000ms recarga, 6000ms duración)', () => {
  const cd = shieldBlock();
  const maxCharges = 2;
  const rechargeMs = 16_000;

  it('sin ningún cast previo: 2 cargas libres', () => {
    const result = chargeAvailabilityAt(cd, maxCharges, rechargeMs, [], 0);
    expect(result).toEqual({ status: 'available_unused', chargesAvailable: 2 });
  });

  it('un cast reciente (dentro de duration): active, independientemente de cargas restantes', () => {
    const result = chargeAvailabilityAt(cd, maxCharges, rechargeMs, [1000], 5000); // 4000ms desde el cast, <= 6000 duration
    expect(result.status).toBe('active');
  });

  it('un solo cast, ya recargado del todo: 2 cargas libres de nuevo', () => {
    const result = chargeAvailabilityAt(cd, maxCharges, rechargeMs, [0], 16_001); // pasado duration y recharge
    expect(result).toEqual({ status: 'available_unused', chargesAvailable: 2 });
  });

  it('dos casts consecutivos y rápidos: la SEGUNDA carga tarda en volver más que un simple +rechargeMs desde su propio cast (cola de un solo servidor, no recarga en paralelo)', () => {
    // casts en t=0 y t=1000. finish[0] = 0+16000 = 16000. finish[1] = max(1000, 16000) + 16000 = 32000.
    // En t=20000 (pasado duration): finish[0]<=20000 (ya libre), finish[1]>20000 (sigue recargando) → 1 carga libre.
    const midway = chargeAvailabilityAt(cd, maxCharges, rechargeMs, [0, 1000], 20_000);
    expect(midway).toEqual({ status: 'available_unused', chargesAvailable: 1 });

    // En t=10000 (pasado duration desde el último cast, 10000-1000=9000>6000): ambas siguen recargando → on_cooldown.
    const bothRecharging = chargeAvailabilityAt(cd, maxCharges, rechargeMs, [0, 1000], 10_000);
    expect(bothRecharging.status).toBe('on_cooldown');
    expect(bothRecharging.chargesAvailable).toBe(0);
    expect(bothRecharging.cooldownRemainingMs).toBe(16_000 - 10_000); // hasta finish[0]=16000

    // En t=32001 (pasado el finish de AMBAS): 2 cargas libres de nuevo.
    const bothFree = chargeAvailabilityAt(cd, maxCharges, rechargeMs, [0, 1000], 32_001);
    expect(bothFree).toEqual({ status: 'available_unused', chargesAvailable: 2 });
  });

  it('missed_ready real: gastó una carga hace tiempo (recargada), la otra sigue disponible — nunca se confunde con on_cooldown por el primer cast', () => {
    // Un solo cast antiguo, ya recargado del todo → sigue habiendo 2 libres (no "1 usada, 1 libre" — la usada YA volvió).
    const result = chargeAvailabilityAt(cd, maxCharges, rechargeMs, [0], 20_000);
    expect(result).toEqual({ status: 'available_unused', chargesAvailable: 2 });
  });
});

describe('chargeAvailabilityAt — inconsistencia física degrada a unknown, nunca a un número inventado', () => {
  it('más "todavía recargando" que maxCharges (imposible con un cast log real) → unknown, no un chargesAvailable negativo', () => {
    // 3 casts casi simultáneos con solo 2 cargas configuradas — no podría
    // pasar con datos reales (no se puede castear sin carga libre), señal
    // de que maxCharges/rechargeMs no describen bien este caso concreto.
    const cd = shieldBlock();
    const result = chargeAvailabilityAt(cd, 2, 16_000, [0, 100, 200], 10_000);
    expect(result.status).toBe('unknown');
    expect(result.chargesAvailable).toBeNull();
  });
});

describe('chargeAvailabilityAt — Survival Instincts real (180000ms recarga, ventana larga tipo raid)', () => {
  it('gastó las 2 cargas al inicio del pull; justo antes de los 3 minutos (recarga de la primera) sigue on_cooldown', () => {
    const cd = survivalInstincts();
    const result = chargeAvailabilityAt(cd, 2, 180_000, [0, 5000], 179_000); // 1s antes de que la primera carga (cast en t=0) termine de recargar
    expect(result.status).toBe('on_cooldown');
    expect(result.cooldownRemainingMs).toBe(1000);
  });

  it('justo tras los 3 minutos ya recuperó la primera carga (la segunda, casteada en t=5000, sigue recargando hasta t=185000)', () => {
    const cd = survivalInstincts();
    const result = chargeAvailabilityAt(cd, 2, 180_000, [0, 5000], 180_001);
    expect(result.status).toBe('available_unused');
    expect(result.chargesAvailable).toBe(1);
  });
});
