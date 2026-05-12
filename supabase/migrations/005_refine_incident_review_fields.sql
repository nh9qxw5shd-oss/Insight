-- EMCC Insight — Refine the SNDM review schema after first iteration.
-- Period/week are now derived from the report date via the railway calendar
-- (lib/railwayCalendar.ts) so we drop the stored columns. Several free-text
-- fields become Yes/No/N/A enums with optional follow-up detail, and the
-- stranded-train singleton fields collapse into a JSONB array so an SNDM
-- can record multiple trains against one incident. MOM depot becomes a
-- preset enum (the EMCC depot list).

-- Drop columns superseded by the new model. Safe because the table is fresh.
ALTER TABLE incident_reviews DROP COLUMN IF EXISTS period;
ALTER TABLE incident_reviews DROP COLUMN IF EXISTS week;
ALTER TABLE incident_reviews DROP COLUMN IF EXISTS technical_conference;
ALTER TABLE incident_reviews DROP COLUMN IF EXISTS stranded_headcode;
ALTER TABLE incident_reviews DROP COLUMN IF EXISTS stranded_location;
ALTER TABLE incident_reviews DROP COLUMN IF EXISTS stranded_time_stranded;
ALTER TABLE incident_reviews DROP COLUMN IF EXISTS stranded_time_moved;
ALTER TABLE incident_reviews DROP COLUMN IF EXISTS itsr;
ALTER TABLE incident_reviews DROP COLUMN IF EXISTS mom_response;

-- Yes / No / N/A outcome enums for the four conditional sections
ALTER TABLE incident_reviews
  ADD COLUMN IF NOT EXISTS technical_conference_outcome text
    CHECK (technical_conference_outcome IS NULL
        OR technical_conference_outcome IN ('YES','NO','NA')),
  ADD COLUMN IF NOT EXISTS stranded_trains_occurred text
    CHECK (stranded_trains_occurred IS NULL
        OR stranded_trains_occurred IN ('YES','NO','NA')),
  ADD COLUMN IF NOT EXISTS itsr_required text
    CHECK (itsr_required IS NULL
        OR itsr_required IN ('YES','NO','NA')),
  ADD COLUMN IF NOT EXISTS mom_responded text
    CHECK (mom_responded IS NULL
        OR mom_responded IN ('YES','NO','NA'));

-- Stranded-trains follow-up: array of { headcode, location, time_stranded, time_moved }
ALTER TABLE incident_reviews
  ADD COLUMN IF NOT EXISTS stranded_trains jsonb;

-- MOM depot — restrict to the EMCC depot list
ALTER TABLE incident_reviews
  DROP CONSTRAINT IF EXISTS incident_reviews_mom_depot_check;
ALTER TABLE incident_reviews
  ADD CONSTRAINT incident_reviews_mom_depot_check
  CHECK (mom_depot IS NULL OR mom_depot IN
    ('WEST_HAMPSTEAD','ELSTREE','BEDFORD','KETTERING','LEICESTER',
     'DERBY','NOTTINGHAM','CHESTERFIELD','LINCOLN'));

COMMENT ON COLUMN incident_reviews.technical_conference_outcome IS
  'Was a technical conference held? YES | NO | NA. Commentary explains a YES/NO decision.';
COMMENT ON COLUMN incident_reviews.commentary IS
  'Free-text statement against the technical conference YES/NO decision.';
COMMENT ON COLUMN incident_reviews.stranded_trains_occurred IS
  'Did stranded-train events occur? YES | NO | NA. When YES, populate stranded_trains array.';
COMMENT ON COLUMN incident_reviews.stranded_trains IS
  'JSONB array of stranded-train detail objects: {headcode, location, time_stranded, time_moved}.';
COMMENT ON COLUMN incident_reviews.itsr_required IS
  'Was an ITSR required? YES | NO | NA. When YES, time_huddle_held captures the huddle time.';
COMMENT ON COLUMN incident_reviews.mom_responded IS
  'Did a MOM respond? YES | NO | NA. When YES, depot/response_time/first-50 capture the response.';
