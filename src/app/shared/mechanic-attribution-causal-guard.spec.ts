import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const responsibilitySchema = readFileSync(
  'supabase/migrations/20260901210000_mechanic_occurrence_responsibility.sql',
  'utf8',
);
const executionLedgerSchema = readFileSync(
  'supabase/migrations/20260901220000_player_execution_ledger.sql',
  'utf8',
);
const materializer = readFileSync(
  'supabase/functions/materialize-execution-ledger/index.ts',
  'utf8',
);

describe('Mechanic Attribution Safety → causal v3 acceptance guard', () => {
  it('una víctima colateral nunca puede ser penalty-eligible en el grafo causal', () => {
    expect(responsibilitySchema).toContain(
      "check (relationship <> 'collateral_victim' or not penalty_eligible)",
    );
    expect(responsibilitySchema).toContain(
      "check (not penalty_eligible or relationship in ('primary_owner', 'co_owner', 'assigned_resolver'))",
    );
  });

  it('la vista de ofensas canónicas exige ownership punitivo explícito', () => {
    expect(executionLedgerSchema).toContain('and edge.penalty_eligible');
    expect(executionLedgerSchema).toContain(
      "and edge.relationship in ('primary_owner', 'co_owner', 'assigned_resolver')",
    );
    expect(executionLedgerSchema).toContain("where e.domain = 'mechanic'");
    expect(executionLedgerSchema).toContain("and e.verdict in ('failure', 'missed')");
    expect(executionLedgerSchema).toContain('and e.penalty_eligible');
  });

  it('el materializador no convierte recepción de daño en primary penalty', () => {
    expect(materializer).toContain('penaltyEligible: edge.penaltyEligible && verdict === \'failure\'');
    expect(materializer).toContain(
      "primaryPenalty: edge.relationship === 'primary_owner' && isMechanicFailure",
    );
  });
});
