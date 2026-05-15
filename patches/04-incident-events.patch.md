# Patch 4 — Persist the incident EVENTS block

Goal: store the per-incident commentary (the CCIL **EVENTS** block) that the
parser already produces but the writer currently discards. Only `event_count`
— the *length* of the block — was being stored; this persists the events
themselves as queryable `jsonb`.

**Prerequisite:** run `supabase/migrations/009_incident_events.sql` first.

## 1. No parser change

`lib/ccilParser.ts` already parses the EVENTS block into an `events` array on
the returned `Incident` (see patch 1 — `events,` is in the return object).
Each entry is `{ date, time, company, description }`. Nothing to change here.

## 2. `lib/supabaseClient.ts` — one line

In `upsertReportData`, inside the `rows = annotated.map(...)` block from
patch 2, add `events` to the returned row object. Place it next to
`event_count`:

```typescript
      // Extended capture
      incident_type_code:  inc.incidentTypeCode  ?? null,
      // ... unchanged ...
      event_count:         inc.eventCount        ?? null,
      events:              inc.events            ?? null,   // ← add this line
      has_files:           inc.hasFiles          ?? false,
```

`inc.events` is the array of `{ date, time, company, description }` objects the
parser builds; supabase-js serialises it to `jsonb` automatically. No types
change is needed — `events` is an existing field on the base `Incident`
interface, so patch 3 is unaffected.

## 3. Redeploy DLog2

From the next uploaded log onward, every incident row carries its full events
block. Historic rows keep `events = NULL` — the rolling analytics windows mean
the gap ages out over time.

## Querying it

The `idx_incidents_events` GIN index supports containment queries:

```sql
-- Incidents that had a Network Rail event logged
SELECT id, ccil, title FROM incidents WHERE events @> '[{"company":"NR"}]';

-- Pull every event description for one incident
SELECT e->>'time' AS time, e->>'company' AS company, e->>'description' AS note
FROM incidents, jsonb_array_elements(events) AS e
WHERE ccil = 'XXXXX'
ORDER BY 1;
```

For free-text search *inside* the descriptions, see the commented-out
`idx_incidents_events_fts` index in migration `009`.

## Surfacing it in Insight (optional)

Insight does not read this column yet. To display incident commentary in the
dashboard, add `events` to `INCIDENT_COLS` in `lib/queries.ts` and an
`events` field to the `IncidentRow` interface in `lib/types.ts`. Not required
for ingestion — the data is captured and queryable in Supabase regardless.
