-- EMCC Insight — MOM dispatch & arrival timestamps on the SNDM review.
-- The single mom_response_time field cannot capture both when a MOM was
-- dispatched and when they arrived on site. These two columns let the Review
-- tab record — and auto-derive from the incident events log — both timings.
-- Nullable; existing review rows stay valid.

ALTER TABLE incident_reviews
  ADD COLUMN IF NOT EXISTS mom_dispatched_time text,   -- HH:MM
  ADD COLUMN IF NOT EXISTS mom_arrived_time    text;   -- HH:MM

COMMENT ON COLUMN incident_reviews.mom_dispatched_time IS
  'Time a MOM was dispatched / first referenced in the incident events log. HH:MM.';
COMMENT ON COLUMN incident_reviews.mom_arrived_time IS
  'Time a MOM arrived on site per the incident events log. HH:MM.';
