'use client'

// ─── Temperature-exposure compute engine ─────────────────────────────────────
// Reimplements the analysis session's validated banding compute inside
// Insight. For a chosen date range: classify each date weekday/sat/sun, fetch
// hourly grid temperatures from Open-Meteo (one multi-location call per
// endpoint), then walk every matching archetype's 15-min route trace sampling
// the nearest grid point's temperature at that hour, accumulating 0.25 h into
// user-definable greater-than temperature bands, split running vs dwell.
// Validated against the 4–17 July 2026 reference output (JULY_2026_REFERENCE).

import {
  EXPOSURE_ARCHETYPES, ARCHETYPE_TRACES, ExposureArchetype, ExposureDayType,
  TracePoint,
} from './exposureData'

// ─── Standard weather grid ───────────────────────────────────────────────────
// 15 fixed points covering the EMR network. Index order matters — traces were
// sampled against nearest-of-these when the reference output was produced.

export interface GridPoint { lat: number; lon: number; label: string }

export const WEATHER_GRID: GridPoint[] = [
  { lat: 51.53, lon: -0.13, label: 'London / St Pancras' },
  { lat: 52.14, lon: -0.48, label: 'Bedford' },
  { lat: 52.63, lon: -1.13, label: 'Leicester' },
  { lat: 52.95, lon: -1.15, label: 'Nottingham' },
  { lat: 53.05, lon: -1.48, label: 'Derby / Matlock' },
  { lat: 53.38, lon: -1.46, label: 'Sheffield' },
  { lat: 53.23, lon: -0.54, label: 'Lincoln' },
  { lat: 52.91, lon: -0.64, label: 'Grantham' },
  { lat: 53.14, lon: 0.34, label: 'Skegness' },
  { lat: 52.48, lon: 0.0, label: 'Peterborough / Ely' },
  { lat: 52.63, lon: 1.31, label: 'Norwich' },
  { lat: 53.44, lon: -2.1, label: 'Manchester' },
  { lat: 53.4, lon: -2.7, label: 'Liverpool' },
  { lat: 53.05, lon: -2.3, label: 'Crewe / Stoke' },
  { lat: 53.57, lon: -0.09, label: 'Grimsby' },
]

