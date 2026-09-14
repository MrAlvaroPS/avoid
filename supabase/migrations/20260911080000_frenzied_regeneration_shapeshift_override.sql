-- §frenzied-regen-shapeshift-override (2026-09-11, feedback real): "solucionamos que la regeneración
-- frenética al requerir cambio de forma en los druidas balance y restauración, contaría como bonus pero no
-- negativamente (sí en los tanks druida)" — confirmado empíricamente que NUNCA se llegó a escribir en el
-- catálogo real: spec_semantic_profiles estaba vacío para Frenzied Regeneration (22842), opportunity_mode
-- 'normal' (cuenta en contra) uniforme para las 4 specs de Druid, penalizando a Gusmï (Balance) toda la noche
-- por algo que ya se había decidido que no debía penalizar.
--
-- Balance/Feral/Restoration NO están en Forma de Oso por defecto (Balance/Restoration no cambian de forma en
-- combate normalmente; Feral vive en Forma Felina) — usar Frenzied Regeneration exige primero cambiar a Forma
-- de Oso, una fricción real (GCD extra, pierde el estado de su forma activa) que Guardian no paga porque ya
-- está en Forma de Oso la mayoría del combate. Mismo patrón ya en producción para Divine Shield de Paladin
-- Protection (requiere Final Stand) — ver defensive_ability_semantic_catalog, spell_id 642.
-- defensive_ability_semantic_catalog es una VIEW (cooldown_catalog LEFT JOIN
-- defensive_ability_semantics por catalog_id) — no admite UPDATE directo por
-- tener más de una tabla origen; se actualiza la tabla base real por catalog_id.
update defensive_ability_semantics s
set spec_semantic_profiles = '[
  {
    "spec": "Balance",
    "usageRole": "personal_survival",
    "defensiveIntent": "primary",
    "activationScope": "self",
    "primaryBeneficiary": "self",
    "secondaryPropagation": "none",
    "mechanisms": ["sustain"],
    "opportunityMode": "credit_only",
    "applicability": {
      "schools": [],
      "schoolScope": "all",
      "deliveryScopes": ["all"],
      "timingRelation": "after_damage",
      "requiresBlockable": false,
      "requiresDodgeable": false,
      "requiresParryable": false,
      "requiresSourceAffectedBySpell": false,
      "notes": "Autocuración porcentual; no depende de la escuela ni de la fuente del daño ya recibido."
    },
    "source": "IRIS 2026-09-11: Balance no está en Forma de Oso por defecto — usar Frenzied Regeneration exige cambiar de forma primero (fricción real, GCD extra), a diferencia de Guardian.",
    "confidence": "high"
  },
  {
    "spec": "Feral",
    "usageRole": "personal_survival",
    "defensiveIntent": "primary",
    "activationScope": "self",
    "primaryBeneficiary": "self",
    "secondaryPropagation": "none",
    "mechanisms": ["sustain"],
    "opportunityMode": "credit_only",
    "applicability": {
      "schools": [],
      "schoolScope": "all",
      "deliveryScopes": ["all"],
      "timingRelation": "after_damage",
      "requiresBlockable": false,
      "requiresDodgeable": false,
      "requiresParryable": false,
      "requiresSourceAffectedBySpell": false,
      "notes": "Autocuración porcentual; no depende de la escuela ni de la fuente del daño ya recibido."
    },
    "source": "IRIS 2026-09-11: Feral vive en Forma Felina, no en Forma de Oso — misma fricción real de cambio de forma que Balance/Restoration, a diferencia de Guardian.",
    "confidence": "high"
  },
  {
    "spec": "Restoration",
    "usageRole": "personal_survival",
    "defensiveIntent": "primary",
    "activationScope": "self",
    "primaryBeneficiary": "self",
    "secondaryPropagation": "none",
    "mechanisms": ["sustain"],
    "opportunityMode": "credit_only",
    "applicability": {
      "schools": [],
      "schoolScope": "all",
      "deliveryScopes": ["all"],
      "timingRelation": "after_damage",
      "requiresBlockable": false,
      "requiresDodgeable": false,
      "requiresParryable": false,
      "requiresSourceAffectedBySpell": false,
      "notes": "Autocuración porcentual; no depende de la escuela ni de la fuente del daño ya recibido."
    },
    "source": "IRIS 2026-09-11: Restoration no está en Forma de Oso por defecto — usar Frenzied Regeneration exige cambiar de forma primero (fricción real, GCD extra), a diferencia de Guardian.",
    "confidence": "high"
  }
]'::jsonb,
    reviewed_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and c.spell_id = 22842
  and c.class = 'Druid';
