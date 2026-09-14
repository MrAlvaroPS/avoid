import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const analyze = readFileSync('supabase/functions/analyze-report/index.ts', 'utf8');
const reanalyze = readFileSync('supabase/functions/reanalyze-defensive-pressure/index.ts', 'utf8');

describe('defensive death-causality materialization parity', () => {
  it('uses the shared lethal-hit causal rule in analyze-report', () => {
    expect(analyze).toContain('preventableWithEffectiveDefensive(deathDefensiveOptionsV2 ?? [],');
    expect(analyze).not.toContain("const missableOptions = (deathDefensiveOptionsV2 ?? []).filter");
  });

  it('recomputes the same causal verdict during defensive reanalysis', () => {
    expect(reanalyze).toContain('preventableWithEffectiveDefensive(deathDefensiveOptionsV2,');
    expect(reanalyze).toContain("record.death_cause?.['killingBlowAmount']");
    expect(reanalyze).toContain("record.death_cause?.['maxHitPoints']");
  });
});
