# DLog2 Patches — Capture Extended Fields for Insight

The Insight analytics platform reads from the same Supabase that DLog2 writes to.
For the new analytics views to populate, DLog2 needs to capture and store a few
extra fields that already exist in the raw CCIL but are currently discarded.

These patches are **additive**. The PDF output is untouched, RLS is untouched,
and existing rows continue to work — new columns are simply nullable until the
next time a report is uploaded.

Apply order:

1. Run the SQL migration `supabase/migrations/003_extend_incident_capture.sql`
   against your Supabase project (SQL Editor or `supabase db push`).
2. Apply the parser patch (`patches/01-ccilParser.patch.md`) to
   `lib/ccilParser.ts` — captures the extra fields off the raw CCIL.
3. Apply the supabase client patch (`patches/02-supabaseClient.patch.md`) to
   `lib/supabaseClient.ts` — writes the extra fields into the new columns.
4. Apply the types patch (`patches/03-types.patch.md`) to `lib/types.ts` — adds
   the new optional fields to the `Incident` interface.
5. Redeploy DLog2. From now on every uploaded log populates the new columns.

Historic rows can be left as-is — Insight gracefully handles NULLs and the
analytics windows are typically rolling, so historic gaps disappear over time.

## Field reference (what gets captured now)

| Column | Source in raw log | Why analytics needs it |
|---|---|---|
| `incident_type_code` | First cell on the type row, e.g. `05C` | CCIL-native classification, more granular than category |
| `incident_type_label` | Same row, full label e.g. `Track Circuit Failure` | Display label without the code prefix |
| `line` | Second row of type block, e.g. `Down Fast` | Direction analytics, repeat fault location |
| `fault_number` | Fault Number cell | Repeat-asset failure detection |
| `possession_ref` | Possession Ref cell | Engineering possession correlation |
| `action_code` | Raw `Action:` cell, e.g. `NJ BK AW LH` | MOM/responder workload |
| `responder_initials` | Parsed `action_code` split on whitespace | Per-MOM workload |
| `advised_time` / `initial_resp_time` / `arrived_at_time` / `nwr_time` | Times row | Derived response metrics |
| `mins_to_advised` / `mins_to_response` / `mins_to_arrival` | Derived | Alert/response performance |
| `incident_duration` | `nwr_time` − `incident_start` | Headline SLA: how long was the railway impacted |
| `train_id` / `train_company` / `train_origin` / `train_destination` / `unit_numbers` | TRAIN block | Operator analytics, rolling-stock fault tracking |
| `trust_ref` / `tda_ref` / `trmc_code` / `fts_div_count` | Stats row | Delay attribution linkage |
| `event_count` | Length of `events[]` | Incident complexity proxy |
| `has_files` | `Incident Has Files` cell | Highlights cases with photographic/document evidence |
| `hour_of_day` / `day_of_week` | Derived from `incident_start` + `report_date` | Cheap pre-computed pattern keys |
