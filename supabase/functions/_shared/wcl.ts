// Colocar en: supabase/functions/_shared/wcl.ts
// Cliente mínimo de Warcraft Logs API v2. Se reutiliza tal cual en la Edge
// Function de polling en vivo de la Fase 4 (sección 11 de la hoja de ruta) —
// por eso vive aparte y no dentro de wcl-import-report.

const WCL_TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token';
const WCL_API_URL = 'https://www.warcraftlogs.com/api/v2/client';

let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getWclToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const clientId = Deno.env.get('WCL_CLIENT_ID');
  const clientSecret = Deno.env.get('WCL_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('Faltan los secrets WCL_CLIENT_ID / WCL_CLIENT_SECRET en Supabase');
  }

  const res = await fetch(WCL_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${clientId}:${clientSecret}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw new Error(`WCL auth falló (${res.status}): ${await res.text()}`);
  }

  const json = await res.json();
  // el token de client_credentials suele durar horas; refrescamos con 60s de margen
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

export async function wclGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const token = await getWclToken();
  const res = await fetch(WCL_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors) {
    throw new Error(`WCL GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

// Mapeo del difficulty numérico de WCL v2 al enum de nuestro esquema.
// Es lo habitual para contenido de raid moderno (3/4/5 = Normal/Heroic/Mythic),
// pero no lo he podido verificar contra un report real desde aquí — la
// primera importación real de la Fase 1 lo confirma o lo corrige en el acto.
export const WCL_DIFFICULTY_MAP: Record<number, 'normal' | 'heroic' | 'mythic'> = {
  3: 'normal',
  4: 'heroic',
  5: 'mythic',
};

export interface WclFight {
  id: number;
  encounterID: number;
  name: string;
  difficulty: number | null;
  kill: boolean;
  startTime: number;
  endTime: number;
  bossPercentage: number | null;
  fightPercentage: number | null;
}

export interface WclReportResponse {
  reportData: {
    report: {
      title: string;
      startTime: number;
      zone: { id: number; name: string } | null;
      fights: WclFight[];
    } | null;
  };
}

export const REPORT_QUERY = `
  query GetReport($code: String!) {
    reportData {
      report(code: $code) {
        title
        startTime
        zone { id name }
        fights(killType: All) {
          id
          encounterID
          name
          difficulty
          kill
          startTime
          endTime
          bossPercentage
          fightPercentage
        }
      }
    }
  }
`;

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
