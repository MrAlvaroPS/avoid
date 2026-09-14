-- §divine-shield-all-specs (2026-09-11, feedback real + decisión explícita del usuario) — el override de
-- Divine Shield (642, Paladin) solo cubría Protection ("requires Final Stand for normal missable
-- opportunity", IRIS final shadow review 2026-09-05). Verificado en real contra la generación publicada:
-- Pitpally (Protection) salía credit_only, pero Helssipanki/Ssquall (Retribution) y Tetasdivinas (Holy)
-- salían 'normal' (resta si estaba libre y no se usó). Preguntado explícitamente al usuario si Divine Shield
-- debía ser credit_only en las 3 specs o si el scope actual (solo Protection) era el correcto — eligió
-- ampliarlo a las 3. Se añaden Retribution y Holy con el mismo mechanism/opportunityMode que Protection ya
-- tenía; Protection se mantiene sin cambios.
-- defensive_ability_semantic_catalog es una VIEW (cooldown_catalog LEFT JOIN defensive_ability_semantics por
-- catalog_id) — no admite UPDATE directo por tener más de una tabla origen; se actualiza la tabla base real.
update defensive_ability_semantics s
set spec_semantic_profiles = '[
  {
    "spec": "Protection",
    "usageRole": "personal_survival",
    "defensiveIntent": "primary",
    "activationScope": "self",
    "primaryBeneficiary": "self",
    "secondaryPropagation": "none",
    "mechanisms": ["immunity"],
    "opportunityMode": "credit_only",
    "applicability": null,
    "source": "IRIS final shadow review 2026-09-05: Protection Divine Shield requires Final Stand for normal missable opportunity",
    "confidence": "high"
  },
  {
    "spec": "Retribution",
    "usageRole": "personal_survival",
    "defensiveIntent": "primary",
    "activationScope": "self",
    "primaryBeneficiary": "self",
    "secondaryPropagation": "none",
    "mechanisms": ["immunity"],
    "opportunityMode": "credit_only",
    "applicability": null,
    "source": "IRIS 2026-09-11: decisión explícita del usuario tras verificar en real que solo Protection tenía el override — ampliado a las 3 specs, mismo criterio de emergencia/bonus que ya regía para Protection.",
    "confidence": "high"
  },
  {
    "spec": "Holy",
    "usageRole": "personal_survival",
    "defensiveIntent": "primary",
    "activationScope": "self",
    "primaryBeneficiary": "self",
    "secondaryPropagation": "none",
    "mechanisms": ["immunity"],
    "opportunityMode": "credit_only",
    "applicability": null,
    "source": "IRIS 2026-09-11: decisión explícita del usuario tras verificar en real que solo Protection tenía el override — ampliado a las 3 specs, mismo criterio de emergencia/bonus que ya regía para Protection.",
    "confidence": "high"
  }
]'::jsonb,
    reviewed_at = now()
from cooldown_catalog c
where s.catalog_id = c.id
  and c.spell_id = 642
  and c.class = 'Paladin';
