-- EMCC DLog2 — Persist the per-incident EVENTS block for Insight.
-- The CCIL parser already builds an events array (date, time, company,
-- description) but only event_count (its length) was being stored. This adds
-- the full block as queryable jsonb so incident commentary survives ingestion.
-- Nullable — legacy rows stay valid; populated from the next upload onward.

ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS events jsonb;

-- GIN index for containment / key queries against the events array, e.g.
--   SELECT * FROM incidents WHERE events @> '[{"company":"NR"}]';
--   SELECT * FROM incidents WHERE events @> '[{"company":"BTP"}]';
CREATE INDEX IF NOT EXISTS idx_incidents_events
  ON incidents USING gin (events);

-- Optional — full-text search inside the event descriptions. Uncomment if you
-- want to query the commentary text itself rather than just structured keys:
--
-- CREATE INDEX IF NOT EXISTS idx_incidents_events_fts
--   ON incidents USING gin (
--     to_tsvector('english',
--       coalesce((
--         SELECT string_agg(e->>'description', ' ')
--         FROM jsonb_array_elements(events) AS e
--       ), '')
--     )
--   );

COMMENT ON COLUMN incidents.events IS
  'Per-incident EVENTS block from the raw CCIL log — a JSON array of {date, time, company, description} objects in capture order. event_count remains the pre-computed length of this array.';
