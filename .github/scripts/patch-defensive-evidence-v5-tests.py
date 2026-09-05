from pathlib import Path

def replace_once(path, old, new):
    p=Path(path); s=p.read_text(); n=s.count(old)
    if n != 1: raise SystemExit(f'{path}: expected 1 match, got {n}')
    p.write_text(s.replace(old,new,1))

# Canonical v5 rows persist usageEvaluable explicitly, but old pure callers/tests
# may still omit it. Keep the public KPI helper backward compatible without
# weakening persisted v5 behavior.
replace_once(
    'supabase/functions/_shared/defensive-episode-kpis.ts',
    '  const usageEvaluable = episode.usageEvaluable;',
    '  const usageEvaluable = episode.usageEvaluable ?? deriveUsageEvaluable(episode.responseVerdict);',
)

# E5 test 9 encoded the old asymmetry: credit_only alone fabricated a positive
# Response denominator. v5 intentionally keeps the action as bonus context only.
replace_once(
    'src/app/shared/defensive-episode-evaluator.spec.ts',
    """  it('used credit_only member with verified damage/timing coverage → covered_verified (test 9)', () => {
    const bearForm = resolvedDefensive({
      spellId: 5487,
      usageRole: 'survival_state',
      opportunityMode: 'credit_only',
      createsMissableOpportunity: false,
      applicability: unrestrictedApplicability({ timingRelation: 'after_damage' }),
    });
    const input = baseInput({
      resolvedDefensives: [bearForm],
      castsBySpellId: new Map([[5487, [11_500]]]), // reactivo, dentro de la ventana de 3000ms tras el episodio
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).toBe('covered_verified');
    expect(episode.usageEngaged).toBe(true);
  });
""",
    """  it('used credit_only member outside any core opportunity is preserved as bonus without fabricating Response (test 9)', () => {
    const bearForm = resolvedDefensive({
      spellId: 5487,
      usageRole: 'survival_state',
      opportunityMode: 'credit_only',
      createsMissableOpportunity: false,
      applicability: unrestrictedApplicability({ timingRelation: 'after_damage' }),
    });
    const input = baseInput({
      resolvedDefensives: [bearForm],
      castsBySpellId: new Map([[5487, [11_500]]]),
    });
    const [episode] = evaluateDefensiveEpisodesForPlayer(input);
    expect(episode.responseVerdict).toBe('no_applicable_resource');
    expect(episode.usageEngaged).toBe(true);
    expect(episode.usageEvaluable).toBe(false);
    expect(episode.evidence['bonusCreditSpellIds']).toEqual([5487]);
  });
""",
)
print('v5 compatibility/tests patched')
