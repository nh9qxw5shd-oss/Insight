'use client'

import { useState, useMemo } from 'react'
import { Database, CalendarRange, ClipboardCheck } from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { IncidentRow } from '@/lib/types'

// ─── Field definitions ────────────────────────────────────────────────────────
// One entry per DLog2 capture field whose completeness we track. Text fields
// treat empty-string / whitespace as missing.

function hasText(v: string | null | undefined): boolean {
  return !!v && v.trim().length > 0
}

interface QualityField {
  key:     string
  label:   string
  color:   string
  caps:    string   // what an incomplete field limits downstream
  present: (i: IncidentRow) => boolean
}

const FIELDS: QualityField[] = [
  { key: 'arrival',    label: 'Arrival timing', color: '#E05206', caps: 'caps SLA & response analytics',              present: i => i.mins_to_arrival != null },
  { key: 'duration',   label: 'Duration',       color: '#F39C12', caps: 'caps duration KPIs & delay-density',         present: i => i.incident_duration != null },
  { key: 'fault',      label: 'Fault number',   color: '#4A6FA5', caps: 'repeat-fault tracking undercounts',          present: i => hasText(i.fault_number) },
  { key: 'line',       label: 'Line',           color: '#27AE60', caps: 'line breakdown panel undercounts',           present: i => hasText(i.line) },
  { key: 'events',     label: 'Events log',     color: '#9B59B6', caps: 'incident timeline reconstruction unavailable', present: i => (i.event_count ?? 0) > 0 },
  { key: 'tda',        label: 'TDA ref',        color: '#5B7FA8', caps: 'TDA cross-referencing unavailable',          present: i => hasText(i.tda_ref) },
  { key: 'responders', label: 'Responders',     color: '#FBBF24', caps: 'responder workload views undercount',        present: i => (i.responder_initials?.length ?? 0) > 0 },
  { key: 'operator',   label: 'Operator',       color: '#E74C3C', caps: 'Operator Impact panel cannot populate',      present: i => hasText(i.train_company) },
  { key: 'type',       label: 'Type label',     color: '#85A3C7', caps: 'type mix & repeat-asset views degrade',      present: i => hasText(i.incident_type_label) },
]

const DEFAULT_SELECTED = ['arrival', 'duration', 'events', 'fault']

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pctColor(p: number): string {
  if (p >= 90) return '#27AE60'
  if (p >= 60) return 'var(--nr-amber)'
  return '#E74C3C'
}

function fmtPct(p: number): string {
  return `${Math.round(p)}%`
}

