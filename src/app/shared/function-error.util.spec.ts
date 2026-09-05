import { describe, expect, it } from 'vitest';
import { describeFunctionError } from './function-error.util';

describe('describeFunctionError', () => {
  it('reads the structured Edge Function body across Response realms', async () => {
    const error = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      context: {
        status: 409,
        clone: () => ({ json: async () => ({ ok: false, error: 'No hay perfiles por ocurrencia.' }) }),
      },
    });

    await expect(describeFunctionError(error, 'generate-defensive-plan')).resolves.toMatchObject({
      message: 'No hay perfiles por ocurrencia.',
    });
  });

  it('keeps function and HTTP status when infrastructure returns no body', async () => {
    const error = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      context: { status: 546 },
    });

    await expect(describeFunctionError(error, 'generate-defensive-plan')).resolves.toMatchObject({
      message: 'generate-defensive-plan: Edge Function returned a non-2xx status code (HTTP 546)',
    });
  });

  it('shows the infrastructure code and message returned by a killed worker', async () => {
    const error = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      context: {
        status: 546,
        clone: () => ({
          json: async () => ({
            code: 'WORKER_RESOURCE_LIMIT',
            message: 'Function failed due to not having enough compute resources',
          }),
        }),
      },
    });

    await expect(describeFunctionError(error, 'generate-defensive-plan')).resolves.toMatchObject({
      message: 'WORKER_RESOURCE_LIMIT: Function failed due to not having enough compute resources',
    });
  });
});
