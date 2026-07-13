-- ============================================================================
-- Historic roster backfill: incident_team_members from RosterDash
-- ============================================================================
--
-- Context
-- -------
-- DLog2 only started capturing "who was on" roster data during run capture on
-- 2026-05-12, but Insight holds incidents back to 2025-12-31. This script
-- reconstructs the on-duty crew for 2025-12-31 .. 2026-05-11 from the
-- RosterDash system's database and inserts it into incident_team_members,
-- giving Insight team/workload context across its full incident history.
--
-- Executed on 2026-07-13. Backfilled rows are identifiable by
-- report_date < '2026-05-12'.
--
-- Method
-- ------
-- Step 1 runs against the ROSTERDASH database and reproduces its "Today on
-- duty" extraction (index.html refreshTodayDuty) plus behaviours observed in
-- DLog2's own captured data (validated against the 2026-05-12..2026-07-13
-- overlap where both systems hold data; ~75% of date/shift/role slots match
-- exactly and ~85% of person-rows are reproduced — the residual is manual
-- adjustment made by controllers at capture time, which cannot be derived
-- from roster data):
--
--   * weeks resolved by week_ending Saturday; status published > draft > planner
--   * the week's roster is read from the roster_week_revisions snapshot that
--     was current at 06:00 the morning after the report day (what DLog2 would
--     have seen), falling back to current data
--   * shift classified from the day's cell text:
--       day   = contains 0600-1800 / 0700-1900 / 0630-1830
--       night = contains 1800-0600 / 1830-0630
--   * RD / RDW / RDH cells are skipped; AL / CL / SICK / BO day-tags exclude;
--     approved or pending AL/CL roster_leave_entries exclude
--   * role = section title (Route Control Manager -> RCM, Train Running
--     Controller -> TRC, WH TRC, Incident Controller 1 -> IC, Incident
--     Controller 2 -> IC2, Incident Support Controller -> ISC, SNDM), except
--     an explicit IC1 / IC2 / ISC token in the cell overrides the section
--     (cross-cover, e.g. "IC1 1800-0600" in the IC2 section -> IC)
--   * 'Vacancy' placeholder rows are dropped
--   * a section's uncovered marker (s1 = day, s2 = night) emits an
--     'Uncovered' row when no staff cover that shift
--   * TSE and Hot Weather Cover roles are NOT backfilled — they are manual
--     DLog2 entries with no RosterDash source
--
-- Step 2 runs against the INSIGHT database: each incident in the window is
-- assigned the day crew when its start hour is 06..17, otherwise the night
-- crew (the report day runs 06:00 -> 06:00, so a 00:30 incident on report
-- date D belongs to the night shift that started 18:00 on D — matching how
-- DLog2 records it). hour_of_day falls back to parsing incident_start, which
-- is stored as HH:MM:SS on pre-May imports and was never parsed into
-- hour_of_day.
--
-- ============================================================================
-- STEP 1 — run on the RosterDash database
-- ============================================================================
-- Produces one row per (day, shift, role, name). Loaded into a scratch table
-- public._roster_backfill_staging(day date, shift text, role text, name text)
-- on the Insight database (via REST bulk insert; any transport works).

