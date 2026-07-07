'use client'

import { useState, useMemo, useEffect } from 'react'
import { ArrowLeftRight, Loader2, MapPin, Layers, TrendingUp } from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { IncidentRow, IncidentCategory, CATEGORY_CONFIG, SAFETY_CATEGORIES } from '@/lib/types'
import { effectiveDelay, nonContinuation, fetchIncidentsForRange } from '@/lib/queries'
import { isSupabaseConfigured } from '@/lib/supabase'
import { generateSyntheticData } from '@/lib/syntheticData'
import { listRailYears, listPeriods, listWeeks } from '@/lib/railwayCalendar'

// ─── Constants ────────────────────────────────────────────────────────────────

const SIDE_A_COLOR = 'var(--nr-orange)'
const SIDE_B_COLOR = '#4A6FA5'
const SEED_A = 42
const SEED_B = 77

// ─── Scope model ──────────────────────────────────────────────────────────────

type ScopeMode = 'period' | 'week' | 'custom'

interface Scope {
  mode:       ScopeMode
  railYear:   number
  period:     number
  week:       number
  customFrom: string
  customTo:   string
}

interface ResolvedScope {
  from:  string
  to:    string
  label: string
  days:  number
}

function yearLabelFor(railYear: number): string {
  return `${railYear}/${String((railYear + 1) % 100).padStart(2, '0')}`
}

