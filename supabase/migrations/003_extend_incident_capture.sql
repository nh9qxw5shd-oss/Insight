-- EMCC DLog2 — Extended capture for analytics
-- Adds fields needed by the EMCC Insight analytics platform.
-- All columns are nullable so legacy rows continue to work. Run after 002.

ALTER TABLE incidents
  -- Granular CCIL-native classification (preserves the "05C", "07b" prefix codes)
  ADD COLUMN IF NOT EXISTS incident_type_code  text,
  ADD COLUMN IF NOT EXISTS incident_type_label text,

  -- Direction / line of route (e.g. "Down Fast", "Up Hendon")
  ADD COLUMN IF NOT EXISTS line                text,

  -- Asset / engineering links
  ADD COLUMN IF NOT EXISTS fault_number        text,
  ADD COLUMN IF NOT EXISTS possession_ref      text,
  ADD COLUMN IF NOT EXISTS btp_ref             text,
  ADD COLUMN IF NOT EXISTS third_party_ref     text,

  -- Action handler — the MOM/responder initials block (e.g. "NJ BK AW LH")
  ADD COLUMN IF NOT EXISTS action_code         text,
  ADD COLUMN IF NOT EXISTS responder_initials  text[],

  -- Response timing (HH:MM strings as captured; minutes_* are derived)
  ADD COLUMN IF NOT EXISTS advised_time        text,
  ADD COLUMN IF NOT EXISTS initial_resp_time   text,
  ADD COLUMN IF NOT EXISTS arrived_at_time     text,
  ADD COLUMN IF NOT EXISTS nwr_time            text,

  -- Derived response/duration metrics (minutes; null when source missing)
  ADD COLUMN IF NOT EXISTS mins_to_advised     integer,
  ADD COLUMN IF NOT EXISTS mins_to_response    integer,
  ADD COLUMN IF NOT EXISTS mins_to_arrival     integer,
  ADD COLUMN IF NOT EXISTS incident_duration   integer,

  -- Train / rolling-stock detail
  ADD COLUMN IF NOT EXISTS train_id            text,
  ADD COLUMN IF NOT EXISTS train_company       text,
  ADD COLUMN IF NOT EXISTS train_origin        text,
  ADD COLUMN IF NOT EXISTS train_destination   text,
  ADD COLUMN IF NOT EXISTS unit_numbers        text[],

  -- TRUST / TRMC / TDA references (delay attribution)
  ADD COLUMN IF NOT EXISTS trust_ref           text,
  ADD COLUMN IF NOT EXISTS tda_ref             text,
  ADD COLUMN IF NOT EXISTS trmc_code           text,
  ADD COLUMN IF NOT EXISTS fts_div_count       integer,

  -- Complexity / files
  ADD COLUMN IF NOT EXISTS event_count         integer,
  ADD COLUMN IF NOT EXISTS has_files           boolean DEFAULT false,

  -- Derived analytics helpers (cheap to maintain in writer, expensive to compute on read)
  ADD COLUMN IF NOT EXISTS hour_of_day         smallint,   -- 0..23
  ADD COLUMN IF NOT EXISTS day_of_week         smallint;   -- 0=Sun .. 6=Sat (matches JS getDay)

-- ── Indexes to support the analytics queries ─────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_incidents_area           ON incidents (area);
CREATE INDEX IF NOT EXISTS idx_incidents_line           ON incidents (line);
CREATE INDEX IF NOT EXISTS idx_incidents_type_code      ON incidents (incident_type_code);
CREATE INDEX IF NOT EXISTS idx_incidents_fault_number   ON incidents (fault_number);
CREATE INDEX IF NOT EXISTS idx_incidents_train_company  ON incidents (train_company);
CREATE INDEX IF NOT EXISTS idx_incidents_severity       ON incidents (severity);
CREATE INDEX IF NOT EXISTS idx_incidents_hour_of_day    ON incidents (hour_of_day);
CREATE INDEX IF NOT EXISTS idx_incidents_day_of_week    ON incidents (day_of_week);

-- ── Comments ────────────────────────────────────────────────────────────────

COMMENT ON COLUMN incidents.incident_type_code IS
  'CCIL native classification prefix, e.g. "05C", "07b", "23A". More granular than category.';

COMMENT ON COLUMN incidents.action_code IS
  'Raw action field from CCIL — typically a space-separated list of MOM/responder initials.';

COMMENT ON COLUMN incidents.responder_initials IS
  'Parsed individual responder initials from action_code, normalised to upper-case.';

COMMENT ON COLUMN incidents.incident_duration IS
  'Minutes between incident_start and nwr_time (clamped to >= 0). NULL when NWR not yet recorded.';

COMMENT ON COLUMN incidents.mins_to_advised IS
  'Minutes from incident_start to advised_time. Negative values clamped to 0.';

-- ── Read-only analytics role (recommended) ──────────────────────────────────
-- Create a separate Supabase role for the Insight platform with read-only
-- access. Run separately if you want analytics workloads isolated from writes.
--
-- CREATE ROLE insight_reader NOLOGIN;
-- GRANT USAGE ON SCHEMA public TO insight_reader;
-- GRANT SELECT ON reports, incidents TO insight_reader;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO insight_reader;
--
-- Then create a Supabase API key restricted to this role for the Insight app.
