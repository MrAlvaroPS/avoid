// Colocar en: src/app/features/raid-night/raid-night.component.ts
import { Component, inject, signal } from '@angular/core';
import { SupabaseService } from '../../core/supabase.service';
import { WclImportService } from '../../core/wcl-import.service';
import { AuthService } from '../../core/auth.service';
import { Pull } from '../../shared/models/domain';
import { mapPull } from '../../shared/models/mappers';
import { extractReportCode } from '../../shared/wcl-code.util';

@Component({
  selector: 'app-raid-night',
  standalone: true,
  templateUrl: './raid-night.component.html',
  styleUrl: './raid-night.component.scss',
})
export class RaidNightComponent {
  private supabase = inject(SupabaseService);
  private wclImport = inject(WclImportService);
  auth = inject(AuthService); // pública: la usa el template para el botón "salir"

  reportCodeInput = signal('');
  loading = signal(false);
  error = signal<string | null>(null);
  lastImportInfo = signal<string | null>(null);
  pulls = signal<Pull[]>([]);
  raidNightId = signal<string | null>(null);

  async onImport(): Promise<void> {
    const code = extractReportCode(this.reportCodeInput());
    if (!code) return;

    this.loading.set(true);
    this.error.set(null);
    this.lastImportInfo.set(null);
    try {
      const result = await this.wclImport.importReport(code, this.raidNightId() ?? undefined);
      this.raidNightId.set(result.raidNight.id);
      this.lastImportInfo.set(
        `${result.pullsCreated.length} pulls nuevos · ${result.pullsSkipped} ya existían · ${result.totalFightsInReport} fights en el report`,
      );
      await this.loadPulls(result.raidNight.id);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  async loadPulls(raidNightId: string): Promise<void> {
    const { data, error } = await this.supabase.client
      .from('pulls')
      .select('*, encounter:encounters(*)')
      .eq('raid_night_id', raidNightId)
      .order('started_at', { ascending: true });

    if (error) {
      this.error.set(error.message);
      return;
    }
    this.pulls.set((data ?? []).map(mapPull));
  }

  formatDuration(ms: number | null): string {
    if (!ms) return '—';
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
}
