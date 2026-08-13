'use client'

// ─── Temperature Exposure tab ────────────────────────────────────────────────
// Where the fleet lives vs where the heat is. Walks each EMR diagram
// archetype's representative route trace against Open-Meteo hourly grid
// temperatures for a chosen window, accumulating running/dwell hours and
// mileage into user-definable temperature bands — then joins Insight's fault
// records (via headcode prefix → service group) to test whether extreme-day
// faults cluster behind accumulated heat exposure. PoC pattern-finder, not a
// significance test: archetypes are schedule-derived averages and the fault
// join is service-group-level until the live consist feed lands.

import { useEffect, useMemo, useState } from 'react'
import {
  Thermometer, Flame, CalendarRange, MapPin, Plus, X, Info,
  Activity, AlertTriangle, Loader2, RotateCcw,
} from 'lucide-react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Legend, ReferenceLine,
} from 'recharts'
import { IncidentRow, IncidentCategory, CATEGORY_CONFIG } from '@/lib/types'
import { nonContinuation, fetchIncidentsForRange } from '@/lib/queries'
import { isSupabaseConfigured } from '@/lib/supabase'
import {
  WEATHER_GRID, fetchGridWeather, computeExposure, cumulativeExposureAt,
  dailyGridMax, classifyDayType, datesInRange, headcodeToGroup,
  headcodeToArchetype, groupColor, HourlyGridWeather, ArchetypeExposure,
  DEFAULT_BANDS,
} from '@/lib/exposure'
import {
  EXPOSURE_ARCHETYPES, ARCHETYPE_TRACES, ExposureDayType,
  JULY_2026_REFERENCE_WINDOW,
} from '@/lib/exposureData'

// ─── Shared bits ─────────────────────────────────────────────────────────────

