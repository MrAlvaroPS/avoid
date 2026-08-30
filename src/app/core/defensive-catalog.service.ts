// Colocar en: src/app/core/defensive-catalog.service.ts
// §"pantalla nueva para clasificar defensivos... parecida a la de
// mecánicas de bosses pero para defensivos" (feedback real). El catálogo
// en sí (cooldown_catalog) ya se rellena solo desde el extractor real de
// WoWAnalyzer (§12.1) — este servicio solo lee y persiste la clasificación
// de supervivencia (survival_type) encima de esos datos, mismo patrón que
// ManifestService para boss_mechanics_candidates.
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type { CooldownCatalogRow } from '../shared/models/domain';

@Injectable({ providedIn: 'root' })
export class DefensiveCatalogService {
  private supabase = inject(SupabaseService);

  async listByClass(className: string): Promise<CooldownCatalogRow[]> {
    const { data, error } = await this.supabase.client
      .from('cooldown_catalog')
      .select('*')
      .eq('class', className)
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []) as CooldownCatalogRow[];
  }

  /** §"Preparación" (ver plan guardado): el desplegable de asignación de defensivo necesita las 13 clases a la vez, no una — el catálogo entero es pequeño (un puñado de filas por clase), una sola carga al entrar en la pantalla en vez de re-pedir por clase seleccionada. */
  async listAll(): Promise<CooldownCatalogRow[]> {
    const { data, error } = await this.supabase.client.from('cooldown_catalog').select('*').order('class', { ascending: true }).order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []) as CooldownCatalogRow[];
  }
}
