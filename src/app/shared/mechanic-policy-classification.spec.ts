import { describe, expect, it } from 'vitest';
import {
  applyPolicyConfidenceGuard,
  responsibilityModeFromClassification,
  validateCausalPolicy,
  type CausalPolicyInput,
} from '../../../supabase/functions/_shared/mechanic-policy-classification';

const policy: CausalPolicyInput = {
  targetingMode: 'selected_player',
  damageSemantics: 'avoidable',
  failurePropagation: 'nearby_players',
  assignmentMode: 'target_derived',
  defensiveExpectation: 'none',
  creditScope: 'resolver',
  penaltyScope: 'owner',
};

describe('mechanic policy classification guards', () => {
  it('accepts only complete causal policies with known enum values', () => {
    expect(validateCausalPolicy(policy)).toBe(true);
    expect(validateCausalPolicy({ ...policy, penaltyScope: 'everyone' })).toBe(false);
    expect(validateCausalPolicy({ ...policy, assignmentMode: undefined })).toBe(false);
  });

  it('removes all scoring scopes from low-confidence research', () => {
    expect(applyPolicyConfidenceGuard('low', policy)).toEqual({
      confidence: 'uncertain',
      creditScope: 'none',
      penaltyScope: 'none',
    });
  });

  it('allows medium confidence to credit but never penalize', () => {
    expect(applyPolicyConfidenceGuard('medium', policy)).toEqual({
      confidence: 'inferred',
      creditScope: 'resolver',
      penaltyScope: 'none',
    });
  });

  it('keeps the proposed scopes only for high confidence', () => {
    expect(applyPolicyConfidenceGuard('high', policy)).toEqual({
      confidence: 'inferred',
      creditScope: 'resolver',
      penaltyScope: 'owner',
    });
  });

  it('maps catalog responsibility to the causal enum conservatively', () => {
    expect(responsibilityModeFromClassification('tank')).toBe('tank_role');
    expect(responsibilityModeFromClassification('personal')).toBe('target');
    expect(responsibilityModeFromClassification(null)).toBe('none');
  });
});
