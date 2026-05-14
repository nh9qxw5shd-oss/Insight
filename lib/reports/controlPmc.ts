// ─── Control PMC weekly KPI roll-up builder ──────────────────────────────────
// Produces a topic-by-topic plan for the weekly Control PMC report. Each topic
// is filtered out of the same incidents bundle, with stranded-train and ITSR
// adherence riding on top of the incident_reviews side-table.
//
// Topic catalogue (matches the section ids in reports/types.ts):
//   • Fatalities / Person struck
//   • Stranded trains      — review.stranded_trains_occurred = YES
//   • Irregular working
//   • PAX (passenger / public injury)  — capped at top 10 by impact
//   • Train faults         — split: >200m primary, top 5 below 200m secondary
//   • ITSR adherence       — all incidents > 300m, split by review.itsr_required
//   • Passenger satisfaction (placeholder; data not yet held)

import {
  CATEGORY_CONFIG, IncidentCategory, IncidentReview, IncidentRow,
} from '../types'
import { effectiveDelay, nonContinuation } from '../queries'
import {
  ControlPmcPlan, PmcIncidentRow, PmcItsrPlan, PmcLocationRow,
  PmcTopicPlan, PmcTopicSummary, ReportKpi,
} from './types'

const ITSR_THRESHOLD_MINS = 300
const TRAIN_FAULT_PRIMARY_MINS = 200
const PAX_TOPN = 10
const TRAIN_FAULT_SECONDARY_TOPN = 5

function pctDelta(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null
  return ((curr - prev) / prev) * 100
}

function fmt(n: number): string {
  return n.toLocaleString('en-GB', { maximumFractionDigits: 0 })
}

