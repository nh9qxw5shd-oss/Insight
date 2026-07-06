-- EMCC Insight — manual Control PMC incident flags
-- Nominates incidents for the weekly Control PMC report. When one or more
-- incidents in the reporting week (a railway week, Sunday → Saturday) are
-- flagged, the report's "Top 5 delay incidents" deep-dive is replaced by the
-- flagged incidents, presented lowest → highest impact.
--
-- The "max 5 flags per railway week" rule is enforced in the app layer
-- (lib/queries.ts addPmcFlag) — railway weeks are derived from the Network
-- Rail period calendar and can't be expressed as a plain column constraint.

CREATE TABLE IF NOT EXISTS incident_pmc_flags (
  incident_id  uuid        PRIMARY KEY REFERENCES incidents(id) ON DELETE CASCADE,
  report_date  date        NOT NULL,
  flagged_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incident_pmc_flags_report_date ON incident_pmc_flags (report_date);

COMMENT ON TABLE incident_pmc_flags IS
  'Manual nominations for the weekly Control PMC report. One row per flagged incident; max 5 per railway week (app-enforced).';

COMMENT ON COLUMN incident_pmc_flags.report_date IS
  'Denormalised from incidents.report_date so per-week flag counts need no join.';
