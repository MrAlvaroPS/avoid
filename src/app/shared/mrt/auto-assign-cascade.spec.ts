import { autoAssignCascade, type CascadeDefensiveInput, type CascadeMechanicInput } from './auto-assign-cascade.util';

describe('autoAssignCascade', () => {
  it('asigna el único defensivo disponible al único pico', () => {
    const mechanics: CascadeMechanicInput[] = [{ abilityId: 1, name: 'Golpe grande', timeMs: 60_000, impactScore: 100 }];
    const defensives: CascadeDefensiveInput[] = [{ spellId: 999, survivalType: 'mitigation', baseCooldownMs: 120_000 }];
    expect(autoAssignCascade(mechanics, defensives)).toEqual([{ abilityId: 1, defensiveSpellId: 999 }]);
  });

  it('un defensivo de cooldown corto cubre VARIOS picos si el tiempo lo permite', () => {
    const mechanics: CascadeMechanicInput[] = [
      { abilityId: 1, name: 'Pico A', timeMs: 60_000, impactScore: 100 },
      { abilityId: 2, name: 'Pico B', timeMs: 180_000, impactScore: 90 },
    ];
    const defensives: CascadeDefensiveInput[] = [{ spellId: 999, survivalType: 'mitigation', baseCooldownMs: 90_000 }];
    const result = autoAssignCascade(mechanics, defensives);
    expect(result).toContainEqual({ abilityId: 1, defensiveSpellId: 999 });
    expect(result).toContainEqual({ abilityId: 2, defensiveSpellId: 999 });
  });

  it('reserva primero el pico más importante pero permite un uso ANTERIOR si el cooldown recupera a tiempo', () => {
    const mechanics: CascadeMechanicInput[] = [
      { abilityId: 1, name: 'Pico pequeño temprano', timeMs: 60_000, impactScore: 10 },
      { abilityId: 2, name: 'Pico prioritario', timeMs: 240_000, impactScore: 100 },
    ];
    const defensives: CascadeDefensiveInput[] = [{ spellId: 999, survivalType: 'mitigation', baseCooldownMs: 120_000 }];
    const result = autoAssignCascade(mechanics, defensives);
    expect(result).toContainEqual({ abilityId: 2, defensiveSpellId: 999 });
    expect(result).toContainEqual({ abilityId: 1, defensiveSpellId: 999 });
  });

  it('respeta el orden por impacto cuando dos reservas sí chocan', () => {
    const mechanics: CascadeMechanicInput[] = [
      { abilityId: 1, name: 'Pico pequeño', timeMs: 30_000, impactScore: 10 },
      { abilityId: 2, name: 'Pico grande', timeMs: 60_000, impactScore: 100 },
    ];
    const defensives: CascadeDefensiveInput[] = [{ spellId: 999, survivalType: 'mitigation', baseCooldownMs: 120_000 }];
    expect(autoAssignCascade(mechanics, defensives)).toEqual([{ abilityId: 2, defensiveSpellId: 999 }]);
  });

  it('respeta reservas manuales preexistentes', () => {
    const mechanics: CascadeMechanicInput[] = [
      // 2:10 está a solo 110s de la reserva manual de 4:00: NO cabe con CD 120s.
      { abilityId: 1, name: 'Demasiado cerca', timeMs: 130_000, impactScore: 100 },
      // 1:00 está a 180s de la reserva manual: sí cabe.
      { abilityId: 2, name: 'Cabe antes', timeMs: 60_000, impactScore: 90 },
    ];
    const defensives: CascadeDefensiveInput[] = [
      { spellId: 999, survivalType: 'mitigation', baseCooldownMs: 120_000, reservedTimesMs: [240_000] },
    ];
    expect(autoAssignCascade(mechanics, defensives)).toEqual([{ abilityId: 2, defensiveSpellId: 999 }]);
  });

  it('permite una reserva exactamente al cumplirse el cooldown', () => {
    const mechanics: CascadeMechanicInput[] = [{ abilityId: 1, name: 'Justo a tiempo', timeMs: 120_000, impactScore: 100 }];
    const defensives: CascadeDefensiveInput[] = [
      { spellId: 999, survivalType: 'mitigation', baseCooldownMs: 120_000, reservedTimesMs: [240_000] },
    ];
    expect(autoAssignCascade(mechanics, defensives)).toEqual([{ abilityId: 1, defensiveSpellId: 999 }]);
  });

  it('con dos defensivos y dos picos simultáneos, reparte uno a cada uno', () => {
    const mechanics: CascadeMechanicInput[] = [
      { abilityId: 1, name: 'Pico A', timeMs: 60_000, impactScore: 100 },
      { abilityId: 2, name: 'Pico B', timeMs: 60_000, impactScore: 90 },
    ];
    const defensives: CascadeDefensiveInput[] = [
      { spellId: 1, survivalType: 'mitigation', baseCooldownMs: 120_000 },
      { spellId: 2, survivalType: 'absorption', baseCooldownMs: 90_000 },
    ];
    const result = autoAssignCascade(mechanics, defensives);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((r) => r.defensiveSpellId))).toEqual(new Set([1, 2]));
  });

  it('nunca asigna un defensivo de tipo emergency', () => {
    const mechanics: CascadeMechanicInput[] = [{ abilityId: 1, name: 'Pico', timeMs: 60_000, impactScore: 100 }];
    const defensives: CascadeDefensiveInput[] = [{ spellId: 999, survivalType: 'emergency', baseCooldownMs: 300_000 }];
    expect(autoAssignCascade(mechanics, defensives)).toEqual([]);
  });

  it('nunca asigna un defensivo con cooldown desconocido (null)', () => {
    const mechanics: CascadeMechanicInput[] = [{ abilityId: 1, name: 'Pico', timeMs: 60_000, impactScore: 100 }];
    const defensives: CascadeDefensiveInput[] = [{ spellId: 999, survivalType: 'mitigation', baseCooldownMs: null }];
    expect(autoAssignCascade(mechanics, defensives)).toEqual([]);
  });

  it('ignora mecánicas sin timing conocido (timeMs null)', () => {
    const mechanics: CascadeMechanicInput[] = [{ abilityId: 1, name: 'Sin timing', timeMs: null, impactScore: 999 }];
    const defensives: CascadeDefensiveInput[] = [{ spellId: 999, survivalType: 'mitigation', baseCooldownMs: 60_000 }];
    expect(autoAssignCascade(mechanics, defensives)).toEqual([]);
  });
});
