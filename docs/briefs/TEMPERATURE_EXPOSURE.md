# Temperature Exposure section

Where the fleet lives vs where the heat is. The Exposure tab walks each EMR
diagram archetype's representative route trace against Open-Meteo hourly grid
temperatures for a user-selected window, accumulating running/dwell hours and
mileage into user-definable greater-than temperature bands — then joins
Insight's fault records (headcode prefix → service group) to test whether
extreme-day faults cluster behind accumulated heat exposure.

## Pieces

| Piece | Where |
|---|---|
| Archetypes + route traces + July 2026 reference (bundled) | `lib/exposureData.ts` (generated) |
| Compute engine: grid, weather fetch, banding, headcode join | `lib/exposure.ts` |
| UI (map, tables, trend chart, deep-dive, stat cards) | `app/temperature-exposure-tab.tsx` |
| Source-of-truth analysis JSON | `supabase/seed/*.json` |
| Supabase tables (canonical store for other consumers) | `supabase/migrations/016_temperature_exposure.sql` |
| Regenerator / seeder | `scripts/seed-exposure.mjs` |
| Methodology + findings write-up | `docs/briefs/PHASE1_DIAGRAM_PROFILING_RESULTS.md` |

The dashboard reads the bundled `lib/exposureData.ts` (works in demo mode, no
round-trip); the Supabase tables exist so other consumers can query the same
archetypes. Regenerate both from the JSON at each timetable change (Dec/May):

```
node scripts/seed-exposure.mjs --ts                 # lib/exposureData.ts
node scripts/seed-exposure.mjs --sql <out-dir>      # seed SQL for the tables
SUPABASE_URL=… SUPABASE_KEY=… node scripts/seed-exposure.mjs --post
```

## Provenance

Archetypes derived from the NWR CIF full daily extract (12 Aug 2026), EMR
(ATOC `EM`), permanent STP `P` schedules only; diagrams inferred by chaining
trips at shared locations with ≤90 min turnaround; classified into service
groups by running-time-weighted vote of passenger trips; tiered
full-day/part-day at 600 min running. Mileage = chained great-circle between
coordinate-known calling points (~5–10% under true route miles, consistent
across fleet). One-unit-per-diagram assumed (breaks on disrupted days —
caveat displayed in-app).

## Weather sampling

Open-Meteo, no key, CORS-open, fetched client-side:

- Historical: `archive-api.open-meteo.com/v1/archive` (ERA5/IFS, ~5-day lag)
- Recent/forecast: `api.open-meteo.com/v1/forecast`

One multi-location call per endpooint covers the standard 15-point grid
(`WEATHER_GRID` in `lib/exposure.ts`; index order matters). Trace points
sample the nearest grid point by minimising `(dLat)² + (dLon×0.6)²`. The
fetch extends one day past the window end because six archetype traces run
past midnight.

## Validation

`computeExposure` was validated against the analysis session's
4–17 July 2026 reference output (`JULY_2026_REFERENCE`): 424 values across
all 53 archetypes, ~90% matching exactly to rounding; `days_sampled` matches
everywhere; worst band-hours difference 0.37 h/day. Residual differences (and
peak-temp offsets of 0.3–1.0 °C on a few archetypes) are upstream ERA5 data
revisions since the analysis snapshot — the archive endpoint reproduces the
reference far better than the forecast endpoint (worst 2.13 h), confirming
the algorithm and source selection. Re-run the check by compiling
`lib/exposure.ts` + `lib/exposureData.ts` and diffing `computeExposure` over
the reference window against `JULY_2026_REFERENCE`.

## Fault → archetype mapping

Service group comes from the headcode's two-character prefix
(`HEADCODE_PREFIX_GROUP` in `lib/exposure.ts`), derived empirically from the
classified EMR schedule data. Day-type from the incident date; tier defaults
to full-day (dominant population), falling back to part-day where a group
runs no full-day diagrams on that day-type. Ambiguities: 1B/1D default to
Nottingham–STP (≥96%); 2K is merged into the Lincoln regional bucket
(Lincoln–Peterborough archetype); unmatched prefixes are excluded as
UNCLASSIFIED, never force-fitted. Prefix mappings drift at timetable changes —
regenerate the table from the current CIF extract each time.

Known limitation: mapping is service-group-level, not unit-level, until the
NWR Allocation & Consist feed lands (Phase 2).

## Honesty rules baked into the UI

- Every deep-dive cell/bucket shows its n; cells resting on fewer than 5
  diagram-days are greyed; groups with fewer than 5 faults are flagged thin.
- The section is labelled a PoC pattern-finder, not a significance test.
- When the selected window extends beyond the app-level incident feed, the
  section fetches incidents for its own range directly (`fetchIncidentsForRange`)
  so extreme days outside the app window keep their faults. Without a database
  connection (demo mode) fault panels clip to the loaded feed and say so.
