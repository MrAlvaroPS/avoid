import { createClient } from 'jsr:@supabase/supabase-js@2';
import { requireOfficer } from '../_shared/require-officer.ts';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { canonicalRefreshStepsForInvocation } from '../_shared/canonical-defensive-auto-refresh.ts';

const FUNCTION_VERSION = 'canonical-defensive-auto-refresh@2';
const SELF_SLUG = 'canonical-defensive-auto-refresh';
const CANONICAL_WORKER_SLUG = 'canonical-defensive-refresh';

type Action = 'drain' | 'execute' | 'continue' | 'start' | 'status';

interface Body {
  action?: Action;
  reportCode?: string | null;
  leaseToken?: string | null;
  generationId?: string | null;
  includeCoverage?: boolean;
}

interface ClaimRow {
  report_code: string;
  lease_token: string;
  attempt: number;
}

interface FailureResult {
  retryScheduled?: boolean;
  retryAfterSeconds?: number;
  staleLease?: boolean;
}

interface RuntimeRow {
  dispatch_token: string;
  function_url: string | null;
  lease_token: string | null;
  lease_report_code: string | null;
  lease_generation_id: string | null;
  lease_expires_at: string | null;
  updated_at: string;
}

const serviceClient = () =>
  createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    const code = (error as { code?: unknown }).code;
    if (typeof message === 'string') {
      return typeof code === 'string' ? `${code}: ${message}` : message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to the final string conversion.
    }
  }
  return String(error);
}

