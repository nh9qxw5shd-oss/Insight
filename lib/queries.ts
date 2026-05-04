'use client'

import { getSupabase } from './supabase'
import {
  AnalyticsFilters, IncidentRow, ReportRow, KPISummary, TrendPoint,
  CategoryDatum, LocationDatum, RepeatFault, RepeatAsset, InfraFailureDatum,
  DelayDensityDatum, ResponderLoad, OperatorImpact, ResponseDistribution,
  HeatmapCell, IncidentCategory, CATEGORY_CONFIG, SEVERITY_CONFIG, SAFETY_CATEGORIES,
  REPEAT_ASSET_CATEGORIES, INFRA_MIX_CATEGORIES,
  Signal, SignalType, LineDatum, AttributionDatum, Chain,
  ChangePoint, DeltaMetric, DeltaContribution, DeltaDecomposition, Severity,
  Hypothesis, HypothesisCluster, HypothesisDimension,
} from './types'

export const SLA_THRESHOLD_MINS = 45   // arrival within 45 minutes is on-time

// ─── Date helpers ────────────────────────────────────────────────────────────

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function resolveWindow(f: AnalyticsFilters): { from: string; to: string; days: number } {
  if (f.startDate && f.endDate) {
    const fromMs = new Date(f.startDate + 'T00:00:00Z').getTime()
    const toMs   = new Date(f.endDate   + 'T00:00:00Z').getTime()
    const days = Math.max(1, Math.round((toMs - fromMs) / 86_400_000) + 1)
    return { from: f.startDate, to: f.endDate, days }
  }
  // Logs cover the previous 24-hour period, so today never has data.
  // End the rolling window at yesterday to avoid a trailing zero on charts.
  const toMs   = Date.now() - 86_400_000
  const fromMs = toMs - (f.windowDays - 1) * 86_400_000
  return {
    from: new Date(fromMs).toISOString().slice(0, 10),
    to:   new Date(toMs).toISOString().slice(0, 10),
    days: f.windowDays,
  }
}

function previousWindow(f: AnalyticsFilters): { from: string; to: string } {
  const w = resolveWindow(f)
  const winFromMs  = new Date(w.from + 'T00:00:00Z').getTime()
  const prevToMs   = winFromMs - 86_400_000
  const prevFromMs = prevToMs  - (w.days - 1) * 86_400_000
  return {
    from: new Date(prevFromMs).toISOString().slice(0, 10),
    to:   new Date(prevToMs).toISOString().slice(0, 10),
  }
}

// ─── Pagination helper ───────────────────────────────────────────────────────
// PostgREST's server-side max-rows cap (default 1 000) cannot be overridden
// by the client — .limit() is silently clamped. We page through in 1 000-row
// chunks and stop when a partial page (or empty page) is returned.

async function fetchAllRows<T>(
  queryFn: () => { range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> },
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = []
  let from = 0
  while (true) {
    const { data, error } = await queryFn().range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as T[]
    all.push(...rows)
    if (rows.length < pageSize) break
    from += pageSize
  }
  return all
}

// ─── Master fetch ────────────────────────────────────────────────────────────

export interface RawData {
  incidents: IncidentRow[]
  prevIncidents: IncidentRow[]
  reports: ReportRow[]
  windowFrom: string
  windowTo: string
  windowDays: number
}

const INCIDENT_COLS =
  'id, report_date, report_id, ccil, category, severity, title, location, area, ' +
  'incident_start, minutes_delay, trains_delayed, cancelled, part_cancelled, ' +
  'is_highlight, is_continuation, delay_delta, ' +
  'incident_type_code, incident_type_label, line, fault_number, possession_ref, ' +
  'btp_ref, third_party_ref, action_code, responder_initials, ' +
  'advised_time, initial_resp_time, arrived_at_time, nwr_time, ' +
  'mins_to_advised, mins_to_response, mins_to_arrival, incident_duration, ' +
  'train_id, train_company, train_origin, train_destination, unit_numbers, ' +
  'trust_ref, tda_ref, trmc_code, fts_div_count, event_count, has_files, ' +
  'hour_of_day, day_of_week'

export async function fetchAnalytics(f: AnalyticsFilters): Promise<RawData | null> {
  const sb = getSupabase()
  if (!sb) return null

  const cur = resolveWindow(f)
  const prev = previousWindow(f)

  // Current window — paginate to bypass the PostgREST server-side max-rows cap
  const curRows = await fetchAllRows<IncidentRow>(() => {
    let q = sb!.from('incidents').select(INCIDENT_COLS)
      .gte('report_date', cur.from)
      .lte('report_date', cur.to)
      .order('report_date', { ascending: true })
    if (f.areas.length)      q = q.in('area', f.areas)
    if (f.categories.length) q = q.in('category', f.categories)
    if (f.severities.length) q = q.in('severity', f.severities)
    return q
  })

  // Previous window — same filters as current window for accurate delta calc
  const prevRows = await fetchAllRows<IncidentRow>(() => {
    let q = sb!.from('incidents').select(INCIDENT_COLS)
      .gte('report_date', prev.from)
      .lte('report_date', prev.to)
      .order('report_date', { ascending: true })
    if (f.areas.length)      q = q.in('area', f.areas)
    if (f.categories.length) q = q.in('category', f.categories)
    if (f.severities.length) q = q.in('severity', f.severities)
    return q
  })

  // Reports row count (for "reports covered" KPI)
  const reportRows = await fetchAllRows<ReportRow>(() =>
    sb!.from('reports').select('*')
      .gte('report_date', cur.from)
      .lte('report_date', cur.to)
  )

  // Apply free-text filter client-side
  const activeSearches = f.searches.map(s => s.trim()).filter(Boolean)
  const matchFn = f.searchMode === 'and'
    ? (i: IncidentRow) => activeSearches.every(q => searchMatch(i, q))
    : (i: IncidentRow) => activeSearches.some(q => searchMatch(i, q))
  const filtered = activeSearches.length ? curRows.filter(matchFn) : curRows

  return {
    incidents: filtered,
    prevIncidents: prevRows,
    reports: reportRows,
    windowFrom: cur.from,
    windowTo: cur.to,
    windowDays: cur.days,
  }
}

export function searchMatch(i: IncidentRow, q: string): boolean {
  const needle = q.toLowerCase()
  return (
    (i.title || '').toLowerCase().includes(needle) ||
    (i.location || '').toLowerCase().includes(needle) ||
    (i.area || '').toLowerCase().includes(needle) ||
    (i.fault_number || '').toLowerCase().includes(needle) ||
    (i.train_id || '').toLowerCase().includes(needle) ||
    (i.ccil || '').toLowerCase().includes(needle) ||
    (i.incident_type_label || '').toLowerCase().includes(needle) ||
    (i.incident_type_code || '').toLowerCase().includes(needle) ||
    (i.line || '').toLowerCase().includes(needle) ||
    (i.train_company || '').toLowerCase().includes(needle)
  )
}

