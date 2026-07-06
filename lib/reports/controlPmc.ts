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
  CATEGORY_CONFIG, IncidentReview, IncidentRow,
} from '../types'
import { deriveRecoveryTrendByPeriod, effectiveDelay, nonContinuation } from '../queries'
import {
  ControlPmcPlan, PmcIncidentRow, PmcItsrPlan, PmcLocationRow,
  PmcRepeatMatch, PmcTopDelayDetail, PmcTopDelayPlan,
  PmcTopicPlan, PmcTopicSummary, ReportKpi,
} from './types'

const ITSR_THRESHOLD_MINS = 300
const TRAIN_FAULT_PRIMARY_MINS = 200
const PAX_TOPN = 10
const TRAIN_FAULT_SECONDARY_TOPN = 5
const TOP_DELAY_N = 5
const TOP_DELAY_MATCHES_CAP = 8
const HISTORICAL_LOOKBACK_DAYS = 183  // ~6 months

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
  const f = (rows: IncidentRow[]) => nonContinuation(rows).filter(i => i.category === 'PERSON_STRUCK')
  const cur = f(curr)
  const pre = f(prev)
  const summary = summarise(cur, pre)

  const insights: string[] = []
  if (cur.length === 0)         insights.push('Zero person-struck or fatality incidents recorded in this week.')
  if (cur.length > pre.length)  insights.push(`Up from ${pre.length} the previous week.`)

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
  if (cur.length === 0) insights.push('No irregular-working events captured this week.')
  if (summary.countDeltaPct != null && summary.countDeltaPct > 50) {
    insights.push(`Volume up ${Math.round(summary.countDeltaPct)}% on the previous week.`)
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

// ─── Top 5 highest-delay incidents (deep-dive) ───────────────────────────────
// Filter-blind, category-blind ranking of the worst-disruption incidents in
// the week. Each entry carries the full incident record plus a list of any
// matching events from the trailing six months (same fault number, or same
// location + asset type) to highlight repeat problems.

function isValidFaultNumber(fn: string | null | undefined): fn is string {
  if (!fn) return false
  const n = fn.trim().toLowerCase()
  return n !== '' && n !== 'n/a' && n !== 'na' && n !== 'n-a' && n !== 'nil' && n !== 'none'
}

function normKey(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

function isoMinusDays(iso: string, days: number): string {
  const ms = new Date(iso + 'T00:00:00Z').getTime() - days * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

function findRepeatMatches(target: IncidentRow, history: IncidentRow[]): { matches: PmcRepeatMatch[]; note: string } {
  const matchedById = new Map<string, PmcRepeatMatch>()
  const targetFault = isValidFaultNumber(target.fault_number) ? target.fault_number.trim() : null
  const targetLoc   = normKey(target.location)
  const targetCode  = normKey(target.incident_type_code)
  const targetLabel = normKey(target.incident_type_label)

  for (const i of history) {
    if (i.id === target.id) continue
    if (i.is_continuation) continue
    let matchedOn: 'fault' | 'location-type' | null = null

    if (targetFault) {
      const fn = i.fault_number?.trim()
      if (fn && fn === targetFault) matchedOn = 'fault'
    }
    if (!matchedOn && targetLoc) {
      const loc = normKey(i.location)
      if (loc === targetLoc) {
        const codeMatch  = targetCode  !== '' && normKey(i.incident_type_code)  === targetCode
        const labelMatch = targetLabel !== '' && normKey(i.incident_type_label) === targetLabel
        const sameCategory = i.category === target.category
        // Match on type (preferred) — fall back to same category at the same
        // location when neither code nor label is captured.
        if (codeMatch || labelMatch || sameCategory) matchedOn = 'location-type'
      }
    }
    if (!matchedOn) continue
    matchedById.set(i.id, {
      id:        i.id,
      date:      i.report_date,
      ccil:      i.ccil,
      title:     i.title,
      delayMins: effectiveDelay(i),
      location:  i.location,
      area:      i.area,
      matchedOn,
    })
  }

  const matches = Array.from(matchedById.values())
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, TOP_DELAY_MATCHES_CAP)

  // Human-readable summary of the search rule used for this incident
  const parts: string[] = []
  if (targetFault) parts.push(`fault no. ${targetFault}`)
  if (targetLoc)   parts.push(`same location ("${target.location}")`)
  if (targetCode || targetLabel) {
    const t = target.incident_type_label || target.incident_type_code
    if (t) parts.push(`same incident type ("${t}")`)
  }
  const note = parts.length
    ? `Searched ${HISTORICAL_LOOKBACK_DAYS} days for: ${parts.join(' OR ')}.`
    : 'No fault number / location / type captured — repeat lookup limited.'

  return { matches, note }
}

function toTopDelayDetail(i: IncidentRow, history: IncidentRow[]): PmcTopDelayDetail {
  const cfg = CATEGORY_CONFIG[i.category]
  const { matches, note } = findRepeatMatches(i, history)
  return {
    id:               i.id,
    date:             i.report_date,
    ccil:             i.ccil,
    tda:              i.tda_ref,
    category:         i.category,
    categoryLabel:    cfg.label,
    categoryShort:    cfg.short,
    categoryColor:    cfg.color,
    severity:         i.severity,
    title:            i.title,
    location:         i.location,
    area:             i.area,
    line:             i.line,
    delayMins:        effectiveDelay(i),
    trainsDelayed:    i.trains_delayed,
    cancelled:        i.cancelled,
    partCancelled:    i.part_cancelled,
    incidentStart:    i.incident_start,
    advisedTime:      i.advised_time,
    initialRespTime:  i.initial_resp_time,
    arrivedAtTime:    i.arrived_at_time,
    nwrTime:          i.nwr_time,
    minsToAdvised:    i.mins_to_advised,
    minsToResponse:   i.mins_to_response,
    minsToArrival:    i.mins_to_arrival,
    incidentDuration: i.incident_duration,
    incidentTypeCode: i.incident_type_code,
    incidentTypeLabel: i.incident_type_label,
    faultNumber:      i.fault_number,
    possessionRef:    i.possession_ref,
    btpRef:           i.btp_ref,
    thirdPartyRef:    i.third_party_ref,
    trustRef:         i.trust_ref,
    tdaRef:           i.tda_ref,
    trmcCode:         i.trmc_code,
    actionCode:       i.action_code,
    responderInitials: i.responder_initials,
    trainId:          i.train_id,
    trainCompany:     i.train_company,
    trainOrigin:      i.train_origin,
    trainDestination: i.train_destination,
    unitNumbers:      i.unit_numbers,
    eventCount:       i.event_count,
    ftsDivCount:      i.fts_div_count,
    hasFiles:         i.has_files,
    hourOfDay:        i.hour_of_day,
    dayOfWeek:        i.day_of_week,
    matches,
    matchNote:        note,
  }
}

function buildTopDelay(
  curr: IncidentRow[],
  history: IncidentRow[],
  weekFrom: string,
  weekTo: string,
  flaggedIds: Set<string>,
): PmcTopDelayPlan {
  // The history pool covers the lookback window plus the current week — we
  // exclude the target row's own id when matching so the same incident never
  // matches itself.
  const lookbackFrom = isoMinusDays(weekFrom, HISTORICAL_LOOKBACK_DAYS)
  const pool = history.filter(h => h.report_date >= lookbackFrom && h.report_date <= weekTo)

  // Manually flagged incidents replace the automatic ranking when present.
  // Flags are filter-blind like the ranking itself, so resolve them against
  // the unfiltered history pool where available (falling back to the
  // filtered week set when the historical dataset isn't loaded), and present
  // them lowest → highest impact.
  const weekPool = pool.filter(h => h.report_date >= weekFrom)
  const flagSource = weekPool.length > 0 ? weekPool : curr
  const flagged = flaggedIds.size === 0 ? [] : nonContinuation(flagSource)
    .filter(i => flaggedIds.has(i.id))
    .map(i => ({ inc: i, delay: effectiveDelay(i) }))
    .sort((a, b) => a.delay - b.delay)
    .slice(0, TOP_DELAY_N)

  const mode: PmcTopDelayPlan['mode'] = flagged.length > 0 ? 'flagged' : 'ranked'

  const ranked = mode === 'flagged' ? flagged : nonContinuation(curr)
    .map(i => ({ inc: i, delay: effectiveDelay(i) }))
    .filter(x => x.delay > 0)
    .sort((a, b) => b.delay - a.delay)
    .slice(0, TOP_DELAY_N)

  const incidents = ranked.map(x => toTopDelayDetail(x.inc, pool))

  const insights: string[] = []
  if (incidents.length === 0) {
    insights.push('No delay-incurring incidents in the week — section presented for completeness.')
  } else {
    if (mode === 'flagged') {
      insights.push(`${incidents.length} incident${incidents.length === 1 ? '' : 's'} manually flagged for this reporting week — replacing the automatic top-5-by-delay ranking, presented lowest → highest impact.`)
    }
    const totalTop = incidents.reduce((s, i) => s + i.delayMins, 0)
    const weekTotal = nonContinuation(curr).reduce((s, i) => s + effectiveDelay(i), 0)
    const share = weekTotal > 0 ? Math.round((totalTop / weekTotal) * 100) : 0
    const setNoun = mode === 'flagged' ? 'Flagged' : 'Top'
    insights.push(`${setNoun} ${incidents.length} incident${incidents.length === 1 ? '' : 's'} account${incidents.length === 1 ? 's' : ''} for ${share}% of the week's total delay (${fmtMinsShort(totalTop)} of ${fmtMinsShort(weekTotal)}).`)
    const repeats = incidents.filter(i => i.matches.length > 0).length
    if (repeats > 0) {
      insights.push(`${repeats} of the ${incidents.length} match historical incidents in the trailing ${HISTORICAL_LOOKBACK_DAYS} days — flagged as candidate repeat issues.`)
    }
    if (history.length === 0) {
      insights.push('Historical 6-month dataset not loaded — repeat-match lookup is unavailable for this preview.')
    }
  }

  return {
    topic:       mode === 'flagged'
      ? `Flagged incidents — Control PMC (${incidents.length} of max ${TOP_DELAY_N})`
      : 'Top 5 delay-incurring incidents',
    windowFrom:  lookbackFrom,
    windowTo:    weekTo,
    mode,
    incidents,
    insights,
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
  history: IncidentRow[],
  weekFrom: string,
  weekTo: string,
  allReviews: IncidentReview[] = [],
  pmcFlaggedIds: string[] = [],
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
  const topDelay    = buildTopDelay(curr, history, weekFrom, weekTo, new Set(pmcFlaggedIds))

  // Recovery trend uses the broadest review pool available. Fall back to
  // current + previous week when no historical window was provided.
  const trendPool = allReviews.length > 0 ? allReviews : [...prevReviews, ...reviews]
  const recoveryTrend = deriveRecoveryTrendByPeriod(trendPool)

  const partial: Omit<ControlPmcPlan, 'headline'> = {
    fatalities, stranded, irregular, pax, trainFaults, itsr, satisfaction, topDelay, recoveryTrend,
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
  // Top-5 / flagged deep-dive — emit each as a regular detail row, then a
  // follow-up row per matched historical incident so the CSV remains flat /
  // Excel-friendly.
  const topDelayTopic = plan.topDelay.mode === 'flagged'
    ? 'Flagged incidents (Control PMC)'
    : 'Top 5 delay incidents'
  for (const t of plan.topDelay.incidents) {
    rows.push([
      topDelayTopic, 'Headline', t.date, t.ccil ?? '', t.tda ?? '',
      CATEGORY_CONFIG[t.category]?.label ?? t.category,
      t.title ?? '', t.location ?? '', t.area ?? '',
      String(t.delayMins), String(t.trainsDelayed),
      String(t.cancelled), String(t.partCancelled),
      [t.incidentTypeLabel, t.faultNumber ? `fault ${t.faultNumber}` : null, t.severity].filter(Boolean).join(' · '),
    ])
    for (const m of t.matches) {
      rows.push([
        topDelayTopic,
        `Repeat match (${m.matchedOn}) of ${t.ccil ?? t.date}`,
        m.date, m.ccil ?? '', '',
        CATEGORY_CONFIG[t.category]?.label ?? t.category,
        m.title ?? '', m.location ?? '', m.area ?? '',
        String(m.delayMins), '', '', '',
        `Matched on ${m.matchedOn}`,
      ])
    }
  }

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
  lines.push(`# Top-5 historical lookup window: ${plan.topDelay.windowFrom} → ${plan.topDelay.windowTo}`)
  if (plan.topDelay.mode === 'flagged') {
    lines.push('# Deep-dive mode: manually flagged incidents (lowest → highest impact) — replaces the top-5-by-delay ranking')
  }
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
