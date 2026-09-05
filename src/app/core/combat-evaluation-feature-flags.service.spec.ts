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

  it('reflects the explicit causal rollout enabled in this environment', () => {
    expect(service.enabled('combatEvaluationContextV2')).toBe(true);
    expect(service.enabled('mechanicPolicyV2')).toBe(true);
    expect(service.enabled('mechanicResponsibilityV2')).toBe(true);
    expect(service.enabled('consumableEvaluatorV2')).toBe(true);
    expect(service.enabled('playerInfographicV3')).toBe(true);
    expect(service.enabled('reliabilityExecutionV3')).toBe(true);
  });

  it('falls back to the environment when the tester override is corrupt', () => {
    localStorage.setItem(key, '{not-json');
    expect(service.enabled('playerInfographicV3')).toBe(true);
  });
});
