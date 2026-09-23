# WhatsApp incident-advice linking — feasibility brief

**Question.** Can a WhatsApp group export (EM North / EM South "Incident Advice")
be uploaded into a new Insight section, have its messages linked to CCIL
incidents by date and content, and then be used to measure how each incident
was communicated: time from incident start to first message, update cadence,
and lifecycle completeness (notification → updates → service recovery)?

**Answer.** Yes, technically feasible, and the evidence below is empirical, not
theoretical. A deterministic matcher (no LLM) run against the live `incidents`
table linked the majority of on-route incident threads to the correct CCIL row
on first attempt. The hard parts are product decisions (PII handling, where the
upload lives) rather than engineering unknowns.

Assessment date: 23 Sep 2026. Data: two iOS WhatsApp exports (text only,
media stripped) and the production `incidents` table (9,370 rows,
31 Dec 2025 – 22 Sep 2026).

---

## 1. What is in the exports

| | EM South (London–Bedford / Critical Corridor) | EM North |
|---|---|---|
| Messages | 2,784 | 3,419 |
| Effective date range | 27 Nov 2023 – 23 Sep 2026 | same |
| Distinct senders | 162 | 151 |
| Top senders | SNDM Derby 1,361 · Control Mob 513 · two named SNDMs 504 | SNDM Derby 1,336 · Control Mob 676 · two named SNDMs 923 |
| Messages with a `*bold*` headline | 1,864 (67%) | 2,269 (66%) |
| Messages with a RAG emoji prefix | 389 (14%) | 804 (24%) |
| Media placeholders ("image omitted") | 1,617 | 1,801 |
| System lines (joins, leaves, privacy) | 172 | 163 |
| Volume 2026 YTD | ~110 / month | ~100 / month |

The messages are far more structured than a typical chat:

- **Headline convention.** Almost every operational post opens with
  `*Title*`, and updates repeat the same title verbatim
  (`🔴 *Loss of all Signalling Kilby Bridge Jn – Wigston North* … Update 5`).
- **RAG prefix.** 🔴/🟠/🟡 open or escalate, 🟢 closes. Used consistently by
  some senders, rarely by others.
- **Templated bodies.** A house template is clearly in use in the SNDM era:
  `*Incident Headline*`, `*Incident Update NN :*`, `*Holding Message*`,
  `*Post incident service recovery:*`, with sub-sections `*Stranded Trains*`,
  `*Response*`, `*Priority Plan*`, `*Service Group Recovery Target:*`,
  `DSF: 6/302`.
- **Rich entities.** Headcodes (`1C94`, `9T11`), point/TC numbers (`897 pts`,
  `TC21`), signal ids (`WH238`), explicit clock times (`0700hrs`, `at 0856`),
  "Normal working resumed as of 20:57".

Both groups also carry non-incident traffic that must be classified out:
conference-call invitations (Control Mob), weather/EWAT advisories,
possession information, hot-weather guidance, route-wide recovery notes,
off-route awareness (Sussex, Kent, York managed).

## 2. What is in CCIL (as stored by DLog2)

The relevant columns of `public.incidents` (see `lib/types.ts`,
migration 003/009):

| Need | Available | Caveat |
|---|---|---|
| Incident start | `report_date` + `incident_start` (HH:MM) | 06:00–06:00 log day: times before 06:00 belong to the next calendar date |
| Advised / NWR | `advised_time` (74% populated), `nwr_time` (50%) | HH:MM only, same day-roll rule |
| Headcode | in `title` free text | `train_id` is never populated; `extractHeadcode()` in `lib/exposure.ts` already handles this |
| Location | `location` free text | no ELR/TIPLOC; `lib/geo.ts` gazetteer resolves ~77% |
| Area | `area` (Bedford / Derby / Leicester / Lincoln / Route Wide / Sussex…) | 38% of rows have `area` null |
| Type | `incident_type_label`, `category` | good |
| Commentary timeline | `events` jsonb (`{date, time, description}`) | ~100% populated from Jun 2026, 41% overall |
| Severity proxy | `minutes_delay`, `is_highlight` | good |

There is no incident end timestamp beyond `nwr_time`; `incident_duration` is
27% populated.

## 3. Trial results

Method: parse export → drop system/media-only lines → group into threads on
normalised headline (36 h reuse window; generic "Incident Update NN" headers
attach to the most recent thread within 6 h) → for each thread score every
CCIL row whose composed start is within −2 h / +30 h of the first message:

