'use client'

import { useState, useMemo } from 'react'
import {
  ChevronDown, ChevronUp, X, Search, RotateCcw, FlaskConical,
  Clock, TrendingUp, Activity, Layers, AlertTriangle, Info,
} from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, Line, LineChart,
  Scatter, ScatterChart, ZAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, ComposedChart, ReferenceLine,
} from 'recharts'
import {
  IncidentRow, IncidentCategory, Severity,
  CATEGORY_CONFIG, SEVERITY_CONFIG,
} from '@/lib/types'
import {
  searchMatch, effectiveDelay, effectiveMinsToArrival, effectiveDuration,
  SLA_THRESHOLD_MINS,
} from '@/lib/queries'

// ─── Filter shape ─────────────────────────────────────────────────────────────

export interface DistillationFilters {
  categories:     IncidentCategory[]
  severities:     Severity[]
  areas:          string[]
  lines:          string[]
  trainCompanies: string[]
  incidentTypes:  string[]
  dayOfWeek:      number[]   // 0=Sun … 6=Sat
  searches:       string[]
  searchMode:     'and' | 'or'
  // Numeric ranges (minutes unless noted)
  minDelay?:           number
  maxDelay?:           number
  minDuration?:        number   // incident_duration in minutes
  maxDuration?:        number
  minMinsToAdvised?:   number
  maxMinsToAdvised?:   number
  minMinsToResponse?:  number
  maxMinsToResponse?:  number
  minMinsToArrival?:   number
  maxMinsToArrival?:   number
  minTrainsDelayed?:   number
  maxTrainsDelayed?:   number
  // Time-of-day (hour 0–23)
  startHourMin?: number
  startHourMax?: number
  // Tri-state flags: undefined=any, true=only, false=exclude
  isContinuation?:   boolean
  isHighlight?:      boolean
  hasCancellations?: boolean
}

const EMPTY_FILTERS: DistillationFilters = {
  categories:     [],
  severities:     [],
  areas:          [],
  lines:          [],
  trainCompanies: [],
  incidentTypes:  [],
  dayOfWeek:      [],
  searches:       [],
  searchMode:     'or',
}

// ─── Filter application ───────────────────────────────────────────────────────

function applyFilters(incidents: IncidentRow[], f: DistillationFilters): IncidentRow[] {
  return incidents.filter(i => {
    if (f.categories.length     && !f.categories.includes(i.category))                  return false
    if (f.severities.length     && !f.severities.includes(i.severity))                  return false
    if (f.areas.length          && !f.areas.includes(i.area ?? ''))                     return false
    if (f.lines.length          && !f.lines.includes(i.line ?? ''))                     return false
    if (f.trainCompanies.length && !f.trainCompanies.includes(i.train_company ?? ''))   return false
    if (f.incidentTypes.length  && !f.incidentTypes.includes((i.incident_type_label ?? '').trim())) return false
    if (f.dayOfWeek.length      && !f.dayOfWeek.includes(i.day_of_week ?? -1))          return false

    if (f.searches.length) {
      const hit = f.searchMode === 'and'
        ? f.searches.every(q => searchMatch(i, q))
        : f.searches.some(q => searchMatch(i, q))
      if (!hit) return false
    }

    const delay    = effectiveDelay(i)
    const duration = i.incident_duration
    const arrival  = i.mins_to_arrival

    if (f.minDelay        != null && delay < f.minDelay)                              return false
    if (f.maxDelay        != null && delay > f.maxDelay)                              return false
    if (f.minDuration     != null && (duration == null || duration < f.minDuration))  return false
    if (f.maxDuration     != null && (duration == null || duration > f.maxDuration))  return false
    if (f.minMinsToAdvised   != null && (i.mins_to_advised   == null || i.mins_to_advised   < f.minMinsToAdvised))   return false
    if (f.maxMinsToAdvised   != null && (i.mins_to_advised   == null || i.mins_to_advised   > f.maxMinsToAdvised))   return false
    if (f.minMinsToResponse  != null && (i.mins_to_response  == null || i.mins_to_response  < f.minMinsToResponse))  return false
    if (f.maxMinsToResponse  != null && (i.mins_to_response  == null || i.mins_to_response  > f.maxMinsToResponse))  return false
    if (f.minMinsToArrival   != null && (arrival              == null || arrival             < f.minMinsToArrival))   return false
    if (f.maxMinsToArrival   != null && (arrival              == null || arrival             > f.maxMinsToArrival))   return false
    if (f.minTrainsDelayed   != null && i.trains_delayed < f.minTrainsDelayed)        return false
    if (f.maxTrainsDelayed   != null && i.trains_delayed > f.maxTrainsDelayed)        return false
    if (f.startHourMin != null && (i.hour_of_day == null || i.hour_of_day < f.startHourMin)) return false
    if (f.startHourMax != null && (i.hour_of_day == null || i.hour_of_day > f.startHourMax)) return false

    if (f.isContinuation   === true  && !i.is_continuation)  return false
    if (f.isContinuation   === false &&  i.is_continuation)  return false
    if (f.isHighlight      === true  && !i.is_highlight)     return false
    if (f.isHighlight      === false &&  i.is_highlight)     return false
    if (f.hasCancellations === true  && (i.cancelled + i.part_cancelled) === 0) return false

    return true
  })
}

function activeCount(f: DistillationFilters): number {
  return (
    f.categories.length + f.severities.length + f.areas.length +
    f.lines.length + f.trainCompanies.length + f.incidentTypes.length +
    f.dayOfWeek.length + f.searches.length +
    (f.minDelay        != null || f.maxDelay        != null ? 1 : 0) +
    (f.minDuration     != null || f.maxDuration     != null ? 1 : 0) +
    (f.minMinsToAdvised  != null || f.maxMinsToAdvised  != null ? 1 : 0) +
    (f.minMinsToResponse != null || f.maxMinsToResponse != null ? 1 : 0) +
    (f.minMinsToArrival  != null || f.maxMinsToArrival  != null ? 1 : 0) +
    (f.minTrainsDelayed  != null || f.maxTrainsDelayed  != null ? 1 : 0) +
    (f.startHourMin != null || f.startHourMax != null ? 1 : 0) +
    (f.isContinuation   != null ? 1 : 0) +
    (f.isHighlight      != null ? 1 : 0) +
    (f.hasCancellations != null ? 1 : 0)
  )
}

// ─── Small reusable components ────────────────────────────────────────────────

