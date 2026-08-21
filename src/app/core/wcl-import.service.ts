// Colocar en: src/app/core/wcl-import.service.ts
import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';

export interface ImportResult {
  raidNight: { id: string; [key: string]: unknown };
  pullsCreated: unknown[];
  pullsSkipped: number;
  totalFightsInReport: number;
}

@Injectable({ providedIn: 'root' })
export class WclImportService {
  private supabase = inject(SupabaseService);

  async importReport(reportCode: string, raidNightId?: string): Promise<ImportResult> {
    // functions.invoke() adjunta automáticamente el JWT de la sesión activa
    // como Authorization header — por eso hace falta estar logueado (AuthService).
    const { data, error } = await this.supabase.client.functions.invoke('wcl-import-report', {
      body: { reportCode, raidNightId },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data as ImportResult;
  }
}
