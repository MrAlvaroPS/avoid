// Colocar en: src/app/core/unassigned-mechanic-catalog.service.ts
// §"UI en Ajustes para gestionar el catálogo a mano" (feedback real,
// 2026-08-29) — mismo patrón de lectura que DefensiveCatalogService/
// ManifestService: solo lee (RLS de la tabla permite SELECT a cualquiera,
// ver migración 20260829080000), la escritura vive en
// EdgeFunctionsService.saveUnassignedMechanicEdit (RLS bloquea escritura
// directa, solo service_role).
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import type { UnassignedMechanicCatalogRow } from '../shared/models/domain';

@Injectable({ providedIn: 'root' })
export class UnassignedMechanicCatalogService {
  private supabase = inject(SupabaseService);

  async listByBoss(bossId: string, difficulty: string): Promise<UnassignedMechanicCatalogRow[]> {
    const { data, error } = await this.supabase.client
      .from('unassigned_mechanic_catalog')
      .select('*')
      .eq('boss_id', bossId)
      .eq('difficulty', difficulty)
      .order('name', { ascending: true });
    if (error) throw error;
    return (data ?? []) as UnassignedMechanicCatalogRow[];
  }

  /** Para el resumen "cuántas mecánicas activas hay" que enseña la pestaña sin tener que abrir cada boss — un solo SELECT ligero (sin *), no una llamada por boss. */
  async listAll(): Promise<Pick<UnassignedMechanicCatalogRow, 'id' | 'boss_id' | 'difficulty' | 'has_confirmed_detection'>[]> {
    const { data, error } = await this.supabase.client
      .from('unassigned_mechanic_catalog')
      .select('id,boss_id,difficulty,has_confirmed_detection');
    if (error) throw error;
    return data ?? [];
  }
}
