-- Briefing pins: findings "plucked" from Insight's charts and tables, each a
-- self-contained snapshot (numbers + window + filters + provenance) that the
-- Briefing tab composes into a one-page executive brief. One shared working
-- set — pins are visible to everyone using Insight, like annotations.

create table if not exists insight_briefing_pins (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  kind            text not null,             -- 'kpi' | 'timeline' | 'level-impact' | 'risk-impact' | 'duration' | 'incident'
  title           text not null,             -- plain-English claim; editable in the composer
  comment         text,                      -- optional supporting sentence added in the composer
  source_label    text,                      -- provenance: which tab/view/table the finding came from
  window_from     date,
  window_to       date,
  filters_summary text,                      -- human-readable active-filter description at pin time
  payload         jsonb not null default '{}'::jsonb,   -- kind-specific data snapshot
  position        int not null default 0     -- composer ordering
);

comment on table insight_briefing_pins is
  'Findings pinned from Insight views for the Briefing composer. payload is a self-contained snapshot so the brief renders identically later even if the underlying data window moves on.';

alter table insight_briefing_pins enable row level security;

create policy open_all_briefing_pins on insight_briefing_pins
  for all to anon, authenticated using (true) with check (true);
