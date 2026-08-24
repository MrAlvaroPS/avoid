-- §"falta la clasificación de 'mecánica de boss'... cuando eres target y te
-- toca hacer algo sí o sí, sin más": categoría nueva, distinta de tankbuster
-- (que golpea siempre al ROL tank) — un jugador cualquiera es seleccionado
-- individualmente por el boss, sin que sea por posición (avoidable-ground)
-- ni por rol (tankbuster). Mismo patrón drop+add que
-- 20260822080000_derived_metrics_and_category_inference.sql para ampliar el
-- enum sin perder filas ya escritas.

alter table boss_mechanics_candidates drop constraint if exists boss_mechanics_candidates_category_check;
alter table boss_mechanics_candidates add constraint boss_mechanics_candidates_category_check
  check (category in ('tankbuster','raid-damage','avoidable-ground','debuff-stack','interrupt','soak','spread','healing-absorb','personal-target'));

alter table boss_mechanics_candidates drop constraint if exists boss_mechanics_candidates_inferred_category_check;
alter table boss_mechanics_candidates add constraint boss_mechanics_candidates_inferred_category_check
  check (inferred_category in ('tankbuster','raid-damage','avoidable-ground','debuff-stack','interrupt','soak','spread','healing-absorb','personal-target'));