| Signal | Score |
|---|---|
| Shared headcode (thread title/body vs CCIL title) | +5 |
| Shared location/asset tokens (stop-worded) | +1 per token, max 3 |
| Shared fault-type keyword (TCF, points, OLE, flood, trespass…) | +1.5 |
| CCIL `area` consistent with the group (South→Bedford/Sussex; North→Derby/Leicester/Lincoln) | +0.5 / −1 |
| First message within 6 h of CCIL start | +1 |

"Confident" = score ≥ 4 and ≥ 1.5 clear of the runner-up. "Ambiguous" = ≥ 2.5.
All 30 confident pairs in the July run were checked by hand: **all 30 were
correct**. Ambiguous pairs were mostly correct too but under-scored (e.g.
"OLE down Elstree" vs CCIL "De-wirement 614 section tripping @ Mill Hill
Broadway" — same event, different place name).

**February 2026** (all 600 non-continuation CCIL rows for the month):

| Group | Threads | Confident | Ambiguous | None |
|---|---|---|---|---|
| North | 19 | 4 | 13 | 2 |
| South | 25 | 6 | 6 | 13 |

**July 2026** (CCIL rows that are highlights or ≥150 min only, 112 rows — so
smaller-delay on-route incidents were deliberately absent from the candidate
set):

| Group | Threads | Confident | Ambiguous | None |
|---|---|---|---|---|
| North | 31 | 13 | 4 | 14 |
| South | 32 | 17 | 1 | 14 |

The unmatched July threads fall into three buckets, none of which is a matcher
failure: off-route incidents (York ROC evacuation, Sussex distorted track,
Kent Herne Hill TCF, Balcombe points), non-incident advisories (hot-weather
guidance, route-wide service recovery, diversion notices), and on-route
incidents that were excluded from the 112-row sample (1D63 at EMPW, person
struck Chesterfield South, Clerkenwell possession overrun, 9O42 struck object).
With the full CCIL set as candidates the on-route link rate would be higher
than shown.

Where the South "none" count is high in February it is dominated by
Sussex-led / GTR-network items and by sub-threads the naive threader split off
an incident already matched (Technical Conference, Command Structure posts).
Both go away if the CCIL incident, not the WhatsApp headline, is the anchor.

### Timing metrics the trial already yields (30 confident July pairs)

| Metric | Value |
|---|---|
| First WhatsApp message after CCIL `incident_start` | median 35 min (p25 21, p75 62) |
| First WhatsApp message after first CCIL `events` entry | median 36 min |
| Update cadence within a thread (all multi-message threads, both groups) | median 25 min between posts, p90 ~110 min |
| Thread duration (first→last post) | median 1.6 h |
| Threads ending with an explicit closure (🟢 or "normal working resumed" / handback text) | North 373/530 (70%), South 275/428 (64%) |
| Threads with both a RAG open and a closure | North 129, South 58 |
| Confident July pairs with a closure post | 16/30; CCIL `nwr_time` present in 18/30 |

Those last two rows are the point of the feature: for the same incident you
can see both "did Control say it was over" and "when did CCIL say it was
over", and score the gap.

## 4. Proposed design

### Anchor on the incident, not the thread

Reconstructing WhatsApp threads from headline text is lossy (one incident can
have five different titles as the picture changes). Instead: classify each
message, score it against CCIL candidates in its time window, and store the
link per message. The "thread" for an incident is then simply all messages
linked to it, ordered by time. Unlinked messages stay visible in an inbox for
manual assignment.

### Tables (new migration, additive)

```
wa_imports        id, group_name, file_name, sha256, first_msg_at, last_msg_at,
                  message_count, imported_by, imported_at
wa_messages       id, import_id, group_name, sent_at timestamptz (Europe/London
                  → UTC), sender_raw, sender_norm, body, headline, rag,
                  headcodes text[], msg_kind (open|update|holding|recovery|
                  close|conference|advisory|other), has_media, is_deleted,
                  UNIQUE (group_name, sent_at, sender_raw, md5(body))
wa_incident_links message_id, incident_id, score numeric, method (auto|manual),
                  status (auto|confirmed|rejected), decided_by, decided_at
wa_incident_stats (view or materialised) incident_id, group_name, first_msg_at,
                  last_msg_at, msg_count, update_count, has_open, has_close,
                  mins_to_first_msg, close_lag_vs_nwr, max_gap_mins
```

The unique key makes re-uploading an overlapping export idempotent, which
matters because WhatsApp exports are always cumulative.

### Matching

Deterministic first, reusing what exists: `extractHeadcode` (`lib/exposure.ts`),
the gazetteer in `lib/geo.ts` for location normalisation on both sides, the
label→category map in `lib/classification.ts` for type keywords, and the
06:00 log-day rule already used for CCIL times. Group→area prior as above.
Thresholds as in the trial; ambiguous links land in a review queue in the UI
with one-click confirm/reassign. An LLM re-ranker for the ambiguous band is an
optional later step, not a prerequisite.

### Ingestion path

Insight has no server layer and no upload UI; writes today go from the
browser with the anon key (reviews, annotations, PMC flags). Three options:

1. **Node CLI** modelled on `scripts/seed-whatsapp-performance.mjs`, which
   already parses this exact export format (message splitting, DST-correct
   London→UTC, PostgREST posting). Fastest to ship; import is an admin task.
2. **Browser upload in a new Insight tab**: parse the `.txt` client-side,
   insert via supabase-js like the other Insight writes. Best UX, but puts a
   bulk-write path on the anon key.
3. **DLog2 upload page**, since DLog2 already owns the write side. Cleanest
   architecturally, but a cross-repo change.

Recommendation: 1 to prove value on the historic exports, then 2 behind the
existing `canWrite` gate once the PII position is settled.

### UI

- New tab "Comms" (or a panel in the Review tab's incident detail next to
  `IncidentEventsBlock`): CCIL events and WhatsApp posts on one time axis.
- Incident list with: group, time-to-first-message, post count, cadence,
  lifecycle badge (open / updates / close), close lag vs NWR.
- Period and area roll-ups: median time-to-first-message, % of highlight
  incidents with any post, % with a close, by group and by month.
- Unlinked inbox and ambiguous-link review queue.

## 5. Risks and decisions needed

- **Personal data.** Exports carry staff names, and unsaved contacts appear as
  phone numbers (`‪+44 7825 …‬`) or `~ Peter`. Recommend storing a normalised
  sender role/initials and hashing or dropping raw numbers at parse time.
  Insight is OFFICIAL-SENSITIVE behind perimeter auth only; there is no user
  identity, and `incidents` and the other Insight-owned tables have RLS
  disabled (Supabase flags 65 such tables in this project). Adding a
  message-text table on that footing needs a decision, not a default.
- **Export format drift.** iOS 24-h format handled; Android and 12-h locale
  variants differ and need a second regex. Media is stripped by the export;
  the placeholder is kept as a flag only.
- **Time semantics.** WhatsApp is local London time; CCIL is HH:MM on a
  06:00–06:00 log day. Both conversions are known and already coded in the
  repo. DST transitions are the usual trap.
- **Coverage asymmetry.** WhatsApp only carries the incidents Control chose to
  message. Silence is itself a finding: "highlight incidents with no post" is a
  first-class metric, not a matching failure.
- **One incident, several titles; several incidents, one post.** Route-wide
  recovery posts reference multiple CCILs. Allow many-to-many links.
- **CCIL `area` null on 38% of rows** weakens the group→area prior; fall back to
  gazetteer corridor.

## 6. Effort

| Phase | Scope | Size |
|---|---|---|
| 0 | Migration + CLI import + link table populated from historic exports | ~2 days |
| 1 | Incident timeline panel + per-incident comms metrics | ~2 days |
| 2 | Comms tab roll-ups, unlinked inbox, manual link/unlink | ~2 days |
| 3 | Browser upload, PII policy, optional LLM re-rank | on decision |

## 7. Reproducing the trial

`scripts/whatsapp-ccil-link-poc.py` is the matcher used above. Export CCIL
candidates to JSON from the SQL Editor:

```sql
select id, ccil, report_date, incident_start, advised_time, nwr_time, title,
       location, area, category, incident_type_label, minutes_delay
from incidents
where not coalesce(is_continuation,false)
  and report_date between '2026-07-01' and '2026-07-31';
```

then

```
python3 scripts/whatsapp-ccil-link-poc.py path/to/_chat.txt ccil.json \
    --group north --from 2026-07-01 --to 2026-08-01
```
