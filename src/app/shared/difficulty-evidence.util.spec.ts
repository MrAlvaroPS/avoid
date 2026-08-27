import { difficultyRank, hasExactDifficultyEvidence, isContradictedByOtherDifficulty } from './difficulty-evidence.util';

// difficulty: 'Normal' a propósito — la mayoría de estos casos prueban el
// contraste normal/fácil-vs-difícil, ver el bloque 'no infiere exclusividad
// hacia dificultades más fáciles' más abajo para el caso Mythic.
const base = {
  difficulty: 'Normal',
  observed_in_logs: false,
  observed_in_reference_logs: false,
  observed_as_interrupt: false,
  reference_occurrences: null,
  reference_source_report: 'NORMAL_REF',
  official_difficulty_applicable: null,
};

describe('difficulty evidence', () => {
  it('conserva una mecánica observada en la dificultad seleccionada', () => {
    expect(hasExactDifficultyEvidence({ ...base, observed_in_reference_logs: true })).toBe(true);
    expect(isContradictedByOtherDifficulty({ ...base, observed_in_reference_logs: true }, [{ difficulty: 'Mythic', hasEvidence: true }])).toBe(false);
  });

  it('oculta una candidata contrastada aquí y observada solo en una dificultad MÁS DURA', () => {
    expect(isContradictedByOtherDifficulty(base, [{ difficulty: 'Mythic', hasEvidence: true }])).toBe(true);
  });

  it('no adivina exclusividad si la dificultad actual no llegó a contrastarse', () => {
    expect(isContradictedByOtherDifficulty({ ...base, reference_source_report: null }, [{ difficulty: 'Mythic', hasEvidence: true }])).toBe(false);
  });

  it('respeta una exclusión oficial sin borrar una observación real contradictoria', () => {
    expect(isContradictedByOtherDifficulty({ ...base, reference_source_report: null, official_difficulty_applicable: false }, [])).toBe(true);
    expect(isContradictedByOtherDifficulty({ ...base, official_difficulty_applicable: false, observed_in_logs: true }, [])).toBe(false);
  });

  // §bug real reportado (2026-08-27, boss 3445 "Entombed Sentinels"): "es
  // raro que en mítico no haya mecánicas que sí hay en normal o hc, por lo
  // que es raro que haya algunas ocultas" — antes esto ocultaba una
  // candidata de Mítica solo porque Normal/Heroico SÍ tenían evidencia,
  // exactamente al revés de cómo funciona el diseño real de WoW (los tiers
  // duros añaden mecánicas, no las quitan).
  it('no infiere exclusividad hacia dificultades más fáciles (Mítica no se oculta solo porque Normal/Heroico ya tengan evidencia)', () => {
    const mythicCandidate = { ...base, difficulty: 'Mythic', reference_source_report: 'MYTHIC_REF' };
    expect(
      isContradictedByOtherDifficulty(mythicCandidate, [
        { difficulty: 'Normal', hasEvidence: true },
        { difficulty: 'Heroic', hasEvidence: true },
      ]),
    ).toBe(false);
    // pero sigue respetando una exclusión OFICIAL (DB2), que no es una
    // inferencia direccional sino un dato real de Blizzard.
    expect(isContradictedByOtherDifficulty({ ...mythicCandidate, official_difficulty_applicable: false }, [])).toBe(true);
  });

  it('difficultyRank ordena de fácil a difícil y no revienta con nombres desconocidos', () => {
    expect(difficultyRank('LFR')).toBeLessThan(difficultyRank('Normal'));
    expect(difficultyRank('Normal')).toBeLessThan(difficultyRank('Heroic'));
    expect(difficultyRank('Heroic')).toBeLessThan(difficultyRank('Mythic'));
    expect(difficultyRank('Dificultad 99')).toBe(0);
  });
});