// ─── Derivers ────────────────────────────────────────────────────────────────
// Continuation-aware: a CCIL that re-appears day-by-day is a single event, so
// it's counted once and only its incremental delay (delay_delta) is summed.

export function effectiveDelay(i: IncidentRow): number {
  return i.is_continuation ? (i.delay_delta ?? 0) : (i.minutes_delay ?? 0)
}

export function nonContinuation<T extends { is_continuation: boolean }>(rows: T[]): T[] {
  return rows.filter(r => !r.is_continuation)
}

function median(nums: number[]): number | null {
  const valid = nums.filter(n => n != null && !isNaN(n))
  if (!valid.length) return null
  const sorted = [...valid].sort((a, b) => a - b)
  const m = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

// Parse elapsed minutes between two "HH:MM" strings, handling cross-midnight.
function minsFromTimes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    return isNaN(h) || isNaN(m) ? null : h * 60 + m
  }
  const s = toMin(start)
  const e = toMin(end)
  if (s == null || e == null) return null
  const diff = e >= s ? e - s : e + 1440 - s  // handle cross-midnight
  return diff
}

// Effective timing getters — prefer precomputed DB columns, fall back to
// parsing the raw HH:MM strings so incidents without computed columns still
// contribute to distributions and median calculations.
export function effectiveMinsToAdvised(i: IncidentRow): number | null {
  if (i.mins_to_advised != null && i.mins_to_advised >= 0 && i.mins_to_advised < 1440)
    return i.mins_to_advised
  const v = minsFromTimes(i.incident_start, i.advised_time)
  return v != null && v >= 0 && v < 1440 ? v : null
}

export function effectiveMinsToResponse(i: IncidentRow): number | null {
  if (i.mins_to_response != null && i.mins_to_response >= 0 && i.mins_to_response < 1440)
    return i.mins_to_response
  const v = minsFromTimes(i.incident_start, i.initial_resp_time)
  return v != null && v >= 0 && v < 1440 ? v : null
}

export function effectiveMinsToArrival(i: IncidentRow): number | null {
  if (i.mins_to_arrival != null && i.mins_to_arrival >= 0 && i.mins_to_arrival < 1440)
    return i.mins_to_arrival
  const v = minsFromTimes(i.incident_start, i.arrived_at_time)
  return v != null && v >= 0 && v < 1440 ? v : null
}

export function effectiveDuration(i: IncidentRow): number | null {
  if (i.incident_duration != null && i.incident_duration > 0 && i.incident_duration < 1440)
    return i.incident_duration
  const v = minsFromTimes(i.incident_start, i.nwr_time)
  return v != null && v > 0 && v < 1440 ? v : null
}

function pctDelta(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null
  return ((curr - prev) / prev) * 100
}

export function deriveKPIs(data: RawData): KPISummary {
  const cur = data.incidents
  const prev = data.prevIncidents

  const curUnique = nonContinuation(cur)
  const prevUnique = nonContinuation(prev)

  const totalDelay = cur.reduce((s, i) => s + effectiveDelay(i), 0)
  const prevDelay  = prev.reduce((s, i) => s + effectiveDelay(i), 0)

  const totalCancelled     = cur.reduce((s, i) => s + (i.cancelled || 0), 0)
  const totalPartCancelled = cur.reduce((s, i) => s + (i.part_cancelled || 0), 0)

  const safetyCount = curUnique.filter(i => SAFETY_CATEGORIES.includes(i.category)).length
  const prevSafety  = prevUnique.filter(i => SAFETY_CATEGORIES.includes(i.category)).length

  const durations = curUnique.map(effectiveDuration).filter((n): n is number => n != null)
  const avgDuration = durations.length
    ? durations.reduce((s, n) => s + n, 0) / durations.length
    : null

  const prevDurations = prevUnique.map(effectiveDuration).filter((n): n is number => n != null)
  const prevAvgDuration = prevDurations.length
    ? prevDurations.reduce((s, n) => s + n, 0) / prevDurations.length
    : null

  const arrivalTimes = curUnique
    .map(effectiveMinsToArrival)
    .filter((n): n is number => n != null)

  const totalTrainsDelayed = curUnique.reduce((s, i) => s + (i.trains_delayed || 0), 0)

  // SLA compliance: % of incidents where responder arrived within threshold
  const slaEligible    = arrivalTimes.length
  const slaBreachCount = arrivalTimes.filter(m => m > SLA_THRESHOLD_MINS).length
  const slaCompliancePct = slaEligible > 0
    ? ((slaEligible - slaBreachCount) / slaEligible) * 100
    : null

  const prevArrivalTimes = prevUnique
    .map(effectiveMinsToArrival)
    .filter((n): n is number => n != null)
  const prevSlaBreachCount = prevArrivalTimes.filter(m => m > SLA_THRESHOLD_MINS).length

  return {
    totalIncidents: curUnique.length,
    totalDelayMins: totalDelay,
    totalCancelled,
    totalPartCancelled,
    totalTrainsDelayed,
    avgIncidentDuration: avgDuration,
    medianArrivalMins: median(arrivalTimes),
    safetyCriticalCount: safetyCount,
    reportsCovered: data.reports.length,
    slaBreachCount,
    slaCompliancePct,
    delayDeltaPct: pctDelta(totalDelay, prevDelay),
    incidentsDeltaPct: pctDelta(curUnique.length, prevUnique.length),
    safetyDeltaPct: pctDelta(safetyCount, prevSafety),
    durationDeltaPct: avgDuration != null && prevAvgDuration != null
      ? pctDelta(avgDuration, prevAvgDuration) : null,
    slaBreachDeltaPct: pctDelta(slaBreachCount, prevSlaBreachCount),
  }
}

