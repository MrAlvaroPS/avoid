import { computeDamageProfile } from '../../../supabase/functions/_shared/damage-profile';

describe('computeDamageProfile', () => {
  it('clasifica como oneshot varios golpes del mismo segundo que suman el 80% de vida', () => {
    const result = computeDamageProfile([
      { timestamp: 1000, amount: 150, maxHitPoints: 1000 },
      { timestamp: 4900, amount: 450, maxHitPoints: 1000 },
      { timestamp: 5000, amount: 350, maxHitPoints: 1000 },
    ], 5000);

    expect(result.damageProfile).toBe('burst');
    expect(result.terminalBurstDamage).toBe(800);
    expect(result.burstHealthPct).toBe(80);
  });

  it('no deja que el daño previo diluya un burst real del último segundo', () => {
    const result = computeDamageProfile([
      { timestamp: 1000, amount: 500, maxHitPoints: 1000 },
      { timestamp: 4500, amount: 800, maxHitPoints: 1000 },
    ], 5000);

    expect(result.damageProfile).toBe('burst');
    expect(result.burstHealthPct).toBe(80);
  });

  it('mantiene como sostenido el daño repartido con ventana de curación', () => {
    const result = computeDamageProfile([
      { timestamp: 1000, amount: 250, maxHitPoints: 1000 },
      { timestamp: 2200, amount: 250, maxHitPoints: 1000 },
      { timestamp: 3400, amount: 250, maxHitPoints: 1000 },
      { timestamp: 5000, amount: 250, maxHitPoints: 1000 },
    ], 5000);

    expect(result.damageProfile).toBe('sustained');
    expect(result.burstHealthPct).toBe(25);
  });

  it('usa concentración temporal en un log antiguo sin vida máxima', () => {
    const result = computeDamageProfile([
      { timestamp: 1000, amount: 100 },
      { timestamp: 4500, amount: 450 },
      { timestamp: 5000, amount: 450 },
    ], 5000);

    expect(result.damageProfile).toBe('burst');
    expect(result.maxHitPoints).toBeNull();
  });
});
