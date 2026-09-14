import { describe, expect, it } from 'vitest';
import { detectDamageWindows } from '../../../supabase/functions/_shared/damage-pressure-windows';

// §pressure-detection-recalibration (2026-09-10) — el factor por defecto
// bajó de 2.5 a 1.7 tras contrastar canonical_defensive_pressure_diagnostics
// contra 2 noches reales (34 pulls, 753 filas jugador×pull, 4 roles): a 2.5,
// ~50% de los pulls de DPS/healer quedaban en 0 ventanas pese a daño de raid
// real y variable (Txerokee: 30 Astral Shift reales en la noche, solo 10
// "episodios" detectados en total). A 1.7 la brecha tank/resto desaparece
// (4.5-5.0 ventanas/pull en los 4 roles) sin introducir ruido — el tank
// resultó ser el rol con MENOS varianza (desviación 1.92, máx 11 de 753
// filas), no el que necesita más margen. Esta fixture reproduce esa forma:
// daño casi continuo con UN pico moderado (~1.75x la mediana) — invisible a
// 2.5, real a 1.7 — el patrón exacto que dejaba a la mayoría del roster sin
// ninguna oportunidad evaluable en pulls de varios minutos.
describe('detectDamageWindows — default factor (§pressure-detection-recalibration)', () => {
  function nearContinuousDamageWithOneModerateSpike(): number[] {
    // 18 buckets de daño de raid "normal" (mediana=50000) + 2 buckets
    // contiguos de un pico real pero moderado (105000, ~1.75x la mediana) —
    // exactamente el rango (avg_max_over_threshold_ratio 1.27-1.81) medido
    // en los roles no-tank de las dos noches reales.
    return [50000, 55000, 48000, 52000, 105000, 105000, 51000, 49000, 53000, 50000,
      47000, 52000, 50000, 55000, 48000, 51000, 50000, 49000, 52000, 50000];
  }

  it('a moderate real spike (~1.75x mediana) produces a window at the default factor', () => {
    const points = nearContinuousDamageWithOneModerateSpike();
    const result = detectDamageWindows(points, 0, 2000);
    expect(result.windows.length).toBeGreaterThan(0);
  });

  it('the same spike was invisible under the old 2.5x factor — regression proof, not a guess', () => {
    const points = nearContinuousDamageWithOneModerateSpike();
    const result = detectDamageWindows(points, 0, 2000, 2.5);
    expect(result.windows.length).toBe(0);
  });

  it('a genuine outlier (well above any candidate factor) is still detected regardless of factor choice', () => {
    const points = [50000, 52000, 48000, 51000, 400000, 49000, 50000, 51000, 49000, 50000];
    const result = detectDamageWindows(points, 0, 2000);
    expect(result.windows.length).toBe(1);
    expect(result.windows[0].peakValue).toBe(400000);
  });

  it('flat, genuinely quiet damage (no real variation) still produces no window — the lower factor does not fabricate pressure', () => {
    const points = [50000, 51000, 49000, 50000, 50500, 49500, 50000, 51000, 49000, 50000];
    const result = detectDamageWindows(points, 0, 2000);
    expect(result.windows.length).toBe(0);
  });
});
