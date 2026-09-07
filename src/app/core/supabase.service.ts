// Colocar en: src/app/core/supabase.service.ts
import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';
import { createConcurrencyLimitedFetch } from '../shared/concurrency-limited-fetch';

// A cold dossier/infographic legitimately launches several independent reads
// in parallel. Letting every Promise.all translate into an unbounded HTTP burst
// can occupy the complete PostgREST connection pool and make otherwise cheap
// queries fail with PGRST003 while waiting for a connection. Six keeps useful
// browser parallelism while leaving headroom for other requests/users. Only
// /rest/v1 is limited: Auth, Storage and Edge Functions retain their existing
// behaviour and concurrency.
const SUPABASE_REST_MAX_CONCURRENT = 6;

@Injectable({ providedIn: 'root' })
export class SupabaseService {
  readonly client: SupabaseClient;

  constructor() {
    const rawFetch = globalThis.fetch.bind(globalThis) as typeof fetch;
    const restFetch = createConcurrencyLimitedFetch(rawFetch, {
      maxConcurrent: SUPABASE_REST_MAX_CONCURRENT,
      shouldLimit: (url) => url.includes('/rest/v1/'),
    });

    this.client = createClient(
      environment.supabaseUrl,
      environment.supabaseAnonKey,
      { global: { fetch: restFetch } },
    );
  }
}
