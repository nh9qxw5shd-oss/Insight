-- EMCC Insight — railway-calendar alignment for shared performance data
--
-- Replicates lib/railwayCalendar.ts in SQL (P1 W1 = first Sunday on or after
-- 1 April; 13 periods × 4 weeks; P13 absorbs the extra week in 53-week rail
-- years) and stamps every ma_message_snapshots row with the railway year /
-- period / week its metrics belong to — derived from metrics_for_date by a
-- trigger, so the message-builder needs no calendar knowledge and the
-- attribution can never drift from Insight's.
--
-- target_period_name is generated in ma_target_periods.period_name format
-- ("Period 4 26/27") so snapshots join cleanly to the targets in force for
-- the calendar-correct period, regardless of which period the builder had
-- selected in its UI.

CREATE OR REPLACE FUNCTION railway_period_week(d date)
RETURNS TABLE (rail_year int, period int, week int, year_label text)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  y    int := EXTRACT(YEAR FROM d)::int;
  apr1 date;
  p1   date;
  week_index int;
BEGIN
  apr1 := make_date(y, 4, 1);
  p1   := apr1 + ((7 - EXTRACT(DOW FROM apr1)::int) % 7);   -- first Sunday ≥ 1 Apr
  IF d < p1 THEN
    y    := y - 1;
    apr1 := make_date(y, 4, 1);
    p1   := apr1 + ((7 - EXTRACT(DOW FROM apr1)::int) % 7);
  END IF;
  week_index := (d - p1) / 7;                               -- 0-based
  period     := LEAST(13, week_index / 4 + 1);
  week       := week_index - (period - 1) * 4 + 1;          -- P13 may exceed 4 in 53-week years
  rail_year  := y;
  year_label := y::text || '/' || lpad(((y + 1) % 100)::text, 2, '0');
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION railway_period_week(date) IS
  'GB rail period calendar, identical to Insight lib/railwayCalendar.ts. P1W1 starts the first Sunday on or after 1 April.';

ALTER TABLE ma_message_snapshots
  ADD COLUMN IF NOT EXISTS rail_year          int,
  ADD COLUMN IF NOT EXISTS rail_period        int,
  ADD COLUMN IF NOT EXISTS rail_week          int,
  ADD COLUMN IF NOT EXISTS rail_year_label    text,
  ADD COLUMN IF NOT EXISTS target_period_name text;

CREATE OR REPLACE FUNCTION ma_message_snapshots_set_rail()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM railway_period_week(NEW.metrics_for_date);
  NEW.rail_year          := r.rail_year;
  NEW.rail_period        := r.period;
  NEW.rail_week          := r.week;
  NEW.rail_year_label    := r.year_label;
  NEW.target_period_name := 'Period ' || r.period || ' '
                            || lpad((r.rail_year % 100)::text, 2, '0') || '/'
                            || lpad(((r.rail_year + 1) % 100)::text, 2, '0');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ma_message_snapshots_set_rail ON ma_message_snapshots;
CREATE TRIGGER trg_ma_message_snapshots_set_rail
  BEFORE INSERT OR UPDATE ON ma_message_snapshots
  FOR EACH ROW EXECUTE FUNCTION ma_message_snapshots_set_rail();

-- Backfill existing rows (the no-op update fires the trigger).
UPDATE ma_message_snapshots SET metrics_for_date = metrics_for_date;

CREATE INDEX IF NOT EXISTS idx_ma_message_snapshots_rail
  ON ma_message_snapshots (rail_year, rail_period, rail_week);

COMMENT ON COLUMN ma_message_snapshots.target_period_name IS
  'Calendar-derived, matches ma_target_periods.period_name (e.g. "Period 4 26/27") — join here for the targets in force.';
