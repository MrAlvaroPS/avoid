import { describe, expect, it } from 'vitest';
import { isDefensiveOpportunityWindow } from './night-player-summary.service';

describe('isDefensiveOpportunityWindow', () => {
  it('incluye una ventana cubierta', () => {
    expect(isDefensiveOpportunityWindow({ covered: true, coverable: false })).toBe(true);
  });

  it('incluye una ventana fallada cuando había una respuesta utilizable', () => {
    expect(isDefensiveOpportunityWindow({ covered: false, coverable: true })).toBe(true);
  });

  it('excluye un pico sin cobertura y sin ningún defensivo utilizable', () => {
    expect(isDefensiveOpportunityWindow({ covered: false, coverable: false })).toBe(false);
  });
});