function shortDateUK(iso: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]}`
}

function daysBetween(from: string, to: string): number {
  const f = Date.parse(from + 'T00:00:00Z')
  const t = Date.parse(to   + 'T00:00:00Z')
  if (isNaN(f) || isNaN(t) || t < f) return 0
  return Math.round((t - f) / 86_400_000) + 1
}

function resolveScope(s: Scope): ResolvedScope | null {
  if (s.mode === 'period') {
    const p = listPeriods(s.railYear).find(x => x.period === s.period)
    if (!p) return null
    return {
      from: p.from, to: p.to, days: daysBetween(p.from, p.to),
      label: `${p.label} · ${yearLabelFor(s.railYear)} · ${shortDateUK(p.from)} → ${shortDateUK(p.to)}`,
    }
  }
  if (s.mode === 'week') {
    const w = listWeeks(s.period, s.railYear).find(x => x.week === s.week)
    if (!w) return null
    return {
      from: w.from, to: w.to, days: daysBetween(w.from, w.to),
      label: `P${String(s.period).padStart(2, '0')} ${w.label} · ${yearLabelFor(s.railYear)} · ${shortDateUK(w.from)} → ${shortDateUK(w.to)}`,
    }
  }
  const days = daysBetween(s.customFrom, s.customTo)
  if (!days) return null
  return {
    from: s.customFrom, to: s.customTo, days,
    label: `Custom · ${shortDateUK(s.customFrom)} → ${shortDateUK(s.customTo)}`,
  }
}

// Default scope A: the most recent fully-complete railway period.
function lastCompletePeriod(): { railYear: number; period: number } {
  for (const { railYear } of listRailYears()) {
    const complete = listPeriods(railYear).filter(p => p.status === 'complete')
    if (complete.length) return { railYear, period: complete[complete.length - 1].period }
  }
  return { railYear: listRailYears()[0].railYear, period: 1 }
}

// Default scope B: the period immediately before A (wrapping into P13 of the prior year).
function periodBefore(railYear: number, period: number): { railYear: number; period: number } {
  return period > 1
    ? { railYear, period: period - 1 }
    : { railYear: railYear - 1, period: 13 }
}

function makeScope(railYear: number, period: number): Scope {
  return { mode: 'period', railYear, period, week: 1, customFrom: '', customTo: '' }
}

// ─── Per-side data hook ───────────────────────────────────────────────────────

function useScopeIncidents(scope: Scope, seed: number, demoMode: boolean) {
  const resolved = useMemo(() => resolveScope(scope), [scope])
  const [rows,    setRows]    = useState<IncidentRow[]>([])
  const [loading, setLoading] = useState(false)

  const from = resolved?.from ?? null
  const to   = resolved?.to   ?? null
  const days = resolved?.days ?? 0

  useEffect(() => {
    if (!from || !to || !days) { setRows([]); return }
    let cancelled = false
    setLoading(true)

    async function run() {
      try {
        if (isSupabaseConfigured() && !demoMode) {
          const data = await fetchIncidentsForRange(from!, to!)
          if (!cancelled) setRows(data)
        } else {
          const synth = generateSyntheticData(days, seed, from!, to!)
          if (!cancelled) setRows(synth.incidents)
        }
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [from, to, days, seed, demoMode])

  return { resolved, rows, loading }
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

interface SideStats {
  incidents:    number
  totalDelay:   number
  delayPerInc:  number
  delayPerDay:  number
  cancellations: number
  trainsDelayed: number
  safetyCount:  number
}

function deriveStats(rows: IncidentRow[], days: number): SideStats {
  const unique = nonContinuation(rows)
  const totalDelay = rows.reduce((s, i) => s + effectiveDelay(i), 0)
  return {
    incidents:    unique.length,
    totalDelay,
    delayPerInc:  unique.length ? totalDelay / unique.length : 0,
    delayPerDay:  days ? totalDelay / days : 0,
    cancellations: rows.reduce((s, i) => s + (i.cancelled || 0) + (i.part_cancelled || 0), 0),
    trainsDelayed: unique.reduce((s, i) => s + (i.trains_delayed || 0), 0),
    safetyCount:  unique.filter(i => SAFETY_CATEGORIES.includes(i.category)).length,
  }
}

// Daily series aligned to a day index (offset from window start).
function dailySeries(rows: IncidentRow[], from: string, days: number): { delay: number; incidents: number; date: string }[] {
  const startMs = Date.parse(from + 'T00:00:00Z')
  const out = Array.from({ length: days }, (_, i) => ({
    delay: 0, incidents: 0,
    date: new Date(startMs + i * 86_400_000).toISOString().slice(0, 10),
  }))
  for (const inc of rows) {
    const idx = Math.round((Date.parse(inc.report_date + 'T00:00:00Z') - startMs) / 86_400_000)
    if (idx < 0 || idx >= days) continue
    out[idx].delay += effectiveDelay(inc)
    if (!inc.is_continuation) out[idx].incidents += 1
  }
  return out
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString()
}

function fmt1dp(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

// ─── Scope selector ───────────────────────────────────────────────────────────

function ScopePicker({
  side, color, scope, onChange,
}: {
  side:     'A' | 'B'
  color:    string
  scope:    Scope
  onChange: (s: Scope) => void
}) {
  const years = listRailYears()
  const periods = listPeriods(scope.railYear)
  const weeks = listWeeks(scope.period, scope.railYear)

  return (
    <div className="card p-4 space-y-3" style={{ borderTopColor: color, borderTopWidth: 2 }}>
      <div className="flex items-center gap-2">
        <div
          className="w-5 h-5 rounded-sm flex items-center justify-center text-[10px] font-mono font-bold"
          style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color, border: `1px solid ${color}` }}
        >
          {side}
        </div>
        <span className="label-micro" style={{ color }}>Scope {side}</span>
      </div>

      <div>
        <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>Mode</div>
        <select
          className="select w-full text-xs"
          value={scope.mode}
          onChange={e => onChange({ ...scope, mode: e.target.value as ScopeMode })}
        >
          <option value="period">Railway period</option>
          <option value="week">Railway week</option>
          <option value="custom">Custom range</option>
        </select>
      </div>

      {(scope.mode === 'period' || scope.mode === 'week') && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>Rail year</div>
            <select
              className="select w-full text-xs"
              value={scope.railYear}
              onChange={e => onChange({ ...scope, railYear: Number(e.target.value) })}
            >
              {years.map(y => <option key={y.railYear} value={y.railYear}>{y.label}</option>)}
            </select>
          </div>
          <div>
            <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>Period</div>
            <select
              className="select w-full text-xs"
              value={scope.period}
              onChange={e => onChange({ ...scope, period: Number(e.target.value), week: 1 })}
            >
              {periods.map(p => (
                <option key={p.period} value={p.period} disabled={p.status === 'future'}>
                  {p.longLabel}{p.status === 'current' ? ' (in progress)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {scope.mode === 'week' && (
        <div>
          <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>Week</div>
          <select
            className="select w-full text-xs"
            value={scope.week}
            onChange={e => onChange({ ...scope, week: Number(e.target.value) })}
          >
            {weeks.map(w => (
              <option key={w.week} value={w.week} disabled={w.status === 'future'}>
                {w.longLabel}{w.status === 'current' ? ' (in progress)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {scope.mode === 'custom' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>From</div>
            <input
              type="date"
              className="input w-full text-xs"
              value={scope.customFrom}
              onChange={e => onChange({ ...scope, customFrom: e.target.value })}
            />
          </div>
          <div>
            <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>To</div>
            <input
              type="date"
              className="input w-full text-xs"
              value={scope.customTo}
              onChange={e => onChange({ ...scope, customTo: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Trend tooltip ────────────────────────────────────────────────────────────

function TrendTip({ active, payload, label, metric }: any) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  if (!row) return null
  const unit = metric === 'delay' ? 'm' : ''
  return (
    <div
      className="px-3 py-2 rounded border text-xs space-y-1"
      style={{ background: 'var(--bg-card-hi)', borderColor: 'var(--line-hi)', color: 'var(--ink-200)' }}
    >
      <div className="label-micro" style={{ color: 'var(--ink-400)' }}>Day {label}</div>
      {row.a != null && (
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: SIDE_A_COLOR }} />
          <span style={{ color: 'var(--ink-500)' }}>{row.aDate ? shortDateUK(row.aDate) : 'A'}:</span>
          <span className="numeric-mono" style={{ color: 'var(--ink-100)' }}>{fmtInt(row.a)}{unit}</span>
        </div>
      )}
      {row.b != null && (
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: SIDE_B_COLOR }} />
          <span style={{ color: 'var(--ink-500)' }}>{row.bDate ? shortDateUK(row.bDate) : 'B'}:</span>
          <span className="numeric-mono" style={{ color: 'var(--ink-100)' }}>{fmtInt(row.b)}{unit}</span>
        </div>
      )}
    </div>
  )
}

// ─── Delta cell ───────────────────────────────────────────────────────────────
// Positive delta (A above B) is "worse" for every KPI in this table.

function DeltaBadge({ a, b, fmt }: { a: number; b: number; fmt: (n: number) => string }) {
  const delta = a - b
  const pct = b !== 0 ? (delta / b) * 100 : null
  const worse  = delta > 0
  const better = delta < 0
  const color = worse ? '#E74C3C' : better ? '#27AE60' : 'var(--ink-500)'
  return (
    <div className="text-right">
      <div className="numeric-mono text-xs" style={{ color }}>
        {delta > 0 ? '+' : ''}{fmt(delta)}
      </div>
      <div className="numeric-mono text-[9px]" style={{ color }}>
        {pct == null ? (delta === 0 ? '—' : 'new') : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
      </div>
    </div>
  )
}

// ─── CompareTab ───────────────────────────────────────────────────────────────

export function CompareTab({ demoMode }: { demoMode: boolean }) {
  const defaults = useMemo(() => {
    const a = lastCompletePeriod()
    const b = periodBefore(a.railYear, a.period)
    return { a, b }
  }, [])

  const [scopeA, setScopeA] = useState<Scope>(() => makeScope(defaults.a.railYear, defaults.a.period))
  const [scopeB, setScopeB] = useState<Scope>(() => makeScope(defaults.b.railYear, defaults.b.period))
  const [trendMetric, setTrendMetric] = useState<'delay' | 'incidents'>('delay')

  const sideA = useScopeIncidents(scopeA, SEED_A, demoMode)
  const sideB = useScopeIncidents(scopeB, SEED_B, demoMode)

  const statsA = useMemo(() => deriveStats(sideA.rows, sideA.resolved?.days ?? 0), [sideA.rows, sideA.resolved?.days])
  const statsB = useMemo(() => deriveStats(sideB.rows, sideB.resolved?.days ?? 0), [sideB.rows, sideB.resolved?.days])

  // Aligned daily trend — both windows mapped onto a shared Day 1..N axis.
  const trendData = useMemo(() => {
    if (!sideA.resolved || !sideB.resolved) return []
    const serA = dailySeries(sideA.rows, sideA.resolved.from, sideA.resolved.days)
    const serB = dailySeries(sideB.rows, sideB.resolved.from, sideB.resolved.days)
    const n = Math.max(serA.length, serB.length)
    return Array.from({ length: n }, (_, i) => ({
      day: i + 1,
      a:     serA[i] ? serA[i][trendMetric] : null,
      b:     serB[i] ? serB[i][trendMetric] : null,
      aDate: serA[i]?.date ?? null,
      bDate: serB[i]?.date ?? null,
    }))
  }, [sideA.rows, sideB.rows, sideA.resolved, sideB.resolved, trendMetric])

  // Category mix — top 10 by combined non-continuation count.
  const categoryMix = useMemo(() => {
    const acc = new Map<IncidentCategory, { a: number; b: number }>()
    for (const i of nonContinuation(sideA.rows)) {
      const e = acc.get(i.category) ?? { a: 0, b: 0 }; e.a += 1; acc.set(i.category, e)
    }
    for (const i of nonContinuation(sideB.rows)) {
      const e = acc.get(i.category) ?? { a: 0, b: 0 }; e.b += 1; acc.set(i.category, e)
    }
    return Array.from(acc.entries())
      .map(([category, v]) => ({ category, ...v, combined: v.a + v.b }))
      .sort((x, y) => y.combined - x.combined)
      .slice(0, 10)
  }, [sideA.rows, sideB.rows])

  const maxCatCount = useMemo(
    () => Math.max(1, ...categoryMix.map(c => Math.max(c.a, c.b))),
    [categoryMix],
  )

  // Top locations by delay per side; shared locations get highlighted.
  const topLocations = useMemo(() => {
    const rank = (rows: IncidentRow[]) => {
      const byLoc = new Map<string, { location: string; count: number; delay: number }>()
      for (const i of rows) {
        const loc = i.location?.trim()
        if (!loc) continue
        const e = byLoc.get(loc) ?? { location: loc, count: 0, delay: 0 }
        e.delay += effectiveDelay(i)
        if (!i.is_continuation) e.count += 1
        byLoc.set(loc, e)
      }
      return Array.from(byLoc.values())
        .sort((x, y) => y.delay - x.delay || y.count - x.count)
        .slice(0, 8)
    }
    const a = rank(sideA.rows)
    const b = rank(sideB.rows)
    const inA = new Set(a.map(l => l.location))
    const shared = new Set(b.filter(l => inA.has(l.location)).map(l => l.location))
    return { a, b, shared }
  }, [sideA.rows, sideB.rows])

  const kpiRows: { label: string; a: number; b: number; fmt: (n: number) => string }[] = [
    { label: 'Incidents',           a: statsA.incidents,     b: statsB.incidents,     fmt: fmtInt },
    { label: 'Total delay (mins)',  a: statsA.totalDelay,    b: statsB.totalDelay,    fmt: fmtInt },
    { label: 'Delay / incident',    a: statsA.delayPerInc,   b: statsB.delayPerInc,   fmt: fmt1dp },
    { label: 'Delay / day',         a: statsA.delayPerDay,   b: statsB.delayPerDay,   fmt: fmt1dp },
    { label: 'Cancellations (+part)', a: statsA.cancellations, b: statsB.cancellations, fmt: fmtInt },
    { label: 'Trains delayed',      a: statsA.trainsDelayed, b: statsB.trainsDelayed, fmt: fmtInt },
    { label: 'Safety-critical',     a: statsA.safetyCount,   b: statsB.safetyCount,   fmt: fmtInt },
  ]

  const anyLoading = sideA.loading || sideB.loading
  const bothResolved = !!sideA.resolved && !!sideB.resolved

  return (
    <div className="space-y-6">

      {/* Heading */}
      <div className="flex items-center gap-3">
        <ArrowLeftRight size={15} style={{ color: 'var(--nr-orange)', flexShrink: 0 }} />
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--ink-100)' }}>Compare</div>
          <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>
            Split comparison of two railway periods, weeks, or custom date windows
          </div>
        </div>
      </div>

      {/* Scope pickers */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ScopePicker side="A" color={SIDE_A_COLOR} scope={scopeA} onChange={setScopeA} />
        <ScopePicker side="B" color={SIDE_B_COLOR} scope={scopeB} onChange={setScopeB} />
      </div>

      {/* Scope labels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {([
          { side: sideA, color: SIDE_A_COLOR, tag: 'A' },
          { side: sideB, color: SIDE_B_COLOR, tag: 'B' },
        ] as const).map(({ side, color, tag }) => (
          <div key={tag} className="card px-4 py-3 flex items-center gap-3" style={{ borderLeftColor: color, borderLeftWidth: 3 }}>
            {side.loading
              ? <Loader2 size={13} className="animate-spin" style={{ color, flexShrink: 0 }} />
              : <div className="w-2 h-2 rounded-full" style={{ background: color, flexShrink: 0 }} />}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate serif" style={{ color: 'var(--ink-100)' }}>
                {side.resolved?.label ?? 'Select a valid range'}
              </div>
              <div className="text-[10px]" style={{ color: 'var(--ink-500)' }}>
                {side.loading
                  ? 'Loading incidents…'
                  : side.resolved
                    ? `${side.resolved.days} days · ${nonContinuation(side.rows).length.toLocaleString()} incidents`
                    : 'Pick a period, week, or complete custom range'}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── KPI comparison ─────────────────────────────────────────────────── */}
      {bothResolved && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b flex items-center justify-between" style={{ borderColor: 'var(--line)' }}>
            <span className="label-micro" style={{ color: 'var(--nr-orange)' }}>Headline KPIs — A vs B</span>
            {anyLoading && <Loader2 size={12} className="animate-spin" style={{ color: 'var(--ink-500)' }} />}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ minWidth: 480 }}>
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--line)' }}>
                  <th className="text-left px-4 py-2 label-micro text-[9px] font-medium" style={{ color: 'var(--ink-500)' }}>Metric</th>
                  <th className="text-right px-4 py-2 label-micro text-[9px] font-medium" style={{ color: SIDE_A_COLOR }}>A</th>
                  <th className="text-right px-4 py-2 label-micro text-[9px] font-medium" style={{ color: SIDE_B_COLOR }}>B</th>
                  <th className="text-right px-4 py-2 label-micro text-[9px] font-medium" style={{ color: 'var(--ink-500)' }}>Δ (A−B)</th>
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: 'var(--line)' }}>
                {kpiRows.map(r => (
                  <tr key={r.label}>
                    <td className="px-4 py-2.5" style={{ color: 'var(--ink-300)' }}>{r.label}</td>
                    <td className="px-4 py-2.5 text-right numeric-mono" style={{ color: 'var(--ink-100)' }}>{r.fmt(r.a)}</td>
                    <td className="px-4 py-2.5 text-right numeric-mono" style={{ color: 'var(--ink-200)' }}>{r.fmt(r.b)}</td>
                    <td className="px-4 py-2.5"><DeltaBadge a={r.a} b={r.b} fmt={r.fmt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Aligned daily trend ────────────────────────────────────────────── */}
      {bothResolved && trendData.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b flex items-center justify-between" style={{ borderColor: 'var(--line)' }}>
            <div className="flex items-center gap-2">
              <TrendingUp size={12} style={{ color: 'var(--nr-orange)' }} />
              <span className="label-micro" style={{ color: 'var(--nr-orange)' }}>Aligned Daily Trend — Day 1..{trendData.length}</span>
            </div>
            <div className="flex items-center gap-1">
              {(['delay', 'incidents'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setTrendMetric(m)}
                  className={`btn !py-0.5 !px-2 text-[9px] ${trendMetric === m ? 'btn-active' : ''}`}
                >
                  {m === 'delay' ? 'Delay' : 'Incidents'}
                </button>
              ))}
            </div>
          </div>
          <div className="px-4 pt-3 pb-4">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={trendData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                />
                <Tooltip content={<TrendTip metric={trendMetric} />} />
                <Line type="monotone" dataKey="a" stroke={SIDE_A_COLOR} strokeWidth={1.75} dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="b" stroke={SIDE_B_COLOR} strokeWidth={1.75} dot={false} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
            <div className="flex items-center gap-4 mt-1">
              <div className="flex items-center gap-1.5">
                <div className="w-4 h-0.5 rounded-full" style={{ background: SIDE_A_COLOR }} />
                <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>A — {sideA.resolved?.label}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-4 h-0.5 rounded-full" style={{ background: SIDE_B_COLOR }} />
                <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>B — {sideB.resolved?.label}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Category mix ───────────────────────────────────────────────────── */}
      {bothResolved && categoryMix.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b flex items-center gap-2" style={{ borderColor: 'var(--line)' }}>
            <Layers size={12} style={{ color: 'var(--nr-orange)' }} />
            <span className="label-micro" style={{ color: 'var(--nr-orange)' }}>
              Category Mix — Top {categoryMix.length} by combined count
            </span>
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
            {categoryMix.map(({ category, a, b }) => {
              const cfg = CATEGORY_CONFIG[category]
              return (
                <div key={category} className="px-4 py-2.5 flex items-center gap-3">
                  <div
                    className="w-24 flex-shrink-0 px-1.5 py-0.5 rounded-sm text-[9px] font-mono font-bold text-center truncate"
                    style={{ background: `${cfg?.color}22`, color: cfg?.color, border: `1px solid ${cfg?.color}44` }}
                    title={cfg?.label ?? category}
                  >
                    {cfg?.short ?? category}
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-sm overflow-hidden" style={{ background: 'var(--line)' }}>
                        <div className="h-full rounded-sm" style={{ width: `${(a / maxCatCount) * 100}%`, background: SIDE_A_COLOR }} />
                      </div>
                      <span className="numeric-mono text-[10px] w-10 text-right" style={{ color: SIDE_A_COLOR }}>{a}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-sm overflow-hidden" style={{ background: 'var(--line)' }}>
                        <div className="h-full rounded-sm" style={{ width: `${(b / maxCatCount) * 100}%`, background: SIDE_B_COLOR }} />
                      </div>
                      <span className="numeric-mono text-[10px] w-10 text-right" style={{ color: SIDE_B_COLOR }}>{b}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Top locations ──────────────────────────────────────────────────── */}
      {bothResolved && (topLocations.a.length > 0 || topLocations.b.length > 0) && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b flex items-center gap-2" style={{ borderColor: 'var(--line)' }}>
            <MapPin size={12} style={{ color: 'var(--nr-orange)' }} />
            <span className="label-micro" style={{ color: 'var(--nr-orange)' }}>
              Top Locations by Delay — shared locations highlighted
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x divide-y md:divide-y-0" style={{ borderColor: 'var(--line)' }}>
            {([
              { list: topLocations.a, color: SIDE_A_COLOR, tag: 'A', label: sideA.resolved?.label },
              { list: topLocations.b, color: SIDE_B_COLOR, tag: 'B', label: sideB.resolved?.label },
            ] as const).map(({ list, color, tag, label }) => (
              <div key={tag} style={{ borderColor: 'var(--line)' }}>
                <div className="px-4 py-2 border-b label-micro text-[9px]" style={{ borderColor: 'var(--line)', color }}>
                  {tag} — {label}
                </div>
                {list.length === 0 ? (
                  <div className="px-4 py-4 text-xs" style={{ color: 'var(--ink-500)' }}>No located incidents in this window</div>
                ) : (
                  <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
                    {list.map((loc, idx) => {
                      const shared = topLocations.shared.has(loc.location)
                      return (
                        <div
                          key={loc.location}
                          className="px-4 py-2 flex items-center gap-3"
                          style={{ background: shared ? 'var(--bg-card-hi)' : undefined }}
                        >
                          <span className="numeric-mono text-[10px] w-4 flex-shrink-0 text-right" style={{ color: 'var(--ink-500)' }}>{idx + 1}</span>
                          <div className="flex-1 min-w-0 flex items-center gap-2">
                            <span className="text-xs truncate" style={{ color: shared ? 'var(--ink-100)' : 'var(--ink-300)' }}>
                              {loc.location}
                            </span>
                            {shared && (
                              <span className="pill flex-shrink-0 !text-[8px]" style={{ background: 'var(--nr-amber)', color: '#1A1A1A' }}>
                                Both
                              </span>
                            )}
                          </div>
                          <div className="flex-shrink-0 text-right">
                            <div className="numeric-mono text-xs" style={{ color: 'var(--ink-200)' }}>{fmtInt(loc.delay)}m</div>
                            <div className="text-[9px]" style={{ color: 'var(--ink-500)' }}>{loc.count} inc</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
