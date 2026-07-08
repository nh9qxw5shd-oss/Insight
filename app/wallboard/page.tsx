'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { AlertTriangle, Pause, Play } from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, CartesianGrid,
  LineChart, Line, ReferenceLine,
} from 'recharts'
import { DEFAULT_FILTERS, SAFETY_CATEGORIES, CATEGORY_CONFIG, PerfMetricReading, PerfSnapshot, PerfSlot } from '@/lib/types'
import {
  fetchAnalytics, deriveKPIs, deriveTrend, deriveLocationHotspots,
  effectiveDelay, nonContinuation, RawData, fetchPerfSnapshots, pickDailyFinal,
} from '@/lib/queries'
import { isSupabaseConfigured } from '@/lib/supabase'
import { generateSyntheticData } from '@/lib/syntheticData'
import { railwayPeriodWeek, railwayPeriodBounds } from '@/lib/railwayCalendar'

const REFRESH_MS = 5 * 60 * 1000   // re-fetch every 5 minutes
const STALE_MS   = 15 * 60 * 1000  // three missed refreshes → visibly stale

// Rotation slots with panel-specific dwell times — dense panels get longer.
const PANELS = [
  { id: 'kpis',        label: 'KPIs',        dwell: 10_000 },
  { id: 'performance', label: 'Performance', dwell: 20_000 },
  { id: 'trend',       label: 'Trend',       dwell: 15_000 },
  { id: 'safety',      label: 'Safety',      dwell: 15_000 },
  { id: 'hotspots',    label: 'Hotspots',    dwell: 20_000 },
] as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtClock(d: Date | null): string {
  if (!d) return '--:--'
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function shortDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function fmtVal(v: number | null): string {
  if (v == null) return '—'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

// RAG recompute (mirrors the Performance tab feed panel).
const RAG_COLOURS = { green: '#27AE60', amber: '#F39C12', red: '#E74C3C', none: 'var(--ink-500)' } as const
type Rag = keyof typeof RAG_COLOURS
function ragFor(m: PerfMetricReading): Rag {
  if (m.value == null) return 'none'
  if (m.target == null) return (m.rag as Rag) in RAG_COLOURS ? (m.rag as Rag) : 'none'
  const higherIsBetter = m.dir !== 'lower'
  if (higherIsBetter) {
    if (m.value >= m.target) return 'green'
    if (m.amber != null && m.value >= m.amber) return 'amber'
    return 'red'
  }
  if (m.value <= m.target) return 'green'
  if (m.amber != null && m.value <= m.amber) return 'amber'
  return 'red'
}

const SLOT_ORDER: PerfSlot[] = ['0530', '0900', '1500', '2200']
const SLOT_LABEL: Record<PerfSlot, string> = { '0530': '05:30 EOD', '0900': '09:00', '1500': '15:00', '2200': '22:00' }

// ─── Page ────────────────────────────────────────────────────────────────────

export default function WallboardPage() {
  const [data,      setData]      = useState<RawData | null>(null)
  const [perf,      setPerf]      = useState<PerfSnapshot[] | null>(null)
  const [synthetic, setSynthetic] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [panel,     setPanel]     = useState(0)
  const [pinned,    setPinned]    = useState(false)
  const [now,       setNow]       = useState(() => Date.now())

  const period = useMemo(() => {
    const pw = railwayPeriodWeek(isoToday())
    return { ...pw, ...railwayPeriodBounds(pw.period, pw.railYear) }
  }, [])

  const load = useCallback(async () => {
    // Performance snapshots load independently — a feed failure must not
    // push the incident panels into demo mode (and vice versa).
    if (isSupabaseConfigured()) {
      fetchPerfSnapshots(period.from, isoToday())
        .then(setPerf)
        .catch(() => setPerf([]))
    } else {
      setPerf([])
    }
    try {
      if (isSupabaseConfigured()) {
        const d = await fetchAnalytics({ ...DEFAULT_FILTERS, windowDays: 7 })
        if (d) {
          setData(d)
          setSynthetic(false)
          setUpdatedAt(new Date())
          return
        }
      }
    } catch {
      // fall through to synthetic below
    }
    setData(generateSyntheticData(7, 42))
    setSynthetic(true)
    setUpdatedAt(new Date())
  }, [period.from])

  // Initial load + 5-minute refresh
  useEffect(() => {
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  // Minute tick so the staleness indicator updates without a data event.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  // ?panel=<id> pins a panel from the URL so a dedicated screen can be
  // locked to one view without anyone touching it.
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get('panel')
    const idx = PANELS.findIndex(p => p.id === want)
    if (idx >= 0) { setPanel(idx); setPinned(true) }
  }, [])

  // Auto-cycle with per-panel dwell (stops when pinned)
  useEffect(() => {
    if (pinned) return
    const t = setTimeout(() => setPanel(p => (p + 1) % PANELS.length), PANELS[panel].dwell)
    return () => clearTimeout(t)
  }, [pinned, panel])

  const stale = !synthetic && updatedAt != null && now - updatedAt.getTime() > STALE_MS

  const kpis     = useMemo(() => data ? deriveKPIs(data) : null, [data])
  const trend    = useMemo(() => data ? deriveTrend(data) : [], [data])
  const hotspots = useMemo(() => data ? deriveLocationHotspots(data, 5) : [], [data])

  // Five most recent high-delay incidents — newest day first, biggest delay first
  const latest = useMemo(() => {
    if (!data) return []
    return [...nonContinuation(data.incidents)]
      .sort((a, b) =>
        b.report_date.localeCompare(a.report_date) ||
        effectiveDelay(b) - effectiveDelay(a),
      )
      .slice(0, 5)
  }, [data])

  const maxHotspotDelay = useMemo(
    () => Math.max(1, ...hotspots.map(h => h.delayMins)),
    [hotspots],
  )

  // Worst days in the window with their single biggest contributor — gives
  // the trend chart a "why", not just a shape.
  const trendDrivers = useMemo(() => {
    if (!data) return []
    const topByDay = new Map<string, { title: string; delay: number }>()
    for (const inc of data.incidents) {
      const d = effectiveDelay(inc)
      const cur = topByDay.get(inc.report_date)
      if (!cur || d > cur.delay) {
        topByDay.set(inc.report_date, { title: inc.title || inc.location || inc.category, delay: d })
      }
    }
    return [...trend]
      .sort((a, b) => b.delayMins - a.delayMins)
      .slice(0, 3)
      .filter(p => p.delayMins > 0)
      .map(p => ({ date: p.date, total: p.delayMins, top: topByDay.get(p.date) ?? null }))
  }, [data, trend])

  // Safety-critical incidents in the window, newest first.
  const safety = useMemo(() => {
    if (!data) return []
    return nonContinuation(data.incidents)
      .filter(i => SAFETY_CATEGORIES.includes(i.category))
      .sort((a, b) =>
        b.report_date.localeCompare(a.report_date) ||
        effectiveDelay(b) - effectiveDelay(a),
      )
      .slice(0, 7)
  }, [data])

  // ── Performance derivations ────────────────────────────────────────────────
  const latestSnap = useMemo(() => {
    if (!perf?.length) return null
    return [...perf].sort((a, b) => b.last_built_at.localeCompare(a.last_built_at))[0]
  }, [perf])

  const tickerDay = useMemo(() => {
    if (!perf?.length) return null
    return [...new Set(perf.map(s => s.metrics_for_date))].sort().pop() ?? null
  }, [perf])

  const tickerRows = useMemo(() => {
    if (!tickerDay || !perf) return []
    return perf
      .filter(s => s.metrics_for_date === tickerDay)
      .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot))
  }, [perf, tickerDay])

  const tickerMetricNames = useMemo(() => {
    const seen: string[] = []
    for (const s of tickerRows) for (const m of s.metrics) {
      if (m.name && !seen.includes(m.name)) seen.push(m.name)
    }
    return seen.slice(0, 6)
  }, [tickerRows])

  // Period-to-date Route T3 % with a linear projection to period end.
  const ptd = useMemo(() => {
    if (!perf?.length) return null
    const METRIC = 'Route T3 %'
    const dates = [...new Set(perf.map(s => s.metrics_for_date))].sort()
    const pts: { date: string; value: number; target: number | null }[] = []
    for (const d of dates) {
      const snap = pickDailyFinal(perf, d)
      const m = snap?.metrics.find(x => x.name === METRIC)
      if (m?.value != null) pts.push({ date: d, value: m.value, target: m.target })
    }
    if (!pts.length) return null
    const target = pts[pts.length - 1].target
    let projection: number | null = null
    if (pts.length >= 3) {
      const n = pts.length
      const xs = pts.map((_, i) => i)
      const ys = pts.map(p => p.value)
      const mx = xs.reduce((s, v) => s + v, 0) / n
      const my = ys.reduce((s, v) => s + v, 0) / n
      const denom = xs.reduce((s, x) => s + (x - mx) ** 2, 0) || 1
      const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / denom
      const periodDays = Math.round((new Date(period.to + 'T00:00:00Z').getTime() - new Date(period.from + 'T00:00:00Z').getTime()) / 86_400_000)
      projection = my + slope * (periodDays - 1 - mx)
    }
    return { pts, target, projection, metric: METRIC }
  }, [perf, period])

  function pinPanel(i: number) {
    if (pinned && panel === i) {
      setPinned(false)          // clicking the pinned dot resumes cycling
    } else {
      setPanel(i)
      setPinned(true)
    }
  }

  const panelId = PANELS[panel].id

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-panel)' }}>

      {/* Header */}
      <header
        className="flex items-center gap-4 px-8 py-5 border-b"
        style={{ borderColor: 'var(--line)' }}
      >
        <span className={`live-dot ${synthetic || stale ? '' : 'animate-pulse-soft'}`}
          style={
            stale      ? { background: '#E74C3C', boxShadow: '0 0 8px #E74C3C' } :
            synthetic  ? { background: 'var(--nr-amber)', boxShadow: '0 0 8px var(--nr-amber)' } : {}
          }
        />
        <h1 className="serif text-2xl md:text-3xl font-light tracking-tight" style={{ color: 'var(--ink-100)' }}>
          EMCC Insight · Wallboard
        </h1>
        {synthetic && (
          <span
            className="pill"
            style={{ background: 'rgba(243, 156, 18, 0.12)', border: '1px solid rgba(243, 156, 18, 0.4)', color: 'var(--nr-amber)' }}
          >
            Demo
          </span>
        )}
        {stale && (
          <span
            className="pill flex items-center gap-1.5"
            style={{ background: 'rgba(231, 76, 60, 0.12)', border: '1px solid rgba(231, 76, 60, 0.5)', color: '#E74C3C' }}
          >
            <AlertTriangle size={12} />
            Data stale — last updated {fmtClock(updatedAt)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-6">
          <span className="numeric-mono text-sm" style={{ color: stale ? '#E74C3C' : 'var(--ink-400)' }}>
            updated {fmtClock(updatedAt)}
          </span>
          <a href="/" className="text-xs hover:underline" style={{ color: 'var(--ink-500)' }}>
            ← dashboard
          </a>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 flex flex-col px-8 py-6 min-h-0">
        {!data || !kpis ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="label-micro animate-pulse-soft" style={{ color: 'var(--ink-500)' }}>Loading…</span>
          </div>
        ) : (
          <div key={panel} className="flex-1 flex flex-col animate-fade-up min-h-0">

            {/* ── Panel — KPI tiles ───────────────────────────────────────── */}
            {panelId === 'kpis' && (
              <div className="flex-1 grid grid-cols-2 lg:grid-cols-3 gap-6 content-center">
                {([
                  {
                    label: 'Incidents · 7d',
                    value: kpis.totalIncidents.toLocaleString(),
                    color: 'var(--ink-100)',
                    tinted: false,
                  },
                  {
                    label: 'Total delay',
                    value: `${Math.round(kpis.totalDelayMins).toLocaleString()}m`,
                    color: 'var(--nr-orange)',
                    tinted: false,
                  },
                  {
                    label: 'Safety-critical',
                    value: kpis.safetyCriticalCount.toLocaleString(),
                    color: kpis.safetyCriticalCount > 0 ? '#E74C3C' : 'var(--ink-100)',
                    tinted: kpis.safetyCriticalCount > 0,
                  },
                  {
                    label: 'Trains delayed',
                    value: kpis.totalTrainsDelayed.toLocaleString(),
                    color: 'var(--ink-100)',
                    tinted: false,
                  },
                  {
                    label: 'Cancellations',
                    value: kpis.totalCancelled.toLocaleString(),
                    color: 'var(--ink-100)',
                    tinted: false,
                  },
                  {
                    label: 'SLA compliance',
                    value: kpis.slaCompliancePct != null ? `${Math.round(kpis.slaCompliancePct)}%` : '—',
                    color: kpis.slaCompliancePct != null && kpis.slaCompliancePct >= 80 ? '#27AE60' : 'var(--nr-amber)',
                    tinted: false,
                  },
                ] as const).map(tile => (
                  <div
                    key={tile.label}
                    className="card flex flex-col items-center justify-center py-10 px-6"
                    style={tile.tinted ? { background: 'rgba(231, 76, 60, 0.08)', borderColor: 'rgba(231, 76, 60, 0.5)' } : {}}
                  >
                    <div className="label-micro text-sm mb-4" style={{ color: 'var(--ink-400)' }}>{tile.label}</div>
                    <div className="numeric-mono text-6xl xl:text-7xl font-light" style={{ color: tile.color }}>
                      {tile.value}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Panel — route performance standing ─────────────────────── */}
            {panelId === 'performance' && (
              perf === null ? (
                <div className="flex-1 flex items-center justify-center">
                  <span className="label-micro animate-pulse-soft" style={{ color: 'var(--ink-500)' }}>Loading performance feed…</span>
                </div>
              ) : !latestSnap ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3">
                  <div className="text-2xl" style={{ color: 'var(--ink-400)' }}>No performance snapshots yet</div>
                  <div className="text-sm" style={{ color: 'var(--ink-500)' }}>
                    Route standing arrives from the tactical messaging feed (05:30 / 09:00 / 15:00 / 22:00 slots).
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col gap-6 min-h-0">
                  {/* Latest standing tiles */}
                  <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
                    {latestSnap.metrics.slice(0, 6).map(m => {
                      const rag = ragFor(m)
                      const colour = RAG_COLOURS[rag]
                      return (
                        <div
                          key={m.name}
                          className="card flex flex-col items-center justify-center py-6 px-3"
                          style={rag === 'none' ? {} : { borderColor: `${colour}66`, background: `${colour}0F` }}
                        >
                          <div className="label-micro text-[11px] mb-2 text-center" style={{ color: 'var(--ink-400)' }}>{m.name}</div>
                          <div className="numeric-mono text-5xl xl:text-6xl font-light" style={{ color: colour }}>{fmtVal(m.value)}</div>
                          <div className="numeric-mono text-sm mt-2" style={{ color: 'var(--ink-500)' }}>
                            {m.target != null ? `tgt ${fmtVal(m.target)}` : ''}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex-1 grid grid-cols-1 xl:grid-cols-2 gap-6 min-h-0">
                    {/* Today's slot ticker */}
                    <div className="card p-8 flex flex-col min-h-0">
                      <div className="label-micro text-sm mb-5" style={{ color: 'var(--nr-orange)' }}>
                        Slot ticker · {tickerDay ?? '—'}
                      </div>
                      <div className="flex-1 overflow-hidden">
                        <table className="w-full text-lg">
                          <thead>
                            <tr className="border-b" style={{ borderColor: 'var(--line)' }}>
                              <th className="text-left pb-3 label-micro text-xs" style={{ color: 'var(--ink-400)' }}>Metric</th>
                              {tickerRows.map(s => (
                                <th key={s.slot} className="text-right pb-3 label-micro text-xs" style={{ color: 'var(--ink-400)' }}>
                                  {SLOT_LABEL[s.slot]}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {tickerMetricNames.map(name => (
                              <tr key={name} className="border-b last:border-0" style={{ borderColor: 'var(--line)' }}>
                                <td className="py-3 text-xl" style={{ color: 'var(--ink-300)' }}>{name}</td>
                                {tickerRows.map(s => {
                                  const m = s.metrics.find(x => x.name === name)
                                  const rag = m ? ragFor(m) : 'none'
                                  return (
                                    <td key={s.slot} className="py-3 text-right numeric-mono text-2xl" style={{ color: RAG_COLOURS[rag] }}>
                                      {m ? fmtVal(m.value) : '—'}
                                    </td>
                                  )
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Period to date + projection */}
                    <div className="card p-8 flex flex-col min-h-0">
                      <div className="label-micro text-sm mb-5" style={{ color: 'var(--nr-orange)' }}>
                        {ptd?.metric ?? 'Route T3 %'} · period to date ({period.yearLabel} P{String(period.period).padStart(2, '0')})
                      </div>
                      {ptd ? (
                        <>
                          <div className="flex-1 min-h-0 relative">
                            <div className="absolute inset-0">
                              <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={ptd.pts} margin={{ top: 10, right: 24, bottom: 0, left: -6 }}>
                                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                                  <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(8)} tick={{ fontSize: 15, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono, monospace' }} axisLine={false} tickLine={false} tickMargin={10} />
                                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 15, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono, monospace' }} axisLine={false} tickLine={false} width={48} />
                                  {ptd.target != null && (
                                    <ReferenceLine y={ptd.target} stroke="#27AE60" strokeDasharray="5 3" strokeOpacity={0.8} />
                                  )}
                                  <Line type="monotone" dataKey="value" stroke="var(--nr-orange)" strokeWidth={3} dot={{ r: 4 }} isAnimationActive={false} />
                                </LineChart>
                              </ResponsiveContainer>
                            </div>
                          </div>
                          <div className="text-base mt-3" style={{ color: 'var(--ink-400)' }}>
                            {ptd.projection != null
                              ? <>Trajectory to period end: <span className="numeric-mono" style={{ color: 'var(--ink-100)' }}>~{fmtVal(ptd.projection)}</span>{ptd.target != null && <> vs target <span className="numeric-mono" style={{ color: '#27AE60' }}>{fmtVal(ptd.target)}</span></>}</>
                              : 'Projection unlocks at 3 captured days.'}
                          </div>
                        </>
                      ) : (
                        <div className="flex-1 flex items-center justify-center text-lg" style={{ color: 'var(--ink-500)' }}>
                          No daily standings captured yet this period.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            )}

            {/* ── Panel — 7-day delay trend ───────────────────────────────── */}
            {panelId === 'trend' && (
              <div className="flex-1 card flex flex-col p-8 min-h-0">
                <div className="label-micro text-sm mb-6" style={{ color: 'var(--nr-orange)' }}>
                  Delay minutes — last 7 days
                </div>
                {/* ResponsiveContainer's height="100%" resolves against the
                    parent's *specified* height, which is auto here (the div is
                    sized by flex-grow) — so it computes 0 and the chart never
                    mounts. An absolutely-positioned wrapper resolves against
                    the parent's real laid-out height instead. */}
                <div className="flex-1 min-h-0 relative">
                  <div className="absolute inset-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={trend} margin={{ top: 10, right: 30, bottom: 10, left: 10 }}>
                      <defs>
                        <linearGradient id="wbDelay" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--nr-orange)" stopOpacity={0.45} />
                          <stop offset="100%" stopColor="var(--nr-orange)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickFormatter={shortDay}
                        tick={{ fontSize: 20, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono, monospace' }}
                        axisLine={false}
                        tickLine={false}
                        tickMargin={14}
                      />
                      <YAxis
                        tick={{ fontSize: 20, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono, monospace' }}
                        tickFormatter={(v: number) => v.toLocaleString()}
                        axisLine={false}
                        tickLine={false}
                        width={90}
                      />
                      <Area
                        type="monotone"
                        dataKey="delayMins"
                        stroke="var(--nr-orange)"
                        strokeWidth={3}
                        fill="url(#wbDelay)"
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                  </div>
                </div>
                {/* Why the bad days were bad — biggest single contributor per worst day */}
                {trendDrivers.length > 0 && (
                  <div className="flex flex-wrap gap-x-10 gap-y-2 pt-5">
                    {trendDrivers.map(d => (
                      <div key={d.date} className="flex items-baseline gap-3 text-lg" style={{ color: 'var(--ink-300)' }}>
                        <span className="numeric-mono" style={{ color: 'var(--ink-400)' }}>{shortDay(d.date)}</span>
                        <span className="numeric-mono" style={{ color: 'var(--nr-orange)' }}>{Math.round(d.total).toLocaleString()}m</span>
                        {d.top && (
                          <span className="truncate max-w-[26rem]" style={{ color: 'var(--ink-400)' }}>
                            — {d.top.title} ({Math.round(d.top.delay).toLocaleString()}m)
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Panel — safety-critical incidents ──────────────────────── */}
            {panelId === 'safety' && (
              <div className="flex-1 card flex flex-col p-8 min-h-0">
                <div className="label-micro text-sm mb-6" style={{ color: '#E74C3C' }}>
                  Safety-critical incidents — last 7 days
                </div>
                {safety.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-3">
                    <div className="numeric-mono text-7xl font-light" style={{ color: '#27AE60' }}>0</div>
                    <div className="text-xl" style={{ color: 'var(--ink-400)' }}>No safety-critical incidents in the window</div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col justify-center divide-y" style={{ borderColor: 'var(--line)' }}>
                    {safety.map(i => {
                      const cfg = CATEGORY_CONFIG[i.category]
                      return (
                        <div key={i.id} className="py-4 flex items-center gap-6" style={{ borderColor: 'var(--line)' }}>
                          <div className="numeric-mono text-lg shrink-0 w-16" style={{ color: 'var(--ink-400)' }}>
                            {shortDay(i.report_date)}
                          </div>
                          <span
                            className="pill shrink-0 numeric-mono text-sm"
                            style={{ background: `${cfg.color}1A`, border: `1px solid ${cfg.color}66`, color: cfg.color }}
                          >
                            {cfg.short}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="text-xl truncate" style={{ color: 'var(--ink-100)' }}>
                              {i.title || i.location || cfg.label}
                            </div>
                            <div className="text-sm truncate mt-0.5" style={{ color: 'var(--ink-500)' }}>
                              {i.location || i.area || '—'}
                            </div>
                          </div>
                          <div className="numeric-mono text-2xl shrink-0" style={{ color: 'var(--nr-orange)' }}>
                            {Math.round(effectiveDelay(i)).toLocaleString()}m
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── Panel — hotspots & latest ───────────────────────────────── */}
            {panelId === 'hotspots' && (
              <div className="flex-1 grid grid-cols-1 xl:grid-cols-2 gap-6 min-h-0">
                {/* Top locations by delay */}
                <div className="card p-8 flex flex-col">
                  <div className="label-micro text-sm mb-6" style={{ color: 'var(--nr-orange)' }}>
                    Top locations by delay — 7 days
                  </div>
                  <div className="flex-1 flex flex-col justify-center gap-6">
                    {hotspots.length === 0 && (
                      <div className="text-lg" style={{ color: 'var(--ink-500)' }}>No location data in window</div>
                    )}
                    {hotspots.map(h => (
                      <div key={h.location}>
                        <div className="flex items-baseline justify-between gap-4 mb-2">
                          <span className="text-xl xl:text-2xl truncate" style={{ color: 'var(--ink-100)' }}>{h.location}</span>
                          <span className="numeric-mono text-xl xl:text-2xl shrink-0" style={{ color: 'var(--nr-orange)' }}>
                            {Math.round(h.delayMins).toLocaleString()}m
                          </span>
                        </div>
                        <div className="h-3 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${(h.delayMins / maxHotspotDelay) * 100}%`, background: 'var(--nr-orange)' }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Latest high-delay incidents */}
                <div className="card p-8 flex flex-col">
                  <div className="label-micro text-sm mb-6" style={{ color: 'var(--nr-orange)' }}>
                    Latest high-delay incidents
                  </div>
                  <div className="flex-1 flex flex-col justify-center divide-y" style={{ borderColor: 'var(--line)' }}>
                    {latest.length === 0 && (
                      <div className="text-lg" style={{ color: 'var(--ink-500)' }}>No incidents in window</div>
                    )}
                    {latest.map(i => (
                      <div key={i.id} className="py-4 flex items-center gap-6" style={{ borderColor: 'var(--line)' }}>
                        <div className="numeric-mono text-lg shrink-0 w-20" style={{ color: 'var(--ink-400)' }}>
                          {i.incident_start ?? '—'}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xl truncate" style={{ color: 'var(--ink-100)' }}>
                            {i.title || i.location || '—'}
                          </div>
                          <div className="text-sm truncate mt-0.5" style={{ color: 'var(--ink-500)' }}>
                            {i.location || i.area || '—'}
                          </div>
                        </div>
                        <div className="numeric-mono text-2xl shrink-0" style={{ color: 'var(--nr-orange)' }}>
                          {Math.round(effectiveDelay(i)).toLocaleString()}m
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Panel selector dots + play/pause */}
        <div className="flex items-center justify-center gap-4 pt-6">
          {PANELS.map((p, i) => (
            <button
              key={p.id}
              onClick={() => pinPanel(i)}
              title={pinned && panel === i ? `${p.label} (pinned — click to resume cycling)` : `Pin ${p.label}`}
              className="w-3 h-3 rounded-full transition-colors"
              style={{
                background: panel === i ? 'var(--nr-orange)' : 'var(--line-hi)',
                boxShadow: panel === i ? '0 0 8px var(--nr-orange)' : 'none',
              }}
            />
          ))}
          <span className="mx-2 text-xs" style={{ color: 'var(--ink-500)' }}>
            {pinned ? `pinned · ${PANELS[panel].label}` : 'cycling'}
          </span>
          <button
            onClick={() => setPinned(p => !p)}
            className="btn !py-1 !px-2 flex items-center gap-1.5 text-[10px]"
            title={pinned ? 'Resume auto-cycling' : 'Pause auto-cycling'}
          >
            {pinned ? <Play size={10} /> : <Pause size={10} />}
            {pinned ? 'Play' : 'Pause'}
          </button>
        </div>
      </main>
    </div>
  )
}
