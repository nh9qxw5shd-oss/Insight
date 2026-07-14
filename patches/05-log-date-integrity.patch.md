# Patch 5 — Log-date integrity gates (fixes the "missing Sunday" corruption)

Goal: make it mechanically impossible for DLog2 to file a daily log under a
`report_date` whose 06:00→06:00 period hasn't happened — the failure that
blanked **Sun 21 Jun** and **Sun 12 Jul 2026** in Insight and merged two days'
incidents under one date.

## The incident this fixes

Every daily log is uploaded at ~02:00–04:00 the following morning and must be
stamped with the **previous** day's date. Three times (22 Jun, 23 Jun, 13 Jul
2026) a log was stamped with the **upload** day instead. Consequences each time:

1. The true day (a Sunday, twice) has no `report_date` row → Insight shows a
   blank day.
2. The next night's correctly-dated log collides with the mislabeled row
   (`reports.report_date` is UNIQUE): the header is upserted over, and because
   the incident replace-delete is CCIL-scoped, the two days' incidents
   **interleave under one date** — one day missing, the next day double-counted.

The 8 Jul hardening (`9e6369c`) only *warned* about a today-dated log; at 2am
the warning was ignored. This patch escalates the decisive cases to hard
blocks, enforced at the save boundary so no UI path can bypass them.

## What the patch does

**`lib/supabaseClient.ts` — three gates in `upsertReportData` (replace mode):**

1. **Impossible period** *(never overridable)* — a log dated `D` covers
   `D 06:00 → D+1 06:00` Europe/London; if that period hasn't **started** at
   save time, the date cannot be right. Throws `SaveBlockedError`. This alone
   would have blocked all three historical incidents, and it passes every
   legitimate upload pattern in the database's history (overnight uploads of
   yesterday's log, daytime backfills of older dates).
2. **Row-vote mismatch** *(overridable)* — each incident's CCIL header line
   carries a machine-stamped `DD/MM/YYYY HH:MM`, which the parser now retains
   (`Incident.headerIsoDate`). Freshly-started (non-continuation) incidents
   must fall inside the log's own period, so if ≥60% of them map to a
   different 06:00→06:00 period than the chosen Log Date, the save throws.
   The hand-edited period header can lie; the rows cannot.
3. **Collision guard** *(overridable)* — a re-upload whose CCIL refs overlap
   <25% with what the target date already stores is a *different day's* log,
   not a regeneration. Throws instead of silently interleaving two days.

**`lib/ccilParser.ts`** — retains `headerIsoDate` per incident; adds shared
helpers `periodStartDateOf` (06:00-boundary date mapping), `voteLogDate`
(majority vote over row timestamps), `londonNow` / `currentPeriodStartDate`
(timezone-pinned clock).

**`app/page.tsx`** —
- Roster step: the two decisive conditions (period-not-started; ≥70% row
  disagreement) now show a **red blocker with a one-click "Set Log Date to X"
  button and disable "Continue to Review"**. Advisory ambers remain for the
  softer heuristics.
- Generate step: `SaveBlockedError.overridable` gates an explicit
  "I have verified the Log Date is correct — save anyway" button (gates 2–3
  only; gate 1 can never be overridden).
- Blank logs started before 06:00 now default to the period in progress
  (yesterday), not today.

**`lib/types.ts`** — `Incident.headerIsoDate`, `dateSource: 'rows'` variant.

## How to apply

The full change is the sibling file `05-log-date-integrity.patch` — a
standard git patch of one commit against `main` @ `9e6369c`:

```bash
cd dlog2
git am path/to/05-log-date-integrity.patch
npm run build   # verifies; then redeploy
```

No SQL migration is needed and the PDF output is untouched.

## Note on the data repair (already applied, 14 Jul 2026)

The Supabase data was repaired surgically alongside this patch: a
`2026-07-12` report row was reconstructed, its 23 incidents (CCILs
3300468–3300983, upload of 02:07 13 Jul) re-parented with `day_of_week = 0`,
their 110 `incident_team_members` rows re-dated, leaving `2026-07-13` with its
true 39 incidents. Both days now reconcile header-to-rows, and no date gaps
remain in the table.
