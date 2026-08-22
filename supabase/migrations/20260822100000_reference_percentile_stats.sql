-- §"cómo está haciendo Avoid comparativamente": comparar contra el kill #1
-- del mundo es un listón injusto/desmotivador — con fightRankings ya
-- vienen hasta 50 kills públicas reales por boss+dificultad (duration +
-- deaths de cada una), así que se guarda un percentil de verdad (mediana,
-- top cuartil) y qué fracción de esas kills fueron "limpias" (0 muertes),
-- no solo la comparación contra el mejor kill absoluto (que se mantiene,
-- son datos complementarios).
alter table boss_reference_stats
  add column if not exists reference_sample_size integer,
  add column if not exists reference_median_duration_ms integer,
  add column if not exists reference_p25_duration_ms integer,
  add column if not exists reference_zero_death_rate numeric;

comment on column boss_reference_stats.reference_sample_size is 'Cuántas kills públicas se usaron para la mediana/percentil (hasta 50, las que devuelva fightRankings).';
comment on column boss_reference_stats.reference_median_duration_ms is 'Mediana de duración de esas kills — comparación más justa que "el mejor del mundo".';
comment on column boss_reference_stats.reference_p25_duration_ms is 'Percentil 25 de duración (el cuartil más rápido) — "el ritmo de las guilds realmente rápidas", sin ser el máximo absoluto.';
comment on column boss_reference_stats.reference_zero_death_rate is 'Fracción (0-1) de esas kills públicas que tuvieron 0 muertes registradas — para contextualizar si "0 muertes" es lo normal en un kill limpio o una rareza incluso para las mejores guilds.';
