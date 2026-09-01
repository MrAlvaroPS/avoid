import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

export type DefensiveFeatureFlag = keyof typeof environment.defensiveFeatureFlags;

const TESTER_OVERRIDE_KEY = 'avoid:defensive-feature-flags:v1';

@Injectable({ providedIn: 'root' })
export class DefensiveFeatureFlagsService {
  enabled(flag: DefensiveFeatureFlag): boolean {
    try {
      const raw = localStorage.getItem(TESTER_OVERRIDE_KEY);
      if (raw) {
        const overrides = JSON.parse(raw) as Partial<Record<DefensiveFeatureFlag, boolean>>;
        if (typeof overrides[flag] === 'boolean') return overrides[flag]!;
      }
    } catch {
      // Un override local inválido no altera el valor seguro del entorno.
    }
    return environment.defensiveFeatureFlags[flag];
  }
}

