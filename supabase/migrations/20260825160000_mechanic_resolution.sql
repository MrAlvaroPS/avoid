-- Resolución práctica y contrastada de cada mecánica. Se mantiene separada
-- tanto de la descripción del Journal (qué hace) como de expected_response
-- ({type, scope}, contrato interno): este texto explica a los raiders cómo
-- ejecutar la mecánica en este boss+dificultad concreta.
alter table boss_mechanics_candidates
  add column if not exists resolution text,
  add column if not exists resolution_sources jsonb not null default '[]'::jsonb,
  add column if not exists resolution_verified_at timestamptz;

comment on column boss_mechanics_candidates.resolution is
  'Cómo resolver la mecánica en este boss+dificultad, investigado mediante el flujo manual de IA. Solo classify-mechanics lo guarda tras validar dos fuentes independientes.';
comment on column boss_mechanics_candidates.resolution_sources is
  'URLs públicas que respaldan resolution. classify-mechanics exige al menos dos URLs válidas de dominios distintos antes de persistirla.';
comment on column boss_mechanics_candidates.resolution_verified_at is
  'Momento en que classify-mechanics validó y guardó la resolución con sus fuentes.';
