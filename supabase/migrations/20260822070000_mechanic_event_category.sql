-- Sin esto, el front no puede distinguir "0 golpeados" (raid-damage/soak,
-- dato real) de "0" como código de "nadie lo interrumpió" (interrupt,
-- players_hit reutilizado como 0/1) — mismo campo, semántica distinta según
-- la categoría de la mecánica.
alter table pull_mechanic_events
  add column if not exists category text;
comment on column pull_mechanic_events.category is 'Copiado de boss_mechanics_candidates.category en el momento de clasificar (igual que description) — para que el front sepa cómo leer players_hit/outcome sin tener que volver a consultar el manifiesto.';
