-- EMCC Insight — annotations and watchlist
-- Annotations pin free-text notes to a date, location, asset or incident so
-- context ("new possession regime started here") lives alongside the data.
-- Watchlist entries mark a location / asset / fault number to keep an eye
-- on; the Notebook tab surfaces recurrence within the current window.

CREATE TABLE IF NOT EXISTS insight_annotations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text        NOT NULL CHECK (kind IN ('date','location','asset','incident')),
  anchor      text        NOT NULL,   -- ISO date / location name / asset key / incident id
  note        text        NOT NULL,
  author      text,                   -- free-text initials (no auth yet)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insight_annotations_kind_anchor ON insight_annotations (kind, anchor);
CREATE INDEX IF NOT EXISTS idx_insight_annotations_created     ON insight_annotations (created_at DESC);

CREATE TABLE IF NOT EXISTS insight_watchlist (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text        NOT NULL CHECK (kind IN ('location','asset','fault')),
  anchor      text        NOT NULL,   -- location name / "type — location" asset key / fault number
  note        text,
  author      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, anchor)
);

COMMENT ON TABLE insight_annotations IS
  'Free-text notes pinned to dates / locations / assets / incidents. Date annotations render as markers on the Overview trend chart.';
COMMENT ON TABLE insight_watchlist IS
  'Locations / assets / fault numbers being watched. The Notebook tab computes recurrence within the current window per entry.';
