// Colocar en: src/app/shared/defensive-spec-match.util.ts
// §Duplicado A PROPÓSITO de specApplies en supabase/functions/_shared/
// defensive-cooldowns.ts — Deno (edge functions) y Angular (src/app) son
// build targets distintos, no comparten import, mismo criterio que ya deja
// documentado wcl-client.ts en otros sitios ("duplicada aquí a propósito").
// Bug real ya visto en el otro lado (2026-08-22, Mistweaver enseñado Touch
// of Karma) por no filtrar `spec` — este helper existe para no repetirlo
// aquí al construir el desplegable de "qué defensivo asignar a esta spec".
import type { CooldownCatalogRow } from './models/domain';

/**
 * cd.spec null = toda la clase; combo "Feral/Guardian" = split('/') +
 * includes, igual que el lado Deno. spec_override (corrección manual, ver
 * migración 20260831090000_cooldown_catalog_spec_override.sql) gana siempre
 * que no sea null, aunque cd.spec diga otra cosa — mismo criterio que
 * specApplies() en defensive-cooldowns.ts, duplicado aquí a propósito.
 */
export function defensiveSpecApplies(cd: Pick<CooldownCatalogRow, 'spec' | 'spec_override'>, playerSpec: string | null): boolean {
  if (playerSpec == null) return true;
  if (cd.spec_override != null) return cd.spec_override.includes(playerSpec);
  if (cd.spec == null) return true;
  return cd.spec
    .split('/')
    .map((s) => s.trim())
    .includes(playerSpec);
}

/** Catálogo completo -> lo que de verdad puede llevar esta class+spec (sin resolver talentos aquí, a diferencia de defensivesForClass en el servidor — esta pantalla es de curación/planificación, no de un pull concreto con un build real). */
export function defensivesForSpec(catalog: CooldownCatalogRow[], wclClass: string, spec: string): CooldownCatalogRow[] {
  return catalog.filter((cd) => cd.class === wclClass && defensiveSpecApplies(cd, spec));
}
