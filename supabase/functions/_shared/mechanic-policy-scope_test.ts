import { partitionReadyMechanicPolicyDifficulties } from './mechanic-policy-scope.ts';

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

Deno.test('keeps complete difficulties when another difficulty lacks identities', () => {
  const result = partitionReadyMechanicPolicyDifficulties([
    { difficulty: 'Heroic', mechanic_key: 'ability:1', ability_id: 1 },
    { difficulty: 'Heroic', mechanic_key: 'ability:2', ability_id: 2 },
    { difficulty: 'Mythic', mechanic_key: 'ability:1', ability_id: 1 },
    { difficulty: 'Mythic', mechanic_key: null, ability_id: 3 },
  ]);

  assertEquals(result.readyCandidates.map((candidate) => candidate.ability_id), [1, 2]);
  assertEquals(result.skippedDifficulties, [
    { difficulty: 'Mythic', totalCandidates: 2, missingIdentities: 1 },
  ]);
});

Deno.test('keeps every difficulty when all identities are ready', () => {
  const candidates = [
    { difficulty: 'Normal', mechanic_key: 'ability:1' },
    { difficulty: 'Heroic', mechanic_key: 'ability:1' },
  ];

  const result = partitionReadyMechanicPolicyDifficulties(candidates);

  assertEquals(result.readyCandidates, candidates);
  assertEquals(result.skippedDifficulties, []);
});