function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div
      className="px-3 py-2 rounded border text-xs space-y-1"
      style={{ background: 'var(--bg-card-hi)', borderColor: 'var(--line-hi)', color: 'var(--ink-200)' }}
    >
      <div className="font-medium" style={{ color: 'var(--ink-100)' }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ background: p.stroke }} />
          <span style={{ color: 'var(--ink-500)' }}>{p.name}:</span>
          <span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{fmtPct(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ─── QualityTab ───────────────────────────────────────────────────────────────

export function QualityTab({
  incidents,
  windowFrom,
  windowTo,
}: {
  incidents:  IncidentRow[]
  windowFrom: string
  windowTo:   string
}) {
  const [selected, setSelected] = useState<string[]>(DEFAULT_SELECTED)

  const toggleField = (key: string) =>
    setSelected(s => s.includes(key) ? s.filter(k => k !== key) : [...s, key])

  // Months present in the window (from all rows, continuations included —
  // completeness is a property of every captured row).
  const months = useMemo(() => {
    const s = new Set<string>()
    incidents.forEach(i => s.add(i.report_date.slice(0, 7)))
    return [...s].sort()
  }, [incidents])

  const latestMonth = months.length ? months[months.length - 1] : null

  // Overall + latest-month completeness per field
  const fieldStats = useMemo(() => {
    const latestRows = latestMonth ? incidents.filter(i => i.report_date.slice(0, 7) === latestMonth) : []
    return FIELDS.map(f => {
      const overallHit = incidents.filter(f.present).length
      const latestHit  = latestRows.filter(f.present).length
      return {
        field:     f,
        overall:   incidents.length ? (overallHit / incidents.length) * 100 : 0,
        latest:    latestRows.length ? (latestHit / latestRows.length) * 100 : null,
      }
    })
  }, [incidents, latestMonth])

  // Per-month completeness series for the line chart
  const monthlyData = useMemo(() => {
    const byMonth = new Map<string, IncidentRow[]>()
    incidents.forEach(i => {
      const m = i.report_date.slice(0, 7)
      const arr = byMonth.get(m)
      if (arr) arr.push(i)
      else byMonth.set(m, [i])
    })
    return months.map(m => {
      const rows = byMonth.get(m) ?? []
      const point: Record<string, string | number> = { month: m }
      FIELDS.forEach(f => {
        point[f.key] = rows.length ? Math.round((rows.filter(f.present).length / rows.length) * 1000) / 10 : 0
      })
      return point
    })
  }, [incidents, months])

  // ── Empty state ─────────────────────────────────────────────────────────────

  if (incidents.length === 0) {
    return (
      <div className="space-y-6">
        <div className="card p-5">
          <div className="mb-4">
            <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Data Quality</h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
              {windowFrom} – {windowTo}
            </p>
          </div>
          <div className="py-14 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
            No incidents in the current window — widen the date range to assess capture quality
          </div>
        </div>
      </div>
    )
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* ── 1 · Field completeness now ────────────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4">
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Field Completeness</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            Share of DLog2 rows in this window with each field captured — gaps cap what the dashboard can show
          </p>
        </div>

        <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
          {fieldStats.map(({ field, overall, latest }) => (
            <div key={field.key} className="py-2.5 flex items-center gap-4" style={{ borderColor: 'var(--line)' }}>
              <div className="w-28 flex-shrink-0 text-xs" style={{ color: 'var(--ink-200)' }}>{field.label}</div>
              <div className="flex-1 flex items-center gap-2 min-w-[120px]">
                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
                  <div className="h-full rounded-full" style={{ width: `${overall}%`, background: pctColor(overall) }} />
                </div>
                <span className="numeric-mono text-xs w-9 text-right" style={{ color: pctColor(overall) }}>{fmtPct(overall)}</span>
              </div>
              <div className="w-20 flex-shrink-0 text-right">
                <span className="text-[9px] mr-1" style={{ color: 'var(--ink-500)' }}>latest mo.</span>
                <span className="numeric-mono text-xs" style={{ color: latest != null ? pctColor(latest) : 'var(--ink-500)' }}>
                  {latest != null ? fmtPct(latest) : '—'}
                </span>
              </div>
              <div className="hidden sm:block w-56 flex-shrink-0 text-right text-[10px]" style={{ color: 'var(--ink-500)' }}>
                {field.caps}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── 2 · Completeness over time ────────────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4">
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Completeness Over Time</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            Monthly capture rate per field — toggle fields to compare how gaps evolve
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-4">
          {FIELDS.map(f => {
            const active = selected.includes(f.key)
            return (
              <button
                key={f.key}
                onClick={() => toggleField(f.key)}
                className="px-2 py-0.5 rounded-sm text-[9px] border transition-colors flex items-center gap-1.5"
                style={{
                  background:  active ? `${f.color}22` : 'transparent',
                  borderColor: active ? f.color : 'var(--line)',
                  color:       active ? f.color : 'var(--ink-500)',
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: active ? f.color : 'var(--ink-500)' }} />
                {f.label}
              </button>
            )
          })}
        </div>

        {selected.length === 0 ? (
          <div className="py-10 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
            Toggle at least one field above to draw the chart
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={monthlyData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
              <XAxis
                dataKey="month"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
              />
              <YAxis
                domain={[0, 100]}
                axisLine={false}
                tickLine={false}
                width={34}
                tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
                tickFormatter={(v: number) => `${v}%`}
              />
              <Tooltip content={<ChartTip />} />
              {FIELDS.filter(f => selected.includes(f.key)).map(f => (
                <Line
                  key={f.key}
                  type="monotone"
                  dataKey={f.key}
                  name={f.label}
                  stroke={f.color}
                  strokeWidth={1.5}
                  dot={{ r: 2, fill: f.color, strokeWidth: 0 }}
                  activeDot={{ r: 3 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── 3 · Row-count context ─────────────────────────────────────────── */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div className="flex items-center gap-2.5">
            <Database size={13} style={{ color: 'var(--ink-500)' }} />
            <div>
              <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Incident rows</div>
              <div className="numeric-mono text-base font-light" style={{ color: 'var(--ink-100)' }}>{incidents.length.toLocaleString()}</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <CalendarRange size={13} style={{ color: 'var(--ink-500)' }} />
            <div>
              <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Months covered</div>
              <div className="numeric-mono text-base font-light" style={{ color: 'var(--ink-100)' }}>{months.length}</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <ClipboardCheck size={13} style={{ color: 'var(--ink-500)' }} />
            <div>
              <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Window</div>
              <div className="numeric-mono text-base font-light" style={{ color: 'var(--ink-100)' }}>{windowFrom} – {windowTo}</div>
            </div>
          </div>
          <div className="flex-1 min-w-[220px] text-[10px]" style={{ color: 'var(--ink-500)' }}>
            Percentages cover all rows (continuations included) in the current dashboard window.
            Widen the global date range to see a longer capture history.
          </div>
        </div>
      </div>
    </div>
  )
}
