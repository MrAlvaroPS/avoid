import { describe, expect, it } from 'vitest';
import { parseMechanicPolicySubmission } from './mechanic-policy-batches';

describe('mechanic policy submission batches', () => {
  it('groups one global response by difficulty and limits every worker batch', () => {
    const rows = [
      ...Array.from({ length: 23 }, (_, index) => ({ abilityId: index + 1, mechanicKey: `normal:${index}`, difficulty: 'Normal' })),
      ...Array.from({ length: 7 }, (_, index) => ({ abilityId: index + 101, mechanicKey: `mythic:${index}`, difficulty: 'Mythic' })),
      ...Array.from({ length: 2 }, (_, index) => ({ abilityId: index + 201, mechanicKey: `heroic:${index}`, difficulty: 'Heroic' })),
    ];

    const result = parseMechanicPolicySubmission(JSON.stringify(rows), 20);

    expect(result.submittedCount).toBe(32);
    expect(result.batches.map((batch) => [batch.difficulty, batch.entries.length])).toEqual([
      ['Normal', 20],
      ['Normal', 3],
      ['Mythic', 7],
      ['Heroic', 2],
    ]);
  });

  it('rejects rows that cannot be routed to one difficulty', () => {
    expect(() => parseMechanicPolicySubmission('[{"abilityId":1,"mechanicKey":"x"}]', 20)).toThrow(/difficulty/);
    expect(() => parseMechanicPolicySubmission('[{"abilityId":1,"mechanicKey":"x","difficulty":"LFR"}]', 20)).toThrow(/LFR/);
  });

  it('rejects duplicate scoped identities before publishing the first batch', () => {
    const duplicated = [
      { abilityId: 1, mechanicKey: 'ability:1', difficulty: 'Normal' },
      { abilityId: 1, mechanicKey: 'ability:1', difficulty: 'Normal' },
    ];
    expect(() => parseMechanicPolicySubmission(JSON.stringify(duplicated), 20)).toThrow(/repite/);
  });

  it('checks the complete response against the identities returned with the prompt', () => {
    const expected = [
      { abilityId: 1, mechanicKey: 'ability:1', difficulty: 'Normal' },
      { abilityId: 2, mechanicKey: 'ability:2', difficulty: 'Heroic' },
    ];
    expect(() => parseMechanicPolicySubmission(
      JSON.stringify([expected[0]]),
      20,
      expected,
    )).toThrow(/omite 1/);
    expect(() => parseMechanicPolicySubmission(
      JSON.stringify([expected[0], { abilityId: 99, mechanicKey: 'ability:99', difficulty: 'Heroic' }]),
      20,
      expected,
    )).toThrow(/no pertenece al prompt/);
  });

  it('rejects malformed top-level responses', () => {
    expect(() => parseMechanicPolicySubmission('{"difficulty":"Normal"}', 20)).toThrow(/array JSON/);
    expect(() => parseMechanicPolicySubmission('not-json', 20)).toThrow(/JSON válido/);
  });
});
