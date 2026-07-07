'use client'

import { useState, useMemo } from 'react'
import { CloudRain, SlidersHorizontal, LayoutGrid, TrendingUp, Info } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { IncidentRow, CATEGORY_CONFIG, IncidentCategory } from '@/lib/types'
import { effectiveDelay, nonContinuation } from '@/lib/queries'
import { WeatherDay, CONDITION_GROUPS, conditionGroup } from '@/lib/weather'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MIN_SAMPLE = 5   // area-days below which lift is suppressed
const BASELINE   = 'Clear / Dry'

function fmtMin(n: number): string {
  return `${Math.round(n).toLocaleString()}m`
}

function fmtRate(n: number): string {
  return n.toFixed(2)
}

function liftColor(l: number): string {
  if (l > 1.75) return '#E74C3C'
  if (l > 1.25) return 'var(--nr-amber)'
  if (l <= 1)   return 'var(--ink-500)'
  return 'var(--ink-300)'
}

function fmtLift(l: number): string {
  return `${l.toFixed(2)}×`
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface GroupStat {
  group:     string
  areaDays:  number
  incidents: number   // non-continuation incidents on those area-days
  delay:     number   // effectiveDelay sum on those area-days
  incRate:   number   // incidents per area-day
  delayRate: number   // delay minutes per area-day
}

type WxMetricKey = 'rain' | 'wind' | 'thigh' | 'tlow'

interface WxMetric {
  key:   WxMetricKey
  label: string
  value: (w: WeatherDay) => number | null
  bands: { label: string; test: (v: number) => boolean }[]
}

const WX_METRICS: WxMetric[] = [
  {
    key: 'rain', label: 'Rainfall (mm)',
    value: w => w.rainfall_mm,
    bands: [
      { label: '0',    test: v => v <= 0 },
      { label: '0–2',  test: v => v > 0  && v <= 2 },
      { label: '2–5',  test: v => v > 2  && v <= 5 },
      { label: '5–10', test: v => v > 5  && v <= 10 },
      { label: '10+',  test: v => v > 10 },
    ],
  },
  {
    key: 'wind', label: 'Max wind (km/h)',
    value: w => w.max_wind_kmh,
    bands: [
      { label: '<30',   test: v => v < 30 },
      { label: '30–45', test: v => v >= 30 && v < 45 },
      { label: '45–60', test: v => v >= 45 && v < 60 },
      { label: '60+',   test: v => v >= 60 },
    ],
  },
  {
    key: 'thigh', label: 'Day high (°C)',
    value: w => w.max_temp_c,
    bands: [
      { label: '<2',    test: v => v < 2 },
      { label: '2–10',  test: v => v >= 2  && v < 10 },
      { label: '10–20', test: v => v >= 10 && v < 20 },
      { label: '20–25', test: v => v >= 20 && v < 25 },
      { label: '25+',   test: v => v >= 25 },
    ],
  },
  {
    key: 'tlow', label: 'Day low (°C)',
    value: w => w.min_temp_c,
    bands: [
      { label: '<0',    test: v => v < 0 },
      { label: '0–5',   test: v => v >= 0  && v < 5 },
      { label: '5–10',  test: v => v >= 5  && v < 10 },
      { label: '10–15', test: v => v >= 10 && v < 15 },
      { label: '15+',   test: v => v >= 15 },
    ],
  },
]

// ─── Chart bits ───────────────────────────────────────────────────────────────

// Two-line x-axis tick: band label + area-day count underneath
function BandTick(props: any) {
  const { x, y, index, bands } = props
  const b = bands?.[index]
  if (!b) return <g />
  return (
    <g transform={`translate(${x},${y})`}>
      <text dy={10} textAnchor="middle" fontSize={9} fill="var(--ink-400)" fontFamily="JetBrains Mono, monospace">
        {b.band}
      </text>
      <text dy={22} textAnchor="middle" fontSize={8} fill="var(--ink-500)" fontFamily="JetBrains Mono, monospace">
        {b.days}d
      </text>
    </g>
  )
}

function BandTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  return (
    <div
      className="px-3 py-2 rounded border text-xs space-y-1"
      style={{ background: 'var(--bg-card-hi)', borderColor: 'var(--line-hi)', color: 'var(--ink-200)' }}
    >
      <div className="font-medium" style={{ color: 'var(--ink-100)' }}>{label}</div>
      <div style={{ color: 'var(--ink-500)' }}>
        Incidents / area-day: <span className="numeric-mono" style={{ color: 'var(--nr-orange)' }}>{fmtRate(d.incRate)}</span>
      </div>
      <div style={{ color: 'var(--ink-500)' }}>
        Delay / area-day: <span className="numeric-mono" style={{ color: 'var(--nr-blue)' }}>{fmtMin(d.delayRate)}</span>
      </div>
      <div className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{d.days} area-days in band</div>
    </div>
  )
}

