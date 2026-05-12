-- incident_team_members
-- Created by Dlog2 to capture which team members were on duty during each incident.
-- Insight reads this table to surface team context alongside incident reviews and
-- provide workload analytics across team members.

create table if not exists public.incident_team_members (
  id          uuid not null default gen_random_uuid(),
  incident_id uuid not null,
  report_date date not null,
  name        text not null,
  role        text not null,
  shift       text not null,
  created_at  timestamp with time zone not null default now(),

  constraint incident_team_members_pkey primary key (id),
  constraint incident_team_members_incident_id_fkey
    foreign key (incident_id) references incidents (id) on delete cascade,
  constraint incident_team_members_shift_check
    check (shift = any (array['day'::text, 'night'::text]))
);

create index if not exists idx_itm_incident_id on public.incident_team_members using btree (incident_id);
create index if not exists idx_itm_report_date on public.incident_team_members using btree (report_date);
create index if not exists idx_itm_name        on public.incident_team_members using btree (name);
create index if not exists idx_itm_role        on public.incident_team_members using btree (role);
