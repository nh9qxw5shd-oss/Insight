# EMCC Insight — Strategic Operations Analytics

**Network Rail · East Midlands Control Centre**
Companion analytics platform to the EMCC Daily Log Generator (DLog2).
Reads the same Supabase project; runs as a separate Vercel deployment.

---

## What it is

Where DLog2 captures and reports the daily log, **Insight** is the long-view
sibling — a strategic dashboard for senior managers reviewing trends, patterns
and recurring issues across the route. It does not write to Supabase: it
consumes the data DLog2 already stores.

Seven views, all driven by a shared filter set:

| View | What it answers |
|---|---|
| **Overview** | Headline KPIs, daily activity, category mix, top hotspots, repeat-fault assets |
| **Safety** | SPADs, TPWS, near-miss, person-struck — current vs prior window radar comparison |
| **Performance** | Delay minutes, cancellations, response-time distribution, location concentration |
| **Geography** | Area performance, hotspot leaderboard, location × area treemap |
| **Patterns** | Day × hour heatmap, hour-of-day profile, weekday profile, category-by-time |
| **Assets** | Asset-failure mix, repeat-fault ranking — engineering review priority |
| **Operators** | Per-TOC/FOC delay, MOM/responder workload distribution |

Filter bar applies globally:

- **Time window** — 7 d / 30 d / 90 d / 6 m / 1 y, or custom date range
- **Areas** (Derby, Leicester, Lincoln, Bedford, …)
- **Categories** (multi-select across all 21 incident classes)
- **Severity** (CRITICAL / HIGH / MEDIUM / LOW / INFO)
- **Search** (title, location, fault number, train ID, CCIL ref)
- **Chart type** swap on every trend chart (line / area / bar)
- **Distribution type** swap on every breakdown (donut / bar / treemap)

KPI cards show **% delta vs the previous equivalent window** so movement is
always contextual rather than absolute.

---

## Architecture

| Layer | Tech |
|---|---|
| Framework | Next.js 14 (App Router, client-first) |
| Hosting | Vercel (free tier, lhr1 region) |
| Data | Supabase (read-only against DLog2's project) |
| Charts | Recharts |
| Icons | Lucide |
| Animation | Framer Motion + custom CSS keyframes |
| Styling | Tailwind, `Fraunces` display + `Inter Tight` body + `JetBrains Mono` |

**No server actions.** The dashboard is a single client-side page; all
aggregation runs in the browser. At ~5–15 incidents/day × 365 days the result
set is well under 10k rows, which Supabase returns in one query and JS
processes in milliseconds. If volumes grow, push aggregations into Supabase
RPCs (TODO section below).

**Demo mode auto-engages** when `NEXT_PUBLIC_SUPABASE_*` env vars are missing,
the query fails, or the result set is empty. The dashboard generates a
deterministic synthetic dataset so the UI never displays as a void.

---

## Deployment

### 1. Apply the schema migration

In your DLog2 Supabase project, run `supabase/migrations/003_extend_incident_capture.sql`
(SQL Editor or `supabase db push`). This adds ~25 nullable analytics columns
to the `incidents` table — no existing data is altered.

### 2. Apply the DLog2 patches

So new uploads populate the new columns. See `patches/README.md`. Three small
edits to `lib/ccilParser.ts`, `lib/supabaseClient.ts`, `lib/types.ts`. The PDF
output and the existing UI are untouched.

### 3. Create a read-only Supabase role *(recommended)*

Insight should not be able to write or delete. The bottom of migration 003
includes the SQL — uncomment, run, and create a new Supabase API key bound to
that role. Use that key for `NEXT_PUBLIC_SUPABASE_ANON_KEY` below.

### 4. Deploy this repo

```bash
# Clone / unzip this directory
cd emcc-insight
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_ORG/emcc-insight.git
git push -u origin main
```

Then on Vercel:

- New Project → import the repo → framework auto-detects as Next.js
- Add environment variables:
  - `NEXT_PUBLIC_SUPABASE_URL` (same project as DLog2)
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the read-only key from step 3)
- Deploy

