// Colocar en: src/app/shared/wcl-code.util.ts
// Permite pegar tanto "AbC123XyZ" como "https://www.warcraftlogs.com/reports/AbC123XyZ"
export function extractReportCode(input: string): string {
  const match = input.match(/reports\/([a-zA-Z0-9]+)/);
  return match ? match[1] : input.trim();
}