function edgeWaitUntil(promise: Promise<unknown>) {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (task: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (typeof runtime?.waitUntil === 'function') {
    runtime.waitUntil(promise);
  } else {
    void promise.catch((error) =>
      console.error(`${FUNCTION_VERSION}: background task failed`, error),
    );
  }
}

async function readRuntime(client: ReturnType<typeof serviceClient>): Promise<RuntimeRow> {
  const { data, error } = await client
    .from('canonical_defensive_refresh_dispatch_runtime')
    .select(
      'dispatch_token,function_url,lease_token,lease_report_code,lease_generation_id,lease_expires_at,updated_at',
    )
    .eq('id', true)
    .single();
  if (error) throw error;
  return data as RuntimeRow;
}

async function hasInternalDispatchToken(
  client: ReturnType<typeof serviceClient>,
  req: Request,
): Promise<boolean> {
  const supplied = req.headers.get('x-iris-dispatch-token');
  if (!supplied) return false;
  try {
    const runtime = await readRuntime(client);
    return supplied === runtime.dispatch_token;
  } catch {
    return false;
  }
}

async function rpc<T>(
  client: ReturnType<typeof serviceClient>,
  name: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await client.rpc(name, params);
  if (error) throw error;
  return data as T;
}

async function callCanonicalWorker(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const response = await fetch(`${url}/functions/v1/${CANONICAL_WORKER_SLUG}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok || parsed.ok === false) {
    throw new Error(
      `${CANONICAL_WORKER_SLUG} ${String(body.action ?? 'unknown')} failed (${response.status}): ${
        typeof parsed.error === 'string' ? parsed.error : text || 'unknown error'
      }`,
    );
  }
  return parsed;
}

async function scheduleSelf(body: Body, delayMs = 0) {
  const client = serviceClient();
  const runtime = await readRuntime(client);
  const url = Deno.env.get('SUPABASE_URL')!;
  const gatewayKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!gatewayKey) throw new Error('SUPABASE_ANON_KEY is required for authenticated self-dispatch');
  const task = (async () => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const response = await fetch(`${url}/functions/v1/${SELF_SLUG}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${gatewayKey}`,
        apikey: gatewayKey,
        'x-iris-dispatch-token': runtime.dispatch_token,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`self-dispatch failed (${response.status}): ${text}`);
    }
  })();
  edgeWaitUntil(task);
}

async function failActiveRequest(
  client: ReturnType<typeof serviceClient>,
  reportCode: string,
  leaseToken: string,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  let result: FailureResult = { retryScheduled: false, retryAfterSeconds: 0 };
  try {
    result = await rpc<FailureResult>(client, 'fail_canonical_defensive_refresh_request', {
      p_report_code: reportCode,
      p_lease_token: leaseToken,
      p_error: message,
    });
  } catch (persistError) {
    console.error(`${FUNCTION_VERSION}: could not persist canonical refresh failure`, persistError);
  }

  if (result.retryScheduled) {
    await scheduleSelf(
      { action: 'drain' },
      Math.max(1, Number(result.retryAfterSeconds ?? 2)) * 1000,
    );
  } else {
    // A blocked request must not starve another independent pending request.
    await scheduleSelf({ action: 'drain' }, 0);
  }

  return {
    ok: false,
    reportCode,
    error: message,
    retryScheduled: result.retryScheduled === true,
    retryAfterSeconds: Number(result.retryAfterSeconds ?? 0),
    staleLease: result.staleLease === true,
  };
}

async function completeActiveRequest(
  client: ReturnType<typeof serviceClient>,
  reportCode: string,
  leaseToken: string,
  generationId: string,
) {
  const completed = await rpc<boolean>(client, 'complete_canonical_defensive_refresh_request', {
    p_report_code: reportCode,
    p_lease_token: leaseToken,
    p_generation_id: generationId,
  });
  if (!completed) {
    return { ok: true, state: 'stale', reportCode, generationId };
  }
  await scheduleSelf({ action: 'drain' }, 0);
  return { ok: true, state: 'completed', reportCode, generationId };
}

async function processGeneration(
  client: ReturnType<typeof serviceClient>,
  reportCode: string,
  leaseToken: string,
  generationId: string,
) {
  try {
    const renewed = await rpc<boolean>(client, 'renew_canonical_defensive_refresh_lease', {
      p_report_code: reportCode,
      p_lease_token: leaseToken,
      p_generation_id: generationId,
    });
    if (!renewed) {
      return { ok: true, state: 'stale', reportCode, generationId };
    }

    let lastResult: Record<string, unknown> | null = null;
    const steps = canonicalRefreshStepsForInvocation();
    for (let index = 0; index < steps; index++) {
      lastResult = await callCanonicalWorker({ action: 'process', generationId });
      if (lastResult.done === true) {
        return await completeActiveRequest(client, reportCode, leaseToken, generationId);
      }

      // Refresh the lease between bounded WCL pulls. If ownership was lost,
      // stop immediately rather than allowing two chains to reset/process the
      // same global BUILDING generation concurrently.
      if (index + 1 < steps) {
        const stillOwned = await rpc<boolean>(client, 'renew_canonical_defensive_refresh_lease', {
          p_report_code: reportCode,
          p_lease_token: leaseToken,
          p_generation_id: generationId,
        });
        if (!stillOwned) {
          return { ok: true, state: 'stale', reportCode, generationId };
        }
      }
    }

    await scheduleSelf({ action: 'continue', reportCode, leaseToken, generationId }, 0);
    return {
      ok: true,
      state: 'running',
      reportCode,
      generationId,
      coverage: lastResult?.coverage ?? null,
    };
  } catch (error) {
    return await failActiveRequest(client, reportCode, leaseToken, error);
  }
}

async function startClaimedRequest(client: ReturnType<typeof serviceClient>, claim: ClaimRow) {
  const reportCode = claim.report_code;
  const leaseToken = claim.lease_token;
  try {
    // A long report can finish its final pull and then lose the fire-and-forget
    // continuation before the next invocation observes `done`. Resume the
    // already-bound generation directly when its persisted contract matches
    // the worker health contract; do not rebuild or wait for WCL again.
    const { data: request, error: requestError } = await client
      .from('canonical_defensive_refresh_requests')
      .select('generation_id')
      .eq('report_code', reportCode)
      .eq('lease_token', leaseToken)
      .eq('status', 'running')
      .maybeSingle();
    if (requestError) throw requestError;
    const resumableGenerationId = typeof request?.generation_id === 'string'
      ? request.generation_id
      : null;
    if (resumableGenerationId) {
      const [{ data: generation, error: generationError }, health] = await Promise.all([
        client
          .from('defensive_generations')
          .select(
            'game_build,semantic_version,resolver_version,semantic_resolver_version,episode_version,evaluator_version',
          )
          .eq('id', resumableGenerationId)
          .maybeSingle(),
        callCanonicalWorker({ action: 'health' }),
      ]);
      if (generationError) throw generationError;
      const contractMatches = generation
        && generation.game_build === health.gameBuild
        && generation.semantic_version === health.semanticVersion
        && generation.resolver_version === health.resolverVersion
        && generation.semantic_resolver_version === health.semanticResolverVersion
        && generation.episode_version === health.evaluatorVersion
        && generation.evaluator_version === health.evaluatorVersion;
      if (contractMatches) {
        return await processGeneration(client, reportCode, leaseToken, resumableGenerationId);
      }
    }

    // Passing the current lease lets the worker replace an incompatible
    // private BUILDING generation and bind the replacement atomically. The
    // legacy bind below remains as an idempotent compatibility check.
    const started = await callCanonicalWorker({ action: 'start', reportCode, leaseToken });
    if (started.skipped === true) {
      const reason =
        typeof started.reason === 'string'
          ? started.reason
          : 'canonical worker skipped the completed report';
      await rpc<boolean>(client, 'block_canonical_defensive_refresh_request', {
        p_report_code: reportCode,
        p_lease_token: leaseToken,
        p_error: reason,
      });
      await scheduleSelf({ action: 'drain' }, 0);
      return { ok: false, state: 'blocked', reportCode, reason };
    }

    const generationId = typeof started.generationId === 'string' ? started.generationId : null;
    if (!generationId) {
      throw new Error('canonical worker start returned no generationId');
    }

    const bound = await rpc<boolean>(client, 'bind_canonical_defensive_refresh_generation', {
      p_report_code: reportCode,
      p_lease_token: leaseToken,
      p_generation_id: generationId,
    });
    if (!bound) {
      return { ok: true, state: 'stale', reportCode, generationId };
    }

    return await processGeneration(client, reportCode, leaseToken, generationId);
  } catch (error) {
    return await failActiveRequest(client, reportCode, leaseToken, error);
  }
}

async function drain(client: ReturnType<typeof serviceClient>) {
  const claims = await rpc<ClaimRow[]>(client, 'claim_canonical_defensive_refresh_request');
  const claim = claims?.[0] ?? null;
  if (claim) {
    // The PostgreSQL wake-up has a deliberately short HTTP timeout. Return as
    // soon as ownership is durable, then perform WCL/canonical work in a fresh
    // authenticated invocation whose lifetime is not tied to pg_net.
    await scheduleSelf(
      { action: 'execute', reportCode: claim.report_code, leaseToken: claim.lease_token },
      0,
    );
    return {
      ok: true,
      state: 'scheduled',
      reportCode: claim.report_code,
      attempt: claim.attempt,
    };
  }

  const [runtimeResponse, pendingResponse] = await Promise.all([
    client
      .from('canonical_defensive_refresh_dispatch_runtime')
      .select('lease_token,lease_expires_at,lease_report_code,lease_generation_id')
      .eq('id', true)
      .single(),
    client
      .from('canonical_defensive_refresh_requests')
      .select('report_code,not_before')
      .eq('status', 'pending')
      .order('not_before', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  if (runtimeResponse.error) throw runtimeResponse.error;
  if (pendingResponse.error) throw pendingResponse.error;

  const runtime = runtimeResponse.data as {
    lease_token: string | null;
    lease_expires_at: string | null;
    lease_report_code: string | null;
    lease_generation_id: string | null;
  };
  const activeLease =
    runtime.lease_token != null &&
    runtime.lease_expires_at != null &&
    new Date(runtime.lease_expires_at).getTime() > Date.now();
  if (activeLease) {
    return {
      ok: true,
      state: 'running',
      reportCode: runtime.lease_report_code,
      generationId: runtime.lease_generation_id,
    };
  }

  const pending = pendingResponse.data as { report_code: string; not_before: string } | null;
  if (pending) {
    const delayMs = Math.max(
      250,
      Math.min(10_000, new Date(pending.not_before).getTime() - Date.now()),
    );
    await scheduleSelf({ action: 'drain' }, delayMs);
    return { ok: true, state: 'waiting', reportCode: pending.report_code, delayMs };
  }

  return { ok: true, state: 'idle' };
}

async function status(
  client: ReturnType<typeof serviceClient>,
  reportCode: string | null,
  includeCoverage: boolean,
) {
  let requestsQuery = client
    .from('canonical_defensive_refresh_requests')
    .select(
      'report_code,status,requested_at,not_before,attempts,generation_id,lease_expires_at,last_error,completed_at,updated_at',
    )
    .order('updated_at', { ascending: false })
    .limit(reportCode ? 1 : 25);
  if (reportCode) requestsQuery = requestsQuery.eq('report_code', reportCode);

  const [runtimeResponse, requestsResponse, generationsResponse] = await Promise.all([
    client
      .from('canonical_defensive_refresh_dispatch_runtime')
      .select('function_url,lease_report_code,lease_generation_id,lease_expires_at,updated_at')
      .eq('id', true)
      .single(),
    requestsQuery,
    client
      .from('defensive_generations')
      .select('id,status,created_at,published_at,game_build')
      .in('status', ['building', 'published'])
      .order('created_at', { ascending: false }),
  ]);
  if (runtimeResponse.error || requestsResponse.error || generationsResponse.error) {
    throw runtimeResponse.error || requestsResponse.error || generationsResponse.error;
  }

  let buildingCoverage: unknown = null;
  const building = (generationsResponse.data ?? []).find(
    (row: { status: string }) => row.status === 'building',
  );
  if (includeCoverage && building?.id) {
    try {
      buildingCoverage = await rpc(client, 'defensive_generation_coverage', {
        p_generation_id: building.id,
      });
    } catch (error) {
      buildingCoverage = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    ok: true,
    version: FUNCTION_VERSION,
    runtime: runtimeResponse.data,
    requests: requestsResponse.data ?? [],
    generations: generationsResponse.data ?? [],
    buildingCoverage,
  };
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const client = serviceClient();
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const requestedAction = body.action ?? 'drain';
    const allowedActions: readonly Action[] = ['start', 'drain', 'execute', 'continue', 'status'];
    if (!allowedActions.includes(requestedAction)) {
      return jsonResponse({ ok: false, error: `Unknown action ${String(requestedAction)}` }, 400);
    }
    const action: Action = requestedAction;
    const internal = await hasInternalDispatchToken(client, req);

    if (!internal) {
      const guard = await requireOfficer(req);
      if (guard instanceof Response) return guard;
      if (action === 'execute' || action === 'continue') {
        return jsonResponse({ ok: false, error: `${action} is internal-only` }, 403);
      }
    }

    if (action === 'status') {
      return jsonResponse(
        await status(client, body.reportCode ?? null, body.includeCoverage !== false),
      );
    }

    if (action === 'start') {
      if (!body.reportCode) {
        return jsonResponse({ ok: false, error: 'reportCode required' }, 400);
      }
      const enqueued = await rpc<boolean>(client, 'enqueue_canonical_defensive_refresh', {
        p_report_code: body.reportCode,
      });
      if (!enqueued) {
        return jsonResponse({ ok: true, state: 'already_current', reportCode: body.reportCode });
      }
      return jsonResponse(await drain(client));
    }

    if (action === 'execute') {
      if (!body.reportCode || !body.leaseToken) {
        return jsonResponse({ ok: false, error: 'reportCode and leaseToken required' }, 400);
      }
      return jsonResponse(
        await startClaimedRequest(client, {
          report_code: body.reportCode,
          lease_token: body.leaseToken,
          attempt: 0,
        }),
      );
    }

    if (action === 'continue') {
      if (!body.reportCode || !body.leaseToken || !body.generationId) {
        return jsonResponse(
          { ok: false, error: 'reportCode, leaseToken and generationId required' },
          400,
        );
      }
      return jsonResponse(
        await processGeneration(client, body.reportCode, body.leaseToken, body.generationId),
      );
    }

    return jsonResponse(await drain(client));
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        version: FUNCTION_VERSION,
        error: describeUnknownError(error),
      },
      500,
    );
  }
});
