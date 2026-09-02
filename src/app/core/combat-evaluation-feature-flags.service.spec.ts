import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CombatEvaluationFeatureFlagsService } from './combat-evaluation-feature-flags.service';

const key = 'avoid:combat-evaluation-feature-flags:v1';

describe('CombatEvaluationFeatureFlagsService', () => {
  let service: CombatEvaluationFeatureFlagsService;

  beforeEach(() => {
    localStorage.removeItem(key);
    TestBed.configureTestingModule({});
    service = TestBed.inject(CombatEvaluationFeatureFlagsService);
  });

  afterEach(() => localStorage.removeItem(key));

  it('keeps every causal rollout flag disabled by default', () => {
    expect(service.enabled('combatEvaluationContextV2')).toBe(false);
    expect(service.enabled('mechanicPolicyV2')).toBe(false);
    expect(service.enabled('mechanicResponsibilityV2')).toBe(false);
    expect(service.enabled('consumableEvaluatorV2')).toBe(false);
    expect(service.enabled('playerInfographicV3')).toBe(false);
    expect(service.enabled('reliabilityExecutionV3')).toBe(false);
  });

  it('does not activate anything from a corrupt tester override', () => {
    localStorage.setItem(key, '{not-json');
    expect(service.enabled('playerInfographicV3')).toBe(false);
  });
});