export function deriveTrend(data: RawData): TrendPoint[] {
  const byDate = new Map<string, TrendPoint>()
  // Seed every day in window so the chart has continuous x-axis (UTC to avoid local/UTC mismatch)
  const startMs = new Date(data.windowFrom + 'T00:00:00Z').getTime()
  for (let i = 0; i < data.windowDays; i++) {
    const k = new Date(startMs + i * 86_400_000).toISOString().slice(0, 10)
    byDate.set(k, { date: k, incidents: 0, delayMins: 0, safetyCritical: 0 })
  }
  for (const inc of data.incidents) {
    const pt = byDate.get(inc.report_date)
    if (!pt) continue
    pt.delayMins += effectiveDelay(inc)
    if (!inc.is_continuation) {
      pt.incidents += 1
      if (SAFETY_CATEGORIES.includes(inc.category)) pt.safetyCritical += 1
    }
  }
  const pts = Array.from(byDate.values())

  // Rolling 7-day averages for all series
  for (let i = 0; i < pts.length; i++) {
    const window = pts.slice(Math.max(0, i - 6), i + 1)
    pts[i].rolling7Avg       = window.reduce((s, p) => s + p.incidents,      0) / window.length
    pts[i].rolling7DelayAvg  = window.reduce((s, p) => s + p.delayMins,      0) / window.length
    pts[i].rolling7SafetyAvg = window.reduce((s, p) => s + p.safetyCritical, 0) / window.length
  }

  // Linear regression on incident counts (y = slope*x + intercept, x = day index)
  if (pts.length > 1) {
    const n = pts.length
    const sumX = (n * (n - 1)) / 2
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6
    const sumY = pts.reduce((s, p) => s + p.incidents, 0)
    const sumXY = pts.reduce((s, p, i) => s + i * p.incidents, 0)
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
    const intercept = (sumY - slope * sumX) / n
    for (let i = 0; i < pts.length; i++) {
      pts[i].regressionY = Math.max(0, slope * i + intercept)
    }
  }

  // Stability band: rolling 14-day baseline (mean ± 2σ) on the incidents
  // series. The lookback is causal (uses prior days only) so the band
  // describes "what we'd expect today given the recent past" — days outside
  // it are flagged anomalous and rendered with a marker on the trend chart.
  const BASELINE_LOOKBACK = 14
  const Z = 2
  for (let i = 0; i < pts.length; i++) {
    const start = Math.max(0, i - BASELINE_LOOKBACK)
    const window = pts.slice(start, i)
    if (window.length < 4) continue   // need a few priors before band is meaningful
    const vals = window.map(p => p.incidents)
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length
    const sigma = Math.sqrt(variance)
    const low  = Math.max(0, mean - Z * sigma)
    const high = mean + Z * sigma
    pts[i].baselineMean = mean
    pts[i].baselineLow  = low
    pts[i].baselineHigh = high
    pts[i].baselineBand = [low, high]
    pts[i].isAnomalous  = pts[i].incidents > high || pts[i].incidents < low
  }

  return pts
}

// ─── Change-point detection ──────────────────────────────────────────────────
// Two-sided CUSUM scan: accumulate (xᵢ − μ̂) and reset whenever the running
// sum dips back through zero. A change point fires when the running sum
// exceeds k × σ̂ for an extended run — at that point we record the position
// and start the next pass from the day after. Crude but effective for the
// short series the dashboard runs over (7-365 days), and it produces stable
// results without needing a stats library.

function changePointsForSeries(
  pts: TrendPoint[],
  metric: 'incidents' | 'delayMins' | 'safetyCritical',
  threshold = 4,             // higher = fewer / stronger change-points
): ChangePoint[] {
  if (pts.length < 14) return []
  const xs = pts.map(p => p[metric])
  const mean  = xs.reduce((s, v) => s + v, 0) / xs.length
  const variance = xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length
  const sigma = Math.sqrt(variance)
  if (sigma === 0) return []

  const k = threshold * sigma
  const out: ChangePoint[] = []
  let segStart = 0
  let cumPos = 0
  let cumNeg = 0
  let cumPosMax = 0
  let cumNegMax = 0
  let cumPosMaxIdx = 0
  let cumNegMaxIdx = 0

  for (let i = 0; i < xs.length; i++) {
    const dev = xs[i] - mean
    cumPos = Math.max(0, cumPos + dev)
    cumNeg = Math.min(0, cumNeg + dev)
    if (cumPos > cumPosMax) { cumPosMax = cumPos; cumPosMaxIdx = i }
    if (cumNeg < cumNegMax) { cumNegMax = cumNeg; cumNegMaxIdx = i }

    if (cumPos > k || cumNeg < -k) {
      const isUp = cumPos > k
      const cpIdx = isUp ? cumPosMaxIdx : cumNegMaxIdx
      // Only record if there's enough room either side for stable means
      if (cpIdx - segStart >= 3 && xs.length - cpIdx - 1 >= 3) {
        const before = xs.slice(segStart, cpIdx + 1)
        const after  = xs.slice(cpIdx + 1, Math.min(xs.length, cpIdx + 1 + 14))
        const beforeMean = before.reduce((s, v) => s + v, 0) / before.length
        const afterMean  = after.reduce((s, v) => s + v, 0) / after.length
        // Reject change-points where the actual shift in means is too small
        // to be operationally meaningful (more than half a sigma).
        if (Math.abs(afterMean - beforeMean) >= sigma * 0.5) {
          out.push({
            date: pts[cpIdx].date,
            metric,
            direction: isUp ? 'up' : 'down',
            beforeMean,
            afterMean,
            magnitude: Math.abs(afterMean - beforeMean),
          })
        }
      }
      // Reset accumulators and segment marker
      segStart = cpIdx + 1
      cumPos = 0; cumNeg = 0
      cumPosMax = 0; cumNegMax = 0
      cumPosMaxIdx = segStart
      cumNegMaxIdx = segStart
    }
  }
  return out
}

export function deriveChangePoints(trend: TrendPoint[]): ChangePoint[] {
  return [
    ...changePointsForSeries(trend, 'incidents'),
    ...changePointsForSeries(trend, 'delayMins'),
  ].sort((a, b) => a.date.localeCompare(b.date))
}

// ─── Delta decomposition ─────────────────────────────────────────────────────
// Given a metric (incidents / delay / safety), break the change vs the prior
// window into per-dimension contributions: each row is "category X went from
// 12 to 28, contributing +16 (40% of the total +40 movement)". Top of mind
// for the "why did this change?" popover on KPI cards.

const HOUR_BANDS: { label: string; from: number; to: number }[] = [
  { label: 'Night 00–06', from: 0,  to: 6  },
  { label: 'AM 06–12',    from: 6,  to: 12 },
  { label: 'PM 12–18',    from: 12, to: 18 },
  { label: 'Eve 18–24',   from: 18, to: 24 },
]

function metricValue(i: IncidentRow, m: DeltaMetric): number {
  if (m === 'delay')   return effectiveDelay(i)
  if (m === 'safety')  return SAFETY_CATEGORIES.includes(i.category) && !i.is_continuation ? 1 : 0
  return i.is_continuation ? 0 : 1
}

