# EMCC Insight — User Guide

**Network Rail · East Midlands Control Centre · Strategic Operations Analytics**

This guide explains how to get value out of Insight day to day. It focuses on
three things senior managers and SNDMs ask about most:

1. [Using the data filters](#1-using-the-data-filters)
2. [Identifying trends and links](#2-identifying-trends-and-links)
3. [Using the Review section (for SNDMs)](#3-using-the-review-section-for-sndms)

A short [orientation](#orientation) section comes first so the rest makes sense.

---

## Orientation

Insight is a read-only strategic dashboard. It reads the same incident data that
DLog2 captures from the daily CCIL log and presents it as long-view trend,
pattern and performance intelligence. **Insight never changes incident data** —
the one exception is the Review section, which writes optional review records to
a separate side-table (it still leaves the original CCIL row untouched).

### The screen layout

- **Header** (top) — the title, the **time-window selector**, the **Filters**
  button, **Export**, **Refresh**, light/dark toggle, and a **Live / Demo Data**
  indicator.
- **Tab bar** — fourteen views. Every analytics tab is driven by the *same*
  shared filter set, so a filter you set once applies everywhere.
- **Content area** — the active tab.

### Live vs Demo Data

Look at the indicator on the top right:

- **Live** (green dot) — you are looking at real incident data from Supabase.
- **Demo Data** (amber dot) — Insight could not reach Supabase, or the query
  returned nothing, so it has generated a synthetic dataset so the screen is not
  blank. **Demo data is not real and Review edits will not save.** If you expect
  live data and see Demo, press **Refresh**, and widen the time window.

---

## 1. Using the data filters

Filters are the core of Insight. Every chart, KPI and table on every analytics
tab responds to the same filter set, so once you have framed the question with
filters, all fourteen views answer it consistently.

There are two places filters live: the **header** (time window) and the
**Filters drawer** (everything else).

### 1.1 The time window — set *when*

In the header, between the `‹` and `›` arrows:

- **Preset windows** — `7d`, `30d`, `90d`, `6m`, `1y`. These are *rolling*
  windows ending today. 30 days is the default.
- **`‹` / `›` arrows** — step backwards or forwards one whole window at a time.
  Example: on a 30-day window, `‹` jumps to the previous 30 days. `›` is
  disabled once you reach today.
- **Custom date range** — set an exact **From** / **To** in the Filters drawer
  (see 1.3). When a custom range is active, it is shown in small text under the
  window buttons, and the preset buttons de-highlight.

> **KPI deltas:** KPI cards show a `%` change "vs the previous equivalent
> window". On a 30-day window that means the 30 days *before* the current one.
> Changing the window changes the comparison baseline too.

### 1.2 Opening the Filters drawer

Click **Filters** in the header. A badge on the button shows how many filters
are currently active. The drawer slides in from the right. Filters you set in
the drawer are **staged as a draft** — they apply when you click **Apply** at
the bottom (or close behavior per the Apply control). **Reset** clears
everything back to defaults.

### 1.3 The filter types

All multi-select filters follow the rule **empty = all** — selecting nothing
means "don't filter on this".

| Filter | What it does |
|---|---|
| **Primary Metric** | Switch between **Delay (mins)** and **Cancellations**. This changes which metric drives trend charts, operator tables and KPI emphasis across the Performance view. |
| **Search** | Free-text tokens matched across title, location, fault number, train ID and CCIL reference. Add several tokens; use the **AND / OR** toggle — *OR* = any token matches, *AND* = every token must match. |
| **Areas** | Restrict to one or more EMCC areas (Derby, Leicester, Lincoln, Bedford, …). Only areas present in the current window are listed. |
| **Staff on Duty** | Restrict to incidents where a named team member was recorded on shift. Only shown when staff data exists in the window. |
| **Categories** | Multi-select across the 21 incident classes (SPAD, TPWS, Near Miss, Infrastructure, …). Chips are colour-coded. |
| **CCIL Incident Type** | The finer-grained CCIL type label (e.g. "Points Failure"). Search the box to find a type; the count next to each shows how many incidents carry it in the window. |
| **Severity** | CRITICAL / HIGH / MEDIUM / LOW / INFO. |
| **Weather** | Filter incidents by the weather on their report date — see 1.4. |
| **Delay Range (minutes)** | Keep only incidents whose per-incident delay is at/above **Min** and/or at/below **Max**. Good for isolating the big-hitters (e.g. Min = 1000). |
| **Custom Date Range** | Exact **From / To** dates. Overrides the rolling window. Use "Clear → use rolling window" to go back to presets. |

### 1.4 Weather filters

Weather is supplemental context fetched from Open-Meteo. Each EMCC area is
matched to one representative measurement point, and weather is joined to
incidents **by area name and report date**.

- **Conditions** — condition groups (Clear / Dry, Rain, Snow, …).
- **Rainfall (mm)**, **Daily High Temperature (°C)**, **Max Wind Speed (km/h)**
  — each has a Min/Max pair.
- Expand **"How weather is matched to incidents"** to see which town represents
  each area.

> **Important:** when *any* weather filter is active, incidents that have no
> matching weather record are **excluded**. Use "Clear all weather filters" to
> remove them in one click.

### 1.5 Active filter chips, saving and sharing

- **Active filter chips** appear below the header. Click the `×` on any chip to
  remove just that filter, or "Clear all" to drop them all — no need to reopen
  the drawer.
- **Saved Views** — at the bottom of the drawer, **"Save current view…"** stores
  the whole filter set under a name. Saved views appear at the top of the drawer
  for one-click recall (e.g. "Derby SPADs — 90d"). Delete with the `×`.
- **Shareable URL** — the current filter set is encoded into the page URL. Copy
  the address bar and send it to a colleague; they will open Insight with the
  exact same filters applied.

### 1.6 A practical filter workflow

1. Set the **time window** to frame the period.
2. Open **Filters**, set **Primary Metric**, pick **Categories** / **Areas** /
   **Severity** as needed, then **Apply**.
3. Read the result across **Overview → Performance → Geography**.
4. Narrow with **Search** or **Delay Range** to isolate a specific question.
5. **Save the view** if you will return to it; otherwise copy the URL.

> **Note:** the **Review**, **Trends**, **Explore** and **Distillation** tabs
> deliberately use *their own* controls rather than the global filter bar — this
> is called out in each section below.

---

## 2. Identifying trends and links

A "trend" is movement over time; a "link" is a relationship between things
(co-occurrence, recurrence, correlation). Insight separates these into purpose-
built tools. The most important rule: **Insight surfaces correlations, never
causes** — every "link" is a prompt to investigate, not a conclusion.

### 2.1 Trend charts on Overview & Performance

The trend chart on the **Overview** and **Performance** tabs is the headline
view of movement. It carries several decision aids:

- **Chart-type toggle** — swap line / area / bar in the card's top-right.
- **Rolling average** — a smoothed 7-day line cuts through daily noise so the
  underlying direction is visible.
- **Stability band** — a shaded band is the rolling 14-day baseline ± 2σ. Days
  where the value pushes **outside the band are flagged as anomalous** — these
  are your "something happened here" days.
- **Change-points** — markers where the series shifts to a new sustained level
  (a step up or down), not just a one-day spike. A change-point means the
  *baseline itself* moved.

Click a point/day on these charts to **drill down** into the incidents behind
it.

### 2.2 The Trends tab — Trend Composer (comparing trends)

The **Trends** tab is the dedicated tool for *comparing* trend lines and seeing
where they interact.

- **Add series** — build up to 8 series. Each series is its own filtered slice:
  pick a **metric** (incidents, delay, …), and optionally narrow by
  **categories / severities / areas**. Give it a label and colour.
- **7d avg** — overlay a rolling average on every series.
- **Normalise** — rescale every series to a common 0–100% so you can compare the
  *shape* of trends that sit at very different magnitudes.
- **Trend badges** — each series chip shows its direction (rising / falling) and
  slope.
- **Trend crossings** — when two series swap order (one overtakes the other),
  Insight lists the date of each crossing under the chart. A crossing is a
  classic "link" signal — e.g. the date Infrastructure delay overtook Train
  Fault delay is worth investigating.

> The Trends tab works off the current **time window** but ignores the global
> category/area/severity filters — each series carries its own.

### 2.3 The Hypothesis panel — "What stood out"

When the trend chart flags anomalous days or a change-point, the **Hypothesis
panel** answers *what moved*. It ranks dimensions (category, area, severity,
hour-of-day, line, operator) that were **over-represented** on the flagged days
versus a comparable baseline.

- Each row shows a **lift** figure — e.g. "Points Failure was 4× more common on
  the spike days."
- Rows that map to a real filter (category / area / severity) are **clickable**
  — clicking pins them as a filter chip so you can immediately investigate.
- Everything here is explicitly a **correlation**. It tells you where to look,
  not why it happened.

### 2.4 The Signals panel

On the Overview tab, the **Signals panel** is an automated watch-list: delay
spikes, incident surges, emerging hotspots, fault acceleration, response
degradation, safety clusters, category spikes and SLA-breach-rate signals. Each
signal carries a severity (critical / warning / info) and a magnitude. Treat it
as the "read me first" panel each morning.

### 2.5 Patterns tab — time-of-day and day-of-week links

The **Patterns** tab finds links to *when* incidents happen:

- **Day × hour heatmap** — concentration across the week.
- **Hour-of-day** and **weekday** profiles.
- **Category-by-time** — which categories cluster into which time bands.

Use this to spot operational links such as "Near Miss clusters in the morning
peak" or "asset failures lean to weekend nights".

### 2.6 Assets tab — recurrence links

The **Assets** tab is where recurring-equipment links live:

- **Repeat-Fault Assets** — the same equipment failing repeatedly, ranked by
  cumulative impact. This is the engineering-review priority list.
- **Multi-Day Escalations (chains)** — incidents that share a CCIL reference
  across multiple days are grouped into a *chain*, showing total span, event
  count and cumulative delay. A chain is a direct "these events are the same
  problem" link. Click a row to drill into every event in the chain.

### 2.7 Explore tab — cohort links

The **Explore** tab slices a filtered segment into **cohorts** (e.g. by arrival-
time band) and surfaces **insights** comparing each cohort to the whole segment.
Use it to test links like "do incidents with slow arrival have worse delay?"

### 2.8 Analytics tab — location × type links

The **Analytics** tab lets you pick a **location** and an **incident type** and
returns the average arrival and resolution times for that exact combination —
the cleanest way to test a "this type at this place behaves differently" link.

### 2.9 Focus tab — single-incident links

The **Focus** tab investigates one incident and compares it against a **cohort**
of similar incidents (matched on category / area / severity), with weather
context. Use it to answer "was this one unusual, or typical for its kind?"

### 2.10 Distillation tab — precision filtering

The **Distillation** tab is a heavy-duty filter workbench with its own much
finer filter set — duration, mins-to-advised/response/arrival, trains-delayed,
time-of-day, and tri-state flags (continuation / highlight / has-cancellations:
*any / only / exclude*). Use it when the global filter bar is not granular
enough to isolate the population you want to study.

### Reading trends and links responsibly

- A **change-point** beats a one-day spike — it means the new level is holding.
- **Normalise** before comparing trends of different sizes.
- A **crossing**, a **chain**, a **lift** figure and a **cohort insight** are all
  links — investigate them, do not report them as causes.
- Always click through to the **drill-down** incident list to confirm the story
  before acting on it.

---

## 3. Using the Review section (for SNDMs)

The **Review** tab is the SNDM workspace. It lets a Senior Network Duty Manager
work through every incident in a period and attach an optional review record:
classification, technical-conference outcome, stranded-train detail, ITSR,
MOM response, recovery times, and corrections to anything CCIL mis-captured.

> **Review writes data.** Unlike the rest of Insight, saving a review writes a
> row to the `incident_reviews` side-table. The **original CCIL incident row is
> never changed** — overrides are stored separately and layered on top.

### 3.1 What the Review tab shows

The Review tab **ignores the global category / severity / search filters** on
purpose — an SNDM must see *every* incident in the period, not a filtered slice.
It is driven only by the date window.

Three KPI cards at the top:

- **Open Log Periods** — how many railway log periods fall in the window.
- **Incidents in Window** — total, with a note of how many are auto-N/A.
- **Reviewed** — progress, e.g. `12 / 18` and a `% complete` figure.

Below that, **Team on Duty** lists who was recorded on shift across the window,
then the **Log Periods** list.

### 3.2 The drill-down structure

Review is organised as a three-level expandable tree:

```
Log Period  (railway period · year · date span · reviewed progress bar)
  └─ Day    (date · week label · incident count · delay · reviewed count)
       └─ Incident  (severity · CCIL ref · time · category · area · status)
```

Click any level to expand it. Each level shows a **reviewed count / progress
bar** so you can see at a glance what is still outstanding. A period bar turns
**green** when every reviewable incident in it is done.

### 3.3 Incident status badges

Each incident row carries one status:

- **Pending** — reviewable, no review saved yet.
- **Reviewed** (green tick) — a review record exists.
- **Auto N/A** — the incident's delay is **below 400 minutes**, so it is
  auto-classified Not Applicable and **excluded from the review progress
  counter**. These rows are dimmed. You can still open one and fill the form to
  record a manual review if you judge it warranted.

If a coloured **classification pill** (Green / Amber / Red / Black) is present,
the incident has been classified.

### 3.4 Reviewing an incident — step by step

1. Expand a **Log Period**, then a **Day**, then click the **incident** row.
2. The top of the panel shows **CCIL Captured Detail** — read-only: reference,
   times, category, train, delay, responders, TRUST/TDA refs and so on. **Team
   on Duty** for that incident appears next if recorded.
3. The **Incident Events Log** sits just below — a collapsed bar that does not
   take up space until you open it. Expand it to read the full CCIL commentary
   for the incident (time, company, description per line). See 3.5.
4. Below that is the **SNDM Review** form. **Every field is optional** — saving
   a review simply means "an SNDM has touched this incident". Fill in only what
   applies:

| Section | What to record |
|---|---|
| **Period / Week** | Read-only — derived from the railway calendar. |
| **Technical Conference** | Was a conference held? (Yes / No / N/A.) Choosing any value reveals a **Commentary** box — record the statement supporting that decision. |
| **Stranded Trains** | Did trains strand? Selecting **Yes** opens a repeatable list — add each train with **headcode, location, time stranded, time moved**. Use **+ Add Train** for more. |
| **ITSR** | Was ITSR implemented? **Yes** reveals **Time Huddle Held**; **No / N/A** reveals a commentary box for the supporting statement. |
| **Incident Classification** | Pick one: **Green / Amber / Red / Black**. Click the active one again to clear it. |
| **MOM Response** | Did a MOM respond? **Yes** reveals **Depot**, **MOM Dispatched**, **MOM Arrived On Site**, **Response Time**, and the **First 50 — 30-minute target** outcome. |
| **Recovery** | Enter **Target** and **Actual** recovery times. **Time to Recover** is calculated automatically from incident start → actual recovery. |
| **Additional Notes** | Free text for anything else. |
| **Reviewed By** | Your initials. |

5. Click **Save Review** (or **Save Changes** if a review already exists). It
   saves immediately to the `incident_reviews` table. The incident's badge flips
   to the green **Reviewed** state and the progress bars update.

### 3.5 The events log and auto-filled fields

DLog2 stores the **events block** — the running commentary captured against
each incident. The Review tab uses it two ways:

- **Reading it** — the **Incident Events Log** bar (collapsed by default) lists
  every event with its time, company and description. It only occupies space
  once you open it.
- **Auto-filling the form** — when an incident has *no review yet*, Insight
  scans the events and pre-fills these fields:
  - the **first ITSR mention** → `ITSR Implemented` = Yes, and that event's
    time → **Time Huddle Held**;
  - the **first MOM dispatch reference** → `MOM Responded` = Yes and
    **MOM Dispatched** time;
  - the **first MOM on-site / arrived reference** → **MOM Arrived On Site** time.

Any auto-filled field carries a small amber **"auto · from events"** tag, and
the matching lines in the events log are tagged **ITSR**, **MOM dispatch** or
**MOM on site**. Auto-fill is a **starting point, not a decision** — edit any
field to override it (the tag clears as soon as you do), and nothing is stored
until you click **Save Review**. Auto-fill never touches a value you have
already saved.

### 3.6 Refining CCIL capture

Sometimes CCIL captured a value wrong. Expand **"Refine CCIL Capture"** inside
the form to override **title, location, area, delay minutes, trains delayed,
cancelled and part-cancelled**.

- The CCIL-captured value is shown in each field label so you can see what you
  are changing.
- Overrides are stored on the review record only — **the original CCIL row is
  left intact**. The rest of the dashboard reads the refined values
  transparently.
- An override to **delay** can move an incident above the 400-minute threshold,
  changing whether it counts as reviewable.

### 3.7 Removing a review

Open a reviewed incident and click **Remove Review**. After you confirm, the
review record is deleted and the incident returns to **Pending** — the CCIL row
is, again, untouched.

### 3.8 How reviews feed the rest of Insight

SNDM reviews are not just record-keeping — they drive reporting:

- **Stranded-train** figures and the stranded-train detail list in reports are
  built from reviewed incidents.
- **ITSR adherence** counts incidents *without* an SNDM review on file against
  adherence — so completing reviews directly improves the accuracy of the
  Control PMC and other reports.

Keeping the Review tab's progress bars green means downstream reports are
trustworthy.

### 3.9 When you cannot save

Saving requires a **live Supabase connection** and **real data**:

- If Supabase environment variables are missing, the tab shows a *"Demo mode —
  review edits will not be saved"* banner; the form is explorable but **Save** is
  disabled.
- If there are no incidents in the window, Insight shows demo data and saves are
  disabled — **widen the date window** to reach real incidents.

---

## Quick reference

| I want to… | Go to |
|---|---|
| Change the period under review | Header — time window / `‹` `›` arrows |
| Narrow to a category / area / severity | **Filters** drawer |
| Isolate the big delay incidents | Filters → **Delay Range** (Min) |
| Re-use a filter set | Filters → **Save current view** |
| Share exactly what I see | Copy the page **URL** |
| See what moved and what is anomalous | **Overview** trend chart + Hypothesis & Signals panels |
| Compare two or more trends | **Trends** tab (Trend Composer) |
| Find recurring equipment / multi-day chains | **Assets** tab |
| Find time-of-day / day-of-week patterns | **Patterns** tab |
| Compare one incident to similar ones | **Focus** tab |
| Do precision multi-criteria filtering | **Distillation** tab |
| Review incidents as an SNDM | **Review** tab |
| Produce a formatted report | **Reports** tab |

---

*Insight is OFFICIAL-SENSITIVE. Do not share screenshots, exported CSVs or
filter URLs outside authorised recipients.*
