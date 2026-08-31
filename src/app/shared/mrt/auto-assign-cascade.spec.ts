import { autoAssignCascade, type CascadeDefensiveInput, type CascadeMechanicInput } from './auto-assign-cascade.util';

describe('autoAssignCascade', () => {
  it('asigna el único defensivo disponible al único pico', () => {
    const mechanics: CascadeMechanicInput[] = [{ abilityId: 1, name: 'Golpe grande', timeMs: 60_000, impactScore: 100 }];
    const defensives: CascadeDefensiveInput[] = [{ spellId: 999, survivalType: 'mitigation', baseCooldownMs: 120_000 }];
    expect(autoAssignCascade(mechanics, defensives)).toEqual([{ abilityId: 1, defensiveSpellId: 999 }]);
  });

  it('un defensivo de cooldown corto cubre VARIOS picos si el tiempo lo permite (cascada real, no un único uso)', () => {
    const mechanics: CascadeMechanicInput[] = [
      { abilityId: 1, name: 'Pico A', timeMs: 60_000, impactScore: 100 },
      { abilityId: 2, name: 'Pico B', timeMs: 180_000, impactScore: 90 }, // 2 min después — cooldown de 90s ya recuperado
    ];
    const defensives: CascadeDefensiveInput[] = [{ spellId: 999, survivalType: 'mitigation', baseCooldownMs: 90_000 }];
    const result = autoAssignCascade(mechanics, defensives);
    expect(result).toContainEqual({ abilityId: 1, defensiveSpellId: 999 });
    expect(result).toContainEqual({ abilityId: 2, defensiveSpellId: 999 });
  });

  it('respeta el orden por impacto: el pico más grande se cubre primero, dejando el segundo sin nada si el cooldown no llega', () => {
    const mechanics: CascadeMechanicInput[] = [
      { abilityId: 1, name: 'Pico pequeño', timeMs: 30_000, impactScore: 10 },
      { abilityId: 2, name: 'Pico grande', timeMs: 60_000, impactScore: 100 }, // solo 30s después del pequeño
    ];
    const defensives: CascadeDefensiveInput[] = [{ spellId: 999, survivalType: 'mitigation', baseCooldownMs: 120_000 }];
    const result = autoAssignCascade(mechanics, defensives);
    // el de más impacto (Pico grande, id 2) gana el único defensivo — el pequeño se queda sin nada, no al revés.
    expect(result).toEqual([{ abilityId: 2, defensiveSpellId: 999 }]);
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

  it('nunca asigna un defensivo con cooldown desconocido (null) — mejor dejarlo a mano que adivinar', () => {
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