function SectionAccordion({
  label, active, children, defaultOpen = false,
}: {
  label: string; active?: boolean; children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b" style={{ borderColor: 'var(--line)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between py-2.5 px-3 text-left group"
        style={{ background: 'transparent' }}
      >
        <span
          className="label-micro flex items-center gap-2"
          style={{ color: active ? 'var(--nr-orange)' : 'var(--ink-400)' }}
        >
          {label}
          {active && <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: 'var(--nr-orange)' }} />}
        </span>
        {open
          ? <ChevronUp size={12} style={{ color: 'var(--ink-500)' }} />
          : <ChevronDown size={12} style={{ color: 'var(--ink-500)' }} />}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}

function Chip({
  label, active, color, onClick,
}: {
  label: string; active: boolean; color?: string; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-1 text-[10px] rounded-sm transition-all duration-150 numeric-mono uppercase tracking-wider"
      style={{
        background: active ? `${color || 'var(--nr-orange)'}22` : 'var(--bg-card)',
        border: `1px solid ${active ? (color || 'var(--nr-orange)') : 'var(--line)'}`,
        color: active ? (color || 'var(--ink-100)') : 'var(--ink-400)',
      }}
    >
      {label}
    </button>
  )
}

function RangeInputs({
  minVal, maxVal, onMin, onMax, placeholder = 'min',
  placeholder2 = 'max', step = 1,
}: {
  minVal: number | undefined
  maxVal: number | undefined
  onMin: (v: number | undefined) => void
  onMax: (v: number | undefined) => void
  placeholder?: string
  placeholder2?: string
  step?: number
}) {
  const parse = (s: string) => {
    const n = parseFloat(s)
    return isNaN(n) ? undefined : n
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        step={step}
        value={minVal ?? ''}
        onChange={e => onMin(parse(e.target.value))}
        placeholder={placeholder}
        className="w-full px-2 py-1.5 text-xs rounded-sm border outline-none"
        style={{
          background: 'var(--bg-card)',
          borderColor: minVal != null ? 'var(--nr-orange)' : 'var(--line)',
          color: 'var(--ink-200)',
        }}
      />
      <span className="text-xs shrink-0" style={{ color: 'var(--ink-500)' }}>–</span>
      <input
        type="number"
        step={step}
        value={maxVal ?? ''}
        onChange={e => onMax(parse(e.target.value))}
        placeholder={placeholder2}
        className="w-full px-2 py-1.5 text-xs rounded-sm border outline-none"
        style={{
          background: 'var(--bg-card)',
          borderColor: maxVal != null ? 'var(--nr-orange)' : 'var(--line)',
          color: 'var(--ink-200)',
        }}
      />
    </div>
  )
}

function TriStateToggle({
  value, onChange, labels = ['Any', 'Yes', 'No'],
}: {
  value: boolean | undefined
  onChange: (v: boolean | undefined) => void
  labels?: [string, string, string]
}) {
  const opts: [boolean | undefined, string][] = [
    [undefined, labels[0]], [true, labels[1]], [false, labels[2]],
  ]
  return (
    <div className="flex gap-1">
      {opts.map(([v, l]) => {
        const active = value === v
        return (
          <button
            key={l}
            onClick={() => onChange(v)}
            className="px-2.5 py-1 text-[10px] rounded-sm transition-all numeric-mono uppercase tracking-wider"
            style={{
              background: active ? 'var(--nr-orange-glow)' : 'var(--bg-card)',
              border: `1px solid ${active ? 'var(--nr-orange)' : 'var(--line)'}`,
              color: active ? 'var(--nr-orange)' : 'var(--ink-400)',
            }}
          >
            {l}
          </button>
        )
      })}
    </div>
  )
}

function SearchTokens({
  tokens, searchMode, onAdd, onRemove, onModeChange,
}: {
  tokens:       string[]
  searchMode:   'and' | 'or'
  onAdd:        (t: string) => void
  onRemove:     (t: string) => void
  onModeChange: (m: 'and' | 'or') => void
}) {
  const [input, setInput] = useState('')

  const commit = () => {
    const tok = input.trim()
    if (!tok || tokens.includes(tok)) { setInput(''); return }
    onAdd(tok)
    setInput('')
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--ink-500)' }} />
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() } }}
          onBlur={commit}
          placeholder="Add tag, press Enter"
          className="w-full pl-7 pr-3 py-1.5 text-xs rounded-sm border outline-none"
          style={{
            background: 'var(--bg-card)',
            borderColor: 'var(--line)',
            color: 'var(--ink-200)',
          }}
        />
      </div>
      {tokens.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tokens.map(tok => (
            <span
              key={tok}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-[10px] numeric-mono"
              style={{
                background: 'var(--nr-orange-glow)',
                border: '1px solid var(--nr-orange)',
                color: 'var(--nr-orange)',
              }}
            >
              {tok}
              <button onClick={() => onRemove(tok)} className="hover:opacity-70">
                <X size={9} />
              </button>
            </span>
          ))}
        </div>
      )}
      {tokens.length > 1 && (
        <div className="flex gap-1">
          {(['or', 'and'] as const).map(m => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className="px-2 py-0.5 text-[10px] rounded-sm numeric-mono uppercase tracking-wider transition-all"
              style={{
                background: searchMode === m ? 'var(--nr-orange-glow)' : 'var(--bg-card)',
                border: `1px solid ${searchMode === m ? 'var(--nr-orange)' : 'var(--line)'}`,
                color: searchMode === m ? 'var(--nr-orange)' : 'var(--ink-500)',
              }}
            >
              {m}
            </button>
          ))}
          <span className="text-[10px] ml-1" style={{ color: 'var(--ink-500)' }}>
            {searchMode === 'and' ? 'all tags match' : 'any tag matches'}
          </span>
        </div>
      )}
    </div>
  )
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div
      className="px-3 py-2 text-xs rounded border"
      style={{
        background: 'var(--bg-card-hi)',
        borderColor: 'var(--line-hi)',
        color: 'var(--ink-200)',
      }}
    >
      {label && <div className="label-micro mb-1.5">{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-sm" style={{ background: p.color || p.fill }} />
          <span style={{ color: 'var(--ink-400)' }}>{p.name}:</span>
          <span className="numeric-mono ml-auto" style={{ color: 'var(--ink-100)' }}>
            {typeof p.value === 'number' ? p.value.toLocaleString() : p.value}
          </span>
        </div>
      ))}
    </div>
  )
}

