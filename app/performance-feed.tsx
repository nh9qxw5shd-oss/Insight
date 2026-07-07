'use client'

// ─── Performance feed panel ──────────────────────────────────────────────────
// Consumes the ma_message_snapshots table written by the messaging assistant
// on every "Build message" press. Shows the latest standing per metric RAG'd
// against the targets in force, the day's slot-by-slot ticker, and a
// period-to-date chart of daily final standings with a naive projection to
// period end once enough days have accumulated. Attribution uses the
// DB-stamped railway-calendar columns (migration 013), never the builder's
// UI period selection.

import { useEffect, useMemo, useState } from 'react'
import { Radio, RefreshCw } from 'lucide-react'
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { PerfMetricReading, PerfSnapshot, PerfSlot } from '@/lib/types'
import { fetchPerfSnapshots, pickDailyFinal } from '@/lib/queries'
import { isSupabaseConfigured } from '@/lib/supabase'
import { railwayPeriodWeek, railwayPeriodBounds } from '@/lib/railwayCalendar'

const RAG_COLOURS = { green: '#27AE60', amber: '#F39C12', red: '#E74C3C', none: 'var(--ink-500)' } as const
type Rag = keyof typeof RAG_COLOURS

// Recompute RAG from value vs target/amber respecting direction — the
// builder's own rag string is a fallback only.
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

