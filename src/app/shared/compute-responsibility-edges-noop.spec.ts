import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('supabase/functions/compute-responsibility-edges/index.ts', 'utf8');

describe('compute-responsibility-edges empty output handling', () => {
  it('treats zero materializable edges as a successful no-op before PostgREST upsert', () => {
    const guard = source.indexOf('if (edgesToInsert.length === 0)');
    const upsert = source.indexOf(".upsert(edgesToInsert, {");
    expect(guard).toBeGreaterThan(-1);
    expect(upsert).toBeGreaterThan(guard);
    expect(source).toContain('edgesCreated: 0');
    expect(source).toContain('edges: []');
  });

  it('preserves structured PostgREST error fields instead of String(object)', () => {
    expect(source).toContain('function formatCaughtError(error: unknown): string');
    expect(source).toContain("record['message']");
    expect(source).toContain("record['details']");
    expect(source).toContain("record['hint']");
    expect(source).toContain("record['code']");
    expect(source).not.toContain('const message = error instanceof Error ? error.message : String(error);');
  });
});