function ScatterTip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as any
  if (!d) return null
  return (
    <div
      className="px-3 py-2 text-xs rounded border space-y-1"
      style={{ background: 'var(--bg-card-hi)', borderColor: 'var(--line-hi)', color: 'var(--ink-200)' }}
    >
      <div className="font-medium" style={{ color: 'var(--ink-100)' }}>{d.title || d.location || 'Incident'}</div>
      <div className="flex gap-4">
        <span style={{ color: 'var(--ink-400)' }}>Duration: <span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{d.x} min</span></span>
        <span style={{ color: 'var(--ink-400)' }}>Delay: <span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{d.y} min</span></span>
      </div>
      {d.category && (
        <div style={{ color: CATEGORY_CONFIG[d.category as IncidentCategory]?.color || 'var(--ink-400)' }}>
          {CATEGORY_CONFIG[d.category as IncidentCategory]?.label || d.category}
        </div>
      )}
    </div>
  )
}

// ─── KPI card ─────────────────────────────────────────────────────────────────

function KPICard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div
      className="rounded border p-4 flex flex-col gap-1"
      style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}
    >
      <div className="label-micro" style={{ color: 'var(--ink-500)' }}>{label}</div>
      <div
        className="text-2xl font-light numeric-mono leading-none"
        style={{ color: accent || 'var(--ink-100)' }}
      >
        {value}
      </div>
      {sub && <div className="text-[10px] mt-0.5" style={{ color: 'var(--ink-500)' }}>{sub}</div>}
    </div>
  )
}

// ─── Hypothesis chips ─────────────────────────────────────────────────────────

const PRESETS: { label: string; desc: string; filters: Partial<DistillationFilters> }[] = [
  {
    label: 'Infra delay accumulation',
    desc: 'Infrastructure faults open >24 h with moderate delay — tests whether slow access is driving delay.',
    filters: {
      categories:  ['INFRASTRUCTURE'],
      minDuration: 1440,
      minDelay:    5,
      maxDelay:    200,
    },
  },
  {
    label: 'Night-hour safety cluster',
    desc: 'Safety-critical incidents in overnight hours (22:00–06:00) to test temporal clustering.',
    filters: {
      categories:  ['SPAD', 'TPWS', 'NEAR_MISS', 'IRREGULAR_WORKING', 'FATALITY', 'PERSON_STRUCK'],
      startHourMin: 22,
    },
  },
  {
    label: 'Slow response, high impact',
    desc: 'Incidents where arrival took >90 min and delay was high — tests response-time / delay correlation.',
    filters: {
      minMinsToArrival: 90,
      minDelay: 100,
    },
  },
  {
    label: 'Repeat small cancellations',
    desc: 'Lower-severity incidents generating cancellations — identifies persistent operational pressure.',
    filters: {
      severities: ['LOW', 'INFO', 'MEDIUM'],
      hasCancellations: true,
    },
  },
]

// ─── Main component ───────────────────────────────────────────────────────────

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const CAT_GROUPS: { label: string; cats: IncidentCategory[] }[] = [
  { label: 'Safety',      cats: ['FATALITY', 'PERSON_STRUCK', 'SPAD', 'TPWS', 'NEAR_MISS', 'IRREGULAR_WORKING', 'DERAILMENT', 'PASSENGER_INJURY', 'HABD_WILD'] },
  { label: 'Asset / Infra', cats: ['INFRASTRUCTURE', 'TRACTION_FAILURE', 'TRAIN_FAULT', 'POSSESSION'] },
  { label: 'Operational', cats: ['STATION_OVERRUN', 'STRANDED_TRAIN', 'LEVEL_CROSSING', 'BRIDGE_STRIKE', 'FIRE', 'CRIME'] },
  { label: 'Other',       cats: ['WEATHER', 'GENERAL'] },
]

const PAGE_SIZE = 25

