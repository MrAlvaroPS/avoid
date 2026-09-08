import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const files = [
  'supabase/functions/analyze-report/index.ts',
  'supabase/functions/reanalyze-defensive-pressure/index.ts',
] as const;

describe('defensive materialization integration guard', () => {
  for (const file of files) {
    it(`${file} uses the canonical semantic + observed-cast contract`, () => {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('resolveEffectiveDefensiveKitWithObservedCastEvidence');
      expect(source).toContain('semanticRows: semanticsResult.data ?? []');
      expect(source).toContain('semanticRuleRows: semanticRulesResult.data ?? []');
      expect(source).toContain('filter((defensive) => defensive.isDefensiveKitMember)');
      expect(source).toContain('filter((option) => option.createsMissableOpportunity)');
      expect(source).not.toContain('filter((defensive) => defensive.eligible).map');
    });
  }
});
