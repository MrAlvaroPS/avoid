import { describe, expect, it } from 'vitest';
import { classifyMechanicPolicyStatus, isCandidateAutoClassified } from './manifest.service';

describe('classifyMechanicPolicyStatus', () => {
  it('keeps an untouched fallback v1 visibly separate from reviewed policies', () => {
    expect(classifyMechanicPolicyStatus('fallback', 1)).toBe('base');
    expect(classifyMechanicPolicyStatus('fallback', 2)).toBe('reviewed');
    expect(classifyMechanicPolicyStatus('inferred', 1)).toBe('reviewed');
  });

  it('gives verified and uncertain confidence their own status', () => {
    expect(classifyMechanicPolicyStatus('verified', 3)).toBe('verified');
    expect(classifyMechanicPolicyStatus('uncertain', 1)).toBe('uncertain');
  });
});

describe('isCandidateAutoClassified', () => {
  it('accepts a deliberately undecided avoidable value once the other IA fields were applied', () => {
    expect(isCandidateAutoClassified({
      category: 'raid-damage',
      responsibility: 'raid',
      resolution: 'Coordina cooldowns de sanación durante la ventana de daño.',
      ai_classification: { confidence: 'high', sources: [], notes: '', classifiedAt: '2026-09-02T00:00:00Z' },
    })).toBe(true);
  });

  it('keeps a row pending when a required automatic result is absent', () => {
    expect(isCandidateAutoClassified({
      category: null,
      responsibility: 'raid',
      resolution: 'Coordina cooldowns de sanación durante la ventana de daño.',
      ai_classification: { confidence: 'medium', sources: [], notes: '', classifiedAt: '2026-09-02T00:00:00Z' },
    })).toBe(false);
  });
});