function bandFor(hour: number | null): string | null {
  if (hour == null) return null
  for (const b of HOUR_BANDS) {
    if (hour >= b.from && hour < b.to) return b.label
  }
  return null
}

function buildContributions<K extends string>(
  curRows: IncidentRow[],
  prevRows: IncidentRow[],
  metric: DeltaMetric,
  keyFn: (i: IncidentRow) => K | null,
  labelFor: (k: K) => { label: string; color?: string },
  totalDelta: number,
  limit = 5,
): DeltaContribution[] {
  const acc = new Map<K, { current: number; previous: number }>()
  for (const i of curRows) {
    const k = keyFn(i); if (k == null) continue
    const e = acc.get(k) ?? { current: 0, previous: 0 }
    e.current += metricValue(i, metric)
    acc.set(k, e)
  }
  for (const i of prevRows) {
    const k = keyFn(i); if (k == null) continue
    const e = acc.get(k) ?? { current: 0, previous: 0 }
    e.previous += metricValue(i, metric)
    acc.set(k, e)
  }
  const denom = Math.abs(totalDelta) || 1
  const rows: DeltaContribution[] = Array.from(acc.entries()).map(([k, v]) => {
    const meta = labelFor(k)
    const contribution = v.current - v.previous
    return {
      key: String(k),
      label: meta.label,
      color: meta.color,
      current: v.current,
      previous: v.previous,
      contribution,
      contributionPct: (contribution / denom) * 100,
    }
  })
  // Sort by absolute contribution descending, drop zero-contribution rows
  return rows
    .filter(r => r.contribution !== 0 || (r.current !== 0 && r.previous !== 0))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, limit)
}

export function deriveDelta(data: RawData, metric: DeltaMetric): DeltaDecomposition {
  // Apply continuation filtering for incident-count and safety metrics; for
  // delay we *include* continuations because their delay_delta is a real
  // contribution to the window's total delay-minutes.
  const cur  = metric === 'delay' ? data.incidents      : data.incidents.filter(i => !i.is_continuation)
  const prev = metric === 'delay' ? data.prevIncidents  : data.prevIncidents.filter(i => !i.is_continuation)

  const currentTotal  = cur.reduce((s, i) => s + metricValue(i, metric), 0)
  const previousTotal = prev.reduce((s, i) => s + metricValue(i, metric), 0)
  const deltaAbs = currentTotal - previousTotal
  const deltaPct = pctDelta(currentTotal, previousTotal)

  const byCategory = buildContributions(
    cur, prev, metric,
    i => i.category as IncidentCategory,
    k => ({ label: CATEGORY_CONFIG[k]?.label ?? String(k), color: CATEGORY_CONFIG[k]?.color }),
    deltaAbs,
  )

  const byArea = buildContributions(
    cur, prev, metric,
    i => i.area ?? null,
    k => ({ label: k }),
    deltaAbs,
  )

  const bySeverity = buildContributions(
    cur, prev, metric,
    i => i.severity as Severity,
    k => ({ label: k, color: SEVERITY_CONFIG[k]?.color }),
    deltaAbs,
  )

  const byHourBand = buildContributions(
    cur, prev, metric,
    i => bandFor(incidentHour(i)),
    k => ({ label: k }),
    deltaAbs,
  )

  return {
    metric,
    currentTotal,
    previousTotal,
    deltaAbs,
    deltaPct,
    byCategory,
    byArea,
    bySeverity,
    byHourBand,
  }
}

// ─── Co-occurrence / candidate-explanation deriver ───────────────────────────
// Given a set of "anomalous" incident rows and a "baseline" comparison set,
// rank values across several dimensions by *lift* — how over-represented
// each value is on the flagged days vs the baseline. Used to surface
// candidate explanations whenever the system flags a level shift or
// out-of-band day cluster. Strictly correlations, not causes.

interface DimensionDef {
  id: HypothesisDimension
  label: string
  keyOf: (i: IncidentRow) => string | null
  metaOf: (k: string) => { label: string; color?: string }
}

const HYPOTHESIS_DIMS: DimensionDef[] = [
  {
    id: 'category',
    label: 'Category',
    keyOf: i => i.category,
    metaOf: k => {
      const cfg = CATEGORY_CONFIG[k as IncidentCategory]
      return { label: cfg?.label ?? k, color: cfg?.color }
    },
  },
  {
    id: 'area',
    label: 'Area',
    keyOf: i => i.area?.trim() || null,
    metaOf: k => ({ label: k }),
  },
  {
    id: 'severity',
    label: 'Severity',
    keyOf: i => i.severity,
    metaOf: k => ({ label: k, color: SEVERITY_CONFIG[k as Severity]?.color }),
  },
  {
    id: 'hourBand',
    label: 'Time of Day',
    keyOf: i => bandFor(incidentHour(i)),
    metaOf: k => ({ label: k }),
  },
  {
    id: 'line',
    label: 'Line',
    keyOf: i => i.line?.trim() || null,
    metaOf: k => ({ label: k }),
  },
  {
    id: 'operator',
    label: 'Operator',
    keyOf: i => i.train_company?.trim().toUpperCase() || null,
    metaOf: k => ({ label: k }),
  },
]

// Lift threshold + min-count threshold balance signal vs noise. Lift > 1.6
// (60% over-represented) is far enough from baseline to be operationally
// interesting; min-count of 3 incidents prevents single-event spikes from
// dominating with implausible "infinity" lifts.
const LIFT_THRESHOLD = 1.6
const MIN_ANOMALOUS_COUNT = 3
const TOP_HYPOTHESES_PER_CLUSTER = 6