### 5. Lock down access

This is OFFICIAL-SENSITIVE. Add Vercel Password Protection (Pro plan) or put
Cloudflare Access in front of the deployment URL.

---

## Local dev

```bash
npm install
cp .env.example .env.local      # populate with your Supabase URL + key
npm run dev                     # → http://localhost:3000
```

Without env vars set, the app boots in demo mode against synthetic data, so
you can develop UI without a Supabase project.

---

## File structure

```
emcc-insight/
├── app/
│   ├── globals.css                ← design system, animations, tokens
│   ├── layout.tsx
│   └── page.tsx                   ← entire dashboard (tabs, charts, filters)
├── lib/
│   ├── types.ts                   ← shared types + category/severity config
│   ├── supabase.ts                ← read-only client singleton
│   ├── queries.ts                 ← fetch + all aggregation derivers
│   └── syntheticData.ts           ← demo-mode dataset generator
├── supabase/
│   └── migrations/
│       └── 003_extend_incident_capture.sql
├── patches/                       ← changes to apply to DLog2
│   ├── README.md
│   ├── 01-ccilParser.patch.md
│   ├── 02-supabaseClient.patch.md
│   └── 03-types.patch.md
├── tailwind.config.js
├── tsconfig.json
├── next.config.js
├── vercel.json
├── package.json
└── README.md
```

---

## Design notes

The aesthetic is intentionally not generic-SaaS. It's an editorial / command-centre
hybrid — Fraunces display serif for hero numbers, JetBrains Mono for labels,
Inter Tight for body. Network Rail orange (`#E05206`) is treated as a single
accent: present at every focal point, absent everywhere else, so attention
flows. Backgrounds are layered (radial glow + grid + panels) rather than
flat. Tick-corner brackets on key cards reference instrumentation/control
displays, which is the metaphor — operators reading instruments.

Animations are subtle by design: a single staggered fade-up on tab change,
hover scale on heatmap cells, draw-in on chart strokes. No bouncy transitions,
no parallax, no cursor effects.

---

## Tuning / extending

**Adding a chart type** — Recharts components are co-located in `app/page.tsx`.
Trend charts go through `<TrendChart>`, distributions through
`<CategoryDistribution>`. Each accepts a `kind` prop you can extend.

**Performance at scale** — Once you cross ~50 k rows in window, replace the
client-side derivers in `lib/queries.ts` with Supabase RPCs:

```sql
CREATE FUNCTION public.insight_trend(p_from date, p_to date)
RETURNS TABLE(date date, incidents int, delay_mins int, safety_critical int)
LANGUAGE sql STABLE AS $$
  SELECT report_date, count(*) FILTER (WHERE NOT is_continuation),
         sum(CASE WHEN is_continuation THEN coalesce(delay_delta,0) ELSE minutes_delay END),
         count(*) FILTER (WHERE NOT is_continuation
           AND category IN ('FATALITY','PERSON_STRUCK','SPAD','TPWS','NEAR_MISS','BRIDGE_STRIKE','LEVEL_CROSSING','IRREGULAR_WORKING','FIRE','DERAILMENT'))
  FROM incidents
  WHERE report_date BETWEEN p_from AND p_to
  GROUP BY report_date ORDER BY report_date;
$$;
```

Then call via `sb.rpc('insight_trend', { p_from, p_to })` in `lib/queries.ts`.

**Tuning the visual palette** — edit `:root` in `app/globals.css`. All
component colours route through CSS variables; nothing is hard-coded.

---

## Security

- Read-only Supabase role recommended (see migration 003 footer)
- `NEXT_PUBLIC_*` env vars are exposed to the browser by design — fine for
  read-only anon keys, never use a service-role key here
- All data stays within the user's browser session — Insight performs no
  server-side processing and writes nothing back
- Mark the Vercel deployment OFFICIAL-SENSITIVE and restrict access