function fmtVal(v: number | null): string {
  if (v == null) return '—'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

const SLOT_ORDER: PerfSlot[] = ['0530', '0900', '1500', '2200']

export function PerformanceFeedPanel() {
  const [snapshots, setSnapshots] = useState<PerfSnapshot[] | null>(null)
  const [loading, setLoading] = useState(false)

  // Current railway period bounds — the feed's natural frame.
  const period = useMemo(() => {
    const pw = railwayPeriodWeek(isoToday())
    const bounds = railwayPeriodBounds(pw.period, pw.railYear)
    return { ...pw, ...bounds }
  }, [])

  useEffect(() => {
    if (!isSupabaseConfigured()) { setSnapshots([]); return }
    let cancelled = false
    setLoading(true)
    fetchPerfSnapshots(period.from, isoToday())
      .then(rows => { if (!cancelled) setSnapshots(rows) })
      .catch(() => { if (!cancelled) setSnapshots([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [period.from])

  const latest = useMemo(() => {
    if (!snapshots?.length) return null
    return [...snapshots].sort((a, b) => b.last_built_at.localeCompare(a.last_built_at))[0]
  }, [snapshots])

  // Daily final standings across the period (0530-next-morning preferred).
  const dailyFinals = useMemo(() => {
    if (!snapshots?.length) return []
    const dates = Array.from(new Set(snapshots.map(s => s.metrics_for_date))).sort()
    return dates
      .map(d => ({ date: d, snap: pickDailyFinal(snapshots, d) }))
      .filter((x): x is { date: string; snap: PerfSnapshot } => x.snap != null)
  }, [snapshots])

  const metricNames = useMemo(() => {
    const seen: string[] = []
    for (const s of snapshots ?? []) for (const m of s.metrics) {
      if (m.name && !seen.includes(m.name)) seen.push(m.name)
    }
    return seen
  }, [snapshots])

  const [chartMetric, setChartMetric] = useState<string | null>(null)
  const activeMetric = chartMetric ?? metricNames[0] ?? null

  // Period-to-date series + naive linear projection for the selected metric.
  const chart = useMemo(() => {
    if (!activeMetric) return null
    const pts = dailyFinals
      .map(({ date, snap }) => {
        const m = snap.metrics.find(x => x.name === activeMetric)
        return m?.value != null ? { date, value: m.value, target: m.target } : null
      })
      .filter((p): p is { date: string; value: number; target: number | null } => p != null)
    if (pts.length === 0) return null
    const target = pts[pts.length - 1].target
    let projection: number | null = null
    if (pts.length >= 3) {
      // OLS over day index → project the period-end value.
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
    return { pts, target, projection }
  }, [activeMetric, dailyFinals, period])

  // The day being tickered — the latest day with any snapshot.
  const tickerDay = dailyFinals.length ? dailyFinals[dailyFinals.length - 1].date : null
  const tickerRows = useMemo(() => {
    if (!tickerDay || !snapshots) return []
    return snapshots
      .filter(s => s.metrics_for_date === tickerDay)
      .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot))
  }, [snapshots, tickerDay])

  // ── Empty / loading states ─────────────────────────────────────────────────
  if (!isSupabaseConfigured() || (snapshots !== null && snapshots.length === 0 && !loading)) {
    return (
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-1">
          <Radio size={14} style={{ color: 'var(--ink-400)' }} />
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Live performance standing</h3>
        </div>
        <p className="text-[11px]" style={{ color: 'var(--ink-400)' }}>
          {isSupabaseConfigured()
            ? `No performance snapshots captured yet for ${period.yearLabel} · P${String(period.period).padStart(2, '0')}. Data arrives automatically each time a tactical message is built (05:30 / 09:00 / 15:00 / 22:00 slots).`
            : 'Performance snapshots come from the live messaging-assistant feed — not available in demo mode.'}
        </p>
      </div>
    )
  }

  if (snapshots === null || loading) {
    return (
      <div className="card p-5 flex items-center gap-2 text-xs" style={{ color: 'var(--ink-400)' }}>
        <RefreshCw size={12} className="animate-spin" /> Loading performance feed…
      </div>
    )
  }

  const latestMetrics = latest?.metrics ?? []

  return (
    <div className="card p-5 tick-corners">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="live-dot animate-pulse-soft" />
            <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Live performance standing</h3>
          </div>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            From tactical messaging snapshots · {latest ? `latest: ${latest.metrics_for_date} · ${latest.slot} slot · build ${latest.build_count}` : ''} · targets: {latest?.target_period_name ?? '—'}
          </p>
        </div>
        <span className="label-micro" style={{ color: 'var(--ink-500)' }}>
          {period.yearLabel} · P{String(period.period).padStart(2, '0')} · {dailyFinals.length} day{dailyFinals.length === 1 ? '' : 's'} captured
        </span>
      </div>

      {/* Latest standing tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
        {latestMetrics.map(m => {
          const rag = ragFor(m)
          const colour = RAG_COLOURS[rag]
          return (
            <div
              key={m.name}
              className="rounded border p-3"
              style={{ borderColor: rag === 'none' ? 'var(--line)' : `${colour}66`, background: rag === 'none' ? 'var(--bg-card)' : `${colour}0F` }}
              title={m.notes ?? undefined}
            >
              <div className="label-micro text-[9px] mb-1 truncate">{m.name}</div>
              <div className="numeric-mono text-xl" style={{ color: colour }}>{fmtVal(m.value)}</div>
              <div className="text-[9.5px] mt-1 numeric-mono" style={{ color: 'var(--ink-500)' }}>
                {m.target != null ? `tgt ${fmtVal(m.target)}` : ''}{m.amber != null ? ` · amb ${fmtVal(m.amber)}` : ''}
              </div>
              {m.notes && <div className="text-[9.5px] mt-1 truncate" style={{ color: 'var(--ink-400)' }}>{m.notes}</div>}
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Period-to-date chart */}
        <div>
          <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
            <div className="label-micro">Period to date · daily final standing</div>
            <div className="flex gap-1 flex-wrap">
              {metricNames.map(n => (
                <button
                  key={n}
                  onClick={() => setChartMetric(n)}
                  className={`btn !py-0.5 !px-1.5 !text-[9px] ${activeMetric === n ? 'btn-active' : ''}`}
                >
                  {n.replace(' %', '')}
                </button>
              ))}
            </div>
          </div>
          {chart ? (
            <>
              <ResponsiveContainer width="100%" height={190}>
                <LineChart data={chart.pts} margin={{ top: 6, right: 12, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="2 6" />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono' }} tickFormatter={(d: string) => d.slice(5)} />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono' }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card-hi)', border: '1px solid var(--line-hi)', fontSize: 11 }}
                    labelStyle={{ color: 'var(--ink-300)' }}
                  />
                  {chart.target != null && (
                    <ReferenceLine y={chart.target} stroke="#27AE60" strokeDasharray="5 3" strokeOpacity={0.7}
                      label={{ value: `target ${fmtVal(chart.target)}`, position: 'insideTopRight', fill: '#27AE60', fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                  )}
                  <Line type="monotone" dataKey="value" stroke="var(--nr-orange)" strokeWidth={1.8} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
              <div className="text-[10.5px] mt-1" style={{ color: 'var(--ink-500)' }}>
                {chart.projection != null
                  ? `Naive trajectory to period end (${period.to}): ~${fmtVal(chart.projection)}${chart.target != null ? ` vs target ${fmtVal(chart.target)}` : ''} — linear fit over ${chart.pts.length} days, indicative only.`
                  : `Projection unlocks at 3 captured days (${chart.pts.length} so far).`}
              </div>
            </>
          ) : (
            <div className="text-[11px] py-8 text-center" style={{ color: 'var(--ink-500)' }}>
              No values captured yet for this metric.
            </div>
          )}
        </div>

        {/* Intraday ticker */}
        <div>
          <div className="label-micro mb-2">Slot ticker · {tickerDay ?? '—'}</div>
          {tickerRows.length === 0 ? (
            <div className="text-[11px] py-8 text-center" style={{ color: 'var(--ink-500)' }}>No slots captured for the latest day.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-[var(--line)]">
                    <th className="text-left pb-1.5 label-micro text-[9px]" style={{ color: 'var(--ink-400)' }}>Metric</th>
                    {tickerRows.map(s => (
                      <th key={s.slot} className="text-right pb-1.5 label-micro text-[9px]" style={{ color: 'var(--ink-400)' }}>
                        {s.slot === '0530' ? '05:30 (EOD)' : `${s.slot.slice(0, 2)}:${s.slot.slice(2)}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {metricNames.map(name => (
                    <tr key={name} className="border-b border-[var(--line)] last:border-0">
                      <td className="py-1.5" style={{ color: 'var(--ink-300)' }}>{name}</td>
                      {tickerRows.map(s => {
                        const m = s.metrics.find(x => x.name === name)
                        const rag = m ? ragFor(m) : 'none'
                        return (
                          <td key={s.slot} className="py-1.5 text-right numeric-mono" style={{ color: RAG_COLOURS[rag] }}>
                            {m ? fmtVal(m.value) : '—'}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-[10px] mt-1.5" style={{ color: 'var(--ink-500)' }}>
                05:30 carries the previous day's end-of-day standing; 09:00 / 15:00 / 22:00 are the running intraday position. Rebuilds refresh a slot until its time passes.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