function rankHypothesesForCluster(
  anomalousRows: IncidentRow[],
  baselineRows: IncidentRow[],
): Hypothesis[] {
  const aTotal = anomalousRows.length
  const bTotal = baselineRows.length
  if (aTotal === 0 || bTotal === 0) return []

  const all: Hypothesis[] = []
  for (const def of HYPOTHESIS_DIMS) {
    const aCounts = new Map<string, number>()
    const bCounts = new Map<string, number>()
    for (const r of anomalousRows) {
      const k = def.keyOf(r); if (k == null) continue
      aCounts.set(k, (aCounts.get(k) ?? 0) + 1)
    }
    for (const r of baselineRows) {
      const k = def.keyOf(r); if (k == null) continue
      bCounts.set(k, (bCounts.get(k) ?? 0) + 1)
    }
    for (const [k, aCount] of aCounts.entries()) {
      if (aCount < MIN_ANOMALOUS_COUNT) continue
      const bCount = bCounts.get(k) ?? 0
      const aShare = aCount / aTotal
      // If a value has zero baseline incidents we treat lift as the share
      // ratio against the smallest representable baseline (one incident in
      // the entire baseline) — keeps the row finite and rankable while still
      // signalling "this is brand new behaviour."
      const bShare = bCount > 0 ? bCount / bTotal : 1 / Math.max(bTotal, 1)
      const lift = aShare / bShare
      if (lift < LIFT_THRESHOLD) continue
      const meta = def.metaOf(k)
      all.push({
        dimension: def.id,
        dimensionLabel: def.label,
        key: k,
        label: meta.label,
        color: meta.color,
        anomalousCount: aCount,
        anomalousTotal: aTotal,
        baselineCount: bCount,
        baselineTotal: bTotal,
        anomalousShare: aShare,
        baselineShare: bCount > 0 ? bCount / bTotal : 0,
        lift,
      })
    }
  }
  return all
    .sort((a, b) => b.lift - a.lift || b.anomalousCount - a.anomalousCount)
    .slice(0, TOP_HYPOTHESES_PER_CLUSTER)
}

