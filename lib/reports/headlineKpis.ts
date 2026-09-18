// ─── Shared headline KPI set ─────────────────────────────────────────────────
// One definition of the six headline numbers, used by both the Period Report
// ("Headline KPIs" section) and the Control PMC week summary so the two packs
// can never drift apart on what a metric means:
//
//   1. Number of incidents   — continuation-aware count of unique events
//   2. Average duration      — incident start → normal working resumed
//   3. Arrival SLA           — % of incidents attended inside the 45-min target
//   4. ITSR adherence        — % of applicable >300m incidents with an ITSR
//   5. Average time stranded — mean stranded → moved across reviewed trains
//   6. Average time to recover — mean incident start → actual recovery
//
// The last three ride on the incident_reviews side-table: without reviews on
// file they read as unreviewed rather than as good news.

import { IncidentReview, IncidentRow } from '../types'
import {
  ITSR_THRESHOLD_MINS, SLA_THRESHOLD_MINS, deriveItsrAdherence, deriveRecoveryStats,
  effectiveDuration, effectiveMinsToArrival, nonContinuation,
} from '../queries'
import { ReportKpi } from './types'

export interface HeadlineKpiInput {
  incidents:     IncidentRow[]
  prevIncidents: IncidentRow[]
  reviews:       IncidentReview[]
  prevReviews:   IncidentReview[]
  /** Delta caption, e.g. "vs prior" for a period, "vs prev week" for the PMC. */
  deltaLabel:    string
}

function pctDelta(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null
  return ((curr - prev) / prev) * 100
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-GB', { maximumFractionDigits: 0 })
}

function fmtMins(n: number): string {
  if (n >= 60) {
    const h = Math.floor(n / 60)
    const m = Math.round(n % 60)
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  return `${Math.round(n)}m`
}

function mean(nums: number[]): number | null {
  return nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : null
}

function avgDuration(rows: IncidentRow[]): number | null {
  return mean(nonContinuation(rows).map(effectiveDuration).filter((n): n is number => n != null))
}

/** Arrival times inside the window, continuation-aware. */
function arrivalTimes(rows: IncidentRow[]): number[] {
  return nonContinuation(rows).map(effectiveMinsToArrival).filter((n): n is number => n != null)
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many
}

// Reviews are fetched for the whole window, unfiltered. The incident bundle
// handed to the builder has already had the dashboard filters applied, so the
// review pool is narrowed to it — otherwise the recovery averages would quietly
// report on areas and categories the rest of the tiles have excluded.
function scopeToIncidents(reviews: IncidentReview[], incidents: IncidentRow[]): IncidentReview[] {
  const ids = new Set(incidents.map(i => i.id))
  return reviews.filter(r => ids.has(r.incident_id))
}

export function buildHeadlineKpis(input: HeadlineKpiInput): ReportKpi[] {
  const { incidents, prevIncidents, reviews, prevReviews, deltaLabel } = input

  // 1 — Number of incidents
  const count     = nonContinuation(incidents).length
  const prevCount = nonContinuation(prevIncidents).length

  // 2 — Average duration
  const dur     = avgDuration(incidents)
  const prevDur = avgDuration(prevIncidents)

  // 3 — Arrival SLA
  const arrivals     = arrivalTimes(incidents)
  const breaches     = arrivals.filter(m => m > SLA_THRESHOLD_MINS).length
  const slaPct       = arrivals.length > 0 ? ((arrivals.length - breaches) / arrivals.length) * 100 : null
  const prevBreaches = arrivalTimes(prevIncidents).filter(m => m > SLA_THRESHOLD_MINS).length

  // 4 — ITSR adherence
  const revById     = new Map(reviews.map(r => [r.incident_id, r]))
  const prevRevById = new Map(prevReviews.map(r => [r.incident_id, r]))
  const itsr        = deriveItsrAdherence(incidents, revById)
  const prevItsr    = deriveItsrAdherence(prevIncidents, prevRevById)

  // 5 & 6 — Time stranded / time to recover
  const rec     = deriveRecoveryStats(scopeToIncidents(reviews, incidents))
  const prevRec = deriveRecoveryStats(scopeToIncidents(prevReviews, prevIncidents))

  const itsrHint = itsr.unreviewed.length > 0
    ? `${itsr.completed.length}/${itsr.applicable} applicable >${ITSR_THRESHOLD_MINS}m · ${itsr.unreviewed.length} unreviewed`
    : `${itsr.completed.length}/${itsr.applicable} applicable incidents >${ITSR_THRESHOLD_MINS}m`

  return [
    {
      label: 'Incidents',
      value: fmtCount(count),
      delta: { signedPct: pctDelta(count, prevCount), deltaInverted: true, label: deltaLabel },
    },
    {
      label: 'Avg duration',
      value: dur != null ? fmtMins(dur) : '—',
      delta: dur != null && prevDur != null
        ? { signedPct: pctDelta(dur, prevDur), deltaInverted: true, label: deltaLabel }
        : undefined,
      hint: dur == null ? 'No closed incidents with timings' : undefined,
    },
    {
      label: 'Arrival SLA',
      value: slaPct != null ? `${slaPct.toFixed(0)}%` : '—',
      delta: arrivals.length > 0
        ? { signedPct: pctDelta(breaches, prevBreaches), deltaInverted: true, label: 'breach Δ' }
        : undefined,
      hint: slaPct != null
        ? `${breaches} ${plural(breaches, 'breach', 'breaches')} of the ${SLA_THRESHOLD_MINS}-min target`
        : 'No arrival times recorded',
      critical: slaPct != null && slaPct < 50,
    },
    {
      label: 'ITSR adherence',
      value: `${itsr.pct.toFixed(0)}%`,
      // Rising adherence is good, so this delta is not inverted. Expressed in
      // percentage POINTS — a relative change between two rates would read as
      // "+250%" for a 5% → 17% move. Only shown when the prior window had an
      // applicable population to compare with.
      delta: prevItsr.applicable > 0
        ? { signedPct: itsr.pct - prevItsr.pct, deltaInverted: false, unit: 'pts' as const, label: deltaLabel }
        : undefined,
      hint: itsrHint,
    },
    {
      label: 'Avg time stranded',
      value: rec.avgTimeStrandedMins != null ? fmtMins(rec.avgTimeStrandedMins) : '—',
      delta: rec.avgTimeStrandedMins != null && prevRec.avgTimeStrandedMins != null
        ? { signedPct: pctDelta(rec.avgTimeStrandedMins, prevRec.avgTimeStrandedMins), deltaInverted: true, label: deltaLabel }
        : undefined,
      hint: rec.strandedSamples > 0
        ? `${rec.strandedSamples} stranded ${plural(rec.strandedSamples, 'train')} on reviewed incidents`
        : 'No stranded trains on reviewed incidents',
    },
    {
      label: 'Avg time to recover',
      value: rec.avgTimeToRecoverMins != null ? fmtMins(rec.avgTimeToRecoverMins) : '—',
      delta: rec.avgTimeToRecoverMins != null && prevRec.avgTimeToRecoverMins != null
        ? { signedPct: pctDelta(rec.avgTimeToRecoverMins, prevRec.avgTimeToRecoverMins), deltaInverted: true, label: deltaLabel }
        : undefined,
      hint: rec.recoverSamples > 0
        ? `${rec.recoverSamples} reviewed ${plural(rec.recoverSamples, 'incident')} with a recovery time`
        : 'No recovery times captured in reviews',
    },
  ]
}
