-- Insight — Temperature Exposure section: archetype seed tables + weather cache.
--
-- exposure_archetypes / archetype_traces hold the EMR diagram-exposure
-- archetypes derived in the profiling analysis (NWR CIF full daily extract,
-- 12 Aug 2026; ATOC EM; permanent STP `P` schedules; diagrams inferred by
-- chaining trips at shared locations with ≤90 min turnaround; tiered
-- full-day/part-day at 600 min running). Seeded from supabase/seed/*.json via
-- scripts/seed-exposure.mjs. The app ships the same data bundled in
-- lib/exposureData.ts, so these tables are the canonical store for other
-- consumers rather than a runtime dependency of the dashboard.

CREATE TABLE IF NOT EXISTS exposure_archetypes (
  id               text PRIMARY KEY,      -- 'weekday|Sheffield - St Pancras|full-day'
  day              text NOT NULL CHECK (day IN ('weekday', 'saturday', 'sunday')),
  service_group    text NOT NULL,
  tier             text NOT NULL CHECK (tier IN ('full-day', 'part-day')),
  n_diagrams       int  NOT NULL,
  avg_running_min  int  NOT NULL,
  avg_dwell_min    int  NOT NULL,
  avg_span_min     int  NOT NULL,
  avg_route_km     int  NOT NULL,
  avg_speed_mph    numeric(5,1) NOT NULL
);

CREATE TABLE IF NOT EXISTS archetype_traces (
  archetype_id  text NOT NULL REFERENCES exposure_archetypes(id) ON DELETE CASCADE,
  minute        int  NOT NULL,            -- minute of day; ≥1440 = past midnight
  lat           numeric(8,4) NOT NULL,
  lon           numeric(8,4) NOT NULL,
  running       boolean NOT NULL,         -- false = dwell
  PRIMARY KEY (archetype_id, minute)
);

CREATE INDEX IF NOT EXISTS archetype_traces_archetype ON archetype_traces (archetype_id);

-- Optional cache of Open-Meteo hourly grid samples so repeated range
-- selections don't refetch. grid_idx indexes the standard 15-point grid
-- defined in lib/exposure.ts (order matters — traces sample nearest-of-these).
CREATE TABLE IF NOT EXISTS weather_cache (
  grid_idx   int         NOT NULL,
  ts         timestamptz NOT NULL,
  temp_c     numeric(4,1),
  cloud_pct  numeric(4,1),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grid_idx, ts)
);

COMMENT ON TABLE exposure_archetypes IS
  'EMR diagram-exposure archetypes (service group × tier × day-type) from the CIF profiling analysis. One-unit-per-diagram assumed; mileage is chained great-circle (~5–10% under true route miles).';
COMMENT ON TABLE archetype_traces IS
  'Per-archetype representative route trace: 15-min timestamped positions flagged running/dwell. Drives the exposure map and all weather sampling.';
COMMENT ON TABLE weather_cache IS
  'Cached Open-Meteo hourly temperature/cloud samples per standard-grid point (see WEATHER_GRID in lib/exposure.ts).';