function shortDateUK(iso: string): string {
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]}`
}

export function deriveHypotheses(
  data: RawData,
  trend: TrendPoint[],
  changePoints: ChangePoint[],
): HypothesisCluster[] {
  const clusters: HypothesisCluster[] = []
  const incidents = data.incidents.filter(i => !i.is_continuation)

  // ── Cluster 1: anomalous days lumped together ─────────────────────────────
  const anomalousDates = new Set(
    trend.filter(p => p.isAnomalous && p.baselineHigh != null && p.incidents > (p.baselineHigh ?? 0))
         .map(p => p.date),
  )
  if (anomalousDates.size >= 1) {
    const anomalousRows = incidents.filter(i => anomalousDates.has(i.report_date))
    // Baseline is the rest of the window — gives the cleanest contrast for
    // "what was different about these days vs the rest of the period."
    const baselineRows = incidents.filter(i => !anomalousDates.has(i.report_date))
    const hypotheses = rankHypothesesForCluster(anomalousRows, baselineRows)
    if (hypotheses.length > 0) {
      const datesSorted = Array.from(anomalousDates).sort()
      clusters.push({
        id: 'anomalous-days',
        trigger: 'anomalous-days',
        title: `${anomalousDates.size} anomalous day${anomalousDates.size === 1 ? '' : 's'}`,
        subtitle: `Days outside the expected range — over-represented vs the rest of the window`,
        periodDates: datesSorted,
        anomalousIncidentCount: anomalousRows.length,
        baselineIncidentCount: baselineRows.length,
        hypotheses,
      })
    }
  }

  // ── Cluster 2..N: one per detected change-point ───────────────────────────
  // Only the incidents-series change-points generate clusters — comparing
  // delay-mins shifts isn't a row-level comparison (delay is a sum, not a
  // count), so it doesn't fit the over-representation framing.
  const incidentCps = changePoints.filter(c => c.metric === 'incidents')
  for (const cp of incidentCps) {
    const afterRows  = incidents.filter(i => i.report_date >= cp.date)
    const beforeRows = incidents.filter(i => i.report_date <  cp.date)
    if (afterRows.length < 5 || beforeRows.length < 5) continue
    const hypotheses = rankHypothesesForCluster(afterRows, beforeRows)
    if (hypotheses.length === 0) continue
    const arrow = cp.direction === 'up' ? '▲' : '▼'
    clusters.push({
      id: `cp-${cp.date}-${cp.direction}`,
      trigger: 'change-point',
      title: `After ${shortDateUK(cp.date)} level shift ${arrow}`,
      subtitle: `${cp.direction === 'up' ? 'Step up' : 'Step down'} from ~${cp.beforeMean.toFixed(1)} to ~${cp.afterMean.toFixed(1)} incidents/day — over-represented vs the period before`,
      periodDates: [cp.date],
      anomalousIncidentCount: afterRows.length,
      baselineIncidentCount: beforeRows.length,
      hypotheses,
    })
  }

  return clusters
}

export function deriveCategorySplit(data: RawData): CategoryDatum[] {
  const byCat = new Map<IncidentCategory, { count: number; delay: number }>()
  for (const i of nonContinuation(data.incidents)) {
    const agg = byCat.get(i.category) ?? { count: 0, delay: 0 }
    agg.count += 1
    agg.delay += effectiveDelay(i)
    byCat.set(i.category, agg)
  }
  return Array.from(byCat.entries())
    .map(([category, agg]) => ({
      category,
      label: CATEGORY_CONFIG[category].label,
      short: CATEGORY_CONFIG[category].short,
      color: CATEGORY_CONFIG[category].color,
      count: agg.count,
      delayMins: agg.delay,
    }))
    .sort((a, b) => b.count - a.count)
}

export function deriveLocationHotspots(data: RawData, limit = 12): LocationDatum[] {
  const byLoc = new Map<string, LocationDatum>()
  for (const i of nonContinuation(data.incidents)) {
    const key = i.location?.trim()
    if (!key) continue
    const agg = byLoc.get(key) ?? { location: key, area: i.area, count: 0, delayMins: 0 }
    agg.count += 1
    agg.delayMins += effectiveDelay(i)
    byLoc.set(key, agg)
  }
  return Array.from(byLoc.values())
    .sort((a, b) => b.delayMins - a.delayMins || b.count - a.count)
    .slice(0, limit)
}

export function deriveRepeatFaults(data: RawData, limit = 10): RepeatFault[] {
  const byFault = new Map<string, RepeatFault>()
  // Group by fault_number across continuations & first-seen alike — a recurring
  // fault number genuinely is the same asset failing repeatedly.
  for (const i of data.incidents) {
    const fn = i.fault_number?.trim()
    if (!fn) continue
    const agg = byFault.get(fn) ?? {
      faultNumber: fn,
      occurrences: 0,
      totalDelay: 0,
      locations: [],
      firstSeen: i.report_date,
      lastSeen: i.report_date,
      category: i.category,
    }
    agg.occurrences += 1
    agg.totalDelay += effectiveDelay(i)
    if (i.location && !agg.locations.includes(i.location)) agg.locations.push(i.location)
    if (i.report_date < agg.firstSeen) agg.firstSeen = i.report_date
    if (i.report_date > agg.lastSeen)  agg.lastSeen = i.report_date
    byFault.set(fn, agg)
  }
  return Array.from(byFault.values())
    .filter(f => f.occurrences > 1)
    .sort((a, b) => b.occurrences - a.occurrences || b.totalDelay - a.totalDelay)
    .slice(0, limit)
}

export function deriveResponderLoad(data: RawData, limit = 12): ResponderLoad[] {
  const byInit = new Map<string, ResponderLoad>()
  for (const i of nonContinuation(data.incidents)) {
    const inits = i.responder_initials || []
    for (const init of inits) {
      const agg = byInit.get(init) ?? { initials: init, incidentCount: 0, totalDelay: 0 }
      agg.incidentCount += 1
      agg.totalDelay += effectiveDelay(i)
      byInit.set(init, agg)
    }
  }
  return Array.from(byInit.values())
    .sort((a, b) => b.incidentCount - a.incidentCount)
    .slice(0, limit)
}

export function deriveOperatorImpact(data: RawData): OperatorImpact[] {
  const byCo = new Map<string, OperatorImpact>()
  for (const i of nonContinuation(data.incidents)) {
    const co = (i.train_company || '').trim().toUpperCase()
    if (!co) continue
    const agg = byCo.get(co) ?? { company: co, trainCount: 0, delayMins: 0, cancellations: 0 }
    agg.trainCount += 1
    agg.delayMins += effectiveDelay(i)
    agg.cancellations += (i.cancelled || 0)
    byCo.set(co, agg)
  }
  return Array.from(byCo.values()).sort((a, b) => b.delayMins - a.delayMins)
}

function incidentDow(i: IncidentRow): number | null {
  if (i.day_of_week != null) return i.day_of_week
  if (i.report_date) return new Date(i.report_date + 'T00:00:00Z').getUTCDay()
  return null
}

function incidentHour(i: IncidentRow): number | null {
  if (i.hour_of_day != null) return i.hour_of_day
  if (i.incident_start) {
    const h = parseInt(i.incident_start.slice(0, 2), 10)
    if (!isNaN(h) && h >= 0 && h <= 23) return h
  }
  return null
}

export function deriveHeatmap(data: RawData): HeatmapCell[] {
  const grid: HeatmapCell[] = []
  for (let dow = 0; dow < 7; dow++) {
    for (let h = 0; h < 24; h++) {
      grid.push({ dow, hour: h, count: 0 })
    }
  }
  for (const i of nonContinuation(data.incidents)) {
    const dow = incidentDow(i)
    const h = incidentHour(i)
    if (dow == null || h == null) continue
    if (dow < 0 || dow > 6 || h < 0 || h > 23) continue
    const cell = grid[dow * 24 + h]
    if (cell) cell.count += 1
  }
  return grid
}

export function deriveAreaList(data: RawData): { area: string; count: number; delay: number }[] {
  const byArea = new Map<string, { area: string; count: number; delay: number }>()
  for (const i of nonContinuation(data.incidents)) {
    // Use the raw DB value without trimming — the Supabase .in() filter does
    // exact-string matching, so the value here must be byte-for-byte identical
    // to what is stored in the database.
    const a = i.area
    if (!a) continue
    const agg = byArea.get(a) ?? { area: a, count: 0, delay: 0 }
    agg.count += 1
    agg.delay += effectiveDelay(i)
    byArea.set(a, agg)
  }
  return Array.from(byArea.values()).sort((a, b) => b.delay - a.delay)
}

// ─── Infrastructure failure sub-category color palette ───────────────────────
// Ordered by visual priority — index 0 goes to the most-common failure type,
// so every slice gets a distinct colour regardless of what DB code it carries.
const INFRA_PALETTE = [
  '#E05206',  // orange
  '#F39C12',  // amber
  '#4A6FA5',  // blue
  '#27AE60',  // green
  '#9B59B6',  // purple
  '#3A8FD5',  // sky blue
  '#E74C3C',  // red
  '#16A085',  // teal
  '#E0A006',  // dark amber
  '#D35400',  // burnt orange
  '#2ECC71',  // light green
  '#8E44AD',  // violet
  '#2980B9',  // medium blue
  '#C0392B',  // dark red
  '#F1C40F',  // yellow
  '#1ABC9C',  // turquoise
  '#6B8FA8',  // slate
  '#E67E22',  // light orange
  '#5B7FA8',  // muted blue
  '#7A9AB8',  // pale blue
  '#A569BD',  // lavender
  '#48C9B0',  // mint
  '#85A3C7',  // powder blue
  '#95A5A6',  // grey
  '#BDC3C7',  // light grey
]

export function deriveRepeatAssets(data: RawData, limit = 15): RepeatAsset[] {
  const byAsset = new Map<string, RepeatAsset>()
  for (const i of nonContinuation(data.incidents)) {
    if (!REPEAT_ASSET_CATEGORIES.includes(i.category)) continue
    const typeLabel = (i.incident_type_label || i.incident_type_code || CATEGORY_CONFIG[i.category].label).trim()
    const loc = (i.location?.trim()) || 'Unknown'
    const key = `${typeLabel}|||${loc}`
    const agg = byAsset.get(key) ?? {
      assetKey: `${typeLabel} — ${loc}`,
      assetType: typeLabel,
      location: loc,
      occurrences: 0,
      totalDelay: 0,
      category: i.category,
      firstSeen: i.report_date,
      lastSeen: i.report_date,
    }
    agg.occurrences += 1
    agg.totalDelay += effectiveDelay(i)
    if (i.report_date < agg.firstSeen) agg.firstSeen = i.report_date
    if (i.report_date > agg.lastSeen) agg.lastSeen = i.report_date
    byAsset.set(key, agg)
  }
  return Array.from(byAsset.values())
    .filter(a => a.occurrences > 1)
    .sort((a, b) => b.occurrences - a.occurrences || b.totalDelay - a.totalDelay)
    .slice(0, limit)
}

export function deriveInfraFailureMix(data: RawData): InfraFailureDatum[] {
  const byType = new Map<string, Omit<InfraFailureDatum, 'color'>>()
  for (const i of nonContinuation(data.incidents)) {
    if (!INFRA_MIX_CATEGORIES.includes(i.category)) continue
    const code = i.incident_type_code?.trim() || 'OTHER'
    const label = (i.incident_type_label?.trim()) || CATEGORY_CONFIG[i.category].label
    // Group by normalised label so the same failure type stored under different
    // codes (e.g. "Points Failure" from "05B" and "5B") merges into one slice.
    const key = label.toLowerCase()
    const agg = byType.get(key) ?? { typeCode: code, typeLabel: label, count: 0, delayMins: 0 }
    agg.count += 1
    agg.delayMins += effectiveDelay(i)
    byType.set(key, agg)
  }
  // Sort by count then assign palette colours by rank so every slice is
  // distinct regardless of what raw type-code the DB happens to store.
  return Array.from(byType.values())
    .sort((a, b) => b.count - a.count)
    .map((d, i) => ({ ...d, color: INFRA_PALETTE[i % INFRA_PALETTE.length] }))
}

export function deriveDelayDensity(data: RawData): DelayDensityDatum[] {
  const byLoc = new Map<string, { densities: number[]; totalDelay: number; count: number; area: string | null }>()
  for (const i of nonContinuation(data.incidents)) {
    const loc = i.location?.trim()
    if (!loc) continue
    const delay = effectiveDelay(i)
    const dur = i.incident_duration
    const agg = byLoc.get(loc) ?? { densities: [], totalDelay: 0, count: 0, area: i.area }
    agg.totalDelay += delay
    agg.count += 1
    if (dur != null && dur > 0) agg.densities.push(delay / dur)
    byLoc.set(loc, agg)
  }
  return Array.from(byLoc.entries())
    .filter(([, v]) => v.densities.length > 0 && v.totalDelay > 0)
    .map(([loc, v]) => ({
      location: loc,
      area: v.area,
      incidentCount: v.count,
      avgDelayDensity: v.densities.reduce((s, n) => s + n, 0) / v.densities.length,
      totalDelay: v.totalDelay,
    }))
    .sort((a, b) => b.avgDelayDensity - a.avgDelayDensity)
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  const idx = Math.ceil(sorted.length * p) - 1
  return sorted[Math.max(0, idx)]
}

function distStats(raw: number[]): { raw: number[]; p50: number | null; p95: number | null } {
  const sorted = [...raw].sort((a, b) => a - b)
  return { raw, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) }
}

export function deriveResponseDistribution(data: RawData): ResponseDistribution {
  const toAdvised:  number[] = []
  const toResponse: number[] = []
  const toArrival:  number[] = []
  const duration:   number[] = []
  for (const i of nonContinuation(data.incidents)) {
    const a = effectiveMinsToAdvised(i)
    const r = effectiveMinsToResponse(i)
    const v = effectiveMinsToArrival(i)
    if (a != null) toAdvised.push(a)
    if (r != null) toResponse.push(r)
    if (v != null) toArrival.push(v)
    if (i.incident_duration != null && i.incident_duration >= 0) duration.push(i.incident_duration)
  }
  return {
    toAdvised:  distStats(toAdvised),
    toResponse: distStats(toResponse),
    toArrival:  distStats(toArrival),
    duration:   distStats(duration),
  }
}

// ─── New derivers ─────────────────────────────────────────────────────────────

export function deriveSignals(data: RawData): Signal[] {
  const signals: Signal[] = []
  const pts = deriveTrend(data)
  if (pts.length < 3) return signals

  // Z-score helper
  const vals = pts.map(p => p.incidents)
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length
  const sigma = Math.sqrt(variance)

  // Delay spike by day
  const delayVals = pts.map(p => p.delayMins)
  const delayMean = delayVals.reduce((s, v) => s + v, 0) / delayVals.length
  const delayVariance = delayVals.reduce((s, v) => s + (v - delayMean) ** 2, 0) / delayVals.length
  const delaySigma = Math.sqrt(delayVariance)

  for (const pt of pts) {
    if (sigma > 0 && pt.incidents > mean + 2 * sigma) {
      const z = (pt.incidents - mean) / sigma
      signals.push({
        id: `surge-${pt.date}`,
        severity: z > 3 ? 'critical' : 'warning',
        type: 'INCIDENT_SURGE',
        title: `Incident surge on ${pt.date}`,
        detail: `${pt.incidents} incidents — well above the window average of ${mean.toFixed(1)} (about ${z.toFixed(1)}× the usual day-to-day variation)`,
        metric: pt.incidents,
        threshold: mean + 2 * sigma,
        delta: z,
        date: pt.date,
      })
    }
    if (delaySigma > 0 && pt.delayMins > delayMean + 2 * delaySigma) {
      const z = (pt.delayMins - delayMean) / delaySigma
      signals.push({
        id: `delay-${pt.date}`,
        severity: z > 3 ? 'critical' : 'warning',
        type: 'DELAY_SPIKE',
        title: `Delay spike on ${pt.date}`,
        detail: `${Math.round(pt.delayMins)} min total delay — well above average (about ${z.toFixed(1)}× the usual day-to-day variation)`,
        metric: pt.delayMins,
        threshold: delayMean + 2 * delaySigma,
        delta: z,
        date: pt.date,
      })
    }
  }

  // Safety cluster: 3+ safety-critical incidents at same location
  const safeLoc = new Map<string, number>()
  for (const i of nonContinuation(data.incidents)) {
    if (!SAFETY_CATEGORIES.includes(i.category)) continue
    const loc = i.location?.trim() || '__unknown__'
    safeLoc.set(loc, (safeLoc.get(loc) ?? 0) + 1)
  }
  for (const [loc, count] of safeLoc.entries()) {
    if (count >= 3) {
      signals.push({
        id: `safety-cluster-${loc}`,
        severity: 'critical',
        type: 'SAFETY_CLUSTER',
        title: `Safety cluster at ${loc === '__unknown__' ? 'unknown location' : loc}`,
        detail: `${count} safety-critical incidents in this window`,
        metric: count,
        threshold: 2,
        delta: count - 2,
      })
    }
  }

  // Fault acceleration: same fault_number in 3+ separate days
  const faultDays = new Map<string, Set<string>>()
  for (const i of data.incidents) {
    const fn = i.fault_number?.trim()
    if (!fn) continue
    const days = faultDays.get(fn) ?? new Set<string>()
    days.add(i.report_date)
    faultDays.set(fn, days)
  }
  for (const [fn, days] of faultDays.entries()) {
    if (days.size >= 3) {
      signals.push({
        id: `fault-accel-${fn}`,
        severity: 'warning',
        type: 'FAULT_ACCELERATION',
        title: `Recurring fault: ${fn}`,
        detail: `Same fault number active on ${days.size} separate days`,
        metric: days.size,
        threshold: 2,
        delta: days.size - 2,
      })
    }
  }

  // Response degradation: trailing 7-day median arrival trending up vs first 7 days
  const arrivalByDay = pts.map(pt => {
    const dayInc = nonContinuation(data.incidents).filter(i => i.report_date === pt.date)
    return dayInc.map(effectiveMinsToArrival).filter((n): n is number => n != null)
  })
  if (arrivalByDay.length >= 14) {
    const earlyMedian = median(arrivalByDay.slice(0, 7).flat())
    const lateMedian  = median(arrivalByDay.slice(-7).flat())
    if (earlyMedian != null && lateMedian != null && earlyMedian > 0) {
      const degradation = ((lateMedian - earlyMedian) / earlyMedian) * 100
      if (degradation > 20) {
        signals.push({
          id: 'response-degradation',
          severity: degradation > 40 ? 'critical' : 'warning',
          type: 'RESPONSE_DEGRADATION',
          title: 'Response time degrading',
          detail: `Median arrival time up ${degradation.toFixed(0)}% — last 7 days vs first 7 days`,
          metric: lateMedian,
          threshold: earlyMedian,
          delta: degradation,
        })
      }
    }
  }

  // SLA breach rate > 35%
  const arrivalAll = nonContinuation(data.incidents)
    .map(effectiveMinsToArrival)
    .filter((n): n is number => n != null)
  if (arrivalAll.length >= 5) {
    const breachRate = (arrivalAll.filter(m => m > SLA_THRESHOLD_MINS).length / arrivalAll.length) * 100
    if (breachRate > 35) {
      signals.push({
        id: 'sla-breach-rate',
        severity: breachRate > 55 ? 'critical' : 'warning',
        type: 'SLA_BREACH_RATE',
        title: `SLA breach rate elevated`,
        detail: `${breachRate.toFixed(0)}% of incidents exceeding ${SLA_THRESHOLD_MINS}-min arrival target`,
        metric: breachRate,
        threshold: 35,
        delta: breachRate - 35,
      })
    }
  }

  // Category spike: category count > 2× its share in previous window
  const curCats = new Map<string, number>()
  const prevCats = new Map<string, number>()
  for (const i of nonContinuation(data.incidents))   curCats.set(i.category,  (curCats.get(i.category)  ?? 0) + 1)
  for (const i of nonContinuation(data.prevIncidents)) prevCats.set(i.category, (prevCats.get(i.category) ?? 0) + 1)
  const prevTotal = Array.from(prevCats.values()).reduce((s, v) => s + v, 0)
  const curTotal  = nonContinuation(data.incidents).length
  for (const [cat, curCount] of curCats.entries()) {
    const prevCount = prevCats.get(cat) ?? 0
    const prevShare = prevTotal > 0 ? prevCount / prevTotal : 0
    const curShare  = curTotal  > 0 ? curCount  / curTotal  : 0
    if (prevShare > 0 && curShare > prevShare * 2 && curCount >= 3) {
      signals.push({
        id: `cat-spike-${cat}`,
        severity: 'warning',
        type: 'CATEGORY_SPIKE',
        title: `${CATEGORY_CONFIG[cat as keyof typeof CATEGORY_CONFIG]?.label ?? cat} spike`,
        detail: `${curCount} incidents — ${(curShare * 100).toFixed(0)}% of window vs ${(prevShare * 100).toFixed(0)}% previously`,
        metric: curShare * 100,
        threshold: prevShare * 2 * 100,
        delta: curShare / prevShare,
      })
    }
  }

  // Sort: critical first, then by delta descending
  return signals.sort((a, b) => {
    const rank = { critical: 0, warning: 1, info: 2 }
    return rank[a.severity] - rank[b.severity] || b.delta - a.delta
  })
}

export function deriveLineBreakdown(data: RawData): LineDatum[] {
  const byLine = new Map<string, {
    incidentCount: number; totalDelay: number
    durations: number[]; cats: Map<string, number>
  }>()
  for (const i of nonContinuation(data.incidents)) {
    const line = i.line?.trim()
    if (!line) continue
    const agg = byLine.get(line) ?? { incidentCount: 0, totalDelay: 0, durations: [] as number[], cats: new Map<string, number>() }
    agg.incidentCount += 1
    agg.totalDelay += effectiveDelay(i)
    const d = effectiveDuration(i)
    if (d != null) agg.durations.push(d)
    agg.cats.set(i.category, (agg.cats.get(i.category) ?? 0) + 1)
    byLine.set(line, agg)
  }
  return Array.from(byLine.entries()).map(([line, agg]) => {
    const topCategory = Array.from(agg.cats.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] as IncidentCategory ?? 'GENERAL'
    return {
      line,
      incidentCount: agg.incidentCount,
      totalDelay: agg.totalDelay,
      avgDuration: agg.durations.length
        ? agg.durations.reduce((s, n) => s + n, 0) / agg.durations.length
        : null,
      topCategory,
    }
  }).sort((a, b) => b.totalDelay - a.totalDelay)
}

const TRMC_LABELS: Record<string, string> = {
  IQVL: 'Network Rail Infrastructure',
  IQVR: 'Network Rail Operations',
  IQV9: 'Network Rail Other',
  MXHA: 'Train Operator',
  IQGR: 'External / Third Party',
}

export function deriveDelayAttribution(data: RawData): AttributionDatum[] {
  const byCode = new Map<string, { incidentCount: number; totalDelay: number }>()
  const total = data.incidents.reduce((s, i) => s + effectiveDelay(i), 0)
  for (const i of nonContinuation(data.incidents)) {
    const code = i.trmc_code?.trim() || 'UNKNOWN'
    const agg  = byCode.get(code) ?? { incidentCount: 0, totalDelay: 0 }
    agg.incidentCount += 1
    agg.totalDelay    += effectiveDelay(i)
    byCode.set(code, agg)
  }
  return Array.from(byCode.entries())
    .map(([code, agg]) => ({
      code,
      label: TRMC_LABELS[code] ?? code,
      incidentCount: agg.incidentCount,
      totalDelay: agg.totalDelay,
      pct: total > 0 ? (agg.totalDelay / total) * 100 : 0,
    }))
    .sort((a, b) => b.totalDelay - a.totalDelay)
}

export function deriveContinuationChains(data: RawData): Chain[] {
  const byCcil = new Map<string, Chain>()
  for (const i of data.incidents) {
    const ccil = i.ccil?.trim()
    if (!ccil) continue
    const existing = byCcil.get(ccil)
    if (existing) {
      existing.incidents.push(i)
      existing.totalDelay += effectiveDelay(i)
      if (!existing.location && i.location) existing.location = i.location
    } else {
      byCcil.set(ccil, {
        ccil,
        days: 0,
        totalDelay: effectiveDelay(i),
        category: i.category,
        location: i.location ?? null,
        incidents: [i],
      })
    }
  }
  return Array.from(byCcil.values())
    .filter(c => c.incidents.length > 1)
    .map(c => {
      const dates = [...new Set(c.incidents.map(i => i.report_date))].sort()
      c.days = dates.length
      return c
    })
    .sort((a, b) => b.totalDelay - a.totalDelay || b.days - a.days)
    .slice(0, 20)
}
