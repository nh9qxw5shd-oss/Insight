'use client'

import { getSupabase } from './supabase'
import {
  AnalyticsFilters, IncidentRow, ReportRow, KPISummary, TrendPoint,
  CategoryDatum, LocationDatum, RepeatFault, RepeatAsset, InfraFailureDatum,
  DelayDensityDatum, ResponderLoad, OperatorImpact,
  HeatmapCell, IncidentCategory, CATEGORY_CONFIG, SAFETY_CATEGORIES,
  REPEAT_ASSET_CATEGORIES, INFRA_MIX_CATEGORIES,
} from './types'

// ─── Date helpers ────────────────────────────────────────────────────────────

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function resolveWindow(f: AnalyticsFilters): { from: string; to: string; days: number } {
  if (f.startDate && f.endDate) {
    const a = new Date(f.startDate)
    const b = new Date(f.endDate)
    const days = Math.max(1, Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1)
    return { from: f.startDate, to: f.endDate, days }
  }
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - (f.windowDays - 1))
  return { from: isoDay(from), to: isoDay(to), days: f.windowDays }
}

function previousWindow(f: AnalyticsFilters): { from: string; to: string } {
  const { days } = resolveWindow(f)
  const w = resolveWindow(f)
  const prevTo = new Date(w.from)
  prevTo.setDate(prevTo.getDate() - 1)
  const prevFrom = new Date(prevTo)
  prevFrom.setDate(prevFrom.getDate() - (days - 1))
  return { from: isoDay(prevFrom), to: isoDay(prevTo) }
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

  // Previous window — only for delta calc, no filters beyond date
  const prevRows = await fetchAllRows<IncidentRow>(() =>
    sb!.from('incidents').select(INCIDENT_COLS)
      .gte('report_date', prev.from)
      .lte('report_date', prev.to)
  )

  // Reports row count (for "reports covered" KPI)
  const reportRows = await fetchAllRows<ReportRow>(() =>
    sb!.from('reports').select('*')
      .gte('report_date', cur.from)
      .lte('report_date', cur.to)
  )

  // Apply free-text filter client-side
  const filtered = f.search.trim()
    ? curRows.filter(i => searchMatch(i, f.search))
    : curRows

  return {
    incidents: filtered,
    prevIncidents: prevRows,
    reports: reportRows,
    windowFrom: cur.from,
    windowTo: cur.to,
    windowDays: cur.days,
  }
}

function searchMatch(i: IncidentRow, q: string): boolean {
  const needle = q.toLowerCase()
  return (
    (i.title || '').toLowerCase().includes(needle) ||
    (i.location || '').toLowerCase().includes(needle) ||
    (i.area || '').toLowerCase().includes(needle) ||
    (i.fault_number || '').toLowerCase().includes(needle) ||
    (i.train_id || '').toLowerCase().includes(needle) ||
    (i.ccil || '').toLowerCase().includes(needle)
  )
}

// ─── Derivers ────────────────────────────────────────────────────────────────
// Continuation-aware: a CCIL that re-appears day-by-day is a single event, so
// it's counted once and only its incremental delay (delay_delta) is summed.

function effectiveDelay(i: IncidentRow): number {
  return i.is_continuation ? (i.delay_delta ?? 0) : (i.minutes_delay ?? 0)
}

function nonContinuation<T extends { is_continuation: boolean }>(rows: T[]): T[] {
  return rows.filter(r => !r.is_continuation)
}

function median(nums: number[]): number | null {
  const valid = nums.filter(n => n != null && !isNaN(n))
  if (!valid.length) return null
  const sorted = [...valid].sort((a, b) => a - b)
  const m = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
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

  const durations = curUnique.map(i => i.incident_duration).filter((n): n is number => n != null)
  const avgDuration = durations.length
    ? durations.reduce((s, n) => s + n, 0) / durations.length
    : null

  const prevDurations = prevUnique.map(i => i.incident_duration).filter((n): n is number => n != null)
  const prevAvgDuration = prevDurations.length
    ? prevDurations.reduce((s, n) => s + n, 0) / prevDurations.length
    : null

  const responseTimes = curUnique
    .map(i => i.mins_to_response)
    .filter((n): n is number => n != null && n >= 0 && n < 24 * 60)

  return {
    totalIncidents: curUnique.length,
    totalDelayMins: totalDelay,
    totalCancelled,
    totalPartCancelled,
    avgIncidentDuration: avgDuration,
    medianResponseMins: median(responseTimes),
    safetyCriticalCount: safetyCount,
    reportsCovered: data.reports.length,
    delayDeltaPct: pctDelta(totalDelay, prevDelay),
    incidentsDeltaPct: pctDelta(curUnique.length, prevUnique.length),
    safetyDeltaPct: pctDelta(safetyCount, prevSafety),
    durationDeltaPct: avgDuration != null && prevAvgDuration != null
      ? pctDelta(avgDuration, prevAvgDuration) : null,
  }
}

export function deriveTrend(data: RawData): TrendPoint[] {
  const byDate = new Map<string, TrendPoint>()
  // Seed every day in window so the chart has continuous x-axis
  const start = new Date(data.windowFrom)
  for (let i = 0; i < data.windowDays; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const k = isoDay(d)
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
  return Array.from(byDate.values())
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

export function deriveHeatmap(data: RawData): HeatmapCell[] {
  const grid: HeatmapCell[] = []
  for (let dow = 0; dow < 7; dow++) {
    for (let h = 0; h < 24; h++) {
      grid.push({ dow, hour: h, count: 0 })
    }
  }
  for (const i of nonContinuation(data.incidents)) {
    const dow = i.day_of_week
    const h = i.hour_of_day
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
    const a = (i.area || 'Unspecified').trim()
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

export function deriveResponseDistribution(data: RawData): {
  toAdvised:  number[]
  toResponse: number[]
  toArrival:  number[]
  duration:   number[]
} {
  const toAdvised:  number[] = []
  const toResponse: number[] = []
  const toArrival:  number[] = []
  const duration:   number[] = []
  for (const i of nonContinuation(data.incidents)) {
    if (i.mins_to_advised  != null && i.mins_to_advised  >= 0 && i.mins_to_advised  < 1440) toAdvised.push(i.mins_to_advised)
    if (i.mins_to_response != null && i.mins_to_response >= 0 && i.mins_to_response < 1440) toResponse.push(i.mins_to_response)
    if (i.mins_to_arrival  != null && i.mins_to_arrival  >= 0 && i.mins_to_arrival  < 1440) toArrival.push(i.mins_to_arrival)
    if (i.incident_duration != null && i.incident_duration >= 0) duration.push(i.incident_duration)
  }
  return { toAdvised, toResponse, toArrival, duration }
}
