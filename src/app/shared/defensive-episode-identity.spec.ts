import { describe, expect, it } from 'vitest';
import {
  deriveEpisodeCausalGroupId,
  resolveDefensiveEpisodeId,
  type EpisodeIdentitySource,
} from '../../../supabase/functions/_shared/defensive-episode-identity';

function window(overrides: Partial<EpisodeIdentitySource> = {}): EpisodeIdentitySource {
  return {
    occurrenceId: null,
    dominantAbilityGameId: 22812,
    memberIndexes: [0, 1],
    startMs: 10_000,
    endMs: 12_000,
    ...overrides,
  };
}

describe('resolveDefensiveEpisodeId', () => {
  it('occurrenceId siempre manda cuando existe (§2.6: prioriza occurrenceId)', () => {
    const id = resolveDefensiveEpisodeId('pull-1', 'Gusmï', window({ occurrenceId: 'occ-abc' }));
    expect(id).toBe('occ-abc');
  });

  it('sin occurrenceId, produce un id heurístico prefijado — nunca se confunde con un UUID de occurrence real', () => {
    const id = resolveDefensiveEpisodeId('pull-1', 'Gusmï', window());
    expect(id.startsWith('heuristic:')).toBe(true);
  });

  it('es determinista: mismos inputs → mismo id, siempre', () => {
    const a = resolveDefensiveEpisodeId('pull-1', 'Gusmï', window());
    const b = resolveDefensiveEpisodeId('pull-1', 'Gusmï', window());
    expect(a).toBe(b);
  });

  it('el orden de memberIndexes no importa (se ordenan internamente antes de hashear)', () => {
    const a = resolveDefensiveEpisodeId('pull-1', 'Gusmï', window({ memberIndexes: [3, 1, 2] }));
    const b = resolveDefensiveEpisodeId('pull-1', 'Gusmï', window({ memberIndexes: [1, 2, 3] }));
    expect(a).toBe(b);
  });

  it('dos episodios genuinamente distintos (start/end distintos) producen ids distintos — no colisiona por compartir milisegundo de otra dimensión', () => {
    const a = resolveDefensiveEpisodeId('pull-1', 'Gusmï', window({ startMs: 10_000, endMs: 12_000 }));
    const b = resolveDefensiveEpisodeId('pull-1', 'Gusmï', window({ startMs: 20_000, endMs: 22_000 }));
    expect(a).not.toBe(b);
  });

  it('distinto jugador o distinto pull produce ids distintos (aislamiento por player/pull)', () => {
    const base = resolveDefensiveEpisodeId('pull-1', 'Gusmï', window());
    expect(resolveDefensiveEpisodeId('pull-1', 'Magzil', window())).not.toBe(base);
    expect(resolveDefensiveEpisodeId('pull-2', 'Gusmï', window())).not.toBe(base);
  });
});

describe('deriveEpisodeCausalGroupId', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('produce una cadena con forma de UUID válida (columna causal_group_id uuid not null)', () => {
    const id = deriveEpisodeCausalGroupId('heuristic:abc123');
    expect(id).toMatch(UUID_RE);
  });

  it('es determinista: mismo episodeId → mismo causalGroupId', () => {
    const a = deriveEpisodeCausalGroupId('occ-xyz');
    const b = deriveEpisodeCausalGroupId('occ-xyz');
    expect(a).toBe(b);
  });

  it('episodeId distintos producen causalGroupId distintos', () => {
    const a = deriveEpisodeCausalGroupId('occ-xyz');
    const b = deriveEpisodeCausalGroupId('occ-abc');
    expect(a).not.toBe(b);
  });
});