export function DistillationTab({
  incidents,
  windowFrom,
  windowTo,
}: {
  incidents:  IncidentRow[]
  windowFrom: string
  windowTo:   string
}) {
  const [filters, setFilters] = useState<DistillationFilters>(EMPTY_FILTERS)
  const [page, setPage]       = useState(0)
  const [sortBy, setSortBy]   = useState<'date' | 'delay' | 'duration'>('date')
  const [typeQuery, setTypeQuery] = useState('')
  const [companyQuery, setCompanyQuery] = useState('')

  const set = <K extends keyof DistillationFilters>(k: K, v: DistillationFilters[K]) =>
    setFilters(f => ({ ...f, [k]: v }))

  const toggle = <T,>(arr: T[], v: T): T[] =>
    arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]

  const applyPreset = (p: Partial<DistillationFilters>) => {
    setFilters({ ...EMPTY_FILTERS, ...p })
    setPage(0)
  }

  const reset = () => { setFilters(EMPTY_FILTERS); setPage(0) }

  // Derived option lists from the incoming (globally-filtered) incidents
  const availableAreas = useMemo(() => {
    const s = new Set<string>()
    incidents.forEach(i => { if (i.area) s.add(i.area) })
    return [...s].sort()
  }, [incidents])

  const availableLines = useMemo(() => {
    const s = new Set<string>()
    incidents.forEach(i => { if (i.line) s.add(i.line) })
    return [...s].sort()
  }, [incidents])

  const availableCompanies = useMemo(() => {
    const s = new Set<string>()
    incidents.forEach(i => { if (i.train_company) s.add(i.train_company) })
    return [...s].sort()
  }, [incidents])

  const availableTypes = useMemo(() => {
    const counts = new Map<string, number>()
    incidents.forEach(i => {
      const lbl = i.incident_type_label?.trim()
      if (lbl) counts.set(lbl, (counts.get(lbl) ?? 0) + 1)
    })
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l, c]) => ({ label: l, count: c }))
  }, [incidents])

  const filteredTypes = useMemo(() => {
    const q = typeQuery.toLowerCase()
    return q ? availableTypes.filter(t => t.label.toLowerCase().includes(q)) : availableTypes
  }, [availableTypes, typeQuery])

  const filteredCompanies = useMemo(() => {
    const q = companyQuery.toLowerCase()
    return q ? availableCompanies.filter(c => c.toLowerCase().includes(q)) : availableCompanies
  }, [availableCompanies, companyQuery])

  // Apply all distillation filters
  const pool = useMemo(() => applyFilters(incidents, filters), [incidents, filters])

  // Sorted pool for the table
  const sortedPool = useMemo(() => {
    const copy = [...pool]
    if (sortBy === 'delay')    copy.sort((a, b) => effectiveDelay(b) - effectiveDelay(a))
    else if (sortBy === 'duration') copy.sort((a, b) => (b.incident_duration ?? 0) - (a.incident_duration ?? 0))
    else copy.sort((a, b) => b.report_date.localeCompare(a.report_date))
    return copy
  }, [pool, sortBy])

  const totalPages = Math.ceil(sortedPool.length / PAGE_SIZE)
  const pageRows   = sortedPool.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

  // ── Pool analytics ────────────────────────────────────────────────────────

  const kpis = useMemo(() => {
    const unique    = pool.filter(i => !i.is_continuation)
    const totalDly  = pool.reduce((s, i) => s + effectiveDelay(i), 0)
    const arrivals  = pool.map(effectiveMinsToArrival).filter((v): v is number => v != null)
    const durations = pool.map(effectiveDuration).filter((v): v is number => v != null)
    const slaBreaches = arrivals.filter(v => v > SLA_THRESHOLD_MINS).length
    const avgDly    = unique.length ? totalDly / unique.length : 0
    const medArrival = arrivals.length
      ? [...arrivals].sort((a, b) => a - b)[Math.floor(arrivals.length / 2)]
      : null
    const avgDuration = durations.length
      ? durations.reduce((s, v) => s + v, 0) / durations.length
      : null
    const pctOfAll  = incidents.length ? (pool.length / incidents.length) * 100 : 0
    return { count: pool.length, unique: unique.length, totalDly, avgDly, medArrival, avgDuration, slaBreaches, pctOfAll }
  }, [pool, incidents])

  // Daily trend
  const trendData = useMemo(() => {
    const byDate = new Map<string, { incidents: number; delay: number }>()
    pool.forEach(i => {
      const d = i.report_date
      const cur = byDate.get(d) ?? { incidents: 0, delay: 0 }
      byDate.set(d, { incidents: cur.incidents + 1, delay: cur.delay + effectiveDelay(i) })
    })
    return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({
      date: date.slice(5),  // MM-DD
      fullDate: date,
      incidents: v.incidents,
      delay: v.delay,
    }))
  }, [pool])

  // Cumulative delay
  const cumulativeData = useMemo(() => {
    let running = 0
    return trendData.map(d => {
      running += d.delay
      return { ...d, cumDelay: running }
    })
  }, [trendData])

  // Category breakdown
  const catData = useMemo(() => {
    const map = new Map<IncidentCategory, { count: number; delay: number }>()
    pool.forEach(i => {
      const cur = map.get(i.category) ?? { count: 0, delay: 0 }
      map.set(i.category, { count: cur.count + 1, delay: cur.delay + effectiveDelay(i) })
    })
    return [...map.entries()]
      .map(([cat, v]) => ({
        cat,
        label: CATEGORY_CONFIG[cat]?.short ?? cat,
        fullLabel: CATEGORY_CONFIG[cat]?.label ?? cat,
        color: CATEGORY_CONFIG[cat]?.color ?? '#4A6FA5',
        count: v.count,
        delay: v.delay,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }, [pool])

  // Duration distribution (histogram buckets)
  const durationBuckets = useMemo(() => {
    const buckets = [
      { label: '<30m',    min: 0,    max: 30   },
      { label: '30–60m',  min: 30,   max: 60   },
      { label: '1–2h',    min: 60,   max: 120  },
      { label: '2–4h',    min: 120,  max: 240  },
      { label: '4–8h',    min: 240,  max: 480  },
      { label: '8–24h',   min: 480,  max: 1440 },
      { label: '>24h',    min: 1440, max: Infinity },
    ]
    return buckets.map(b => ({
      label: b.label,
      count: pool.filter(i => {
        const d = i.incident_duration
        return d != null && d >= b.min && d < b.max
      }).length,
    }))
  }, [pool])

  // Duration vs Delay scatter (only incidents with both values)
  const scatterData = useMemo(() => {
    return pool
      .filter(i => i.incident_duration != null && effectiveDelay(i) > 0)
      .map(i => ({
        x:        i.incident_duration!,
        y:        effectiveDelay(i),
        category: i.category,
        title:    i.title,
        location: i.location,
        color:    CATEGORY_CONFIG[i.category]?.color ?? '#4A6FA5',
      }))
  }, [pool])

  // Top locations
  const locationData = useMemo(() => {
    const map = new Map<string, { count: number; delay: number }>()
    pool.forEach(i => {
      const loc = i.location || '(unknown)'
      const cur = map.get(loc) ?? { count: 0, delay: 0 }
      map.set(loc, { count: cur.count + 1, delay: cur.delay + effectiveDelay(i) })
    })
    return [...map.entries()]
      .map(([loc, v]) => ({ loc, count: v.count, delay: v.delay }))
      .sort((a, b) => b.delay - a.delay)
      .slice(0, 12)
  }, [pool])

  const numActive = activeCount(filters)
  const hasPool   = pool.length > 0

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex gap-6 items-start">

      {/* ── Left: Filter panel ────────────────────────────────────────────── */}
      <div
        className="shrink-0 rounded border overflow-y-auto"
        style={{
          width: 300,
          maxHeight: 'calc(100vh - 160px)',
          position: 'sticky',
          top: 72,
          background: 'var(--bg-panel)',
          borderColor: 'var(--line)',
        }}
      >
        {/* Panel header */}
        <div
          className="flex items-center justify-between px-3 py-3 border-b"
          style={{ borderColor: 'var(--line)' }}
        >
          <div className="flex items-center gap-2">
            <FlaskConical size={13} style={{ color: 'var(--nr-orange)' }} />
            <span className="label-micro" style={{ color: 'var(--ink-300)' }}>Filter stack</span>
            {numActive > 0 && (
              <span
                className="text-[10px] numeric-mono px-1.5 py-0.5 rounded"
                style={{ background: 'var(--nr-orange)', color: '#fff' }}
              >
                {numActive}
              </span>
            )}
          </div>
          {numActive > 0 && (
            <button
              onClick={reset}
              className="flex items-center gap-1 text-[10px] hover:opacity-70 transition-opacity"
              style={{ color: 'var(--ink-400)' }}
            >
              <RotateCcw size={10} />
              Reset
            </button>
          )}
        </div>

        {/* Pool status */}
        <div
          className="px-3 py-2.5 border-b"
          style={{ borderColor: 'var(--line)', background: 'var(--bg-card)' }}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: 'var(--ink-400)' }}>Pool</span>
            <span className="numeric-mono text-sm font-medium" style={{ color: 'var(--nr-orange)' }}>
              {pool.length.toLocaleString()}
              <span className="text-[10px] ml-1" style={{ color: 'var(--ink-500)' }}>
                / {incidents.length.toLocaleString()} ({kpis.pctOfAll.toFixed(1)}%)
              </span>
            </span>
          </div>
        </div>

        {/* Hypotheses presets */}
        <SectionAccordion label="Hypothesis presets">
          <div className="space-y-2">
            {PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => applyPreset(p.filters)}
                className="w-full text-left rounded p-2.5 text-xs transition-colors hover:border-[var(--nr-orange)]"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--line)',
                  color: 'var(--ink-300)',
                }}
              >
                <div className="font-medium text-[11px] mb-0.5" style={{ color: 'var(--ink-200)' }}>{p.label}</div>
                <div style={{ color: 'var(--ink-500)', fontSize: 10 }}>{p.desc}</div>
              </button>
            ))}
          </div>
        </SectionAccordion>

        {/* Categories */}
        <SectionAccordion
          label="Category"
          active={filters.categories.length > 0}
          defaultOpen={filters.categories.length > 0}
        >
          <div className="space-y-2.5">
            {CAT_GROUPS.map(grp => (
              <div key={grp.label}>
                <div className="label-micro mb-1.5" style={{ fontSize: 9, color: 'var(--ink-500)' }}>{grp.label}</div>
                <div className="flex flex-wrap gap-1">
                  {grp.cats.map(cat => {
                    const cfg = CATEGORY_CONFIG[cat]
                    return (
                      <Chip
                        key={cat}
                        label={cfg.short}
                        active={filters.categories.includes(cat)}
                        color={cfg.color}
                        onClick={() => set('categories', toggle(filters.categories, cat))}
                      />
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </SectionAccordion>

        {/* Severity */}
        <SectionAccordion
          label="Severity"
          active={filters.severities.length > 0}
          defaultOpen={filters.severities.length > 0}
        >
          <div className="flex flex-wrap gap-1">
            {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as Severity[]).map(s => (
              <Chip
                key={s}
                label={s}
                active={filters.severities.includes(s)}
                color={SEVERITY_CONFIG[s].color}
                onClick={() => set('severities', toggle(filters.severities, s))}
              />
            ))}
          </div>
        </SectionAccordion>

        {/* Areas */}
        {availableAreas.length > 0 && (
          <SectionAccordion
            label="Area"
            active={filters.areas.length > 0}
            defaultOpen={filters.areas.length > 0}
          >
            <div className="flex flex-wrap gap-1">
              {availableAreas.map(a => (
                <Chip
                  key={a}
                  label={a}
                  active={filters.areas.includes(a)}
                  onClick={() => set('areas', toggle(filters.areas, a))}
                />
              ))}
            </div>
          </SectionAccordion>
        )}

        {/* Lines */}
        {availableLines.length > 0 && (
          <SectionAccordion
            label="Line"
            active={filters.lines.length > 0}
            defaultOpen={filters.lines.length > 0}
          >
            <div className="flex flex-wrap gap-1">
              {availableLines.map(l => (
                <Chip
                  key={l}
                  label={l}
                  active={filters.lines.includes(l)}
                  onClick={() => set('lines', toggle(filters.lines, l))}
                />
              ))}
            </div>
          </SectionAccordion>
        )}

        {/* Incident types */}
        <SectionAccordion
          label="Incident type"
          active={filters.incidentTypes.length > 0}
          defaultOpen={filters.incidentTypes.length > 0}
        >
          <div className="relative mb-2">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--ink-500)' }} />
            <input
              value={typeQuery}
              onChange={e => setTypeQuery(e.target.value)}
              placeholder="Search types…"
              className="w-full pl-6 pr-2 py-1 text-[11px] rounded-sm border outline-none"
              style={{ background: 'var(--bg-card)', borderColor: 'var(--line)', color: 'var(--ink-200)' }}
            />
          </div>
          <div className="space-y-0.5 max-h-40 overflow-y-auto pr-1">
            {filteredTypes.slice(0, 30).map(t => {
              const on = filters.incidentTypes.includes(t.label)
              return (
                <button
                  key={t.label}
                  onClick={() => set('incidentTypes', toggle(filters.incidentTypes, t.label))}
                  className="w-full text-left px-2 py-1 text-[11px] rounded-sm flex items-center justify-between transition-colors"
                  style={{
                    background: on ? 'var(--nr-orange-glow)' : 'transparent',
                    color: on ? 'var(--nr-orange)' : 'var(--ink-300)',
                  }}
                >
                  <span className="truncate">{t.label}</span>
                  <span className="numeric-mono text-[10px] ml-1 shrink-0" style={{ color: 'var(--ink-500)' }}>
                    {t.count}
                  </span>
                </button>
              )
            })}
          </div>
        </SectionAccordion>

        {/* Train companies */}
        {availableCompanies.length > 0 && (
          <SectionAccordion
            label="Train operator"
            active={filters.trainCompanies.length > 0}
            defaultOpen={filters.trainCompanies.length > 0}
          >
            {availableCompanies.length > 4 && (
              <div className="relative mb-2">
                <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--ink-500)' }} />
                <input
                  value={companyQuery}
                  onChange={e => setCompanyQuery(e.target.value)}
                  placeholder="Search operators…"
                  className="w-full pl-6 pr-2 py-1 text-[11px] rounded-sm border outline-none"
                  style={{ background: 'var(--bg-card)', borderColor: 'var(--line)', color: 'var(--ink-200)' }}
                />
              </div>
            )}
            <div className="flex flex-wrap gap-1">
              {filteredCompanies.map(c => (
                <Chip
                  key={c}
                  label={c}
                  active={filters.trainCompanies.includes(c)}
                  onClick={() => set('trainCompanies', toggle(filters.trainCompanies, c))}
                />
              ))}
            </div>
          </SectionAccordion>
        )}

        {/* Day of week */}
        <SectionAccordion
          label="Day of week"
          active={filters.dayOfWeek.length > 0}
          defaultOpen={filters.dayOfWeek.length > 0}
        >
          <div className="flex gap-1">
            {DOW_LABELS.map((d, i) => (
              <Chip
                key={d}
                label={d}
                active={filters.dayOfWeek.includes(i)}
                onClick={() => set('dayOfWeek', toggle(filters.dayOfWeek, i))}
              />
            ))}
          </div>
        </SectionAccordion>

        {/* Free-text search */}
        <SectionAccordion
          label="Text search / tags"
          active={filters.searches.length > 0}
          defaultOpen={filters.searches.length > 0}
        >
          <SearchTokens
            tokens={filters.searches}
            searchMode={filters.searchMode}
            onAdd={t => set('searches', [...filters.searches, t])}
            onRemove={t => set('searches', filters.searches.filter(s => s !== t))}
            onModeChange={m => set('searchMode', m)}
          />
        </SectionAccordion>

        {/* ─── Timing & response ─── */}
        <div className="px-3 py-1.5 border-y" style={{ borderColor: 'var(--line)', background: 'var(--bg-base)' }}>
          <span className="label-micro" style={{ fontSize: 9, color: 'var(--ink-500)', letterSpacing: '0.2em' }}>
            Timing &amp; response
          </span>
        </div>

        {/* Delay range */}
        <SectionAccordion
          label="Delay (minutes)"
          active={filters.minDelay != null || filters.maxDelay != null}
          defaultOpen={filters.minDelay != null || filters.maxDelay != null}
        >
          <RangeInputs
            minVal={filters.minDelay} maxVal={filters.maxDelay}
            onMin={v => set('minDelay', v)} onMax={v => set('maxDelay', v)}
            placeholder="min delay" placeholder2="max delay"
          />
        </SectionAccordion>

        {/* Duration range */}
        <SectionAccordion
          label="Duration (minutes open)"
          active={filters.minDuration != null || filters.maxDuration != null}
          defaultOpen={filters.minDuration != null || filters.maxDuration != null}
        >
          <RangeInputs
            minVal={filters.minDuration} maxVal={filters.maxDuration}
            onMin={v => set('minDuration', v)} onMax={v => set('maxDuration', v)}
            placeholder="min (e.g. 1440 = 24h)" placeholder2="max"
          />
          <div className="mt-1.5 text-[10px]" style={{ color: 'var(--ink-500)' }}>
            60 = 1h · 480 = 8h · 1440 = 24h
          </div>
        </SectionAccordion>

        {/* Start time (hour of day) */}
        <SectionAccordion
          label="Start time (hour of day)"
          active={filters.startHourMin != null || filters.startHourMax != null}
          defaultOpen={filters.startHourMin != null || filters.startHourMax != null}
        >
          <RangeInputs
            minVal={filters.startHourMin} maxVal={filters.startHourMax}
            onMin={v => set('startHourMin', v)} onMax={v => set('startHourMax', v)}
            placeholder="from (0–23)" placeholder2="to (0–23)"
            step={1}
          />
          <div className="mt-1.5 text-[10px]" style={{ color: 'var(--ink-500)' }}>
            0–6 = early hours · 22–23 = late night
          </div>
        </SectionAccordion>

        {/* Time to advised */}
        <SectionAccordion
          label="Time to advised (min)"
          active={filters.minMinsToAdvised != null || filters.maxMinsToAdvised != null}
          defaultOpen={filters.minMinsToAdvised != null || filters.maxMinsToAdvised != null}
        >
          <RangeInputs
            minVal={filters.minMinsToAdvised} maxVal={filters.maxMinsToAdvised}
            onMin={v => set('minMinsToAdvised', v)} onMax={v => set('maxMinsToAdvised', v)}
            placeholder="min" placeholder2="max"
          />
        </SectionAccordion>

        {/* Time to response */}
        <SectionAccordion
          label="Time to response (min)"
          active={filters.minMinsToResponse != null || filters.maxMinsToResponse != null}
          defaultOpen={filters.minMinsToResponse != null || filters.maxMinsToResponse != null}
        >
          <RangeInputs
            minVal={filters.minMinsToResponse} maxVal={filters.maxMinsToResponse}
            onMin={v => set('minMinsToResponse', v)} onMax={v => set('maxMinsToResponse', v)}
            placeholder="min" placeholder2="max"
          />
        </SectionAccordion>

        {/* Time to arrival */}
        <SectionAccordion
          label="Time to arrival (min)"
          active={filters.minMinsToArrival != null || filters.maxMinsToArrival != null}
          defaultOpen={filters.minMinsToArrival != null || filters.maxMinsToArrival != null}
        >
          <RangeInputs
            minVal={filters.minMinsToArrival} maxVal={filters.maxMinsToArrival}
            onMin={v => set('minMinsToArrival', v)} onMax={v => set('maxMinsToArrival', v)}
            placeholder="min" placeholder2={`max (SLA = ${SLA_THRESHOLD_MINS})`}
          />
          <div className="mt-1.5 text-[10px]" style={{ color: 'var(--ink-500)' }}>
            SLA threshold: {SLA_THRESHOLD_MINS} min
          </div>
        </SectionAccordion>

        {/* ─── Volume ─── */}
        <div className="px-3 py-1.5 border-y" style={{ borderColor: 'var(--line)', background: 'var(--bg-base)' }}>
          <span className="label-micro" style={{ fontSize: 9, color: 'var(--ink-500)', letterSpacing: '0.2em' }}>Volume</span>
        </div>

        {/* Trains delayed */}
        <SectionAccordion
          label="Trains delayed (count)"
          active={filters.minTrainsDelayed != null || filters.maxTrainsDelayed != null}
          defaultOpen={filters.minTrainsDelayed != null || filters.maxTrainsDelayed != null}
        >
          <RangeInputs
            minVal={filters.minTrainsDelayed} maxVal={filters.maxTrainsDelayed}
            onMin={v => set('minTrainsDelayed', v)} onMax={v => set('maxTrainsDelayed', v)}
            placeholder="min trains" placeholder2="max trains"
          />
        </SectionAccordion>

        {/* ─── Flags ─── */}
        <div className="px-3 py-1.5 border-y" style={{ borderColor: 'var(--line)', background: 'var(--bg-base)' }}>
          <span className="label-micro" style={{ fontSize: 9, color: 'var(--ink-500)', letterSpacing: '0.2em' }}>Flags</span>
        </div>

        <SectionAccordion
          label="Continuation"
          active={filters.isContinuation != null}
          defaultOpen={filters.isContinuation != null}
        >
          <TriStateToggle
            value={filters.isContinuation}
            onChange={v => set('isContinuation', v)}
            labels={['Any', 'Continuations only', 'Exclude continuations']}
          />
        </SectionAccordion>

        <SectionAccordion
          label="Highlight"
          active={filters.isHighlight != null}
          defaultOpen={filters.isHighlight != null}
        >
          <TriStateToggle
            value={filters.isHighlight}
            onChange={v => set('isHighlight', v)}
            labels={['Any', 'Highlights only', 'Exclude highlights']}
          />
        </SectionAccordion>

        <SectionAccordion
          label="Cancellations"
          active={filters.hasCancellations != null}
          defaultOpen={filters.hasCancellations != null}
        >
          <TriStateToggle
            value={filters.hasCancellations}
            onChange={v => set('hasCancellations', v)}
            labels={['Any', 'Has cancellations', 'No cancellations']}
          />
        </SectionAccordion>
      </div>

      {/* ── Right: Analytics panel ───────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2" style={{ color: 'var(--ink-100)' }}>
              <FlaskConical size={18} style={{ color: 'var(--nr-orange)' }} />
              Distillation
            </h2>
            <p className="text-xs mt-1" style={{ color: 'var(--ink-400)' }}>
              Stack AND-gate filters to isolate a specific data pool, then interrogate it for correlations,
              trends, and supporting inference.
            </p>
          </div>
          {numActive > 0 && (
            <div
              className="shrink-0 text-xs px-3 py-1.5 rounded border"
              style={{
                background: 'var(--nr-orange-glow)',
                borderColor: 'var(--nr-orange)',
                color: 'var(--nr-orange)',
              }}
            >
              {numActive} condition{numActive !== 1 ? 's' : ''} active
            </div>
          )}
        </div>

        {/* Empty state */}
        {!hasPool && (
          <div
            className="rounded border flex flex-col items-center justify-center py-20 gap-3"
            style={{ borderColor: 'var(--line)', background: 'var(--bg-card)' }}
          >
            <FlaskConical size={36} style={{ color: 'var(--ink-500)' }} />
            <div className="text-sm" style={{ color: 'var(--ink-400)' }}>
              {numActive > 0
                ? 'No incidents match all active conditions.'
                : 'No incidents in the current window.'}
            </div>
            {numActive > 0 && (
              <button
                onClick={reset}
                className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded border transition-colors"
                style={{ borderColor: 'var(--line)', color: 'var(--ink-400)' }}
              >
                <RotateCcw size={12} />
                Clear filters
              </button>
            )}
          </div>
        )}

        {hasPool && (
          <>
            {/* KPI row */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <KPICard
                label="Incidents in pool"
                value={kpis.count.toLocaleString()}
                sub={`${kpis.pctOfAll.toFixed(1)}% of window`}
                accent="var(--nr-orange)"
              />
              <KPICard
                label="Total delay"
                value={`${kpis.totalDly.toLocaleString()} min`}
                sub={kpis.count > 0 ? `across ${kpis.count.toLocaleString()} incident${kpis.count === 1 ? '' : 's'}` : undefined}
              />
              <KPICard
                label="Avg delay / incident"
                value={`${Math.round(kpis.avgDly)} min`}
                sub={kpis.count > 1 ? `across ${kpis.unique} unique` : undefined}
              />
              <KPICard
                label="Avg duration"
                value={kpis.avgDuration != null ? `${Math.round(kpis.avgDuration)} min` : '—'}
                sub={kpis.avgDuration != null ? `${(kpis.avgDuration / 60).toFixed(1)} h avg` : 'no duration data'}
              />
              <KPICard
                label="Median arrival"
                value={kpis.medArrival != null ? `${kpis.medArrival} min` : '—'}
                sub={kpis.slaBreaches > 0 ? `${kpis.slaBreaches} SLA breach${kpis.slaBreaches !== 1 ? 'es' : ''}` : 'SLA met'}
                accent={kpis.slaBreaches > 0 ? 'var(--nr-red)' : undefined}
              />
            </div>

            {/* Trend chart */}
            {trendData.length > 0 && (
              <div className="rounded border p-5" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <div className="label-micro" style={{ color: 'var(--ink-400)' }}>Daily profile</div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--ink-500)' }}>
                      Incidents and delay by day across the window
                    </div>
                  </div>
                  <Activity size={14} style={{ color: 'var(--ink-500)' }} />
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <ComposedChart data={trendData} margin={{ left: 0, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--ink-500)' }} tickLine={false} />
                    <YAxis yAxisId="left" tick={{ fontSize: 10, fill: 'var(--ink-500)' }} tickLine={false} axisLine={false} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: 'var(--ink-500)' }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip />} />
                    <Bar yAxisId="left" dataKey="incidents" name="Incidents" fill="var(--nr-steel)" opacity={0.7} radius={[2, 2, 0, 0]} />
                    <Line yAxisId="right" type="monotone" dataKey="delay" name="Delay (min)" stroke="var(--nr-orange)" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Category breakdown + Duration histogram */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

              {/* Category breakdown */}
              {catData.length > 0 && (
                <div className="rounded border p-5" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
                  <div className="label-micro mb-4" style={{ color: 'var(--ink-400)' }}>Category mix</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={catData} layout="vertical" margin={{ left: 0, right: 8, top: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--ink-500)' }} tickLine={false} />
                      <YAxis type="category" dataKey="label" tick={{ fontSize: 10, fill: 'var(--ink-400)' }} tickLine={false} width={48} />
                      <Tooltip content={<ChartTip />} />
                      <Bar dataKey="count" name="Incidents" radius={[0, 2, 2, 0]}>
                        {catData.map((d, i) => <Cell key={i} fill={d.color} opacity={0.85} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Duration histogram */}
              <div className="rounded border p-5" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
                <div className="flex items-center justify-between mb-4">
                  <div className="label-micro" style={{ color: 'var(--ink-400)' }}>Duration distribution</div>
                  <Clock size={13} style={{ color: 'var(--ink-500)' }} />
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={durationBuckets} margin={{ left: 0, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--ink-500)' }} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--ink-500)' }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip />} />
                    <Bar dataKey="count" name="Incidents" fill="var(--nr-steel)" radius={[2, 2, 0, 0]}>
                      {durationBuckets.map((d, i) => (
                        <Cell
                          key={i}
                          fill={d.label === '>24h' ? 'var(--nr-orange)' : d.label === '8–24h' ? 'var(--nr-amber)' : 'var(--nr-steel)'}
                          opacity={0.85}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Duration vs Delay scatter */}
            {scatterData.length > 1 && (
              <div className="rounded border p-5" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
                <div className="flex items-start justify-between mb-1">
                  <div>
                    <div className="label-micro" style={{ color: 'var(--ink-400)' }}>Duration vs. delay correlation</div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--ink-500)' }}>
                      Each point is one incident. A right-leaning cluster suggests longer-open incidents accumulate
                      more delay — supporting the access &amp; fix hypothesis.
                    </div>
                  </div>
                  <TrendingUp size={14} style={{ color: 'var(--ink-500)' }} />
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <ScatterChart margin={{ left: 0, right: 8, top: 12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis
                      type="number" dataKey="x" name="Duration (min)"
                      tick={{ fontSize: 10, fill: 'var(--ink-500)' }} tickLine={false}
                      label={{ value: 'Duration (min)', position: 'insideBottom', offset: -2, fontSize: 10, fill: 'var(--ink-500)' }}
                    />
                    <YAxis
                      type="number" dataKey="y" name="Delay (min)"
                      tick={{ fontSize: 10, fill: 'var(--ink-500)' }} tickLine={false} axisLine={false}
                      label={{ value: 'Delay (min)', angle: -90, position: 'insideLeft', offset: 10, fontSize: 10, fill: 'var(--ink-500)' }}
                    />
                    <ZAxis range={[30, 30]} />
                    <Tooltip content={<ScatterTip />} />
                    <Scatter data={scatterData} opacity={0.7}>
                      {scatterData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Scatter>
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Cumulative delay */}
            {cumulativeData.length > 1 && (
              <div className="rounded border p-5" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
                <div className="flex items-start justify-between mb-1">
                  <div>
                    <div className="label-micro" style={{ color: 'var(--ink-400)' }}>Cumulative delay accumulation</div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--ink-500)' }}>
                      Steeper gradient = delay concentrating in a short period. Steady rise = persistent low-level pressure.
                    </div>
                  </div>
                  <Layers size={14} style={{ color: 'var(--ink-500)' }} />
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={cumulativeData} margin={{ left: 0, right: 8 }}>
                    <defs>
                      <linearGradient id="cumDelayGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="var(--nr-orange)" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="var(--nr-orange)" stopOpacity={0.03} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--ink-500)' }} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--ink-500)' }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip />} />
                    <Area
                      type="monotone" dataKey="cumDelay" name="Cumulative delay (min)"
                      stroke="var(--nr-orange)" strokeWidth={2}
                      fill="url(#cumDelayGrad)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Top locations */}
            {locationData.length > 0 && (
              <div className="rounded border p-5" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
                <div className="label-micro mb-4" style={{ color: 'var(--ink-400)' }}>Top locations by delay</div>
                <ResponsiveContainer width="100%" height={Math.max(160, locationData.length * 26)}>
                  <BarChart data={locationData} layout="vertical" margin={{ left: 0, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--ink-500)' }} tickLine={false} />
                    <YAxis
                      type="category" dataKey="loc"
                      tick={{ fontSize: 10, fill: 'var(--ink-400)' }} tickLine={false}
                      width={120}
                      tickFormatter={v => v.length > 18 ? v.slice(0, 17) + '…' : v}
                    />
                    <Tooltip content={<ChartTip />} />
                    <Bar dataKey="delay" name="Delay (min)" fill="var(--nr-orange)" opacity={0.8} radius={[0, 2, 2, 0]} />
                    <Bar dataKey="count" name="Incidents" fill="var(--nr-steel)" opacity={0.6} radius={[0, 2, 2, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Incidents table */}
            <div className="rounded border" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
              <div
                className="flex items-center justify-between px-4 py-3 border-b"
                style={{ borderColor: 'var(--line)' }}
              >
                <div className="label-micro" style={{ color: 'var(--ink-400)' }}>
                  Pool incidents ({pool.length.toLocaleString()})
                </div>
                {/* Sort controls */}
                <div className="flex gap-1">
                  {([
                    ['date', 'Date'],
                    ['delay', 'Delay'],
                    ['duration', 'Duration'],
                  ] as const).map(([k, l]) => (
                    <button
                      key={k}
                      onClick={() => { setSortBy(k); setPage(0) }}
                      className="text-[10px] px-2 py-1 rounded-sm numeric-mono uppercase tracking-wider transition-all"
                      style={{
                        background: sortBy === k ? 'var(--nr-orange-glow)' : 'transparent',
                        border: `1px solid ${sortBy === k ? 'var(--nr-orange)' : 'var(--line)'}`,
                        color: sortBy === k ? 'var(--nr-orange)' : 'var(--ink-500)',
                      }}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--line)' }}>
                      {['Date', 'Category', 'Location', 'Delay', 'Duration', 'Arrival', 'Severity'].map(h => (
                        <th
                          key={h}
                          className="text-left px-3 py-2 label-micro"
                          style={{ color: 'var(--ink-500)', fontWeight: 500 }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((inc, i) => {
                      const cfg = CATEGORY_CONFIG[inc.category]
                      const sevCfg = SEVERITY_CONFIG[inc.severity]
                      const dur = inc.incident_duration
                      const arr = inc.mins_to_arrival
                      const dly = effectiveDelay(inc)
                      return (
                        <tr
                          key={inc.id}
                          style={{
                            borderBottom: '1px solid var(--line)',
                            background: i % 2 === 0 ? 'transparent' : 'rgba(74,111,165,0.03)',
                          }}
                        >
                          <td className="px-3 py-2 numeric-mono whitespace-nowrap" style={{ color: 'var(--ink-400)' }}>
                            {inc.report_date}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span
                              className="text-[10px] numeric-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm"
                              style={{ background: `${cfg.color}22`, color: cfg.color }}
                            >
                              {cfg.short}
                            </span>
                          </td>
                          <td
                            className="px-3 py-2 max-w-[160px] truncate"
                            style={{ color: 'var(--ink-300)' }}
                            title={inc.location ?? ''}
                          >
                            {inc.location ?? '—'}
                          </td>
                          <td className="px-3 py-2 numeric-mono whitespace-nowrap" style={{ color: dly > 0 ? 'var(--nr-orange)' : 'var(--ink-500)' }}>
                            {dly > 0 ? `${dly} min` : '—'}
                          </td>
                          <td className="px-3 py-2 numeric-mono whitespace-nowrap" style={{ color: dur != null ? 'var(--ink-300)' : 'var(--ink-500)' }}>
                            {dur != null ? `${dur} min` : '—'}
                          </td>
                          <td
                            className="px-3 py-2 numeric-mono whitespace-nowrap"
                            style={{ color: arr != null ? (arr > SLA_THRESHOLD_MINS ? 'var(--nr-red)' : 'var(--nr-green)') : 'var(--ink-500)' }}
                          >
                            {arr != null ? `${arr} min` : '—'}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span
                              className="text-[10px] numeric-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm"
                              style={{ background: `${sevCfg.color}22`, color: sevCfg.color }}
                            >
                              {inc.severity}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div
                  className="flex items-center justify-between px-4 py-2.5 border-t"
                  style={{ borderColor: 'var(--line)' }}
                >
                  <span className="text-[11px]" style={{ color: 'var(--ink-500)' }}>
                    Page {page + 1} of {totalPages} · {pool.length} incidents
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setPage(p => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="px-2.5 py-1 text-[11px] rounded-sm border transition-colors disabled:opacity-30"
                      style={{ borderColor: 'var(--line)', color: 'var(--ink-400)' }}
                    >
                      ← Prev
                    </button>
                    <button
                      onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                      disabled={page >= totalPages - 1}
                      className="px-2.5 py-1 text-[11px] rounded-sm border transition-colors disabled:opacity-30"
                      style={{ borderColor: 'var(--line)', color: 'var(--ink-400)' }}
                    >
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