function fmtMinsShort(n: number): string {
  if (n >= 60) {
    const h = Math.floor(n / 60)
    const m = Math.round(n % 60)
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  return `${Math.round(n)}m`
}

function toPmcRow(i: IncidentRow, note?: string | null): PmcIncidentRow {
  const cfg = CATEGORY_CONFIG[i.category]
  return {
    date:          i.report_date,
    ccil:          i.ccil,
    tda:           i.tda_ref,
    category:      i.category,
    categoryShort: cfg.short,
    categoryColor: cfg.color,
    title:         i.title,
    location:      i.location,
    area:          i.area,
    delayMins:     effectiveDelay(i),
    trainsDelayed: i.trains_delayed,
    cancelled:     i.cancelled,
    partCancelled: i.part_cancelled,
    note:          note ?? null,
  }
}

function topLocations(rows: IncidentRow[], limit = 5): PmcLocationRow[] {
  const m = new Map<string, PmcLocationRow>()
  for (const i of rows) {
    const key = (i.location ?? '').trim()
    if (!key) continue
    const cur = m.get(key) ?? { location: key, area: i.area, count: 0, delayMins: 0 }
    cur.count += 1
    cur.delayMins += effectiveDelay(i)
    m.set(key, cur)
  }
  return Array.from(m.values())
    .sort((a, b) => b.delayMins - a.delayMins || b.count - a.count)
    .slice(0, limit)
}

function summarise(curr: IncidentRow[], prev: IncidentRow[]): PmcTopicSummary {
  const c = nonContinuation(curr)
  const p = nonContinuation(prev)
  const cDelay = curr.reduce((s, i) => s + effectiveDelay(i), 0)
  const pDelay = prev.reduce((s, i) => s + effectiveDelay(i), 0)
  return {
    count:         c.length,
    prevCount:     p.length,
    countDeltaPct: pctDelta(c.length, p.length),
    delayMins:     cDelay,
    prevDelay:     pDelay,
    delayDeltaPct: pctDelta(cDelay, pDelay),
    uniqueLocations: new Set(c.map(i => i.location).filter((l): l is string => !!l && !!l.trim())).size,
    uniqueCcil:      new Set(c.map(i => i.ccil).filter((c): c is string => !!c && !!c.trim())).size,
    uniqueTda:       new Set(c.map(i => i.tda_ref).filter((t): t is string => !!t && !!t.trim())).size,
  }
}

// ─── Topic: Fatalities / Person struck ───────────────────────────────────────

function buildFatalities(curr: IncidentRow[], prev: IncidentRow[]): PmcTopicPlan {
  const f = (rows: IncidentRow[]) => nonContinuation(rows).filter(i =>
    i.category === 'PERSON_STRUCK' || i.category === 'FATALITY')
  const cur = f(curr)
  const pre = f(prev)
  const summary = summarise(cur, pre)
  const insights: string[] = []
  if (cur.length === 0)        insights.push('Zero person-struck or fatality incidents recorded in this week — sustain proactive trespass and lineside safety messaging.')
  if (cur.length > pre.length) insights.push(`Up from ${pre.length} the previous week — review trespass hotspots and BTP coordination.`)
  return {
    topic:     'Fatalities · Person Struck',
    summary,
    locations: topLocations(cur),
    incidents: cur.sort((a, b) => effectiveDelay(b) - effectiveDelay(a)).map(i => toPmcRow(i)),
    insights,
  }
}

// ─── Topic: Stranded trains ──────────────────────────────────────────────────
// Driven by reviewed incidents where stranded_trains_occurred === 'YES'.

function buildStranded(
  curr: IncidentRow[], prev: IncidentRow[],
  curRevById: Map<string, IncidentReview>, prevRevById: Map<string, IncidentReview>,
): PmcTopicPlan {
  const f = (rows: IncidentRow[], rev: Map<string, IncidentReview>) =>
    nonContinuation(rows).filter(i => rev.get(i.id)?.stranded_trains_occurred === 'YES')
  const cur = f(curr, curRevById)
  const pre = f(prev, prevRevById)
  const summary = summarise(cur, pre)
  const insights: string[] = []
  if (cur.length === 0) insights.push('No reviewed incidents flagged a stranded train this week.')
  // Surface stranded entries as inline notes on the row
  const rows: PmcIncidentRow[] = cur
    .sort((a, b) => effectiveDelay(b) - effectiveDelay(a))
    .map(i => {
      const rev = curRevById.get(i.id)
      const entries = rev?.stranded_trains ?? []
      const note = entries.length
        ? entries.map(e => [e.headcode, e.location, e.time_stranded].filter(Boolean).join(' · ')).join(' | ')
        : null
      return toPmcRow(i, note)
    })
  // Total stranded units across the week (from review entries)
  let totalUnits = 0
  for (const i of cur) {
    const rev = curRevById.get(i.id)
    totalUnits += rev?.stranded_trains?.length ?? 0
  }
  if (totalUnits > 0) insights.push(`${totalUnits} train${totalUnits === 1 ? '' : 's'} stranded across ${cur.length} reviewed incident${cur.length === 1 ? '' : 's'}.`)
  return {
    topic:     'Stranded train incidents',
    summary,
    locations: topLocations(cur),
    incidents: rows,
    insights,
    status:    curRevById.size === 0 ? 'No incident reviews loaded for this week — stranded-train flag depends on reviewed incidents.' : undefined,
  }
}

// ─── Topic: Irregular working ────────────────────────────────────────────────

function buildIrregular(curr: IncidentRow[], prev: IncidentRow[]): PmcTopicPlan {
  const f = (rows: IncidentRow[]) => nonContinuation(rows).filter(i => i.category === 'IRREGULAR_WORKING')
  const cur = f(curr)
  const pre = f(prev)
  const summary = summarise(cur, pre)
  const insights: string[] = []
  if (cur.length === 0)               insights.push('No irregular-working events captured this week.')
  if (summary.countDeltaPct != null && summary.countDeltaPct > 50) {
    insights.push(`Volume up ${Math.round(summary.countDeltaPct)}% on the previous week — consider a brief look at common causes.`)
  }
  return {
    topic:     'Irregular working',
    summary,
    locations: topLocations(cur),
    incidents: cur.sort((a, b) => effectiveDelay(b) - effectiveDelay(a)).map(i => toPmcRow(i)),
    insights,
  }
}

// ─── Topic: PAX incidents (top 10 by impact) ─────────────────────────────────

function buildPax(curr: IncidentRow[], prev: IncidentRow[]): PmcTopicPlan {
  const f = (rows: IncidentRow[]) => nonContinuation(rows).filter(i => i.category === 'PASSENGER_INJURY')
  const cur = f(curr)
  const pre = f(prev)
  const summary = summarise(cur, pre)
  const sorted = [...cur].sort((a, b) => effectiveDelay(b) - effectiveDelay(a))
  const capped = sorted.slice(0, PAX_TOPN)
  const insights: string[] = []
  if (sorted.length > PAX_TOPN) {
    insights.push(`Showing top ${PAX_TOPN} of ${sorted.length} PAX incidents by delay impact — ${sorted.length - PAX_TOPN} lower-impact event${sorted.length - PAX_TOPN === 1 ? '' : 's'} omitted from the table.`)
  }
  if (cur.length === 0) insights.push('No passenger / public injury incidents captured this week.')
  return {
    topic:     `PAX incidents${cur.length > PAX_TOPN ? ` (top ${PAX_TOPN} of ${cur.length})` : ''}`,
    summary,
    locations: topLocations(cur),
    incidents: capped.map(i => toPmcRow(i)),
    insights,
  }
}

// ─── Topic: Train faults (>200m + top 5 below) ───────────────────────────────

function buildTrainFaults(curr: IncidentRow[], prev: IncidentRow[]): PmcTopicPlan {
  const f = (rows: IncidentRow[]) => nonContinuation(rows).filter(i => i.category === 'TRAIN_FAULT')
  const cur = f(curr)
  const pre = f(prev)
  const summary = summarise(cur, pre)

  const above = cur.filter(i => effectiveDelay(i) > TRAIN_FAULT_PRIMARY_MINS).sort((a, b) => effectiveDelay(b) - effectiveDelay(a))
  const below = cur.filter(i => effectiveDelay(i) <= TRAIN_FAULT_PRIMARY_MINS).sort((a, b) => effectiveDelay(b) - effectiveDelay(a)).slice(0, TRAIN_FAULT_SECONDARY_TOPN)

  const insights: string[] = []
  insights.push(`${above.length} train fault${above.length === 1 ? '' : 's'} above ${TRAIN_FAULT_PRIMARY_MINS} minutes delay; top ${below.length} below the threshold also shown.`)
  if (cur.length === 0) insights.push('No train fault incidents captured this week.')

  return {
    topic:     'Train fault incidents',
    summary,
    locations: topLocations(cur),
    incidents: above.map(i => toPmcRow(i, `>${TRAIN_FAULT_PRIMARY_MINS}m`)),
    secondary: below.length ? {
      title:     `Top ${below.length} train fault${below.length === 1 ? '' : 's'} below ${TRAIN_FAULT_PRIMARY_MINS}m delay`,
      incidents: below.map(i => toPmcRow(i)),
    } : undefined,
    insights,
  }
}

// ─── Topic: ITSR adherence (>300m incidents, split by review) ─────────────────

function buildItsr(
  curr: IncidentRow[], prev: IncidentRow[],
  curRevById: Map<string, IncidentReview>, prevRevById: Map<string, IncidentReview>,
): PmcItsrPlan {
  const filterAbove = (rows: IncidentRow[]) =>
    nonContinuation(rows).filter(i => effectiveDelay(i) > ITSR_THRESHOLD_MINS)
  const cur = filterAbove(curr)
  const pre = filterAbove(prev)

  // Classify each current-window 300m+ incident by ITSR completion.
  const did: IncidentRow[]    = []
  const didnt: IncidentRow[]  = []
  const unrev: IncidentRow[]  = []
  for (const i of cur) {
    const r = curRevById.get(i.id)
    if (!r) { unrev.push(i); continue }
    if (r.itsr_required === 'YES') did.push(i)
    else didnt.push(i)
  }

  const itsrCount      = cur.length
  const itsrCompleted  = did.length
  const itsrMissing    = didnt.length
  const itsrUnreviewed = unrev.length
  // Adherence percentage uses the full 300m+ population as denominator —
  // an unreviewed incident counts against adherence so the number reflects
  // the policy gate (every 300m+ event should have an ITSR completed).
  const itsrPct = itsrCount === 0 ? 100 : (itsrCompleted / itsrCount) * 100

  // Same metric for previous week
  let prevDid = 0
  for (const i of pre) {
    const r = prevRevById.get(i.id)
    if (r?.itsr_required === 'YES') prevDid += 1
  }
  const prevPct = pre.length === 0 ? 100 : (prevDid / pre.length) * 100

  const summary = summarise(cur, pre)
  const insights: string[] = []
  insights.push(`${itsrCompleted} of ${itsrCount} (${itsrPct.toFixed(0)}%) of incidents above ${ITSR_THRESHOLD_MINS} minutes had an ITSR completed.`)
  if (itsrUnreviewed > 0) insights.push(`${itsrUnreviewed} incident${itsrUnreviewed === 1 ? '' : 's'} have no review on file — these count against adherence until reviewed.`)
  if (itsrMissing > 0)   insights.push(`${itsrMissing} reviewed incident${itsrMissing === 1 ? '' : 's'} were marked as not requiring ITSR — verify the rationale.`)
  if (pre.length > 0)    insights.push(`Previous week adherence: ${prevPct.toFixed(0)}% (${prevDid}/${pre.length}).`)

  // Primary table = with ITSR; secondary = without (didn't have + unreviewed)
  const primary = did
    .sort((a, b) => effectiveDelay(b) - effectiveDelay(a))
    .map(i => toPmcRow(i, 'ITSR completed'))
  const noItsr = [
    ...didnt.map(i => ({ inc: i, note: 'Reviewed · ITSR not required' as string })),
    ...unrev.map(i => ({ inc: i, note: 'Not yet reviewed' as string })),
  ].sort((a, b) => effectiveDelay(b.inc) - effectiveDelay(a.inc))

  return {
    topic:           `ITSR adherence — incidents over ${ITSR_THRESHOLD_MINS} min`,
    summary,
    locations:       topLocations(cur),
    incidents:       primary,
    secondary:       noItsr.length
      ? { title: `Incidents above ${ITSR_THRESHOLD_MINS}m without an ITSR (${noItsr.length})`, incidents: noItsr.map(x => toPmcRow(x.inc, x.note)) }
      : undefined,
    insights,
    status:          curRevById.size === 0
      ? 'No incident reviews loaded — ITSR adherence cannot be measured until reviews are captured.'
      : undefined,
    itsrPct,
    itsrCount,
    itsrCompleted,
    itsrMissing,
    itsrUnreviewed,
  }
}

// ─── Topic: Passenger satisfaction (placeholder) ──────────────────────────────

function buildSatisfaction(): PmcTopicPlan {
  return {
    topic:     'Passenger satisfaction',
    summary:   {
      count: 0, prevCount: 0, countDeltaPct: null,
      delayMins: 0, prevDelay: 0, delayDeltaPct: null,
      uniqueLocations: 0, uniqueCcil: 0, uniqueTda: 0,
    },
    locations: [],
    incidents: [],
    insights:  [
      'Passenger satisfaction data is not yet captured in Insight.',
      'A dedicated source feed and survey integration will be implemented later — this section is reserved.',
    ],
    status: 'Pending implementation — data source not yet wired up.',
  }
}

// ─── Headline KPI summary across all topics ───────────────────────────────────

function buildHeadline(plan: Omit<ControlPmcPlan, 'headline'>): ReportKpi[] {
  const itsr = plan.itsr
  return [
    {
      label: 'PST · Fatalities',
      value: fmt(plan.fatalities.summary.count),
      delta: { signedPct: plan.fatalities.summary.countDeltaPct, deltaInverted: true, label: 'vs prev week' },
      critical: plan.fatalities.summary.count > 0,
    },
    {
      label: 'Stranded trains',
      value: fmt(plan.stranded.summary.count),
      delta: { signedPct: plan.stranded.summary.countDeltaPct, deltaInverted: true, label: 'vs prev week' },
    },
    {
      label: 'Irregular working',
      value: fmt(plan.irregular.summary.count),
      delta: { signedPct: plan.irregular.summary.countDeltaPct, deltaInverted: true, label: 'vs prev week' },
    },
    {
      label: 'PAX incidents',
      value: fmt(plan.pax.summary.count),
      delta: { signedPct: plan.pax.summary.countDeltaPct, deltaInverted: true, label: 'vs prev week' },
    },
    {
      label: 'Train faults',
      value: fmt(plan.trainFaults.summary.count),
      delta: { signedPct: plan.trainFaults.summary.countDeltaPct, deltaInverted: true, label: 'vs prev week' },
      hint: `${fmtMinsShort(plan.trainFaults.summary.delayMins)} total delay`,
    },
    {
      label: 'ITSR adherence',
      value: `${itsr.itsrPct.toFixed(0)}%`,
      hint: `${itsr.itsrCompleted}/${itsr.itsrCount} incidents > ${ITSR_THRESHOLD_MINS}m`,
    },
  ]
}

// ─── Public entry ─────────────────────────────────────────────────────────────

export function buildControlPmcPlan(
  curr: IncidentRow[],
  prev: IncidentRow[],
  reviews: IncidentReview[],
  prevReviews: IncidentReview[],
): ControlPmcPlan {
  const curRev  = new Map(reviews.map(r => [r.incident_id, r]))
  const prevRev = new Map(prevReviews.map(r => [r.incident_id, r]))

  const fatalities  = buildFatalities(curr, prev)
  const stranded    = buildStranded(curr, prev, curRev, prevRev)
  const irregular   = buildIrregular(curr, prev)
  const pax         = buildPax(curr, prev)
  const trainFaults = buildTrainFaults(curr, prev)
  const itsr        = buildItsr(curr, prev, curRev, prevRev)
  const satisfaction = buildSatisfaction()

  const partial: Omit<ControlPmcPlan, 'headline'> = {
    fatalities, stranded, irregular, pax, trainFaults, itsr, satisfaction,
  }
  return { ...partial, headline: buildHeadline(partial) }
}

// ─── CSV serialiser ──────────────────────────────────────────────────────────
// One row per incident across every topic — flat, audit-friendly format that
// drops cleanly into Excel / Power BI.

function csvEscape(v: string | number | null | undefined): string {
  if (v == null) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function serialiseControlPmcCsv(plan: ControlPmcPlan, scopeLabel: string, generatedAt: string): string {
  const header = [
    'topic', 'section', 'date', 'ccil', 'tda', 'category', 'title',
    'location', 'area', 'delay_mins', 'trains_delayed', 'cancelled', 'part_cancelled', 'note',
  ]

  const rows: string[][] = []
  const push = (topic: string, section: string, list: PmcIncidentRow[]) => {
    for (const r of list) {
      rows.push([
        topic, section, r.date, r.ccil ?? '', r.tda ?? '',
        CATEGORY_CONFIG[r.category]?.label ?? r.category,
        r.title ?? '', r.location ?? '', r.area ?? '',
        String(r.delayMins), String(r.trainsDelayed),
        String(r.cancelled), String(r.partCancelled), r.note ?? '',
      ])
    }
  }
  push('Fatalities · Person Struck', 'Primary',  plan.fatalities.incidents)
  push('Stranded trains',            'Primary',  plan.stranded.incidents)
  push('Irregular working',          'Primary',  plan.irregular.incidents)
  push('PAX incidents',              'Top 10',   plan.pax.incidents)
  push('Train faults',               '>200m',    plan.trainFaults.incidents)
  if (plan.trainFaults.secondary) push('Train faults', 'Top 5 ≤200m', plan.trainFaults.secondary.incidents)
  push('ITSR adherence',             'ITSR completed', plan.itsr.incidents)
  if (plan.itsr.secondary)        push('ITSR adherence', 'No ITSR / unreviewed', plan.itsr.secondary.incidents)

  // Summary block at the top — one summary row per topic
  const summary: string[][] = []
  const summaryHeader = [
    'topic', 'count', 'count_delta_pct', 'delay_mins', 'delay_delta_pct',
    'unique_locations', 'unique_ccil', 'unique_tda',
  ]
  const sline = (label: string, t: PmcTopicPlan) => summary.push([
    label,
    String(t.summary.count),
    t.summary.countDeltaPct == null ? '' : t.summary.countDeltaPct.toFixed(1),
    String(t.summary.delayMins),
    t.summary.delayDeltaPct == null ? '' : t.summary.delayDeltaPct.toFixed(1),
    String(t.summary.uniqueLocations),
    String(t.summary.uniqueCcil),
    String(t.summary.uniqueTda),
  ])
  sline('Fatalities · Person Struck', plan.fatalities)
  sline('Stranded trains',            plan.stranded)
  sline('Irregular working',          plan.irregular)
  sline('PAX incidents',              plan.pax)
  sline('Train faults',               plan.trainFaults)
  sline('ITSR adherence (>300m)',     plan.itsr)

  const lines: string[] = []
  lines.push(`# Control PMC weekly report — ${scopeLabel}`)
  lines.push(`# Generated: ${generatedAt}`)
  lines.push(`# ITSR adherence: ${plan.itsr.itsrPct.toFixed(1)}% (${plan.itsr.itsrCompleted}/${plan.itsr.itsrCount} incidents > ${ITSR_THRESHOLD_MINS}m)`)
  lines.push('')
  lines.push('## Topic summary')
  lines.push(summaryHeader.map(csvEscape).join(','))
  for (const r of summary) lines.push(r.map(csvEscape).join(','))
  lines.push('')
  lines.push('## Incident detail')
  lines.push(header.map(csvEscape).join(','))
  for (const r of rows) lines.push(r.map(csvEscape).join(','))
  return lines.join('\r\n') + '\r\n'
}

export function controlPmcCsvFilename(scopeLabel: string): string {
  const safe = scopeLabel.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return `emcc-control-pmc-${safe}.csv`
}