with days as (
  select d::date as day
  from generate_series('2025-12-31'::date, '2026-05-11'::date, interval '1 day') d
),
dk as (
  select day,
         (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from day)::int + 1] as daykey,
         (day + ((6 - extract(dow from day)::int + 7) % 7))::date as week_sat
  from days
),
wk_ranked as (
  select id, link, week_ending, data,
         row_number() over (
           partition by link, week_ending
           order by case status when 'published' then 1 when 'draft' then 2 else 3 end,
                    promoted_at desc nulls last, created_at desc
         ) as rn
  from roster_weeks
  where link in ('CTRL','SNDM') and status in ('published','draft','planner')
),
wk as (select id, link, week_ending, data from wk_ranked where rn = 1),
src as (
  select dk.day, dk.daykey, w.link,
         coalesce(rv.snapshot->'sections', w.data->'sections') as sections
  from dk
  join wk w on w.week_ending = dk.week_sat
  left join lateral (
    select snapshot from roster_week_revisions r
    where r.week_id = w.id
      and r.created_at < (dk.day::timestamptz + interval '1 day 6 hours')
    order by r.created_at desc limit 1
  ) rv on true
),
secs as (
  select src.day, src.daykey, src.link, s.sec,
    case s.sec->>'title'
      when 'Route Control Manager'        then 'RCM'
      when 'Train Running Controller'     then 'TRC'
      when 'WH TRC'                       then 'WH TRC'
      when 'Incident Controller 1'        then 'IC'
      when 'Incident Controller 2'        then 'IC2'
      when 'Incident Support Controller'  then 'ISC'
      when 'SNDM'                         then 'SNDM'
      else null
    end as role
  from src
  cross join lateral jsonb_array_elements(src.sections) s(sec)
),
leave as (
  select entry_date, staff_name from roster_leave_entries
  where entry_type in ('AL','CL')
    and status in ('AUTO_APPROVED','APPROVED','PENDING')
),
cells as (
  select sc.day, sc.role as section_role,
         r->>'staff_name' as name,
         trim(coalesce(r->'shifts'->>sc.daykey,'')) as cell,
         coalesce(r->'tags'->sc.daykey, '[]'::jsonb) as tags
  from secs sc
  cross join lateral jsonb_array_elements(sc.sec->'rows') r
  where sc.role is not null
    and coalesce(r->>'staff_name','') <> ''
    and r->>'staff_name' <> 'Vacancy'
),
cand as (
  select day, name,
    case
      when cell ~ '(0600-1800|0700-1900|0630-1830)' then 'day'
      when cell ~ '(1800-0600|1830-0630)' then 'night'
      else null
    end as shift,
    case
      when cell ~* '\mISC\M'    then 'ISC'
      when cell ~* '\mIC\s?1\M' then 'IC'
      when cell ~* '\mIC\s?2\M' then 'IC2'
      else section_role
    end as role
  from cells
  where upper(cell) not in ('RD','RDW','RDH')
    and not (tags ?| array['AL','CL','SICK','BO'])
    and not exists (
      select 1 from leave l
      where l.entry_date = cells.day and l.staff_name = cells.name
    )
),
cand_ok as (
  select distinct day, role, shift, name from cand where shift is not null
),
unc as (
  select sc.day, sc.role, sh.shift, 'Uncovered' as name
  from secs sc
  cross join lateral (values
    ('day',   trim(coalesce(sc.sec->'uncovered'->sc.daykey->>'s1',''))),
    ('night', trim(coalesce(sc.sec->'uncovered'->sc.daykey->>'s2','')))
  ) sh(shift, marker)
  where sc.role is not null
    and sh.marker <> ''
    and not exists (
      select 1 from cand_ok c
      where c.day = sc.day and c.role = sc.role and c.shift = sh.shift
    )
)
select * from cand_ok
union all
select day, role, shift, name from unc
order by day, shift, role, name;

-- ============================================================================
-- STEP 2 — run on the Insight database
-- ============================================================================
-- With the step-1 output loaded into public._roster_backfill_staging:

-- insert into public.incident_team_members (incident_id, report_date, name, role, shift)
-- select i.id, i.report_date, s.name, s.role, s.shift
-- from public.incidents i
-- cross join lateral (
--   select case
--     when coalesce(i.hour_of_day,
--                   substring(trim(i.incident_start) from '^(\d{1,2})')::int) between 6 and 17
--     then 'day' else 'night'
--   end as shift
-- ) sh
-- join public._roster_backfill_staging s
--   on s.day = i.report_date and s.shift = sh.shift
-- where i.report_date between '2025-12-31' and '2026-05-11'
--   and not exists (select 1 from public.incident_team_members m where m.incident_id = i.id);
--
-- drop table public._roster_backfill_staging;
--
-- Result on 2026-07-13: 1,597 crew rows extracted across all 132 dates;
-- 21,480 incident_team_members rows inserted covering all 3,483 incidents in
-- the window. Roster coverage now spans 2025-12-31 .. present with no gaps.
