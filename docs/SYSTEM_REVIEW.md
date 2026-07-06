# EMCC Insight — System Review & Forward Plan

**Date:** July 2026 · **Version reviewed:** main @ `4d652b2` (post PR #28)
**Method:** full codebase audit (app, analytics engine, reporting pipeline, data layer), live click-through of every tab, production-deployment check, and direct interrogation of the live database.

---

## 1. Executive summary

Insight is a substantial, working product: a 14-tab analytics dashboard over the DLog2 CCIL feed with a genuinely deep analytic layer (trend/stability bands, change-point detection, delta decomposition, cohort exploration, single-incident benchmarking), a complete SNDM review workflow, and a five-template print-quality reporting engine including the weekly Control PMC pack. **Everything user-facing renders and functions** — all 14 tabs load with zero errors, production is deployed and healthy, and the live database holds 187 consecutive days of data (6,134 incidents) with the review and PMC-flag workflows in active use.

The review found no broken user-facing features, but it did find:

- **Two fully-built features that are never shown** — the Signals alert panel and the Hypothesis ("why did this change?") engine are complete, imported, and unmounted. The most sophisticated analytics in the codebase are invisible.
- **One functional defect** — the minimum-temperature weather filter compares against the day's *maximum* temperature.
- **A set of statistical inconsistencies** — three different median implementations, two different anomaly baselines, two different duration-validity rules — that make the same metric read differently on different screens.
- **A security posture worth a deliberate decision** — no login, no RLS, and write access via the browser-embedded anon key, while the README simultaneously claims the app is read-only and recommends a hardening step that would break saving reviews.
- **Data-quality ceilings** that cap several analytics: the operator field is 0 % populated (the Operator Impact panel can never show live data), arrival timings are ~9 % populated, and durations ~27 %.

None of this is structural. The platform is in a strong position: the next phase should be about **surfacing the intelligence already built, making the numbers trustworthy and consistent, and moving from "describes the past" to "anticipates and advises."** Sections 4–5 lay out ten candidate features and a phased long-term direction.

---

## 2. System overview

| Layer | What it is | Status |
|---|---|---|
| Frontend | Next.js 14 (App Router), single-page client dashboard; ~7,700-line `app/page.tsx` plus Focus & Distillation tab modules | Working; monolithic (see §3.6) |
| Data source | Supabase Postgres shared with DLog2 (which writes `incidents` / `reports` / `incident_team_members`); Insight writes `incident_reviews`, `incident_pmc_flags`, `weather_daily` | Healthy; 187/187 daily logs captured |
| Analytics | All aggregation client-side over a paginated two-window fetch (current + previous); ~30 derivation functions | Working; scaling and consistency notes in §3.5–3.6 |
| Reporting | Plan-builder → styled HTML → browser print-to-PDF; 5 templates; Control PMC CSV | Working |
| Deployment | Vercel (`lhr1`), auto-deploy from `main`; production READY on latest merge | Working |
| Auth | None — anon key in browser, no RLS, no user identity | Deliberate gap; see §3.7 |
| Tests | None (no test framework in the repo) | Gap |

**Live data profile** (queried July 2026): 6,134 incidents across 187 days (31 Dec 2025 → 5 Jul 2026, no gaps); 36 SNDM reviews saved by 5 named reviewers (vs ~181 delay-gate-reviewable incidents all-time → ~20 % adoption before the new keyword triggers roughly doubled the reviewable pool); 1 PMC flag already placed; 2,436 weather day-rows synced.

**Field completeness** (share of incidents with the column populated): incident type label 100 %, line 99.6 %, events log 41 % overall but **~100 % since June**; fault number 45 %; incident duration 27 % (32–44 % in recent months); **arrival timings 8.6 %**; **train operator 0 %**. The last two matter: SLA/arrival analytics run on a small biased sample, and the Operator Impact chart can never populate from live data until DLog2 captures `train_company`.

---

## 3. Capability inventory and working status

### 3.1 Filtering & date refinement — ✅ working
Rolling windows (7d–1y) plus railway **week/period** stepping with correct period/year rollover; custom ranges; 12 filter dimensions (areas, categories, incident types, severities, staff-on-duty, free-text AND/OR search, delay range, weather conditions + numeric ranges, off-route mode, primary-metric focus); removable chips; saved views (localStorage); URL-encoded shareable state; CSV export. Verified live.
*Edges:* the header filter-count badge and the chips-row total are two hand-maintained sums of the same dimensions (drift risk); **the min-temperature filter tests `max_temp_c`** and numeric weather filters coerce missing values to 0 — both genuine defects.

### 3.2 Analytics tabs — ✅ working
- **Overview**: KPIs with clickable **delta decomposition** ("what drove the change" by category/area/severity/hour-band), daily trend with rolling average + stability band + change-point markers, click-to-filter category mix, hotspots, repeat assets.
- **Safety**: operational-safety vs PAX split, radar vs prior window, drill-downs.
- **Performance**: delay/cancellation focus switch, response-time distributions, TRMC delay attribution, interactive delay-threshold splitter.
- **Geography**: delay density, hotspot leaderboard, area treemap.
- **Patterns**: day×hour heatmap, hourly/DoW profiles, staff workload and day/night split.
- **Assets**: infra failure mix, repeat-fault assets, multi-day escalation chains.
- **Routes**: per-line KPIs, tables and drill-downs.
- **Trends**: multi-series Trend Composer (8 series, 7 metrics, per-series filters, regression badges, crossing detection).
- **Explore**: cohort comparison across 7 split dimensions × 7 metrics with a lift-based "why does this cohort stand out?" panel.
- **Analytics**: location × incident-type response lens.
- **Focus**: single-incident benchmarking vs a matched cohort (percentile strips, scatter, profile).
- **Distillation**: AND-filter cohort interrogation with KPIs, trend, histogram, presets.

All verified rendering with zero console/page errors.

### 3.3 Review workflow — ✅ working, adoption is the constraint
Period → day → incident tree with progress bars; two-gate reviewability (≥400 min delay OR keyword triggers: ITSR / service recovery / stranded / refail / technical conference — the triggers roughly doubled coverage on live data); event-log auto-fill of ITSR/MOM fields; full SNDM form (classification, stranded-train array, MOM response, recovery times, CCIL overrides); PMC flagging with the 5-per-railway-week cap; recovery-trend charts. Verified live including on real data.
*Note:* 36 reviews vs ~180+ reviewable — the tooling works; the workflow needs to get cheaper per review (see feature 7).

### 3.4 Reporting — ✅ working
Five templates with independent scope pickers (railway period/week aware), per-template section toggles, live A4 preview, print-to-PDF, HTML archive, Control PMC CSV. The Control PMC pack: topic-by-topic KPIs, stranded/ITSR adherence from reviews, recovery trend, and the top-5/flagged deep-dive with 6-month repeat-issue matching.
*Defects:* the "Reports covered" KPI is always 0 inside generated reports (the builder passes an empty `reports` array); PDF fidelity depends on Google Fonts fetched at print time; **no scheduled/automated generation** — the weekly pack is produced by hand.

### 3.5 Analytics engine internals — ⚠️ works, consistency debt
Sound and continuation-aware overall, with three classes of debt:
1. **Invisible intelligence.** `deriveSignals` (7 alert types: surges, spikes, safety clusters, fault acceleration, response degradation, SLA breach rate) and the entire `deriveHypotheses` lift-ranking engine are built and tested by usage in reports (signals) or **never called at all** (hypotheses). `SignalsPanel` and `HypothesisPanel` components exist but are never mounted. An unrendered `OperatorsTab` component also lingers.
2. **Inconsistent statistical primitives.** Three median estimators across queries/focus/distillation; signals use self-contaminated z-scores while the trend band correctly uses a causal baseline; CUSUM runs against a global mean (heuristic, admittedly "crude"); durations ≥24 h are excluded from KPIs but included in histograms; `pctDelta` reports a 0→N surge as *no change* (null).
3. **Hard-coded thresholds** (SLA 45 min, z>2, lift>1.6, CUSUM k=4σ, 400-min review gate…) that should graduate to a visible config surface as the user base grows.

### 3.6 Architecture & scale — ⚠️ fine today, plan for growth
Everything derives client-side from a two-window fetch (deliberately unfiltered by category so reclassification stays trustworthy). At one control centre's volumes (~30–35 incidents/day) this is fine; a 1-year window already moves ~15k rows twice. Multi-year or multi-centre analysis will need server-side aggregation (RPCs or materialised views). The single 7,716-line client file is the main maintainability risk — splitting the Review and Reports subtrees out would halve it. **There are no tests**; the railway calendar, classification map, narrative generator and CSV serialiser are all non-trivial and untested.

### 3.7 Security & data posture — ⚠️ decision needed
No login; the browser-embedded anon key can **write** reviews, PMC flags and weather rows (RLS disabled on all six Insight tables — confirmed by Supabase advisors). Protection is perimeter-only (Vercel password / Cloudflare Access per README). The README also states the app is read-only and recommends binding the anon key to a SELECT-only role — **which would silently break review saves, PMC flags and weather sync**. `reviewed_by` is free-typed initials, so there is no real audit trail. The PMC 5-per-week cap is a check-then-insert (a concurrent race can exceed it; harmless today, worth a DB-side guard later). Base migrations for `incidents`/`reports` (001/002) live only in DLog2, so this repo can't provision a fresh environment alone.

### 3.8 Defect list (verified)

| # | Defect | Severity |
|---|---|---|
| 1 | Signals + Hypothesis panels fully built, never rendered | High (missing value, not breakage) |
| 2 | Min-temperature filter compares against day-max temperature; weather nulls coerced to 0 | Medium |
| 3 | "Reports covered" KPI always 0 in generated reports | Low–medium |
| 4 | `pctDelta` hides 0→N surges (null delta) | Medium |
| 5 | Inconsistent median/duration/anomaly methods across tabs | Medium (trust) |
| 6 | README read-only claim vs three write paths; missing `.env.example`; stale file map | Low (docs) |
| 7 | Dead code: `OperatorsTab`, `reviewReports` state, unused props | Low |
| 8 | Operator field 0 % populated → Operator Impact panel permanently empty on live data | Upstream (DLog2) |
| 9 | Change-point markers for safety shifts drawn on the incidents series in report charts | Low |
| 10 | Duplicate user guide (`docs/` md vs `public/` html) drifting apart | Low |

---

## 4. Ten proposed features / analytic tools

Ordered roughly by value-to-effort. The first two unlock code that already exists.

**1. Surface the Signals engine as an "Attention" panel (quick win).**
Mount the existing `SignalsPanel` on Overview with the seven built alert types, fix the baseline (causal window, exclude the flagged day), and add day-of-week seasonal adjustment so Monday peaks stop looking anomalous. This turns Insight from "look and find" into "opens with what needs attention today."

**2. Wire up the Hypothesis ("why did this change?") engine (quick win).**
The lift-based over-representation engine is complete and unreachable. Attach it to the stability band and change-point markers so clicking an anomalous day answers "points failures at Leicester were 4× over-represented" — with a minimum-sample guard so tiny clusters don't over-claim.

**3. Weather–performance correlation module.**
Weather data is synced daily but only used as a filter. Add an analysis view: incident rate and delay lift by rainfall/wind/temperature band, storm-day vs dry-day comparisons per category (points failures in cold snaps, trespass in heatwaves), and an estimated weather-attributable delay figure per period — directly useful for seasonal-preparedness cases.

**4. Period forecasting & projection.**
A seasonal-naïve + trend forecast (well within reach client-side): project the current period's end-state ("P04 is tracking to ~19,800 delay minutes, +12 % vs P03; worst period this rail year"), forecast next period per category/area, and flag when a projection breaches a target. Turns the periodic scorecard from retrospective to anticipatory.

**5. Asset reliability & MTBF/MTTR module.**
Repeat-asset data exists but only as counts. Add per-asset mean-time-between-failures, repair-time trending, a deteriorating-assets watchlist (shrinking failure intervals), and a cause Pareto — the natural evolution of the Assets tab and strong evidence for maintenance escalations to Network Rail asset management.

**6. Periodic scorecard & league table.**
A single P01–P13 grid per rail year: delay, incidents, safety count, SLA, review completion per period with year-on-year same-period comparison, plus per-area league tables. This becomes the natural front page for period-end reviews and feeds the Period report automatically.

**7. Review command centre.**
Adoption (36 reviews vs 180+ reviewable) is the bottleneck, not capability. Add a flat "review queue" view (all pending, sorted by impact/trigger, independent of the period tree), one-click "nothing to add" completion for simple cases, keyboard-driven form flow, and a review-coverage KPI per week on the scorecard. Goal: a full week reviewable in one sitting.

**8. Scheduled report generation & delivery.**
The weekly Control PMC pack is hand-cranked. Add a scheduled job (Vercel cron or GitHub Action) that renders the pack server-side each railway-week end (headless Chromium — the HTML pipeline is already self-contained), stores it in a `report_archive` table/storage bucket, and emails/Teams-posts it. Reports become an artefact the team receives, not a chore they perform.

**9. Events-log intelligence & incident search.**
The events commentary is now ~100 % populated and GIN-indexed but barely exploited. Add full-text search across all incident commentary ("find every mention of Brooksby AHB"), a reconstructed response timeline per incident, and text-similarity "incidents like this" retrieval — upgrading the Focus tab's delay-proximity matching into real precedent lookup for controllers mid-incident.

**10. Route map / geospatial view.**
Locations are strings today. Add a curated geocoding table for EMCC locations (a few hundred rows, one-off effort), then a route-schematic or map view with incident overlay, corridor heat, and spatial clustering. High demo value and a genuinely different lens — geography as geography rather than a table.

*Honourable mentions:* configurable thresholds page (SLA, review gate, signal sensitivities); LLM-assisted narrative and "ask the data" Q&A over the incident corpus; responder-load normalisation (per-shift rather than raw counts).

---

## 5. Long-term direction

### Phase 1 — Trust the numbers (now → next few weeks)
The platform's credibility rests on every screen agreeing with every other screen and with the PMC pack.
- Fix the verified defects (§3.8: temperature filter, pctDelta, reports-covered KPI, chart mislabel).
- Consolidate statistical primitives into one `lib/stats.ts` (single median/percentile/z-score implementation) and one duration-validity rule.
- Introduce a test harness (vitest) for `lib/` — railway calendar, classification map, narrative, CSV, report builders. These are pure functions; testing them is cheap and locks in correctness for the parts that feed official reports.
- Reconcile the README/security story and add `.env.example`; single-source the user guide.

### Phase 2 — From dashboard to decision support (1–3 months)
Ship features 1, 2, 3, 6, 7 — surface the built-but-hidden intelligence, add weather correlation and the periodic scorecard, and make reviews fast enough to keep pace. Success measure: review coverage above ~80 % per week and the Signals panel becoming the first thing checked each morning.

### Phase 3 — Operational platform (3–6 months)
- **Identity & audit**: Supabase Auth (email magic-link is enough), RLS policies on the write tables, `reviewed_by`/`flagged_by` as real identities, audit timestamps. This is the precondition for multi-user trust and for anything OFFICIAL-SENSITIVE hardening beyond a perimeter password.
- **Automation**: scheduled PMC generation and delivery (feature 8); report archive.
- **Codebase health**: split `page.tsx` (Review, Reports, and each tab into modules); move the heaviest aggregations behind Supabase RPCs as window sizes grow; bring base migrations 001/002 into a shared schema repo with DLog2 so a fresh environment is provisionable.
- **Upstream data quality**: the highest-leverage analytics improvements are DLog2 capture fixes — populate `train_company`, lift arrival-time capture from ~9 %, close the duration gap (BIO closing time). Insight can add a small data-quality panel making these gaps visible so they get managed.

### Phase 4 — Strategic options (6 months +)
- **Forecasting & risk**: mature feature 4 into period-ahead planning; combine with weather forecasts for a next-72-hours risk outlook.
- **Benchmarking**: once a second control centre or national feeds (TRUST/PPM) are in scope, the same engine becomes a comparative platform — that is the point to invest in multi-tenancy, not before.
- **Assistant layer**: with events text at 100 % coverage and reviews accumulating, an LLM layer (daily auto-briefing, natural-language query over the corpus, draft review commentary) becomes credible and cheap to trial behind a flag.
- **The DLog2 + Insight suite**: capture (DLog2) → intelligence (Insight) → distribution (scheduled packs) as one product family with a shared schema, shared auth, and a single design language.

### Direction in one paragraph
Insight has finished its "build the instrument panel" era: the descriptive layer is broad, deep and working. The next era is **judgement support** — surfacing what matters unprompted (signals, hypotheses, forecasts), making the operational workflows (review, PMC) so cheap they stay current, and hardening identity/consistency so the numbers can be defended anywhere. Scale (multi-centre, national feeds) is a real option but should stay behind adoption: the best signal to expand will be the EMCC team treating Insight's weekly pack and morning signals as indispensable.
