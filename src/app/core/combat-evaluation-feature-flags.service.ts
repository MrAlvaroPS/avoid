import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

export type CombatEvaluationFeatureFlag = keyof typeof environment.combatEvaluationFeatureFlags;

const TESTER_OVERRIDE_KEY = 'avoid:combat-evaluation-feature-flags:v1';

@Injectable({ providedIn: 'root' })
export class CombatEvaluationFeatureFlagsService {
  enabled(flag: CombatEvaluationFeatureFlag): boolean {
    try {
      const raw = localStorage.getItem(TESTER_OVERRIDE_KEY);
      if (raw) {
        const overrides = JSON.parse(raw) as Partial<Record<CombatEvaluationFeatureFlag, boolean>>;
        if (typeof overrides[flag] === 'boolean') return overrides[flag];
      }
    } catch {
      // Un override local corrupto no puede activar una capacidad por error.
    }
    return environment.combatEvaluationFeatureFlags[flag];
  }
}

