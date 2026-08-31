import { decodeMrtExport, encodeMrtExport, type MrtReminderInput } from './mrt-reminder-codec';

// §Estos tests solo prueban que encode/decode son inversos ENTRE SÍ — NO que
// el resultado de encodeMrtExport lo acepte el MRT real. Esa validación es
// manual (ver cabecera de mrt-reminder-codec.ts y el plan): decodificar un
// export hecho de verdad desde el juego, e importar de verdad en MRT un
// export nuestro, antes de repartir nada a un raider.

function baseReminder(overrides: Partial<MrtReminderInput> = {}): MrtReminderInput {
  return {
    uid: 'rd_3012_16_pepito_aoe3',
    name: 'AOE #3 - Pepito',
    message: '{spell:48792} DEFENSIVO',
    bossId: 3012,
    difficultyId: 16,
    players: [],
    prewarnSeconds: 5,
    trigger: { type: 'pull', delayTimeSeconds: 80 },
    ...overrides,
  };
}

describe('encodeMrtExport / decodeMrtExport', () => {
  it('empieza por MRTREMD1 (siempre comprimido)', () => {
    const exported = encodeMrtExport('Raid Defensivos', [baseReminder()]);
    expect(exported.startsWith('MRTREMD1')).toBe(true);
  });

  it('ida y vuelta de un reminder con trigger de tiempo (pull) — countdown+durrev', () => {
    const exported = encodeMrtExport('Raid Defensivos', [baseReminder()]);
    const decoded = decodeMrtExport(exported);

    expect(decoded.senderVersion).toBe(4);
    expect(decoded.addonVersion).toBe(71);
    expect(decoded.profileName).toBe('Raid Defensivos');
    expect(decoded.reminders).toHaveLength(1);

    const r = decoded.reminders[0];
    expect(r.uid).toBe('rd_3012_16_pepito_aoe3');
    expect(r.name).toBe('AOE #3 - Pepito');
    expect(r.message).toBe('{spell:48792} DEFENSIVO');
    expect(r.bossId).toBe(3012);
    expect(r.difficultyId).toBe(16);
    expect(r.prewarnSeconds).toBe(5);
    expect(r.countdown).toBe(true);
    expect(r.durRev).toBe(true); // solo los triggers de tipo 'pull' activan durrev
    expect(r.players).toEqual([]);
    expect(r.triggers).toEqual([{ type: 'pull', delayTimeSeconds: 80 }]);
  });

  it('ida y vuelta de un reminder con trigger de bossmod (spellId, sin patrón) — sin durrev', () => {
    const exported = encodeMrtExport(
      'Raid Defensivos',
      [baseReminder({ uid: 'rd_3012_16_marta_blast', trigger: { type: 'bossmod', timeLeftSeconds: 6, spellId: 123456 } })],
    );
    const r = decodeMrtExport(exported).reminders[0];

    expect(r.durRev).toBe(false); // bwtimeleft ya adelanta la activación, MRT no le resta nada más
    expect(r.countdown).toBe(true);
    expect(r.triggers).toEqual([{ type: 'bossmod', timeLeftSeconds: 6, spellId: 123456, pattern: undefined }]);
  });

  it('conserva el contador de ocurrencia de un trigger bossmod', () => {
    const encoded = encodeMrtExport('Ocurrencia', [
      baseReminder({ uid: 'occ_3', trigger: { type: 'bossmod', timeLeftSeconds: 5, spellId: 123456, counter: 3 } }),
    ]);
    expect(decodeMrtExport(encoded).reminders[0].triggers[0]).toEqual({
      type: 'bossmod', timeLeftSeconds: 5, spellId: 123456, pattern: undefined, counter: 3,
    });
  });

  it('varios reminders en un único export, en orden', () => {
    const exported = encodeMrtExport('Raid Defensivos', [
      baseReminder({ uid: 'a', name: 'Primero' }),
      baseReminder({ uid: 'b', name: 'Segundo', trigger: { type: 'bossmod', timeLeftSeconds: 4 } }),
    ]);
    const decoded = decodeMrtExport(exported);

    expect(decoded.reminders.map((r) => r.uid)).toEqual(['a', 'b']);
    expect(decoded.reminders[0].name).toBe('Primero');
    expect(decoded.reminders[1].name).toBe('Segundo');
  });

  it('lista de jugadores va y vuelve igual (join/split por ":")', () => {
    const exported = encodeMrtExport('Raid Defensivos', [baseReminder({ players: ['Pepito', 'Marta', 'Juan'] })]);
    expect(decodeMrtExport(exported).reminders[0].players).toEqual(['Pepito', 'Marta', 'Juan']);
  });

  it('un valor que produce el byte crudo D1 (0xAC) en su UTF-8 (ej. "€") sobrevive el escapado', () => {
    // "€" (U+20AC) codifica en UTF-8 como E2 82 AC — el último byte ES
    // exactamente D1 (0xAC). Es el caso real (no sintético) que obliga a
    // escapar D1/D2 dentro de un valor, no solo entre campos.
    const exported = encodeMrtExport('Raid Defensivos', [baseReminder({ name: 'Coste: 5€', message: 'ojo con el € en el mensaje' })]);
    const r = decodeMrtExport(exported).reminders[0];

    expect(r.name).toBe('Coste: 5€');
    expect(r.message).toBe('ojo con el € en el mensaje');
  });

  it('decodeMrtExport rechaza un texto que no es un export de MRT', () => {
    expect(() => decodeMrtExport('esto no es un export')).toThrow();
  });
});
