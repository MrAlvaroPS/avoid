-- §pressure-detection-diagnostics follow-up (2026-09-10) — el factor de
-- detectDamageWindows() (2.5x mediana propia) deja el pull en 0 ventanas
-- para el 49-56% de healers/melee/ranged (vs 23% en tanks), en un informe
-- donde el raid entero recibe daño casi continuo (94-98% de buckets>0).
-- Antes de proponer un factor concreto hace falta el recuento real de
-- ventanas a varios factores candidatos — no solo si el pico llega al
-- umbral — para comprobar que bajarlo no reintroduce el falso-positivo de
-- tank que esta fórmula relativa ya arregló una vez.
alter table canonical_defensive_pressure_diagnostics
  add column if not exists window_count_factor_1_5 integer,
  add column if not exists window_count_factor_1_7 integer,
  add column if not exists window_count_factor_2_0 integer,
  add column if not exists window_count_factor_2_2 integer;
