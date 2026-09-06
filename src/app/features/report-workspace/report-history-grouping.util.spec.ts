import { describe, expect, it } from 'vitest';
import {
  filterReportItems,
  groupReportsByMonth,
  reportMatchesQuery,
  type ReportHistoryItem,
} from './report-history-grouping.util';
import type { ReportRow } from '../../shared/models/domain';

// Mediodía UTC a propósito — evita que el offset de la zona horaria del
// runner empuje la fecha local al día/mes anterior o siguiente.
function item(overrides: Partial<ReportRow> & { code: string }): ReportHistoryItem {
  return {
    report: {
      code: overrides.code,
      title: overrides.title ?? `Report ${overrides.code}`,
      zone_id: null,
      zone_name: null,
      is_raid: true,
      start_time: overrides.start_time ?? 0,
      end_time: null,
      last_processed_fight_id: null,
    },
    bossesAttempted: [],
  };
}

describe('groupReportsByMonth · PR4', () => {
  it('agrupa por mes, meses más recientes primero', () => {
    const groups = groupReportsByMonth([
      item({ code: 'AGO', start_time: Date.UTC(2026, 7, 27, 12) }),
      item({ code: 'SEP', start_time: Date.UTC(2026, 8, 4, 12) }),
    ]);

    expect(groups.map((g) => g.label)).toEqual(['SEPTIEMBRE 2026', 'AGOSTO 2026']);
  });

  it('dentro de un mes, ordena las noches más recientes primero', () => {
    const groups = groupReportsByMonth([
      item({ code: 'EARLY', start_time: Date.UTC(2026, 8, 1, 12) }),
      item({ code: 'LATE', start_time: Date.UTC(2026, 8, 4, 12) }),
    ]);

    expect(groups[0].items.map((i) => i.report.code)).toEqual(['LATE', 'EARLY']);
  });

  it('dos noches del mismo mes caen en el mismo grupo', () => {
    const groups = groupReportsByMonth([
      item({ code: 'A', start_time: Date.UTC(2026, 8, 1, 12) }),
      item({ code: 'B', start_time: Date.UTC(2026, 8, 30, 12) }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });
});

describe('reportMatchesQuery / filterReportItems · PR4', () => {
  const dewerland = item({
    code: 'ABC123',
    title: 'Manaforge Omega',
    start_time: Date.UTC(2026, 8, 2, 12),
  });

  it('una búsqueda vacía coincide con todo', () => {
    expect(reportMatchesQuery(dewerland, '')).toBe(true);
  });

  it('busca por título (sin distinguir mayúsculas)', () => {
    expect(reportMatchesQuery(dewerland, 'manaforge')).toBe(true);
  });

  it('busca por código de report', () => {
    expect(reportMatchesQuery(dewerland, 'abc123')).toBe(true);
  });

  it('busca por fecha formateada (día y mes en español)', () => {
    expect(reportMatchesQuery(dewerland, '2 de septiembre')).toBe(true);
  });

  it('no coincide con texto irrelevante', () => {
    expect(reportMatchesQuery(dewerland, 'nexus-king')).toBe(false);
  });

  it('filterReportItems sin query devuelve la lista intacta', () => {
    const items = [dewerland];
    expect(filterReportItems(items, '  ')).toBe(items);
  });

  it('filterReportItems filtra usando la misma regla que reportMatchesQuery', () => {
    expect(filterReportItems([dewerland], 'manaforge')).toEqual([dewerland]);
    expect(filterReportItems([dewerland], 'no-existe')).toEqual([]);
  });
});