const DAY_TYPES: { key: ExposureDayType; label: string }[] = [
  { key: 'weekday', label: 'Weekday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
]

// Fault-category chips: unit faults first (the heat theory's subjects), plus
// the asset categories worth eyeballing for contrast.
const FAULT_CATEGORIES: IncidentCategory[] = [
  'TRAIN_FAULT', 'TRACTION_FAILURE', 'INFRASTRUCTURE', 'STRANDED_TRAIN',
]

function bandColor(threshold: number): string {
  return threshold >= 30 ? 'var(--nr-red)' : threshold >= 25 ? 'var(--nr-amber)' : 'var(--nr-blue)'
}

function fmtH(h: number): string {
  return h === 0 ? '0' : h.toFixed(h < 10 ? 2 : 1)
}

function fmtKm(km: number): string {
  return km === 0 ? '0' : Math.round(km).toLocaleString()
}

function faultMinute(i: IncidentRow): number | null {
  if (i.incident_start) {
    const [h, m] = i.incident_start.split(':').map(Number)
    if (Number.isFinite(h)) return h * 60 + (Number.isFinite(m) ? m : 0)
  }
  if (i.hour_of_day != null) return i.hour_of_day * 60 + 30
  return null
}

function StatCard({ label, value, sub, accent }: {
  label: string; value: string; sub?: string; accent?: boolean
}) {
  return (
    <div className={`card p-5 animate-count-up ${accent ? 'card-hi' : ''}`}>
      <span className="label-micro">{label}</span>
      <div className="numeric text-3xl font-light leading-none mt-2 mb-1" style={{ color: 'var(--ink-100)' }}>
        {value}
      </div>
      {sub && <div className="numeric-mono text-[11px] mt-1" style={{ color: 'var(--ink-400)' }}>{sub}</div>}
    </div>
  )
}

function Chip({ active, color, onClick, children }: {
  active: boolean; color?: string; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-1 rounded-sm text-[10px] transition-colors"
      style={{
        border: `1px solid ${active ? (color ?? 'var(--nr-orange)') : 'var(--line)'}`,
        color: active ? (color ?? 'var(--nr-orange)') : 'var(--ink-400)',
        background: active ? 'var(--bg-card-hi)' : 'transparent',
        fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.06em',
      }}
    >
      {children}
    </button>
  )
}

// ─── Route map ───────────────────────────────────────────────────────────────
// Self-contained SVG projection (no tile dependency — matches Insight's grid
// aesthetic). One polyline per archetype; colour = service group; weight and
// opacity scale with the selected band's exposure so hot routes glow.

const LAT_MAX = 53.85
const LAT_MIN = 51.35
const LON_MIN = -3.15
const LON_MAX = 1.5
const MAP_H = 620
const KY = MAP_H / (LAT_MAX - LAT_MIN)
const KX = KY * Math.cos((52.6 * Math.PI) / 180)
const MAP_W = Math.round((LON_MAX - LON_MIN) * KX)

function px(lon: number): number { return (lon - LON_MIN) * KX }
function py(lat: number): number { return (LAT_MAX - lat) * KY }

function RouteMap({ exposure, bands, wxReady }: {
  exposure: Map<string, ArchetypeExposure> | null
  bands: number[]
  wxReady: boolean
}) {
  const [dayType, setDayType] = useState<ExposureDayType>('weekday')
  const [metricBand, setMetricBand] = useState<number | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)

  const band = metricBand != null && bands.includes(metricBand)
    ? metricBand
    : bands[bands.length - 1]

  const visible = useMemo(() => {
    const rows = EXPOSURE_ARCHETYPES
      .filter(a => a.day === dayType && ARCHETYPE_TRACES[a.id]?.length)
      .map(a => {
        const exp = exposure?.get(a.id)
        const acc = exp?.bands[band]
        return { a, exp, metric: acc ? acc.runH + acc.dwellH : 0 }
      })
    // hottest drawn last so they sit on top
    rows.sort((x, y) => x.metric - y.metric)
    return rows
  }, [dayType, exposure, band])

  const maxMetric = Math.max(0.001, ...visible.map(v => v.metric))
  const active = pinned ?? hovered
  const activeRow = active ? visible.find(v => v.a.id === active) : null

  const graticuleLons = [-3, -2, -1, 0, 1]
  const graticuleLats = [51.5, 52, 52.5, 53, 53.5]

  return (
    <div className="card p-5 tick-corners">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Where the fleet lives</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            Representative route trace per archetype · line weight &amp; glow = hours &gt;{band}°C per day in the selected window
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            {DAY_TYPES.map(d => (
              <Chip key={d.key} active={dayType === d.key} onClick={() => { setDayType(d.key); setPinned(null); setHovered(null) }}>
                {d.label.toUpperCase()}
              </Chip>
            ))}
          </div>
          <div className="flex gap-1 items-center">
            <span className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Metric</span>
            {bands.map(b => (
              <Chip key={b} active={band === b} color={bandColor(b)} onClick={() => setMetricBand(b)}>
                &gt;{b}°C
              </Chip>
            ))}
          </div>
        </div>
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="w-full" style={{ maxHeight: 620, background: 'var(--bg-panel)', borderRadius: 4 }}>
          {/* graticule */}
          {graticuleLons.map(lon => (
            <line key={`lon${lon}`} x1={px(lon)} y1={0} x2={px(lon)} y2={MAP_H} stroke="var(--line)" strokeWidth={0.5} strokeDasharray="2 6" />
          ))}
          {graticuleLats.map(lat => (
            <line key={`lat${lat}`} x1={0} y1={py(lat)} x2={MAP_W} y2={py(lat)} stroke="var(--line)" strokeWidth={0.5} strokeDasharray="2 6" />
          ))}

          {/* standard weather grid points */}
          {WEATHER_GRID.map((g, i) => (
            <g key={i} opacity={0.75}>
              <rect x={px(g.lon) - 2.5} y={py(g.lat) - 2.5} width={5} height={5} transform={`rotate(45 ${px(g.lon)} ${py(g.lat)})`} fill="none" stroke="var(--ink-500)" strokeWidth={0.8} />
              <text x={px(g.lon) + 6} y={py(g.lat) + 3} fontSize={8} fill="var(--ink-500)" fontFamily="JetBrains Mono, monospace">
                {g.label}
              </text>
            </g>
          ))}

          {/* archetype traces */}
          {visible.map(({ a, metric }) => {
            const pts = ARCHETYPE_TRACES[a.id]
            const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p[2]).toFixed(1)},${py(p[1]).toFixed(1)}`).join('')
            const norm = wxReady ? metric / maxMetric : 0
            const isActive = active === a.id
            const dim = active != null && !isActive
            return (
              <g key={a.id}>
                <path
                  d={d}
                  fill="none"
                  stroke={groupColor(a.group)}
                  strokeWidth={isActive ? 3.5 : 1.2 + norm * 3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={dim ? 0.12 : 0.35 + norm * 0.6}
                  style={{ transition: 'opacity 150ms, stroke-width 150ms' }}
                />
                {/* invisible fat hit-line */}
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={11}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHovered(a.id)}
                  onMouseLeave={() => setHovered(h => (h === a.id ? null : h))}
                  onClick={() => setPinned(p => (p === a.id ? null : a.id))}
                />
              </g>
            )
          })}
        </svg>

        {/* hover / pinned archetype card */}
        {activeRow && (
          <div
            className="absolute top-3 right-3 p-3 rounded border text-xs w-64"
            style={{ background: 'var(--bg-card-hi)', borderColor: 'var(--line-hi)' }}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium" style={{ color: groupColor(activeRow.a.group) }}>{activeRow.a.group}</div>
                <div className="label-micro text-[9px] mt-0.5" style={{ color: 'var(--ink-500)' }}>
                  {activeRow.a.tier} · {dayType} · n={activeRow.a.n_diagrams} diagrams
                </div>
              </div>
              {pinned === activeRow.a.id && (
                <button onClick={() => setPinned(null)} style={{ color: 'var(--ink-500)' }}><X size={12} /></button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2 numeric-mono text-[10px]" style={{ color: 'var(--ink-300)' }}>
              <div><span style={{ color: 'var(--ink-500)' }}>run</span> {Math.round(activeRow.a.avg_running_min / 60 * 10) / 10}h</div>
              <div><span style={{ color: 'var(--ink-500)' }}>dwell</span> {Math.round(activeRow.a.avg_dwell_min / 60 * 10) / 10}h</div>
              <div><span style={{ color: 'var(--ink-500)' }}>km</span> {activeRow.a.avg_route_km.toLocaleString()}</div>
            </div>
            {activeRow.exp && (
              <div className="mt-2 pt-2 space-y-1" style={{ borderTop: '1px solid var(--line)' }}>
                {bands.map(b => {
                  const acc = activeRow.exp!.bands[b]
                  if (!acc) return null
                  return (
                    <div key={b} className="flex justify-between numeric-mono text-[10px]">
                      <span style={{ color: bandColor(b) }}>&gt;{b}°C</span>
                      <span style={{ color: 'var(--ink-300)' }}>
                        {fmtH(acc.runH)}h run · {fmtH(acc.dwellH)}h dwell · {fmtKm(acc.runKm)}km
                      </span>
                    </div>
                  )
                })}
                <div className="flex justify-between numeric-mono text-[10px]">
                  <span style={{ color: 'var(--ink-500)' }}>peak on route</span>
                  <span style={{ color: 'var(--ink-300)' }}>
                    {activeRow.exp.peakRouteTempC != null ? `${activeRow.exp.peakRouteTempC.toFixed(1)}°C` : '—'}
                  </span>
                </div>
              </div>
            )}
            <div className="text-[9px] mt-1.5" style={{ color: 'var(--ink-500)' }}>
              {pinned === activeRow.a.id ? 'pinned — click route to unpin' : 'click route to pin'}
            </div>
          </div>
        )}
      </div>

      {/* group legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
        {Array.from(new Set(visible.map(v => v.a.group))).map(g => (
          <span key={g} className="inline-flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--ink-400)' }}>
            <span className="inline-block w-3 h-[3px] rounded" style={{ background: groupColor(g) }} />
            {g}
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Exposure tables ─────────────────────────────────────────────────────────

function ExposureTables({ exposure, bands }: {
  exposure: Map<string, ArchetypeExposure> | null
  bands: number[]
}) {
  const [dayType, setDayType] = useState<ExposureDayType>('weekday')
  const topBand = bands[bands.length - 1]

  const rows = useMemo(() => {
    const list = EXPOSURE_ARCHETYPES
      .filter(a => a.day === dayType)
      .map(a => ({ a, exp: exposure?.get(a.id) ?? null }))
    list.sort((x, y) => {
      const xv = x.exp ? x.exp.bands[topBand].runH + x.exp.bands[topBand].dwellH : 0
      const yv = y.exp ? y.exp.bands[topBand].runH + y.exp.bands[topBand].dwellH : 0
      return yv - xv
    })
    return list
  }, [dayType, exposure, topBand])

  const daysSampled = rows.find(r => r.exp && r.exp.daysSampled > 0)?.exp?.daysSampled ?? 0

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Archetype exposure</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            Hours &amp; km in band are averages per sampled day · sorted by &gt;{topBand}°C exposure · {daysSampled} {dayType} day{daysSampled === 1 ? '' : 's'} sampled
          </p>
        </div>
        <div className="flex gap-1">
          {DAY_TYPES.map(d => (
            <Chip key={d.key} active={dayType === d.key} onClick={() => setDayType(d.key)}>
              {d.label.toUpperCase()}
            </Chip>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px]" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>
              <th className="text-left py-2 pr-3 font-normal">Service group</th>
              <th className="text-left py-2 pr-3 font-normal">Tier</th>
              <th className="text-right py-2 pr-3 font-normal">n</th>
              <th className="text-right py-2 pr-3 font-normal">Run min</th>
              <th className="text-right py-2 pr-3 font-normal">Dwell min</th>
              <th className="text-right py-2 pr-4 font-normal">km/day</th>
              {bands.map(b => (
                <th key={b} colSpan={3} className="text-center py-2 px-2 font-normal" style={{ color: bandColor(b), borderLeft: '1px solid var(--line)' }}>
                  &gt;{b}°C — run h · dwell h · run km
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ a, exp }) => (
              <tr key={a.id} style={{ borderTop: '1px solid var(--line)' }}>
                <td className="py-1.5 pr-3" style={{ color: 'var(--ink-200)' }}>
                  <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: groupColor(a.group) }} />
                  {a.group}
                </td>
                <td className="py-1.5 pr-3" style={{ color: 'var(--ink-400)' }}>{a.tier}</td>
                <td className="py-1.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-300)' }}>{a.n_diagrams}</td>
                <td className="py-1.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-300)' }}>{a.avg_running_min}</td>
                <td className="py-1.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-300)' }}>{a.avg_dwell_min}</td>
                <td className="py-1.5 pr-4 text-right numeric-mono" style={{ color: 'var(--ink-300)' }}>{a.avg_route_km.toLocaleString()}</td>
                {bands.map(b => {
                  const acc = exp?.bands[b]
                  const hot = acc && (acc.runH + acc.dwellH) > 0
                  const c = hot ? bandColor(b) : 'var(--ink-500)'
                  return (
                    <td key={b} className="py-1.5 px-2 text-center numeric-mono whitespace-nowrap" style={{ borderLeft: '1px solid var(--line)', color: c }}>
                      {acc ? `${fmtH(acc.runH)} · ${fmtH(acc.dwellH)} · ${fmtKm(acc.runKm)}` : '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Reliability trend: faults vs time of day ────────────────────────────────

const BIN_MIN = 30
const BINS = (24 * 60) / BIN_MIN

function TrendTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="px-3 py-2 rounded border text-xs space-y-1" style={{ background: 'var(--bg-card-hi)', borderColor: 'var(--line-hi)', color: 'var(--ink-200)' }}>
      <div className="font-medium" style={{ color: 'var(--ink-100)' }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ color: 'var(--ink-500)' }}>
          {p.name}: <span className="numeric-mono" style={{ color: p.stroke }}>{p.value.toFixed(3)}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Deep-dive helpers ───────────────────────────────────────────────────────

interface JoinedFault {
  incident: IncidentRow
  date: string
  minute: number
  group: string
  archetypeId: string
  extreme: boolean
}

const CUM_BUCKETS = [
  { label: '0–1h', lo: 0, hi: 1 },
  { label: '1–2h', lo: 1, hi: 2 },
  { label: '2–3h', lo: 2, hi: 3 },
  { label: '3h+', lo: 3, hi: Infinity },
]

const N_FLOOR = 5   // grey out cells resting on fewer diagram-days than this

function heatColor(rate: number, max: number): string {
  if (max <= 0 || rate <= 0) return 'rgba(39, 174, 96, 0.12)'
  const t = Math.min(1, rate / max)
  if (t < 0.5) return `rgba(243, 156, 18, ${0.10 + t * 0.5})`
  return `rgba(231, 76, 60, ${0.12 + (t - 0.5) * 0.75})`
}

// ─── Main tab ────────────────────────────────────────────────────────────────

export function TemperatureExposureTab({ incidents, windowFrom, windowTo }: {
  incidents: IncidentRow[]
  windowFrom: string
  windowTo: string
}) {
  // Section-level date range (defaults to the app window)
  const [from, setFrom] = useState(windowFrom)
  const [to, setTo] = useState(windowTo)
  const [draftFrom, setDraftFrom] = useState(windowFrom)
  const [draftTo, setDraftTo] = useState(windowTo)

  // User-definable greater-than temperature bands
  const [bands, setBands] = useState<number[]>(DEFAULT_BANDS)
  const [newBand, setNewBand] = useState('')

  // Extreme-day threshold (max grid temp at/above this = extreme day)
  const [extremeThreshold, setExtremeThreshold] = useState(30)

  // Fault filters shared by the trend chart + deep-dive
  const [faultCats, setFaultCats] = useState<IncidentCategory[]>(['TRAIN_FAULT'])
  const [groupFilter, setGroupFilter] = useState<string[]>([])
  const [trendDayTypes, setTrendDayTypes] = useState<ExposureDayType[]>([])

  // Deep-dive band selector
  const [ddBand, setDdBand] = useState<number | null>(null)

  // ── Weather fetch ──────────────────────────────────────────────────────────
  const [wxState, setWxState] = useState<{ status: 'loading' | 'ready' | 'error'; wx: HourlyGridWeather | null }>({ status: 'loading', wx: null })

  useEffect(() => {
    let alive = true
    setWxState({ status: 'loading', wx: null })
    fetchGridWeather(from, to)
      .then(wx => { if (alive) setWxState({ status: 'ready', wx }) })
      .catch(() => { if (alive) setWxState({ status: 'error', wx: null }) })
    return () => { alive = false }
  }, [from, to])

  const wx = wxState.wx

  // ── Fault data for the section's own range ─────────────────────────────────
  // The app-level feed only covers [windowFrom..windowTo]. When the section
  // range extends beyond it (e.g. the July heat window from an August app
  // window), fetch incidents for the full range directly so extreme days
  // outside the app window still get their faults. Demo mode (no Supabase)
  // falls back to clipping against the loaded feed.
  const needsOwnFetch = from < windowFrom || to > windowTo
  const [rangeIncidents, setRangeIncidents] = useState<IncidentRow[] | null>(null)
  const [rangeLoading, setRangeLoading] = useState(false)

  useEffect(() => {
    let alive = true
    setRangeIncidents(null)
    if (!needsOwnFetch || !isSupabaseConfigured()) return
    setRangeLoading(true)
    fetchIncidentsForRange(from, to)
      .then(rows => { if (alive) setRangeIncidents(rows) })
      .catch(() => { if (alive) setRangeIncidents(null) })
      .finally(() => { if (alive) setRangeLoading(false) })
    return () => { alive = false }
  }, [from, to, needsOwnFetch])

  const usingOwnFetch = rangeIncidents != null
  const faultSource = usingOwnFetch ? rangeIncidents : incidents

  function applyRange() {
    if (!draftFrom || !draftTo || draftTo < draftFrom) return
    // Clamp: ≤ 92 days (compute + API budget), ≤ forecast horizon
    let f = draftFrom
    let t = draftTo
    const maxTo = new Date(f + 'T00:00:00Z')
    maxTo.setUTCDate(maxTo.getUTCDate() + 91)
    const horizon = new Date(); horizon.setDate(horizon.getDate() + 14)
    const clampTo = [t, maxTo.toISOString().slice(0, 10), horizon.toISOString().slice(0, 10)]
      .sort()[0]
    setFrom(f); setTo(clampTo); setDraftTo(clampTo)
  }

  const sortedBands = useMemo(() => [...bands].sort((a, b) => a - b), [bands])

  // ── Core compute ───────────────────────────────────────────────────────────
  const exposure = useMemo(
    () => (wx ? computeExposure(wx, from, to, sortedBands) : null),
    [wx, from, to, sortedBands],
  )

  // Daily max grid temp, restricted to the selected window
  const dayMax = useMemo(() => {
    if (!wx) return new Map<string, number>()
    const all = dailyGridMax(wx)
    const out = new Map<string, number>()
    for (const d of datesInRange(from, to)) {
      const v = all.get(d)
      if (v != null) out.set(d, v)
    }
    return out
  }, [wx, from, to])

  // Fault panels cover the whole section range when the section fetched its
  // own incidents; otherwise only where the loaded feed overlaps it.
  const faultFrom = usingOwnFetch ? from : (from > windowFrom ? from : windowFrom)
  const faultTo = usingOwnFetch ? to : (to < windowTo ? to : windowTo)
  const faultWindowOk = faultFrom <= faultTo

  const classifiedDates = useMemo(() => {
    if (!faultWindowOk) return [] as { date: string; extreme: boolean }[]
    return datesInRange(faultFrom, faultTo)
      .filter(d => dayMax.has(d))
      .map(d => ({ date: d, extreme: dayMax.get(d)! >= extremeThreshold }))
  }, [faultWindowOk, faultFrom, faultTo, dayMax, extremeThreshold])

  const extremeDates = useMemo(() => classifiedDates.filter(d => d.extreme).map(d => d.date), [classifiedDates])
  const baselineDates = useMemo(() => classifiedDates.filter(d => !d.extreme).map(d => d.date), [classifiedDates])
  const dateClass = useMemo(() => new Map(classifiedDates.map(d => [d.date, d.extreme])), [classifiedDates])

  // ── Fault set (shared filters) ─────────────────────────────────────────────
  const allGroups = useMemo(
    () => Array.from(new Set(EXPOSURE_ARCHETYPES.map(a => a.group))).filter(g => g !== 'UNCLASSIFIED'),
    [],
  )

  const faults = useMemo(() => {
    return nonContinuation(faultSource).filter(i => {
      if (!faultCats.includes(i.category)) return false
      if (!dateClass.has(i.report_date)) return false
      if (trendDayTypes.length && !trendDayTypes.includes(classifyDayType(i.report_date))) return false
      if (groupFilter.length && !groupFilter.includes(headcodeToGroup(i.train_id))) return false
      return true
    })
  }, [faultSource, faultCats, dateClass, trendDayTypes, groupFilter])

  const unclassifiedFaults = useMemo(
    () => faults.filter(i => headcodeToGroup(i.train_id) === 'UNCLASSIFIED').length,
    [faults],
  )

  // ── Trend chart bins ───────────────────────────────────────────────────────
  const trendData = useMemo(() => {
    const nExtreme = extremeDates.length
    const nBaseline = baselineDates.length
    const ext = new Array(BINS).fill(0)
    const base = new Array(BINS).fill(0)
    for (const i of faults) {
      const m = faultMinute(i)
      if (m == null) continue
      const bin = Math.min(BINS - 1, Math.floor(m / BIN_MIN))
      if (dateClass.get(i.report_date)) ext[bin]++
      else base[bin]++
    }
    return Array.from({ length: BINS }, (_, b) => {
      const h = Math.floor((b * BIN_MIN) / 60)
      const m = (b * BIN_MIN) % 60
      return {
        label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        extreme: nExtreme ? ext[b] / nExtreme : 0,
        baseline: nBaseline ? base[b] / nBaseline : 0,
      }
    })
  }, [faults, dateClass, extremeDates.length, baselineDates.length])

  // ── Deep-dive joins ────────────────────────────────────────────────────────
  const deepBand = ddBand != null && sortedBands.includes(ddBand)
    ? ddBand
    : sortedBands[sortedBands.length - 1]

  const joined = useMemo<JoinedFault[]>(() => {
    if (!wx) return []
    const out: JoinedFault[] = []
    for (const i of faults) {
      const m = faultMinute(i)
      if (m == null) continue
      const arch = headcodeToArchetype(i.train_id, i.report_date)
      if (!arch) continue
      out.push({
        incident: i, date: i.report_date, minute: m,
        group: arch.group, archetypeId: arch.id,
        extreme: dateClass.get(i.report_date) ?? false,
      })
    }
    return out
  }, [wx, faults, dateClass])

  // Panel A — divergence curve: cumulative faults/day vs cumulative
  // hours-above-band at time of fault.
  const divergence = useMemo(() => {
    if (!wx) return { points: [] as any[], nExt: 0, nBase: 0 }
    const extVals: number[] = []
    const baseVals: number[] = []
    for (const f of joined) {
      const cum = cumulativeExposureAt(f.archetypeId, wx, f.date, f.minute, deepBand)
      if (!cum) continue
      ;(f.extreme ? extVals : baseVals).push(cum.hours)
    }
    extVals.sort((a, b) => a - b)
    baseVals.sort((a, b) => a - b)
    const maxX = Math.max(1, ...extVals, ...baseVals)
    const nE = Math.max(1, extremeDates.length)
    const nB = Math.max(1, baselineDates.length)
    const points = []
    for (let x = 0; x <= maxX + 0.25; x += 0.25) {
      points.push({
        x: Math.round(x * 100) / 100,
        extreme: extVals.filter(v => v <= x).length / nE,
        baseline: baseVals.filter(v => v <= x).length / nB,
      })
    }
    return { points, nExt: extVals.length, nBase: baseVals.length }
  }, [wx, joined, deepBand, extremeDates.length, baselineDates.length])

  // Panel B — threshold heat-grid on extreme days: rows = cumulative-exposure
  // buckets, columns = bands; cell = faults per 100 diagram-days at risk.
  const heatGrid = useMemo(() => {
    if (!wx) return null
    const extremeJoined = joined.filter(f => f.extreme)
    const cells = sortedBands.map(band => {
      // full-day exposure per (extreme date, archetype) → diagram-days per bucket
      const denomByBucket = CUM_BUCKETS.map(() => 0)
      for (const date of extremeDates) {
        const day = classifyDayType(date)
        for (const a of EXPOSURE_ARCHETYPES) {
          if (a.day !== day) continue
          const full = cumulativeExposureAt(a.id, wx, date, 1500, band)
          if (!full) continue
          CUM_BUCKETS.forEach((bk, bi) => {
            if (full.hours >= bk.lo) denomByBucket[bi] += a.n_diagrams
          })
        }
      }
      return CUM_BUCKETS.map((bk, bi) => {
        let n = 0
        for (const f of extremeJoined) {
          const cum = cumulativeExposureAt(f.archetypeId, wx, f.date, f.minute, band)
          if (!cum) continue
          if (cum.hours >= bk.lo && cum.hours < bk.hi) n++
        }
        const denom = denomByBucket[bi]
        return { band, bucket: bk.label, n, denom, rate: denom > 0 ? (n / denom) * 100 : 0 }
      })
    })
    const maxRate = Math.max(0, ...cells.flat().filter(c => c.denom >= N_FLOOR).map(c => c.rate))
    return { cells, maxRate }
  }, [wx, joined, sortedBands, extremeDates])

  // Panel C — fault rate per 100 diagram-days by service group, extreme vs
  // baseline side-by-side.
  const groupComparison = useMemo(() => {
    if (!wx) return []
    const diagramDays = (group: string, dates: string[]) => {
      let n = 0
      for (const date of dates) {
        const day = classifyDayType(date)
        for (const a of EXPOSURE_ARCHETYPES) {
          if (a.group === group && a.day === day) n += a.n_diagrams
        }
      }
      return n
    }
    return allGroups
      .map(group => {
        const extN = joined.filter(f => f.group === group && f.extreme).length
        const baseN = joined.filter(f => f.group === group && !f.extreme).length
        const extDD = diagramDays(group, extremeDates)
        const baseDD = diagramDays(group, baselineDates)
        return {
          group,
          shortGroup: group.replace(' - ', '–'),
          extreme: extDD > 0 ? (extN / extDD) * 100 : 0,
          baseline: baseDD > 0 ? (baseN / baseDD) * 100 : 0,
          extN, baseN, extDD, baseDD,
          thin: extN + baseN < N_FLOOR,
        }
      })
      .filter(g => g.extDD > 0 || g.baseDD > 0)
      .sort((a, b) => b.extreme - a.extreme)
  }, [wx, joined, allGroups, extremeDates, baselineDates])

  // ── Header stats ───────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    let peak: number | null = null
    let hottestDay: string | null = null
    dayMax.forEach((v, d) => {
      if (peak == null || v > peak) { peak = v; hottestDay = d }
    })
    const lowBand = sortedBands[0]
    const topBand30 = sortedBands.find(b => b >= 30) ?? sortedBands[sortedBands.length - 1]
    let over5h = 0
    let anyHotRunning = 0
    if (exposure) {
      exposure.forEach(e => {
        if (e.daysSampled === 0) return
        const low = e.bands[lowBand]
        if (low && low.runH + low.dwellH > 5) over5h++
        const hot = e.bands[topBand30]
        if (hot && hot.runH > 0) anyHotRunning++
      })
    }
    const extFaults = faults.filter(i => dateClass.get(i.report_date)).length
    const baseFaults = faults.length - extFaults
    return { peak: peak as number | null, hottestDay: hottestDay as string | null, over5h, anyHotRunning, extFaults, baseFaults, lowBand, topBand30 }
  }, [dayMax, exposure, sortedBands, faults, dateClass])

  const loading = wxState.status === 'loading'

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="card p-5">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div>
            <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>From</div>
            <input type="date" className="input text-xs" value={draftFrom} onChange={e => setDraftFrom(e.target.value)} />
          </div>
          <div>
            <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>To</div>
            <input type="date" className="input text-xs" value={draftTo} onChange={e => setDraftTo(e.target.value)} />
          </div>
          <button className="btn text-xs" onClick={applyRange}>
            <CalendarRange size={12} className="inline mr-1.5" style={{ verticalAlign: '-2px' }} />Apply
          </button>
          <button
            className="btn text-xs"
            onClick={() => {
              setDraftFrom(JULY_2026_REFERENCE_WINDOW[0]); setDraftTo(JULY_2026_REFERENCE_WINDOW[1])
              setFrom(JULY_2026_REFERENCE_WINDOW[0]); setTo(JULY_2026_REFERENCE_WINDOW[1])
            }}
          >
            <Flame size={12} className="inline mr-1.5" style={{ verticalAlign: '-2px', color: 'var(--nr-orange)' }} />Jul 2026 heat window
          </button>
          <button
            className="btn text-xs"
            onClick={() => { setDraftFrom(windowFrom); setDraftTo(windowTo); setFrom(windowFrom); setTo(windowTo) }}
          >
            <RotateCcw size={12} className="inline mr-1.5" style={{ verticalAlign: '-2px' }} />App window
          </button>

          <div className="flex items-end gap-2">
            <div>
              <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>Temperature bands (&gt;°C)</div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {sortedBands.map(b => (
                  <span
                    key={b}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] numeric-mono"
                    style={{ border: `1px solid ${bandColor(b)}`, color: bandColor(b) }}
                  >
                    &gt;{b}°C
                    {sortedBands.length > 1 && (
                      <button onClick={() => setBands(bs => bs.filter(x => x !== b))} style={{ color: 'var(--ink-500)' }}>
                        <X size={10} />
                      </button>
                    )}
                  </span>
                ))}
                <input
                  className="input text-xs w-14"
                  placeholder="+28"
                  value={newBand}
                  onChange={e => setNewBand(e.target.value)}
                  onKeyDown={e => {
                    if (e.key !== 'Enter') return
                    const v = parseInt(newBand.replace(/[^0-9]/g, ''), 10)
                    if (Number.isFinite(v) && v >= 15 && v <= 45 && !bands.includes(v)) {
                      setBands(bs => [...bs, v]); setNewBand('')
                    }
                  }}
                />
                <button
                  className="btn text-xs px-2"
                  onClick={() => {
                    const v = parseInt(newBand.replace(/[^0-9]/g, ''), 10)
                    if (Number.isFinite(v) && v >= 15 && v <= 45 && !bands.includes(v)) {
                      setBands(bs => [...bs, v]); setNewBand('')
                    }
                  }}
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>
          </div>

          <div>
            <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>Extreme day ≥ °C (grid max)</div>
            <input
              type="number" className="input text-xs w-20" value={extremeThreshold}
              min={20} max={45}
              onChange={e => { const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) setExtremeThreshold(v) }}
            />
          </div>

          <div className="ml-auto flex items-center gap-2 text-[11px]" style={{ color: 'var(--ink-400)' }}>
            {loading && <><Loader2 size={13} className="animate-spin" style={{ color: 'var(--nr-orange)' }} /> Sampling grid weather…</>}
            {wxState.status === 'error' && (
              <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--nr-red)' }}>
                <AlertTriangle size={13} /> Open-Meteo fetch failed — retry via Apply
              </span>
            )}
            {wxState.status === 'ready' && (
              <span className="numeric-mono">
                {dayMax.size}/{datesInRange(from, to).length} days sampled · {extremeDates.length} extreme · {baselineDates.length} baseline
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 stagger">
        <StatCard
          label="Window peak temp"
          value={stats.peak != null ? `${stats.peak.toFixed(1)}°` : '—'}
          sub="max across 15-pt grid"
          accent
        />
        <StatCard
          label="Hottest day"
          value={stats.hottestDay ? stats.hottestDay.slice(5) : '—'}
          sub={stats.hottestDay ? `${classifyDayType(stats.hottestDay)} · ${dayMax.get(stats.hottestDay)?.toFixed(1)}°C` : 'no sampled days'}
        />
        <StatCard
          label={`Archetypes >5h/day over ${stats.lowBand}°`}
          value={exposure ? String(stats.over5h) : '—'}
          sub={`of ${EXPOSURE_ARCHETYPES.length} archetypes`}
        />
        <StatCard
          label={`Any >${stats.topBand30}° running`}
          value={exposure ? String(stats.anyHotRunning) : '—'}
          sub="archetypes with hot running time"
        />
        <StatCard
          label="Faults · extreme days"
          value={String(stats.extFaults)}
          sub={extremeDates.length ? `${(stats.extFaults / extremeDates.length).toFixed(1)}/day over ${extremeDates.length} days` : 'no extreme days'}
          accent={stats.extFaults > 0}
        />
        <StatCard
          label="Faults · baseline days"
          value={String(stats.baseFaults)}
          sub={baselineDates.length ? `${(stats.baseFaults / baselineDates.length).toFixed(1)}/day over ${baselineDates.length} days` : 'no baseline days'}
        />
      </div>

      {/* Route map */}
      <RouteMap exposure={exposure} bands={sortedBands} wxReady={wxState.status === 'ready'} />

      {/* Exposure tables */}
      <ExposureTables exposure={exposure} bands={sortedBands} />

      {/* Fault filters + trend chart */}
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
          <div>
            <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Faults vs time of day</h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
              Average faults per day per 30-min bin · extreme = grid max ≥ {extremeThreshold}°C ·
              if heat exposure accumulates, the extreme line should diverge upward from mid-afternoon
            </p>
          </div>
          <div className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>
            {extremeDates.length} extreme · {baselineDates.length} baseline days
          </div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-2 my-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Fault types</span>
            {FAULT_CATEGORIES.map(c => (
              <Chip
                key={c}
                active={faultCats.includes(c)}
                color={CATEGORY_CONFIG[c].color}
                onClick={() => setFaultCats(fc => fc.includes(c) ? (fc.length > 1 ? fc.filter(x => x !== c) : fc) : [...fc, c])}
              >
                {CATEGORY_CONFIG[c].short}
              </Chip>
            ))}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Day type</span>
            {DAY_TYPES.map(d => (
              <Chip
                key={d.key}
                active={trendDayTypes.includes(d.key)}
                onClick={() => setTrendDayTypes(ts => ts.includes(d.key) ? ts.filter(x => x !== d.key) : [...ts, d.key])}
              >
                {d.label.toUpperCase()}
              </Chip>
            ))}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Service group</span>
            {allGroups.map(g => (
              <Chip
                key={g}
                active={groupFilter.includes(g)}
                color={groupColor(g)}
                onClick={() => setGroupFilter(gf => gf.includes(g) ? gf.filter(x => x !== g) : [...gf, g])}
              >
                {g.replace(' - ', '–').toUpperCase()}
              </Chip>
            ))}
          </div>
        </div>

        {!faultWindowOk ? (
          <div className="text-xs py-8 text-center" style={{ color: 'var(--ink-500)' }}>
            Selected range does not overlap the loaded incident window ({windowFrom} – {windowTo}) — adjust the app-level date filter to load fault data for this range.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={trendData} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
              <CartesianGrid strokeDasharray="2 6" stroke="var(--line)" vertical={false} />
              <XAxis
                dataKey="label" interval={5} tickLine={false} axisLine={{ stroke: 'var(--line)' }}
                tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
              />
              <YAxis
                tickLine={false} axisLine={false}
                tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
              />
              <Tooltip content={<TrendTip />} />
              <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }} />
              <Line
                type="monotone" dataKey="baseline" name={`Baseline (<${extremeThreshold}°C, n=${baselineDates.length}d)`}
                stroke="var(--nr-blue)" strokeWidth={1.5} dot={false}
              />
              <Line
                type="monotone" dataKey="extreme" name={`Extreme (≥${extremeThreshold}°C, n=${extremeDates.length}d)`}
                stroke="var(--nr-orange)" strokeWidth={2} dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
        {rangeLoading && (
          <div className="text-[10px] mt-1" style={{ color: 'var(--ink-500)' }}>
            Loading fault data for {from} – {to}…
          </div>
        )}
        {!usingOwnFetch && faultWindowOk && (faultFrom !== from || faultTo !== to) && !rangeLoading && (
          <div className="text-[10px] mt-1" style={{ color: 'var(--nr-amber)' }}>
            Fault data limited to the loaded incident window {faultFrom} – {faultTo} (no database connection to load the full range); exposure metrics still cover the full selected range.
          </div>
        )}
      </div>

      {/* Deep-dive */}
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Extreme vs baseline — cumulative exposure at fault</h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
              Each fault joined to its archetype via headcode prefix; exposure accumulated along the trace up to the fault&apos;s time of day ·
              {' '}{joined.length} of {faults.length} filtered faults joined
              {unclassifiedFaults > 0 && ` · ${unclassifiedFaults} unclassified headcodes excluded`}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Band</span>
            {sortedBands.map(b => (
              <Chip key={b} active={deepBand === b} color={bandColor(b)} onClick={() => setDdBand(b)}>
                &gt;{b}°C
              </Chip>
            ))}
          </div>
        </div>

        {!faultWindowOk || !wx ? (
          <div className="text-xs py-8 text-center" style={{ color: 'var(--ink-500)' }}>
            {loading ? 'Sampling grid weather…' : 'No overlapping fault + weather data for this range.'}
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {/* Panel A — divergence curve */}
            <div>
              <div className="label-micro text-[9px] mb-2" style={{ color: 'var(--ink-500)' }}>
                A · Cumulative faults/day vs hours &gt;{deepBand}°C accumulated at fault time
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={divergence.points} margin={{ top: 4, right: 12, bottom: 14, left: -18 }}>
                  <CartesianGrid strokeDasharray="2 6" stroke="var(--line)" vertical={false} />
                  <XAxis
                    dataKey="x" type="number" domain={[0, 'dataMax']} tickLine={false}
                    axisLine={{ stroke: 'var(--line)' }}
                    tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
                    label={{ value: `cumulative h >${deepBand}°C at fault`, position: 'insideBottom', offset: -8, fontSize: 9, fill: 'var(--ink-500)' }}
                  />
                  <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }} />
                  <Tooltip content={<TrendTip />} />
                  <Line type="stepAfter" dataKey="baseline" name={`Baseline (${divergence.nBase} faults)`} stroke="var(--nr-blue)" strokeWidth={1.5} dot={false} />
                  <Line type="stepAfter" dataKey="extreme" name={`Extreme (${divergence.nExt} faults)`} stroke="var(--nr-orange)" strokeWidth={2} dot={false} />
                  <Legend verticalAlign="top" wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }} />
                </LineChart>
              </ResponsiveContainer>
              <div className="text-[10px] mt-1" style={{ color: 'var(--ink-500)' }}>
                A knee in the extreme curve marks the exposure level where failures start clustering.
              </div>
            </div>

            {/* Panel B — threshold heat-grid */}
            <div>
              <div className="label-micro text-[9px] mb-2" style={{ color: 'var(--ink-500)' }}>
                B · Extreme-day fault rate per 100 diagram-days · rows = cumulative exposure at fault
              </div>
              {heatGrid && (
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]" style={{ borderCollapse: 'separate', borderSpacing: 3 }}>
                    <thead>
                      <tr>
                        <th className="label-micro text-[9px] text-left font-normal" style={{ color: 'var(--ink-500)' }}>cum. exposure</th>
                        {sortedBands.map(b => (
                          <th key={b} className="label-micro text-[9px] text-center font-normal" style={{ color: bandColor(b) }}>&gt;{b}°C</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {CUM_BUCKETS.map((bk, bi) => (
                        <tr key={bk.label}>
                          <td className="numeric-mono text-[10px] pr-2" style={{ color: 'var(--ink-400)' }}>{bk.label}</td>
                          {sortedBands.map((b, ci) => {
                            const cell = heatGrid.cells[ci][bi]
                            const thin = cell.denom < N_FLOOR
                            return (
                              <td
                                key={b}
                                className="text-center py-2.5 px-2 rounded-sm numeric-mono"
                                style={{
                                  background: thin ? 'var(--bg-card-hi)' : heatColor(cell.rate, heatGrid.maxRate),
                                  color: thin ? 'var(--ink-500)' : 'var(--ink-100)',
                                  opacity: thin ? 0.6 : 1,
                                }}
                                title={`${cell.n} faults over ${cell.denom} diagram-days`}
                              >
                                <div className="text-[12px]">{thin ? '·' : cell.rate.toFixed(1)}</div>
                                <div className="text-[8px]" style={{ color: thin ? 'var(--ink-500)' : 'var(--ink-300)' }}>
                                  n={cell.n}{thin ? ` · <${N_FLOOR}dd` : ''}
                                </div>
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="text-[10px] mt-1" style={{ color: 'var(--ink-500)' }}>
                Denominator = diagram-days whose trace reached that cumulative exposure. Cells on &lt;{N_FLOOR} diagram-days are greyed. A hot bottom-right corner = failures cluster behind accumulated heat.
              </div>
            </div>

            {/* Panel C — group comparison */}
            <div className="xl:col-span-2">
              <div className="label-micro text-[9px] mb-2" style={{ color: 'var(--ink-500)' }}>
                C · Fault rate per 100 diagram-days by service group — extreme vs baseline
              </div>
              <ResponsiveContainer width="100%" height={Math.max(160, groupComparison.length * 34)}>
                <BarChart data={groupComparison} layout="vertical" margin={{ top: 4, right: 40, bottom: 0, left: 40 }}>
                  <CartesianGrid strokeDasharray="2 6" stroke="var(--line)" horizontal={false} />
                  <XAxis type="number" tickLine={false} axisLine={{ stroke: 'var(--line)' }} tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }} />
                  <YAxis
                    type="category" dataKey="shortGroup" width={170} tickLine={false} axisLine={false}
                    tick={{ fontSize: 10, fill: 'var(--ink-300)' }}
                  />
                  <Tooltip
                    content={({ active, payload }: any) => {
                      if (!active || !payload?.length) return null
                      const d = payload[0].payload
                      return (
                        <div className="px-3 py-2 rounded border text-xs space-y-1" style={{ background: 'var(--bg-card-hi)', borderColor: 'var(--line-hi)', color: 'var(--ink-200)' }}>
                          <div className="font-medium" style={{ color: 'var(--ink-100)' }}>{d.group}</div>
                          <div style={{ color: 'var(--ink-500)' }}>Extreme: <span className="numeric-mono" style={{ color: 'var(--nr-orange)' }}>{d.extreme.toFixed(1)}</span> ({d.extN} faults / {d.extDD} dd)</div>
                          <div style={{ color: 'var(--ink-500)' }}>Baseline: <span className="numeric-mono" style={{ color: 'var(--nr-blue)' }}>{d.baseline.toFixed(1)}</span> ({d.baseN} faults / {d.baseDD} dd)</div>
                          {d.thin && <div style={{ color: 'var(--nr-amber)' }}>thin sample — &lt;{N_FLOOR} faults total</div>}
                        </div>
                      )
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }} />
                  <Bar dataKey="baseline" name="Baseline" fill="var(--nr-blue)" barSize={8} radius={[0, 2, 2, 0]} fillOpacity={0.7} />
                  <Bar dataKey="extreme" name="Extreme" fill="var(--nr-orange)" barSize={8} radius={[0, 2, 2, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="text-[10px] mt-1" style={{ color: 'var(--ink-500)' }}>
                Tests the July prediction: MML intercity diagrams should over-index on extreme afternoons vs coastal/northern regionals. Thin samples (&lt;{N_FLOOR} faults) shown but not load-bearing.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Provenance & caveats */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Info size={13} style={{ color: 'var(--ink-500)' }} />
          <span className="label-micro">Method &amp; caveats</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-2 text-[11px]" style={{ color: 'var(--ink-400)' }}>
          <div className="space-y-1.5">
            <p>
              <span style={{ color: 'var(--ink-300)' }}>Archetypes</span> — derived from the NWR CIF full daily extract (12 Aug 2026), EMR permanent schedules only; diagrams inferred by chaining trips at shared locations with ≤90 min turnaround, classified into service groups by running-time-weighted vote and tiered full-day/part-day at 600 min running. Regenerated at each timetable change (Dec/May) via <span className="numeric-mono">scripts/seed-exposure.mjs</span>.
            </p>
            <p>
              <span style={{ color: 'var(--ink-300)' }}>Mileage</span> — chained great-circle between coordinate-known calling points: a consistent ~5–10% underestimate of true route miles. In-band km apportioned uniformly across running trace points.
            </p>
            <p>
              <span style={{ color: 'var(--ink-300)' }}>Weather</span> — Open-Meteo hourly temperatures sampled at the nearest of 15 standard grid points along each trace (archive for settled days, forecast API for the recent/forecast tail). Compute validated against the 4–17 Jul 2026 reference; residual differences of a few tenths of an hour reflect upstream ERA5 data revisions since the analysis snapshot.
            </p>
          </div>
          <div className="space-y-1.5">
            <p>
              <span style={{ color: 'var(--nr-amber)' }}>One unit per diagram assumed</span> — breaks on disrupted days; treat disrupted-day joins with suspicion.
            </p>
            <p>
              <span style={{ color: 'var(--nr-amber)' }}>Fault→archetype mapping is service-group-level</span>, not true unit-level, until the live consist feed lands (Phase 2). Headcode prefix → group is empirical from EMR CIF data; 1B/1D default to Nottingham–STP (≥96%), 2K merged into the Lincoln regional bucket; unmatched prefixes are excluded as UNCLASSIFIED, never force-fitted. Tier defaults to full-day.
            </p>
            <p>
              <span style={{ color: 'var(--nr-amber)' }}>Pattern-finder, not a significance test</span> — cells and groups resting on fewer than {N_FLOOR} diagram-days/faults are greyed or flagged; small-n archetypes (n≤2) carry misclassified edge diagrams.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
