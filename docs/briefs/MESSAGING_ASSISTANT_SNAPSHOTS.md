# Brief: Messaging Assistant — performance snapshot capture for Insight

Copy the prompt below into a coding session on the **messaging-assistant** repo.
Insight (this repo) will consume the resulting table from the shared Supabase
project; the read contract is at the bottom.

---

## Prompt

I want the messaging assistant to capture a data snapshot every time the user
presses **Build message**, so the performance data embedded in our tactical
messages becomes queryable by another system (EMCC Insight) via our shared
Supabase project.

**The slot model.** We build tactical messages against four daily time slots:
`0530`, `0900`, `1500` and `2200` (Europe/London local time, DST-aware). The
0530 message is special — it carries **yesterday's end-of-day performance
standing**; 0900/1500/2200 carry the running intraday position. Snapshot rules:

1. When the user presses Build message, determine the **next approaching slot**:
   the first of 05:30 / 09:00 / 15:00 / 22:00 later than now today; if it's
   after 22:00, the next slot is **tomorrow's 0530**.
2. Save the snapshot pinned to that (date, slot). If the user builds again
   before the slot time passes, **replace** the held snapshot (same date+slot)
   so each slot always holds the most recent build. Once the slot time passes,
   later builds pin to the next slot, and so on.
3. Never write anything for a slot whose time has already passed — only the
   next approaching slot is ever written.

**Schema.** Create a migration adding one table to the shared Supabase project
(same one that holds `ma_targets` / `ma_target_periods`; do not enable RLS —
consistent with the rest of the project):

```sql
CREATE TABLE IF NOT EXISTS ma_message_snapshots (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date    date        NOT NULL,             -- the slot's calendar day (local)
  slot             text        NOT NULL CHECK (slot IN ('0530','0900','1500','2200')),
  metrics_for_date date        NOT NULL,             -- the day the metrics describe:
                                                     -- snapshot_date for 0900/1500/2200,
                                                     -- snapshot_date - 1 for 0530 (EOD figures)
  built_at         timestamptz NOT NULL DEFAULT now(),
  build_count      integer     NOT NULL DEFAULT 1,   -- how many builds refreshed this slot
  content          jsonb       NOT NULL,             -- the full structured message content as built
  metrics          jsonb       NOT NULL DEFAULT '[]',-- [{ "name": "...", "value": <number> }, ...]
  target_period_id uuid        REFERENCES ma_target_periods(id),
  UNIQUE (snapshot_date, slot)
);
CREATE INDEX IF NOT EXISTS idx_ma_message_snapshots_date ON ma_message_snapshots (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_ma_message_snapshots_mfd  ON ma_message_snapshots (metrics_for_date);
```

**Implementation requirements:**

- Hook the capture into the existing Build message action — one small utility
  called after a successful build. It must never block or fail message
  building: wrap in try/catch, log quietly on error.
- Slot resolution must use Europe/London wall-clock time (handle BST/GMT
  correctly — don't do raw UTC hour math).
- Write with a single **upsert on `(snapshot_date, slot)`** that replaces
  `content` / `metrics` / `built_at`, sets `metrics_for_date`, links
  `target_period_id` to the active `ma_target_periods` row, and increments
  `build_count` (fetch-then-upsert or an RPC — either is fine; a lost
  increment under a race is acceptable, the content replacement is what
  matters).
- `metrics` must contain one entry per key performance metric in the message,
  with **`name` matching `ma_targets.name` exactly** (currently: `Route T3 %`,
  `EMR T3 %`, `EMR Can %`, `GTR T3 %`, `XC T3 %`) so consumers can join to the
  targets in force, and numeric `value` (strip `%` signs). Include any extra
  metrics the message carries under their natural names — additive is fine.
- `content` is the full structured message data (whatever internal shape the
  builder already has — sections, free text, figures). Don't flatten it to a
  string if structure exists.
- Add a subtle confirmation in the UI after capture (e.g. a toast or footnote:
  "snapshot saved · 0900 slot") — nothing intrusive.
- Backstop: if a slot's snapshot already exists and a build happens *exactly*
  at the boundary, prefer the later slot (strictly `>` comparison on the slot
  time).

**Acceptance checks:**

1. Build at 07:00 → row `(today, '0900')`. Build again 08:30 → same row
   replaced, `build_count` 2. Build at 09:30 → new row `(today, '1500')`.
2. Build at 23:00 → row `(tomorrow, '0530')` with
   `metrics_for_date = today` … wait — careful: the 0530 message describes
   **the day before the 0530 slot**, i.e. `metrics_for_date = snapshot_date - 1`.
   With snapshot_date = tomorrow, `metrics_for_date` = today. Verify this is
   what the code produces.
3. `select * from ma_message_snapshots order by snapshot_date, slot` reads
   naturally: one row per slot per day, latest build wins.
4. Message building still succeeds when Supabase is unreachable.

---

## Read contract (Insight side — for reference)

- **Final standing for day D**: the row with `slot = '0530'` and
  `metrics_for_date = D` (i.e. `snapshot_date = D + 1`). Fall back to the
  latest tactical slot of day D (`2200`, then `1500`, then `0900`) when the
  0530 row hasn't been captured.
- **Intraday ticker for day D**: rows with `snapshot_date = D` and slot in
  `('0900','1500','2200')`, ordered by slot.
- **Targets in force**: join `metrics[].name` → `ma_targets.name` within the
  `target_period_id`'s period (target / amber / dir columns).

Once data is flowing, Insight will add a Performance panel: daily standing
RAG'd against target/amber, period-to-date trajectory with projection to
period end, and incident-vs-performance overlay for review prioritisation.