// ─── WeatherTab ───────────────────────────────────────────────────────────────

export function WeatherTab({
  incidents,
  weatherData,
  windowFrom,
  windowTo,
}: {
  incidents:   IncidentRow[]
  weatherData: WeatherDay[]
  windowFrom:  string
  windowTo:    string
}) {
  const [metricKey, setMetricKey] = useState<WxMetricKey>('rain')

  // Weather rows inside the window; the unit of analysis is the "area-day" —
  // one (area, date) pair that has a weather row.
  const wxInWindow = useMemo(
    () => weatherData.filter(w => w.date >= windowFrom && w.date <= windowTo),
    [weatherData, windowFrom, windowTo],
  )

  const wxMap = useMemo(() => {
    const m = new Map<string, WeatherDay>()
    wxInWindow.forEach(w => m.set(`${w.area}::${w.date}`, w))
    return m
  }, [wxInWindow])

  // Per-area-day incident load: count (non-continuation) + delay (effective)
  const perDayLoad = useMemo(() => {
    const m = new Map<string, { inc: number; delay: number }>()
    const counted = new Set(nonContinuation(incidents).map(i => i.id))
    incidents.forEach(i => {
      if (!i.area) return
      const key = `${i.area}::${i.report_date}`
      if (!wxMap.has(key)) return
      const cur = m.get(key) ?? { inc: 0, delay: 0 }
      cur.delay += effectiveDelay(i)
      if (counted.has(i.id)) cur.inc += 1
      m.set(key, cur)
    })
    return m
  }, [incidents, wxMap])

  // Condition-group aggregates
  const groupStats = useMemo<GroupStat[]>(() => {
    const acc = new Map<string, { areaDays: number; incidents: number; delay: number }>()
    wxInWindow.forEach(w => {
      const g   = conditionGroup(w.conditions)
      const cur = acc.get(g) ?? { areaDays: 0, incidents: 0, delay: 0 }
      const load = perDayLoad.get(`${w.area}::${w.date}`) ?? { inc: 0, delay: 0 }
      cur.areaDays  += 1
      cur.incidents += load.inc
      cur.delay     += load.delay
      acc.set(g, cur)
    })
    // Order: CONDITION_GROUPS order first, then anything else (Unknown etc.)
    const order = CONDITION_GROUPS.map(g => g.label)
    return [...acc.entries()]
      .sort((a, b) => {
        const ia = order.indexOf(a[0]); const ib = order.indexOf(b[0])
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
      })
      .map(([group, v]) => ({
        group,
        areaDays:  v.areaDays,
        incidents: v.incidents,
        delay:     v.delay,
        incRate:   v.areaDays ? v.incidents / v.areaDays : 0,
        delayRate: v.areaDays ? v.delay / v.areaDays : 0,
      }))
  }, [wxInWindow, perDayLoad])

  const baseline = useMemo(
    () => groupStats.find(g => g.group === BASELINE) ?? null,
    [groupStats],
  )

  // Category × condition matrix
  const matrix = useMemo(() => {
    const cols = groupStats.filter(g => g.areaDays >= MIN_SAMPLE)
    const catCounts = new Map<IncidentCategory, number>()
    const cells     = new Map<string, number>()   // `${category}::${group}` → count
    nonContinuation(incidents).forEach(i => {
      if (!i.area) return
      const wx = wxMap.get(`${i.area}::${i.report_date}`)
      if (!wx) return
      const g = conditionGroup(wx.conditions)
      catCounts.set(i.category, (catCounts.get(i.category) ?? 0) + 1)
      const key = `${i.category}::${g}`
      cells.set(key, (cells.get(key) ?? 0) + 1)
    })
    const topCats = [...catCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([cat]) => cat)
    return { cols, topCats, cells }
  }, [groupStats, incidents, wxMap])

  // Threshold explorer buckets for the selected metric
  const metric = WX_METRICS.find(m => m.key === metricKey) ?? WX_METRICS[0]
  const bucketData = useMemo(() => {
    const acc = metric.bands.map(b => ({ band: b.label, days: 0, inc: 0, delay: 0 }))
    wxInWindow.forEach(w => {
      const v = metric.value(w)
      if (v == null) return
      const idx = metric.bands.findIndex(b => b.test(v))
      if (idx === -1) return
      const load = perDayLoad.get(`${w.area}::${w.date}`) ?? { inc: 0, delay: 0 }
      acc[idx].days  += 1
      acc[idx].inc   += load.inc
      acc[idx].delay += load.delay
    })
    return acc.map(b => ({
      ...b,
      incRate:   b.days ? b.inc / b.days : 0,
      delayRate: b.days ? b.delay / b.days : 0,
    }))
  }, [wxInWindow, perDayLoad, metric])

  // Weather-attributable delay estimate
  const attribution = useMemo(() => {
    const windowTotalDelay = incidents.reduce((s, i) => s + effectiveDelay(i), 0)
    const adverse = groupStats.filter(g => g.group !== BASELINE && g.group !== 'Unknown')
    const adverseAreaDays = adverse.reduce((s, g) => s + g.areaDays, 0)
    const adverseDelay    = adverse.reduce((s, g) => s + g.delay, 0)
    const baselineRate    = baseline && baseline.areaDays > 0 ? baseline.delayRate : null
    const excess = baselineRate != null ? adverseDelay - baselineRate * adverseAreaDays : null
    const sharePct = excess != null && windowTotalDelay > 0 ? (excess / windowTotalDelay) * 100 : null
    return { windowTotalDelay, adverseAreaDays, adverseDelay, baselineRate, excess, sharePct }
  }, [incidents, groupStats, baseline])

  // ── Empty state ─────────────────────────────────────────────────────────────

  if (weatherData.length === 0) {
    return (
      <div className="space-y-6">
        <div className="card p-5">
          <div className="mb-4">
            <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Weather Impact</h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
              {windowFrom} – {windowTo}
            </p>
          </div>
          <div className="py-14 flex flex-col items-center gap-3 text-center">
            <CloudRain size={28} style={{ color: 'var(--ink-500)' }} />
            <div className="text-sm" style={{ color: 'var(--ink-400)' }}>
              Weather data hasn&apos;t synced for this window yet
            </div>
            <div className="text-[11px] max-w-sm" style={{ color: 'var(--ink-500)' }}>
              Daily weather is fetched per area on load and cached. If you&apos;re in demo mode,
              weather sync is disabled — connect a live database to enable this tab.
            </div>
          </div>
        </div>
      </div>
    )
  }

  const maxIncRate = Math.max(...groupStats.map(g => g.incRate), 0.0001)
  const clearAreaDays = matrix.cols.find(c => c.group === BASELINE)?.areaDays ?? 0

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* ── 1 · Condition impact ─────────────────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4">
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Condition Impact</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            Incident and delay rates per area-day by condition group — lift vs the {BASELINE} baseline · {windowFrom} – {windowTo}
          </p>
        </div>

        {groupStats.length === 0 ? (
          <div className="py-10 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
            No weather rows overlap this window
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ minWidth: 640 }}>
              <thead>
                <tr className="text-left" style={{ color: 'var(--ink-500)' }}>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3">Condition</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Area-days</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3" style={{ width: '26%' }}>Incidents / area-day</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Delay / area-day</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Incident lift</th>
                  <th className="label-micro text-[9px] font-normal pb-2 text-right">Delay lift</th>
                </tr>
              </thead>
              <tbody>
                {groupStats.map(g => {
                  const isBaseline = g.group === BASELINE
                  const lowSample  = g.areaDays < MIN_SAMPLE
                  const incLift    = baseline && baseline.incRate   > 0 ? g.incRate   / baseline.incRate   : null
                  const delayLift  = baseline && baseline.delayRate > 0 ? g.delayRate / baseline.delayRate : null
                  return (
                    <tr key={g.group} className="border-t" style={{ borderColor: 'var(--line)' }}>
                      <td className="py-2.5 pr-3" style={{ color: 'var(--ink-200)' }}>
                        {g.group}
                        {isBaseline && (
                          <span className="ml-1.5 text-[9px]" style={{ color: 'var(--ink-500)' }}>baseline</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-300)' }}>
                        {g.areaDays.toLocaleString()}
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.min(100, (g.incRate / maxIncRate) * 100)}%`,
                                background: isBaseline ? 'var(--ink-400)' : 'var(--nr-orange)',
                              }}
                            />
                          </div>
                          <span className="numeric-mono w-10 text-right" style={{ color: 'var(--ink-200)' }}>{fmtRate(g.incRate)}</span>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-200)' }}>
                        {fmtMin(g.delayRate)}
                      </td>
                      {isBaseline ? (
                        <td colSpan={2} className="py-2.5 text-right text-[10px]" style={{ color: 'var(--ink-500)' }}>1.00× reference</td>
                      ) : lowSample ? (
                        <td colSpan={2} className="py-2.5 text-right text-[10px]" style={{ color: 'var(--ink-500)' }}>low sample (&lt;{MIN_SAMPLE} area-days)</td>
                      ) : (
                        <>
                          <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: incLift != null ? liftColor(incLift) : 'var(--ink-500)' }}>
                            {incLift != null ? fmtLift(incLift) : '—'}
                          </td>
                          <td className="py-2.5 text-right numeric-mono" style={{ color: delayLift != null ? liftColor(delayLift) : 'var(--ink-500)' }}>
                            {delayLift != null ? fmtLift(delayLift) : '—'}
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!baseline && groupStats.length > 0 && (
          <div className="mt-3 text-[10px]" style={{ color: 'var(--ink-500)' }}>
            No {BASELINE} area-days in this window — lift columns unavailable.
          </div>
        )}
      </div>

      {/* ── 2 · Category × condition matrix ──────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4">
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Category × Condition</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            Incidents per area-day for the top categories under each condition — heat shows the ratio vs that category&apos;s {BASELINE} rate
          </p>
        </div>

        {matrix.topCats.length === 0 || matrix.cols.length === 0 ? (
          <div className="py-10 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
            Not enough weather-joined incidents to build the matrix
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th className="label-micro text-[9px] font-normal text-left pb-2 pr-3" style={{ color: 'var(--ink-500)' }}>Category</th>
                  {matrix.cols.map(c => (
                    <th key={c.group} className="label-micro text-[9px] font-normal text-right pb-2 px-2" style={{ color: 'var(--ink-500)' }}>
                      {c.group}
                      <div className="text-[8px] normal-case" style={{ color: 'var(--ink-500)' }}>{c.areaDays}d</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.topCats.map(cat => {
                  const cfg = CATEGORY_CONFIG[cat]
                  const clearCount = matrix.cells.get(`${cat}::${BASELINE}`) ?? 0
                  const clearRate  = clearAreaDays > 0 ? clearCount / clearAreaDays : 0
                  return (
                    <tr key={cat} className="border-t" style={{ borderColor: 'var(--line)' }}>
                      <td className="py-2 pr-3 whitespace-nowrap" style={{ color: cfg?.color ?? 'var(--ink-200)' }}>
                        {cfg?.label ?? cat}
                      </td>
                      {matrix.cols.map(c => {
                        const count = matrix.cells.get(`${cat}::${c.group}`) ?? 0
                        const rate  = c.areaDays > 0 ? count / c.areaDays : 0
                        const ratio = clearRate > 0 ? rate / clearRate : (rate > 0 ? 3 : 0)
                        const alpha = Math.min(0.7, ratio * 0.22)
                        return (
                          <td
                            key={c.group}
                            className="py-2 px-2 text-right numeric-mono"
                            title={`${cfg?.label ?? cat} · ${c.group}: ${count} incidents over ${c.areaDays} area-days = ${fmtRate(rate)}/day${clearRate > 0 ? ` (${ratio.toFixed(2)}× vs ${BASELINE} ${fmtRate(clearRate)}/day)` : ''}`}
                            style={{
                              background: alpha > 0 ? `rgba(224, 82, 6, ${alpha})` : 'transparent',
                              color: 'var(--ink-200)',
                            }}
                          >
                            {fmtRate(rate)}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="flex items-center gap-2 mt-3">
              <LayoutGrid size={10} style={{ color: 'var(--ink-500)' }} />
              <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>
                Columns limited to conditions with ≥{MIN_SAMPLE} area-days · hover a cell for exact numbers
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── 3 · Threshold explorer ────────────────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Threshold Explorer</h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
              Incident and delay rates per area-day across fixed bands of {metric.label.toLowerCase()}
            </p>
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            <SlidersHorizontal size={11} style={{ color: 'var(--ink-500)' }} />
            {WX_METRICS.map(m => (
              <button
                key={m.key}
                onClick={() => setMetricKey(m.key)}
                className={m.key === metricKey ? 'btn btn-active' : 'btn'}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {bucketData.every(b => b.days === 0) ? (
          <div className="py-10 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
            No area-days have {metric.label.toLowerCase()} readings in this window
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={bucketData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barGap={3}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis
                  dataKey="band"
                  axisLine={false}
                  tickLine={false}
                  height={34}
                  interval={0}
                  tick={<BandTick bands={bucketData} />}
                />
                <YAxis
                  yAxisId="inc"
                  axisLine={false}
                  tickLine={false}
                  width={36}
                  tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <YAxis
                  yAxisId="delay"
                  orientation="right"
                  axisLine={false}
                  tickLine={false}
                  width={44}
                  tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <Tooltip content={<BandTip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                <Bar yAxisId="inc"   dataKey="incRate"   fill="var(--nr-orange)" radius={[2, 2, 0, 0]} maxBarSize={36} />
                <Bar yAxisId="delay" dataKey="delayRate" fill="var(--nr-blue)"   radius={[2, 2, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
            <div className="flex items-center gap-5 mt-2">
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--nr-orange)' }} />
                <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>Incidents / area-day (left axis)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--nr-blue)' }} />
                <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>Delay minutes / area-day (right axis)</span>
              </div>
              <span className="text-[9px] ml-auto" style={{ color: 'var(--ink-500)' }}>Area-day counts shown under each band</span>
            </div>
          </>
        )}
      </div>

      {/* ── 4 · Weather-attributable delay ────────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4">
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Weather-Attributable Delay</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            Excess vs dry-day baseline — correlation, not cause
          </p>
        </div>

        {attribution.baselineRate == null ? (
          <div className="py-8 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
            No {BASELINE} area-days in this window — a baseline rate can&apos;t be established
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded overflow-hidden border" style={{ borderColor: 'var(--line)', background: 'var(--line)' }}>
              <div className="px-4 py-3" style={{ background: 'var(--bg-card)' }}>
                <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Est. excess delay</div>
                <div className="numeric-mono text-xl font-light mt-1" style={{ color: (attribution.excess ?? 0) > 0 ? 'var(--nr-orange)' : 'var(--ink-300)' }}>
                  {attribution.excess != null ? `${attribution.excess < 0 ? '−' : ''}${fmtMin(Math.abs(attribution.excess))}` : '—'}
                </div>
                <div className="text-[9px] mt-0.5" style={{ color: 'var(--ink-500)' }}>on adverse-weather area-days</div>
              </div>
              <div className="px-4 py-3" style={{ background: 'var(--bg-card)' }}>
                <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Share of window delay</div>
                <div className="numeric-mono text-xl font-light mt-1" style={{ color: 'var(--ink-100)' }}>
                  {attribution.sharePct != null ? `${attribution.sharePct.toFixed(1)}%` : '—'}
                </div>
                <div className="text-[9px] mt-0.5" style={{ color: 'var(--ink-500)' }}>of {fmtMin(attribution.windowTotalDelay)} total</div>
              </div>
              <div className="px-4 py-3" style={{ background: 'var(--bg-card)' }}>
                <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Adverse area-days</div>
                <div className="numeric-mono text-xl font-light mt-1" style={{ color: 'var(--ink-100)' }}>
                  {attribution.adverseAreaDays.toLocaleString()}
                </div>
                <div className="text-[9px] mt-0.5" style={{ color: 'var(--ink-500)' }}>carrying {fmtMin(attribution.adverseDelay)} delay</div>
              </div>
              <div className="px-4 py-3" style={{ background: 'var(--bg-card)' }}>
                <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Dry-day baseline</div>
                <div className="numeric-mono text-xl font-light mt-1" style={{ color: 'var(--ink-100)' }}>
                  {fmtMin(attribution.baselineRate)}
                </div>
                <div className="text-[9px] mt-0.5" style={{ color: 'var(--ink-500)' }}>delay per {BASELINE} area-day</div>
              </div>
            </div>
            <div className="flex items-start gap-2 mt-3">
              <Info size={11} style={{ color: 'var(--ink-500)', flexShrink: 0, marginTop: 1 }} />
              <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>
                Estimate only: total delay on adverse area-days minus what the {BASELINE} baseline rate would predict
                for the same number of area-days. Weather correlates with — but does not prove it caused — the excess.
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <TrendingUp size={11} style={{ color: 'var(--ink-500)', flexShrink: 0 }} />
              <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>
                Window {windowFrom} – {windowTo} · {wxInWindow.length.toLocaleString()} weather area-days joined
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
