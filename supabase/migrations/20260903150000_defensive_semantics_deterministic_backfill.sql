-- IRIS Defensive Canonicalization v1 · Paso B-1 (backfill determinista)
-- Ver iris-defensive-canonicalization-v1-plan.md §5 (Paso B) y §8.
--
-- Solo se marca semantic_status='verified' donde el hecho es estructural y
-- no depende de investigar la habilidad una por una:
--
--   1) category IN (semi_defensive, external_defensive) — por definición
--      el jugador PUEDE elegir a otro como destinatario (targeting_mode
--      'both'/'ally'/'raid'), lo que ya descalifica la fila del KPI
--      personal (criterio §1 del plan) sin importar el usage_role exacto.
--   2) Dos excepciones nombradas explícitamente en el plan (Bear Form,
--      Death Strike) — fixtures obligatorias (§7), no una suposición.
--
-- La auditoría de las 216 filas mostró que category='personal_defensive'
-- AND targeting_mode='self' (146 filas) mezcla CDs personales reales con
-- lo que en muchos casos parecen talentos/pasivos modificadores de otra
-- habilidad (ej. Refractive Images, Ice Cold — el propio §24 del plan ya
-- cita Ice Cold como "reemplaza/suprime Ice Block", no como defensivo
-- independiente) y con casos build-dependientes (Mirror Image, Fade).
-- Clasificar eso a mano por SQL recrearía el mismo problema que esta
-- migración existe para arreglar — se deja pending a propósito para el
-- Paso B-2 (classify-defensives extendido, investigación real por
-- habilidad, igual que ya hace con category/cooldown/duration hoy).

-- 1) semi_defensive / external_defensive: nunca cuentan como personales.
update defensive_ability_semantics s
set
  usage_role = case
    when c.category = 'external_defensive' and c.targeting_mode = 'raid' then 'raid_defensive'
    when c.category = 'external_defensive' then 'external'
    else 'healer_throughput' -- semi_defensive: heal/protección libremente targeteable
  end,
  activation_scope = case c.targeting_mode
    when 'both' then 'ally_selectable'
    when 'ally' then 'ally_selectable'
    when 'raid' then 'raid'
    else 'unknown'
  end,
  secondary_propagation = 'none',
  mechanisms = case c.survival_type
    when 'mitigation' then array['mitigation']
    when 'absorption' then array['absorption']
    when 'sustain' then array['sustain']
    when 'emergency' then array['effective_health']
    else '{}'
  end::text[],
  -- No cuentan para el KPI personal en absoluto (activation_scope != self
  -- ya las excluye); opportunity_mode=none lo deja explícito.
  opportunity_mode = 'none',
  semantic_status = 'verified',
  confidence = 'inferred', -- derivado de category/targeting_mode/survival_type ya curados, no re-verificado habilidad por habilidad
  source = 'deterministic_backfill_paso_b1',
  reviewed_at = now(),
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and c.category in ('semi_defensive', 'external_defensive');

-- 2) Pre-fill barato (sin marcar verified): un pasivo nunca fabrica una
-- oportunidad, sin importar cuál acabe siendo su usage_role real. Solo
-- toca filas que sigan pending — no pisa nada ya resuelto arriba.
update defensive_ability_semantics s
set
  opportunity_mode = 'none',
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and c.activation_mode = 'passive'
  and s.semantic_status = 'pending';

-- 3) Bear Form — fixture Gusmï (§7 del plan): survival_state, credit_only.
-- Casi siempre disponible; no debe fabricar missed_ready por su mera
-- disponibilidad, pero un uso correcto sí puede resolver un episodio.
update defensive_ability_semantics s
set
  usage_role = 'survival_state',
  activation_scope = 'self',
  secondary_propagation = 'none',
  mechanisms = array['mitigation', 'effective_health'],
  opportunity_mode = 'credit_only',
  semantic_status = 'verified',
  confidence = 'verified',
  source = 'plan_fixture_bear_form',
  reviewed_at = now(),
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and c.class = 'Druid'
  and c.name = 'Bear Form';

-- 4) Death Strike — fixture DK (§1/§5 del plan, "rotational survival"):
-- cura al DK pero se lanza CONTRA un enemigo y es parte de la rotación de
-- recursos. targeting_mode='self' en cooldown_catalog describe a quién
-- BENEFICIA, no contra quién se dirige el cast — activation_scope='enemy'
-- corrige esa conflación para este caso concreto. No personal_survival.
update defensive_ability_semantics s
set
  usage_role = 'rotational_survival',
  activation_scope = 'enemy',
  secondary_propagation = 'none',
  mechanisms = array['sustain'],
  opportunity_mode = 'none',
  semantic_status = 'verified',
  confidence = 'verified',
  source = 'plan_fixture_death_strike',
  reviewed_at = now(),
  updated_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and c.class = 'DeathKnight'
  and c.name = 'Death Strike';

notify pgrst, 'reload schema';
