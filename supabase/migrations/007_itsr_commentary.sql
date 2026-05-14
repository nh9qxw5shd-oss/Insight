-- EMCC Insight — Add itsr_commentary column to capture the reason an ITSR
-- was not implemented (NO or N/A outcome). Mirrors the existing commentary
-- field used for the technical conference section.

ALTER TABLE incident_reviews
  ADD COLUMN IF NOT EXISTS itsr_commentary text;

COMMENT ON COLUMN incident_reviews.itsr_commentary IS
  'Free-text statement against a NO or N/A ITSR decision.';
