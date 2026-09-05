// Permite pegar tanto "AbC123XyZ" como "https://www.warcraftlogs.com/reports/AbC123XyZ".
export function extractReportCode(input: string): string {
  const match = input.match(/reports\/([a-zA-Z0-9]+)/);
  return match ? match[1] : input.trim();
}

function validatedReportCode(input: string): string {
  const reportCode = extractReportCode(input);
  if (!reportCode || !/^[a-zA-Z0-9]+$/.test(reportCode)) {
    throw new Error('Invalid Warcraft Logs report code.');
  }
  return reportCode;
}

/** Enlace mínimo autoritario al report completo. */
export function wclReportUrl(reportCodeOrUrl: string): string {
  return `https://www.warcraftlogs.com/reports/${validatedReportCode(reportCodeOrUrl)}`;
}

/**
 * Enlace mínimo autoritario al fight exacto. No añade filtros de vista que no
 * estén respaldados por una identidad/evidencia más fuerte.
 */
export function wclFightUrl(reportCodeOrUrl: string, fightId: number): string {
  if (!Number.isInteger(fightId) || fightId <= 0) {
    throw new RangeError(`fightId must be a positive integer, got ${fightId}`);
  }
  return `${wclReportUrl(reportCodeOrUrl)}#fight=${fightId}`;
}
