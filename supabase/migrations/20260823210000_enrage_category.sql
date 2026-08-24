-- §"nos hace falta la categoría de enrage, he visto que varias habilidades
-- son de enrage y no la podemos clasificar bien" (feedback real): boss/add
-- se enfurece (golpea más fuerte, castea más rápido, o aparece tras un
-- tiempo límite) — no encaja en ninguna de las 9 categorías existentes
-- (no es daño repartido normal, no es posicional, no es responsabilidad de
-- un jugador concreto). Mismo patrón drop+add que las ampliaciones
-- anteriores del enum (20260822080000, 20260822130000) para no perder
-- filas ya escritas.
alter table boss_mechanics_candidates drop constraint if exists boss_mechanics_candidates_category_check;
alter table boss_mechanics_candidates add constraint boss_mechanics_candidates_category_check
  check (category in ('tankbuster','raid-damage','avoidable-ground','debuff-stack','interrupt','soak','spread','healing-absorb','personal-target','enrage'));

alter table boss_mechanics_candidates drop constraint if exists boss_mechanics_candidates_inferred_category_check;
alter table boss_mechanics_candidates add constraint boss_mechanics_candidates_inferred_category_check
  check (inferred_category in ('tankbuster','raid-damage','avoidable-ground','debuff-stack','interrupt','soak','spread','healing-absorb','personal-target','enrage'));
