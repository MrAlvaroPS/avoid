-- §"estaría bien meter un botón o icono de información que te venga lo que
-- dice en 'notas' al preguntarle a una IA, ya que parece bastante útil"
-- (feedback real): classify-mechanics ya generaba confidence/sources/notes
-- por mecánica pero los descartaba tras aplicar la categoría — se guardan
-- para poder mostrarlos en Ajustes junto a cada mecánica clasificada así.
alter table boss_mechanics_candidates add column if not exists ai_classification jsonb;

comment on column boss_mechanics_candidates.ai_classification is
  '{confidence, sources, notes, classifiedAt} — solo presente en mecánicas clasificadas vía el flujo de prompt de IA (classify-mechanics, action=submit). null = clasificada a mano o nunca clasificada.';
