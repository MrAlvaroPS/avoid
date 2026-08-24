-- §bug real encontrado y arreglado a mano el 2026-08-23: la noche del 19 de
-- agosto quedó guardada como DOS reports distintos (dos personas subieron el
-- mismo log con addons distintos) — sin ninguna detección, esto duplicaba
-- CADA pull/muerte/mecánica en todo el pipeline (boss-history, fiabilidad,
-- ofensor repetido, tendencia de jugador). Se limpiaron los datos existentes
-- a mano; esta columna es la detección para que no vuelva a colar en
-- silencio — analyze-report la rellena al crear un report nuevo si encuentra
-- otro YA importado con inicio cercano (±6h) y ≥2 bosses en común. NUNCA
-- bloquea el import (podría ser una segunda sesión real el mismo día) — es
-- un aviso visible para que el RL decida, mismo principio que el resto de
-- la app (nunca decidir en silencio).
alter table reports add column if not exists possible_duplicate_of text;

comment on column reports.possible_duplicate_of is
  'report_code de OTRO report ya importado que parece ser la misma sesión (inicio a ±6h, ≥2 bosses en común) — null = sin sospecha de duplicado. Puramente informativo, no impide nada.';
