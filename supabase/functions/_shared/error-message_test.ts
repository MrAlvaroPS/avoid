import { errorMessage } from './error-message.ts';

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

Deno.test('preserves PostgREST message, details and hint', () => {
  assertEquals(
    errorMessage({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
      details: 'Key (pull_id) already exists.',
      hint: 'Use the existing pull.',
    }),
    'duplicate key value violates unique constraint · Key (pull_id) already exists. · Use the existing pull.',
  );
});

Deno.test('never degrades a plain object to [object Object]', () => {
  assertEquals(errorMessage({ code: 'UNEXPECTED_SHAPE' }), '{"code":"UNEXPECTED_SHAPE"}');
});