// Nearest grid point, exactly as used to produce the validated reference:
// minimise (dLat)² + (dLon×0.6)².
export function nearestGridIdx(lat: number, lon: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < WEATHER_GRID.length; i++) {
    const dLat = lat - WEATHER_GRID[i].lat
    const dLon = (lon - WEATHER_GRID[i].lon) * 0.6
    const d = dLat * dLat + dLon * dLon
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

// ─── Date helpers ────────────────────────────────────────────────────────────

export function classifyDayType(date: string): ExposureDayType {
  const dow = new Date(date + 'T00:00:00').getDay()   // 0=Sun, 6=Sat
  if (dow === 0) return 'sunday'
  if (dow === 6) return 'saturday'
  return 'weekday'
}

export function datesInRange(from: string, to: string): string[] {
  const out: string[] = []
  const cur = new Date(from + 'T00:00:00Z')
  const end = new Date(to + 'T00:00:00Z')
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// ─── Hourly grid weather ─────────────────────────────────────────────────────
// temps[gridIdx][dayIdx * 24 + hour] in °C; NaN where the API has no value
// (e.g. forecast horizon). dates covers [from .. to+1] — the +1 day services
// the six archetype traces that run past midnight.

export interface HourlyGridWeather {
  dates: string[]              // fetched dates, index 0 = range start
  temps: Float64Array[]        // one array per grid point
}

const ARCHIVE_LAG_DAYS = 6     // archive endpoint trails realtime by ~5 days

async function fetchOpenMeteoHourly(
  base: string, from: string, to: string, extraParams = '',
): Promise<any> {
  const lats = WEATHER_GRID.map(g => g.lat).join(',')
  const lons = WEATHER_GRID.map(g => g.lon).join(',')
  const url =
    `${base}?latitude=${lats}&longitude=${lons}` +
    `&start_date=${from}&end_date=${to}` +
    `&hourly=temperature_2m,cloud_cover&timezone=Europe%2FLondon${extraParams}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`)
  return res.json()
}

// Merge one endpoint's response into the temps arrays.
function mergeResponse(json: any, dates: string[], temps: Float64Array[]) {
  // Multi-location responses come back as an array; single location as object.
  const perLoc: any[] = Array.isArray(json) ? json : [json]
  const dayIdx = new Map(dates.map((d, i) => [d, i]))
  perLoc.forEach((loc, li) => {
    if (li >= temps.length) return
    const times: string[] = loc.hourly?.time ?? []
    const t: (number | null)[] = loc.hourly?.temperature_2m ?? []
    for (let i = 0; i < times.length; i++) {
      const d = dayIdx.get(times[i].slice(0, 10))
      if (d == null || t[i] == null) continue
      const hour = parseInt(times[i].slice(11, 13), 10)
      temps[li][d * 24 + hour] = t[i]!
    }
  })
}

const weatherMemo = new Map<string, Promise<HourlyGridWeather>>()

// Fetch hourly temperatures for every grid point across [from .. to+1 day],
// splitting archive vs forecast endpoints around the archive's realtime lag.
// Memoised per range for the session so repeated recomputes are free.
export function fetchGridWeather(from: string, to: string): Promise<HourlyGridWeather> {
  const key = `${from}|${to}`
  const hit = weatherMemo.get(key)
  if (hit) return hit
  const p = (async () => {
    const fetchTo = addDays(to, 1)                       // overnight trace tails
    const dates = datesInRange(from, fetchTo)
    const temps = WEATHER_GRID.map(() => {
      const a = new Float64Array(dates.length * 24)
      a.fill(NaN)
      return a
    })

    const today = new Date().toISOString().slice(0, 10)
    const archiveEnd = addDays(today, -ARCHIVE_LAG_DAYS)

    const jobs: Promise<void>[] = []
    if (from <= archiveEnd) {
      const end = fetchTo <= archiveEnd ? fetchTo : archiveEnd
      jobs.push(
        fetchOpenMeteoHourly('https://archive-api.open-meteo.com/v1/archive', from, end)
          .then(j => mergeResponse(j, dates, temps)),
      )
    }
    if (fetchTo > archiveEnd) {
      const start = from > archiveEnd ? from : addDays(archiveEnd, 1)
      jobs.push(
        fetchOpenMeteoHourly('https://api.open-meteo.com/v1/forecast', start, fetchTo)
          .then(j => mergeResponse(j, dates, temps)),
      )
    }
    await Promise.all(jobs)
    return { dates, temps }
  })()
  // Drop failed fetches from the memo so a transient error can be retried.
  p.catch(() => weatherMemo.delete(key))
  weatherMemo.set(key, p)
  return p
}

// ─── Banding compute ─────────────────────────────────────────────────────────

export const DEFAULT_BANDS = [25, 30]

export interface BandAccum {
  runH: number
  dwellH: number
  runKm: number
}

export interface ArchetypeExposure {
  archetype: ExposureArchetype
  daysSampled: number
  // keyed by band threshold; values are AVERAGES PER SAMPLED DAY (matching
  // the reference output), nested greater-than bands
  bands: Record<number, BandAccum>
  peakRouteTempC: number | null
}

// Pre-computed per-trace metadata
const traceMeta = new Map<string, { runningPoints: number }>()
function runningPointCount(id: string): number {
  let m = traceMeta.get(id)
  if (!m) {
    const trace = ARCHETYPE_TRACES[id] ?? []
    m = { runningPoints: trace.reduce((n, p) => n + p[3], 0) }
    traceMeta.set(id, m)
  }
  return m.runningPoints
}

// Sample the temperature for a trace point on a given day. Returns NaN when
// the hour is outside the fetched window or the API had no value.
function sampleTemp(
  wx: HourlyGridWeather, dayIdx: number, pt: TracePoint,
): number {
  const hourIdx = dayIdx * 24 + Math.floor(pt[0] / 60)   // minute may be ≥1440
  const arr = wx.temps[nearestGridIdx(pt[1], pt[2])]
  return hourIdx < arr.length ? arr[hourIdx] : NaN
}

// Core banding walk. Accumulates hours/km-in-band per archetype across every
// date in [from..to] whose day-type matches, then divides by days sampled.
export function computeExposure(
  wx: HourlyGridWeather,
  from: string,
  to: string,
  bands: number[] = DEFAULT_BANDS,
): Map<string, ArchetypeExposure> {
  const dates = datesInRange(from, to)
  const out = new Map<string, ArchetypeExposure>()

  for (const a of EXPOSURE_ARCHETYPES) {
    const trace = ARCHETYPE_TRACES[a.id]
    if (!trace?.length) continue
    const kmPerRunPoint = a.avg_route_km / Math.max(1, runningPointCount(a.id))

    const totals: Record<number, BandAccum> = {}
    for (const b of bands) totals[b] = { runH: 0, dwellH: 0, runKm: 0 }
    let peak: number | null = null
    let daysSampled = 0

    for (const date of dates) {
      if (classifyDayType(date) !== a.day) continue
      const dayIdx = wx.dates.indexOf(date)
      if (dayIdx < 0) continue
      let sawData = false

      for (const pt of trace) {
        const temp = sampleTemp(wx, dayIdx, pt)
        if (Number.isNaN(temp)) continue
        sawData = true
        if (peak == null || temp > peak) peak = temp
        for (const b of bands) {
          if (temp <= b) continue
          const acc = totals[b]
          if (pt[3] === 1) { acc.runH += 0.25; acc.runKm += kmPerRunPoint }
          else acc.dwellH += 0.25
        }
      }
      if (sawData) daysSampled++
    }

    const bandsAvg: Record<number, BandAccum> = {}
    for (const b of bands) {
      const t = totals[b]
      const n = Math.max(1, daysSampled)
      bandsAvg[b] = { runH: t.runH / n, dwellH: t.dwellH / n, runKm: t.runKm / n }
    }
    out.set(a.id, { archetype: a, daysSampled, bands: bandsAvg, peakRouteTempC: peak })
  }
  return out
}

// Cumulative exposure a single archetype's trace has accumulated above a band
// on one date, up to a given minute of day. Used by the deep-dive to ask
// "how many hot hours had this diagram banked when the fault occurred?"
export function cumulativeExposureAt(
  archetypeId: string,
  wx: HourlyGridWeather,
  date: string,
  minuteOfDay: number,
  band: number,
): { hours: number; km: number } | null {
  const trace = ARCHETYPE_TRACES[archetypeId]
  const a = EXPOSURE_ARCHETYPES.find(x => x.id === archetypeId)
  if (!trace?.length || !a) return null
  const dayIdx = wx.dates.indexOf(date)
  if (dayIdx < 0) return null
  const kmPerRunPoint = a.avg_route_km / Math.max(1, runningPointCount(archetypeId))

  let hours = 0
  let km = 0
  let sawData = false
  for (const pt of trace) {
    if (pt[0] > minuteOfDay) break
    const temp = sampleTemp(wx, dayIdx, pt)
    if (Number.isNaN(temp)) continue
    sawData = true
    if (temp > band) {
      hours += 0.25
      if (pt[3] === 1) km += kmPerRunPoint
    }
  }
  return sawData ? { hours, km } : null
}

// Max temperature across the whole grid for each date in the fetched window —
// drives the extreme/baseline day classification.
export function dailyGridMax(wx: HourlyGridWeather): Map<string, number> {
  const out = new Map<string, number>()
  wx.dates.forEach((date, d) => {
    let max = -Infinity
    for (const arr of wx.temps) {
      for (let h = 0; h < 24; h++) {
        const v = arr[d * 24 + h]
        if (!Number.isNaN(v) && v > max) max = v
      }
    }
    if (max > -Infinity) out.set(date, max)
  })
  return out
}

// ─── Headcode → archetype mapping ────────────────────────────────────────────
// Service group from the headcode's two-character prefix, derived empirically
// from the classified EMR CIF schedule data (permanent schedules, passenger
// trips). Prefix mappings can drift at timetable changes (Dec/May) —
// regenerate from the current CIF extract each time.
//
// Ambiguity notes (from the analysis):
//  · 1B/1D are ≥96% Nottingham–STP; a handful of Sheffield/Leicester workings
//    share the prefix. Defaulted to Nottingham–STP.
//  · 2K is genuinely shared between Lincoln–Peterborough and Lincoln–Doncaster;
//    both are Lincoln-based regionals with similar exposure geography, so they
//    are merged into the Lincoln–Peterborough bucket for the PoC.

export const HEADCODE_PREFIX_GROUP: Record<string, string> = {
  '1C': 'Sheffield - St Pancras',
  '1F': 'Sheffield - St Pancras',
  '1B': 'Nottingham - St Pancras',
  '1D': 'Nottingham - St Pancras',
  '1H': 'Corby - St Pancras',
  '1Y': 'Corby - St Pancras',
  '1L': 'Liverpool - Norwich',
  '1R': 'Liverpool - Norwich',
  '1K': 'Crewe - Lincoln',
  '1N': 'Crewe - Lincoln',
  '2A': 'Matlock - Nottingham/Cleethorpes',
  '2J': 'Matlock - Nottingham/Cleethorpes',
  '2N': 'Matlock - Nottingham/Cleethorpes',
  '2O': 'Nottingham - Skegness',
  '2S': 'Nottingham - Skegness',
  '2K': 'Lincoln - Peterborough',
  '2F': 'Cleethorpes - Barton',
  '2D': 'Nottingham - Worksop',
  '2H': 'Nottingham - Worksop',
  '2W': 'Nottingham - Worksop',
  '2P': 'Nottingham - Leicester',
}

export function headcodeToGroup(headcode: string | null | undefined): string {
  if (!headcode) return 'UNCLASSIFIED'
  const prefix = headcode.trim().toUpperCase().slice(0, 2)
  return HEADCODE_PREFIX_GROUP[prefix] ?? 'UNCLASSIFIED'
}

// Resolve a headcode + date to its archetype. Tier defaults to full-day (the
// dominant population); falls back to part-day where the group runs no
// full-day diagrams on that day-type (e.g. Corby–STP on Sundays). Returns
// null for unclassified prefixes — excluded from group-level correlation
// rather than force-fitted.
export function headcodeToArchetype(
  headcode: string | null | undefined,
  date: string,
): ExposureArchetype | null {
  const group = headcodeToGroup(headcode)
  if (group === 'UNCLASSIFIED') return null
  const day = classifyDayType(date)
  return (
    EXPOSURE_ARCHETYPES.find(a => a.group === group && a.day === day && a.tier === 'full-day') ??
    EXPOSURE_ARCHETYPES.find(a => a.group === group && a.day === day) ??
    null
  )
}

// ─── Service-group palette ───────────────────────────────────────────────────
// Stable colour per service group for the map and group comparisons. Intercity
// groups take the warm accents; regionals take the cooler steels/greens.

export const GROUP_COLORS: Record<string, string> = {
  'Sheffield - St Pancras':            '#E05206',
  'Nottingham - St Pancras':           '#F39C12',
  'Corby - St Pancras':                '#F47A3D',
  'Liverpool - Norwich':               '#9B59B6',
  'Crewe - Lincoln':                   '#4A6FA5',
  'Matlock - Nottingham/Cleethorpes':  '#27AE60',
  'Nottingham - Skegness':             '#16A085',
  'Lincoln - Peterborough':            '#5B7FA8',
  'Cleethorpes - Barton':              '#85A3C7',
  'Nottingham - Worksop':              '#6B7FA5',
  'Nottingham - Leicester':            '#A9B5C9',
  'UNCLASSIFIED':                      '#556077',
}

export function groupColor(group: string): string {
  return GROUP_COLORS[group] ?? '#556077'
}
