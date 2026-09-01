import { describe, expect, it } from 'vitest';
import { auditControlledDefensiveBackfill } from '../../../supabase/functions/_shared/controlled-defensive-backfill-audit';

function record(overrides: Record<string, unknown> = {}) {
  return {
    playerName: 'Player',
    gameBuild: '11.2.0.12345',
    gameBuildConfidence: 'verified',
    defensiveResolutionShadow: { kit: [] },
    deathDefensiveOptionsV2: null,
    defensivePressureWindowsV2: null,
    ...overrides,
  };
}

describe('auditControlledDefensiveBackfill', () => {
  it('validates Fade, unchanged values and charge recharge independently', () => {
    const cases = auditControlledDefensiveBackfill([
      record({
        defensiveResolutionShadow: {
          kit: [
            {
              spellId: 586,
              name: 'Fade',
              effectiveCooldownMs: 20_000,
              effectiveDurationMs: 10_000,
              charges: 1,
              rechargeMs: null,
              targetingMode: 'self',
              confidence: 'verified',
              provenance: [
                { kind: 'catalog_base', field: 'cooldown_ms', after: 30_000 },
                { kind: 'modifier', field: 'cooldown_ms', after: 20_000 },
              ],
            },
            {
              spellId: 100,
              name: 'Unchanged',
              effectiveCooldownMs: 60_000,
              effectiveDurationMs: 8_000,
              charges: 2,
              rechargeMs: 60_000,
              targetingMode: 'self',
              confidence: 'verified',
              provenance: [
                { kind: 'catalog_base', field: 'cooldown_ms', after: 60_000 },
                { kind: 'catalog_base', field: 'duration_ms', after: 8_000 },
              ],
            },
          ],
        },
      }),
    ]);
    expect(cases.find((item) => item.id === 'fade_modifier')?.state).toBe('passed');
    expect(cases.find((item) => item.id === 'unchanged_base')?.state).toBe('passed');
    expect(cases.find((item) => item.id === 'charges_recharge')?.state).toBe('passed');
    expect(cases.find((item) => item.id === 'external_target')?.state).toBe('not_observed');
  });

  it('rejects an external surfaced as a personal death opportunity', () => {
    const cases = auditControlledDefensiveBackfill([
      record({
        defensiveResolutionShadow: {
          kit: [{ spellId: 200, name: 'External', category: 'external_defensive', targetingMode: 'ally', confidence: 'verified', provenance: [] }],
        },
        deathDefensiveOptionsV2: [{ spellId: 200, status: 'available_unused', confidence: 'verified' }],
      }),
    ]);
    expect(cases.find((item) => item.id === 'external_target')?.state).toBe('failed');
  });

  it('does not fail Fade when the sample only contains the base spell and no selected modifier evidence', () => {
    const cases = auditControlledDefensiveBackfill([
      record({
        defensiveResolutionShadow: {
          kit: [{
            spellId: 586,
            name: 'Fade',
            effectiveCooldownMs: 30_000,
            effectiveDurationMs: 10_000,
            charges: 1,
            rechargeMs: null,
            targetingMode: 'self',
            confidence: 'inferred',
            provenance: [{ kind: 'catalog_base', field: 'cooldown_ms', after: 30_000 }],
          }],
        },
      }),
    ]);
    const fade = cases.find((item) => item.id === 'fade_modifier');
    expect(fade?.state).toBe('not_observed');
    expect(fade?.detail).toContain('contienen Fade base');
  });

  it('keeps an unknown historical build non-punitive', () => {
    const cases = auditControlledDefensiveBackfill([
      record({
        gameBuild: null,
        gameBuildConfidence: 'uncertain',
        defensiveResolutionShadow: {
          kit: [{ spellId: 300, name: 'Unknown', targetingMode: 'self', confidence: 'uncertain', provenance: [] }],
        },
        defensivePressureWindowsV2: { windows: [{ options: [{ spellId: 300, availableOpportunity: false }] }] },
      }),
    ]);
    expect(cases.find((item) => item.id === 'unknown_build')?.state).toBe('passed');
  });
});
