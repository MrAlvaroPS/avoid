import { extractReportCode, wclFightUrl, wclReportUrl } from './wcl-code.util';

describe('wcl-code util', () => {
  it('extrae el report code desde código o URL', () => {
    expect(extractReportCode('7GbANtw1J2pjZzH9')).toBe('7GbANtw1J2pjZzH9');
    expect(extractReportCode('https://www.warcraftlogs.com/reports/7GbANtw1J2pjZzH9')).toBe('7GbANtw1J2pjZzH9');
  });

  it('construye el enlace autoritario al report sin filtros inventados', () => {
    expect(wclReportUrl('7GbANtw1J2pjZzH9')).toBe('https://www.warcraftlogs.com/reports/7GbANtw1J2pjZzH9');
  });

  it('construye el enlace autoritario al fight exacto', () => {
    expect(wclFightUrl('7GbANtw1J2pjZzH9', 34)).toBe(
      'https://www.warcraftlogs.com/reports/7GbANtw1J2pjZzH9#fight=34',
    );
  });

  it('acepta una URL de report como entrada sin duplicar la ruta', () => {
    expect(wclFightUrl('https://www.warcraftlogs.com/reports/7GbANtw1J2pjZzH9', 34)).toBe(
      'https://www.warcraftlogs.com/reports/7GbANtw1J2pjZzH9#fight=34',
    );
  });

  it('rechaza locators ambiguos o fights inválidos', () => {
    expect(() => wclReportUrl('not a report')).toThrow('Invalid Warcraft Logs report code.');
    expect(() => wclFightUrl('7GbANtw1J2pjZzH9', 0)).toThrow(RangeError);
    expect(() => wclFightUrl('7GbANtw1J2pjZzH9', 2.5)).toThrow(RangeError);
  });
});
