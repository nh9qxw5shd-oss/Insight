-- EMCC Insight — SNDM incident review side-table
-- Stores the additional details senior duty managers capture when reviewing
-- a daily log: incident classification (green/amber/red/black), MOM response
-- timings, recovery targets, stranded-train details, technical conference and
-- ITSR notes, plus optional overrides for CCIL-captured fields (delay totals,
-- title, location, etc.). Original CCIL rows in `incidents` are never mutated
-- — Insight reads the override transparently when one is present.

CREATE TABLE IF NOT EXISTS incident_reviews (
  id                            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id                   uuid          NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
  report_date                   date          NOT NULL,

  -- Audit
  reviewed_by                   text,
  reviewed_at                   timestamptz   NOT NULL DEFAULT now(),
  updated_at                    timestamptz   NOT NULL DEFAULT now(),

  -- Row 1 — Period / week
  period                        text,
  week                          text,

  -- Row 2 — Technical conference / commentary
  technical_conference          text,
  commentary                    text,

  -- Row 3 — Stranded train
  stranded_headcode             text,
  stranded_location             text,
  stranded_time_stranded        text,   -- HH:MM
  stranded_time_moved           text,   -- HH:MM

  -- Row 4 — ITSR / huddle
  itsr                          text,
  time_huddle_held              text,   -- HH:MM

  -- Row 5 — Incident classification (preset)
  incident_classification       text
    CHECK (incident_classification IS NULL
        OR incident_classification IN ('GREEN','AMBER','RED','BLACK')),

  -- Row 6 — MOM response
  mom_response                  text,
  mom_depot                     text,
  mom_response_time             text,   -- HH:MM
  first_50_30min_target_met     text
    CHECK (first_50_30min_target_met IS NULL
        OR first_50_30min_target_met IN ('YES','NO','NA')),

  -- Row 7 — Recovery
  target_recovery_time          text,   -- HH:MM
  actual_recovery_time          text,   -- HH:MM
  time_to_recover_mins          integer,  -- minutes, derived from incident_start → actual_recovery_time

  -- Optional CCIL refinements (overrides — original row stays intact)
  title_override                text,
  location_override             text,
  area_override                 text,
  minutes_delay_override        integer,
  trains_delayed_override       integer,
  cancelled_override            integer,
  part_cancelled_override       integer,

  notes                         text
);

CREATE INDEX IF NOT EXISTS idx_incident_reviews_report_date     ON incident_reviews (report_date);
CREATE INDEX IF NOT EXISTS idx_incident_reviews_incident_id     ON incident_reviews (incident_id);
CREATE INDEX IF NOT EXISTS idx_incident_reviews_classification  ON incident_reviews (incident_classification);

-- Keep updated_at current on every write
CREATE OR REPLACE FUNCTION incident_reviews_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_incident_reviews_touch_updated_at ON incident_reviews;
CREATE TRIGGER trg_incident_reviews_touch_updated_at
  BEFORE UPDATE ON incident_reviews
  FOR EACH ROW EXECUTE FUNCTION incident_reviews_touch_updated_at();

COMMENT ON TABLE incident_reviews IS
  'SNDM review data layered on top of CCIL-captured incidents. One row per incident; all fields optional.';

COMMENT ON COLUMN incident_reviews.incident_classification IS
  'Operational severity: GREEN | AMBER | RED | BLACK. Preset 4-step scale.';

COMMENT ON COLUMN incident_reviews.first_50_30min_target_met IS
  'First-50 30-minute response target: YES | NO | NA.';

COMMENT ON COLUMN incident_reviews.time_to_recover_mins IS
  'Minutes between incident_start and actual_recovery_time; derived on write.';
