-- §"si marco el primer boss que solo tiene 2 pulls, debajo me sale #3 y #4"
-- (feedback real): efecto secundario de la limpieza del report duplicado
-- (20260823 antes) — pull_number se asigna como COUNT(pulls de ese
-- boss+dificultad)+1 EN EL MOMENTO de insertar (analyze-report), nunca se
-- renumera después. Al borrar los pulls del report duplicado, los que
-- sobrevivieron se quedaron con los números que les tocó cuando el
-- duplicado todavía existía (huecos: #3/#4 en vez de #1/#2). Reparación de
-- datos única: renumera 1..N por boss+dificultad en orden cronológico real.
--
-- OJO — el propio esquema de numeración (COUNT en insert, nunca revisado)
-- sigue siendo frágil ante cualquier borrado futuro de un pull, no solo
-- ante duplicados de report. Queda documentado aquí; una migración real a
-- "pull_number calculado, no guardado" (ROW_NUMBER() OVER en una vista) es
-- el arreglo de fondo si esto se repite.
with ranked as (
  select id, row_number() over (partition by boss_id, difficulty order by closed_at asc, fight_id asc) as rn
  from pulls
)
update pulls p
set pull_number = r.rn
from ranked r
where p.id = r.id and p.pull_number <> r.rn;
