// Colocar en: src/app/shared/defensive-spec-match.util.ts
// §Duplicado A PROPÓSITO de specApplies en supabase/functions/_shared/
// defensive-cooldowns.ts — Deno (edge functions) y Angular (src/app) son
// build targets distintos, no comparten import, mismo criterio que ya deja
// documentado wcl-client.ts en otros sitios ("duplicada aquí a propósito").
// Bug real ya visto en el otro lado (2026-08-22, Mistweaver enseñado Touch
// of Karma) por no filtrar `spec` — este helper existe para no repetirlo
// aquí al construir el desplegable de "qué defensivo asignar a esta spec".
import type { CooldownCatalogRow } from './models/domain';

/** cd.spec null = toda la clase; combo "Feral/Guardian" = split('/') + includes, igual que el lado Deno. */
export function defensiveSpecApplies(catalogSpec: string | null, playerSpec: string | null): boolean {
  if (catalogSpec == null) return true;
  if (playerSpec == null) return true;
  return catalogSpec
    .split('/')
    .map((s) => s.trim())
    .includes(playerSpec);
}

/** Catálogo completo -> lo que de verdad puede llevar esta class+spec (sin resolver talentos aquí, a diferencia de defensivesForClass en el servidor — esta pantalla es de curación/planificación, no de un pull concreto con un build real). */
export function defensivesForSpec(catalog: CooldownCatalogRow[], wclClass: string, spec: string): CooldownCatalogRow[] {
  return catalog.filter((cd) => cd.class === wclClass && defensiveSpecApplies(cd.spec, spec));
}
