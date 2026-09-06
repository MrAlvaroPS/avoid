// Colocar en: src/app/features/report-workspace/report-history-grouping.util.ts
// PR4 del plan IRIS (Report Workspace): agrupación por mes + búsqueda básica
// para "Ver todas" en el selector de noches del sidebar — pura, sin Angular
// ni Supabase, mismo espíritu que report-participant-grouping.util.ts (PR3).
import type { ReportRow } from '../../shared/models/domain';

export interface ReportHistoryItem {
  report: ReportRow;
  bossesAttempted: string[];
}

export interface ReportMonthGroup {
  /** "2026-09" — solo para trackBy/ordenar, nunca se muestra. */
  key: string;
  /** "SEPTIEMBRE 2026" (es-ES, mayúsculas — spec §11). */
  label: string;
  items: ReportHistoryItem[];
}

/** §11 del spec: "Ver todas" agrupado por mes, meses más recientes primero, noches más recientes primero dentro del mes. */
export function groupReportsByMonth(items: ReportHistoryItem[]): ReportMonthGroup[] {
  const byKey = new Map<string, ReportHistoryItem[]>();
  for (const item of items) {
    const date = new Date(item.report.start_time);
    const key = `${date.getFullYear()}-${String(date.getMonth()).padStart(2, '0')}`;
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, groupItems]) => {
      const sorted = [...groupItems].sort((a, b) => b.report.start_time - a.report.start_time);
      const date = new Date(sorted[0].report.start_time);
      // toLocaleDateString con {month, year} intercala "de" ("septiembre de
      // 2026") — el mockup del spec (§11) quiere "SEPTIEMBRE 2026", así que
      // se arma a mano en vez de aceptar el formato combinado del locale.
      const monthName = date.toLocaleDateString('es-ES', { month: 'long' });
      const label = `${monthName} ${date.getFullYear()}`.toLocaleUpperCase('es');
      return { key, label, items: sorted };
    });
}

/**
 * §12 del spec: búsqueda básica — fecha, título o código del report (boss
 * queda para más adelante, "puede implementarse posteriormente si requiere
 * modificar significativamente las consultas actuales").
 */
export function reportMatchesQuery(item: ReportHistoryItem, query: string): boolean {
  const q = query.trim().toLocaleLowerCase('es');
  if (!q) return true;
  const dateLabel = new Date(item.report.start_time)
    .toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })
    .toLocaleLowerCase('es');
  return (
    item.report.title.toLocaleLowerCase('es').includes(q) ||
    item.report.code.toLocaleLowerCase('es').includes(q) ||
    dateLabel.includes(q)
  );
}

export function filterReportItems(items: ReportHistoryItem[], query: string): ReportHistoryItem[] {
  if (!query.trim()) return items;
  return items.filter((item) => reportMatchesQuery(item, query));
}
