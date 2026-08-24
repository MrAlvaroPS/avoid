-- §"meter en el dosier de un jugador y en el resumen de toda la noche
-- completa también la consulta de IA... a nivel más detalle, y poder
-- copiar ese informe" (feedback real, 2026-08-24): mismo mecanismo que
-- pull_briefs (generate-pull-brief/manual-pull-brief), dos tablas nuevas
-- para las otras dos combinaciones que ya existen en el resto de la app —
-- jugador × noche y raid × noche — en vez de forzar todo en pull_briefs
-- (que está atado a un pull_id concreto, no a estos dos ámbitos).
--
-- Columna `next_pull_actions` (no `next_actions`): a propósito el mismo
-- nombre que pull_briefs, aunque aquí no sea literalmente "el próximo
-- pull" — así el frontend reutiliza tal cual mapBrief()/LlmPullAnalysis sin
-- una función de mapeo aparte por tabla. El prompt de cada ámbito ya deja
-- claro al LLM qué significa el campo en cada caso.

create table if not exists night_player_briefs (
  id uuid primary key default gen_random_uuid(),
  report_code text not null references reports(code) on delete cascade,
  player_name text not null,
  headline text not null,
  improved jsonb not null default '[]'::jsonb,
  regressed jsonb not null default '[]'::jsonb,
  next_pull_actions jsonb not null default '[]'::jsonb,
  model text not null,
  created_at timestamptz not null default now(),
  unique (report_code, player_name)
);
alter table night_player_briefs enable row level security;
create policy "read all - night_player_briefs" on night_player_briefs for select using (true);

create table if not exists night_briefs (
  id uuid primary key default gen_random_uuid(),
  report_code text not null unique references reports(code) on delete cascade,
  headline text not null,
  improved jsonb not null default '[]'::jsonb,
  regressed jsonb not null default '[]'::jsonb,
  next_pull_actions jsonb not null default '[]'::jsonb,
  model text not null,
  created_at timestamptz not null default now()
);
alter table night_briefs enable row level security;
create policy "read all - night_briefs" on night_briefs for select using (true);
