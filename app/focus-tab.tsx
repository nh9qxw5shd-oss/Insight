'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import {
  Search, X, Target, RotateCcw, ChevronDown, ChevronUp, Users, ArrowRight,
} from 'lucide-react'
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts'
import {
  IncidentRow, IncidentCategory, Severity,
  CATEGORY_CONFIG, SEVERITY_CONFIG,
} from '@/lib/types'
import { searchMatch, effectiveDelay, effectiveMinsToArrival } from '@/lib/queries'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeAvg(vals: number[]): number {
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  return sorted[Math.floor(q * (sorted.length - 1))]
}

function pctileOf(v: number, sorted: number[]): number {
  if (!sorted.length) return 0
  return Math.round((sorted.filter(x => x < v).length / sorted.length) * 100)
}

function fmtMin(m: number | null | undefined): string {
  if (m == null) return '—'
  if (m < 60) return `${Math.round(m)}m`
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`
}

function fmtNum(n: number): string {
  return n === 0 ? '—' : n.toLocaleString()
}

function sevLabel(s: Severity): string {
  return s.charAt(0) + s.slice(1).toLowerCase()
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface CohortFilters {
  matchCategory: boolean
  matchArea:     boolean
  matchSeverity: boolean
  categories:    IncidentCategory[]
  areas:         string[]
  severities:    Severity[]
}

const EMPTY_COHORT: CohortFilters = {
  matchCategory: false,
  matchArea:     false,
  matchSeverity: false,
  categories:    [],
  areas:         [],
  severities:    [],
}

const SEV_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']

type YMetric = 'duration' | 'response' | 'arrival'
const Y_METRIC_OPTS: { key: YMetric; label: string }[] = [
  { key: 'duration', label: 'Duration' },
  { key: 'response', label: 'Mins to Response' },
  { key: 'arrival',  label: 'Mins to Arrival' },
]

function getYVal(i: IncidentRow, m: YMetric): number | null {
  if (m === 'duration') return i.incident_duration ?? null
  if (m === 'response') return i.mins_to_response  ?? null
  return effectiveMinsToArrival(i)
}

// ─── Scatter tooltip ─────────────────────────────────────────────────────────

function ScatterTip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  const cfg = d.category ? CATEGORY_CONFIG[d.category as IncidentCategory] : null
  return (
    <div
      className="px-3 py-2 rounded border text-xs space-y-1 max-w-[220px]"
      style={{ background: 'var(--bg-card-hi)', borderColor: 'var(--line-hi)', color: 'var(--ink-200)' }}
    >
      {d.isFocal && (
        <div className="label-micro" style={{ color: 'var(--nr-orange)' }}>Focal incident</div>
      )}
      {d.isCompare && (
        <div className="label-micro" style={{ color: '#5B7FA8' }}>Comparison incident</div>
      )}
      <div className="font-medium truncate" style={{ color: 'var(--ink-100)' }}>
        {d.title || '—'}
      </div>
      {cfg && (
        <div style={{ color: cfg.color }}>{cfg.label}</div>
      )}
      <div className="flex gap-3">
        <span style={{ color: 'var(--ink-500)' }}>Delay: <span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{d.x}m</span></span>
        <span style={{ color: 'var(--ink-500)' }}>Y: <span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{d.y}m</span></span>
      </div>
      {d.date && <div className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{d.date}</div>}
    </div>
  )
}

// ─── FocusTab ────────────────────────────────────────────────────────────────

export function FocusTab({ incidents }: { incidents: IncidentRow[] }) {
  const [query,       setQuery]       = useState('')
  const [showDrop,    setShowDrop]    = useState(false)
  const [focalId,     setFocalId]     = useState<string | null>(null)
  const [compareId,   setCompareId]   = useState<string | null>(null)
  const [cohort,      setCohort]      = useState<CohortFilters>(EMPTY_COHORT)
  const [showFilters, setShowFilters] = useState(false)
  const [yMetric,     setYMetric]     = useState<YMetric>('duration')

  const dropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!dropRef.current?.contains(e.target as Node)) setShowDrop(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const focal   = useMemo(() => incidents.find(i => i.id === focalId)   ?? null, [incidents, focalId])
  const compare = useMemo(() => incidents.find(i => i.id === compareId) ?? null, [incidents, compareId])

  const candidates = useMemo(() => {
    if (!query.trim()) return []
    return incidents.filter(i => searchMatch(i, query.trim())).slice(0, 15)
  }, [incidents, query])

  const cohortIncidents = useMemo(() => {
    return incidents.filter(i => {
      if (i.id === focalId || i.id === compareId) return false
      if (cohort.matchCategory && focal && i.category !== focal.category) return false
      if (cohort.matchArea     && focal && i.area     !== focal.area)     return false
      if (cohort.matchSeverity && focal && i.severity !== focal.severity) return false
      if (cohort.categories.length && !cohort.categories.includes(i.category))  return false
      if (cohort.areas.length      && !cohort.areas.includes(i.area ?? ''))     return false
      if (cohort.severities.length && !cohort.severities.includes(i.severity))  return false
      return true
    })
  }, [incidents, focalId, compareId, cohort, focal])

  // Sorted value arrays per metric (cohort only)
  const sortedDelays    = useMemo(() => [...cohortIncidents.map(effectiveDelay).filter(v => v > 0)].sort((a,b)=>a-b), [cohortIncidents])
  const sortedDurations = useMemo(() => [...cohortIncidents.map(i => i.incident_duration ?? 0).filter(v => v > 0)].sort((a,b)=>a-b), [cohortIncidents])
  const sortedResponses = useMemo(() => [...cohortIncidents.map(i => i.mins_to_response  ?? 0).filter(v => v > 0)].sort((a,b)=>a-b), [cohortIncidents])
  const sortedArrivals  = useMemo(() => [...cohortIncidents.map(i => effectiveMinsToArrival(i) ?? 0).filter(v => v > 0)].sort((a,b)=>a-b), [cohortIncidents])

  const focalDelay    = focal ? effectiveDelay(focal) : null
  const focalDuration = focal?.incident_duration ?? null
  const focalResponse = focal?.mins_to_response  ?? null
  const focalArrival  = focal ? effectiveMinsToArrival(focal) : null

  const compareDelay    = compare ? effectiveDelay(compare)          : null
  const compareDuration = compare?.incident_duration                  ?? null
  const compareResponse = compare?.mins_to_response                   ?? null
  const compareArrival  = compare ? effectiveMinsToArrival(compare)  : null

  // Scatter data — cohort dots + focal/compare highlights
  const scatterCohort = useMemo(() => {
    return cohortIncidents
      .map(i => {
        const x = effectiveDelay(i)
        const y = getYVal(i, yMetric)
        if (y == null || x === 0) return null
        return {
          x, y,
          title:    i.title || i.location || '—',
          date:     i.report_date,
          category: i.category,
          id:       i.id,
          isFocal:   false,
          isCompare: false,
        }
      })
      .filter(Boolean)
  }, [cohortIncidents, yMetric])

  const scatterFocal = useMemo(() => {
    if (!focal) return []
    const x = focalDelay
    const y = getYVal(focal, yMetric)
    if (x == null || y == null) return []
    return [{ x, y, title: focal.title || focal.location || '—', date: focal.report_date, category: focal.category, id: focal.id, isFocal: true, isCompare: false }]
  }, [focal, focalDelay, yMetric])

  const scatterCompare = useMemo(() => {
    if (!compare) return []
    const x = compareDelay
    const y = getYVal(compare, yMetric)
    if (x == null || y == null) return []
    return [{ x, y, title: compare.title || compare.location || '—', date: compare.report_date, category: compare.category, id: compare.id, isFocal: false, isCompare: true }]
  }, [compare, compareDelay, yMetric])

  // Similar incidents — same cat + area, ordered by delay proximity
  const similar = useMemo(() => {
    if (!focal) return []
    return cohortIncidents
      .filter(i => i.category === focal.category && i.area === focal.area)
      .sort((a, b) => Math.abs(effectiveDelay(a) - (focalDelay ?? 0)) - Math.abs(effectiveDelay(b) - (focalDelay ?? 0)))
      .slice(0, 8)
  }, [focal, cohortIncidents, focalDelay])

  const areaOptions = useMemo(() => [...new Set(incidents.map(i => i.area).filter(Boolean) as string[])].sort(), [incidents])
  const catOptions  = useMemo(() => [...new Set(incidents.map(i => i.category))].sort() as IncidentCategory[], [incidents])
  const focalLabel   = focal?.ccil   ? `CCIL ${focal.ccil}`   : 'Focal'
  const compareLabel = compare?.ccil ? `CCIL ${compare.ccil}` : 'Compare'

  const hasActiveCohortFilters =
    cohort.matchCategory || cohort.matchArea || cohort.matchSeverity ||
    cohort.categories.length > 0 || cohort.areas.length > 0 || cohort.severities.length > 0

  function select(i: IncidentRow) {
    setFocalId(i.id)
    setQuery('')
    setShowDrop(false)
    if (compareId === i.id) setCompareId(null)
  }

  function clearFocal() {
    setFocalId(null)
    setCompareId(null)
    setCohort(EMPTY_COHORT)
  }

  function swapToFocus(i: IncidentRow) {
    setFocalId(i.id)
    if (compareId === i.id) setCompareId(null)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* Heading */}
      <div className="flex items-center gap-3">
        <Target size={15} style={{ color: 'var(--nr-orange)', flexShrink: 0 }} />
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--ink-100)' }}>Incident Focus</div>
          <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>
            Select an incident to see where it sits across the cohort on every metric
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="relative" ref={dropRef}>
        <div
          className="flex items-center gap-2 px-3 py-2 rounded border"
          style={{ background: 'var(--bg-card)', borderColor: showDrop && query ? 'var(--nr-orange)' : 'var(--line)', transition: 'border-color 0.15s' }}
        >
          <Search size={13} style={{ color: 'var(--ink-400)', flexShrink: 0 }} />
          <input
            className="flex-1 bg-transparent text-xs outline-none"
            style={{ color: 'var(--ink-100)' }}
            placeholder="Search by CCIL ref, title, location, or fault number…"
            value={query}
            onChange={e => { setQuery(e.target.value); setShowDrop(true) }}
            onFocus={() => { if (query) setShowDrop(true) }}
          />
          {query && <button onClick={() => { setQuery(''); setShowDrop(false) }}><X size={12} style={{ color: 'var(--ink-500)' }} /></button>}
        </div>

        {showDrop && query.trim() && (
          <div
            className="absolute z-30 w-full mt-1 rounded border shadow-xl overflow-hidden"
            style={{ background: 'var(--bg-card-hi)', borderColor: 'var(--line-hi)' }}
          >
            {candidates.length === 0 ? (
              <div className="px-4 py-3 text-xs" style={{ color: 'var(--ink-500)' }}>
                No incidents found in current window — adjust the global date range if needed
              </div>
            ) : (
              <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
                {candidates.map(i => {
                  const cfg = CATEGORY_CONFIG[i.category]
                  return (
                    <button
                      key={i.id}
                      onClick={() => select(i)}
                      className="w-full text-left px-3 py-2.5 flex items-start gap-3 hover:bg-white/5 transition-colors"
                    >
                      <div
                        className="mt-0.5 px-1.5 py-0.5 rounded-sm text-[9px] font-mono font-bold flex-shrink-0"
                        style={{ background: `${cfg?.color}22`, color: cfg?.color, border: `1px solid ${cfg?.color}44` }}
                      >
                        {cfg?.label ?? i.category}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs truncate" style={{ color: 'var(--ink-100)' }}>{i.title || i.location || '—'}</div>
                        <div className="flex items-center gap-2 mt-0.5 text-[10px]" style={{ color: 'var(--ink-500)' }}>
                          <span>{i.report_date}</span>
                          {i.ccil && <><span>·</span><span>CCIL {i.ccil}</span></>}
                          {i.area && <><span>·</span><span>{i.area}</span></>}
                        </div>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <div className="numeric-mono text-xs" style={{ color: 'var(--ink-200)' }}>{effectiveDelay(i)}m</div>
                        <div className="text-[9px]" style={{ color: 'var(--ink-500)' }}>delay</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Focal card */}
      {focal && (() => {
        const cfg    = CATEGORY_CONFIG[focal.category]
        const sevCfg = SEVERITY_CONFIG[focal.severity]
        return (
          <div
            className="rounded border overflow-hidden"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--line)', borderLeftColor: cfg?.color, borderLeftWidth: 3 }}
          >
            <div className="px-4 py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  {focal.ccil && (
                    <span className="px-1.5 py-0.5 rounded-sm text-[9px] font-mono font-bold" style={{ background: 'var(--nr-orange-glow)', color: 'var(--nr-orange)', border: '1px solid var(--line-glow)' }}>
                      CCIL {focal.ccil}
                    </span>
                  )}
                  <span className="px-1.5 py-0.5 rounded-sm text-[9px] font-mono font-bold" style={{ background: `${cfg?.color}22`, color: cfg?.color }}>
                    {cfg?.label ?? focal.category}
                  </span>
                  <span className="px-1.5 py-0.5 rounded-sm text-[9px] font-mono font-bold" style={{ background: `${sevCfg?.color}22`, color: sevCfg?.color }}>
                    {sevLabel(focal.severity)}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{focal.report_date}</span>
                  {focal.area && <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{focal.area}</span>}
                </div>
                <div className="text-sm font-medium" style={{ color: 'var(--ink-100)' }}>{focal.title || focal.location || '—'}</div>
                {focal.location && focal.title && <div className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{focal.location}</div>}
              </div>
              <button onClick={clearFocal} className="btn !py-1 !px-2 flex-shrink-0 flex items-center gap-1"><X size={10} /> Clear</button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 border-t divide-x" style={{ borderColor: 'var(--line)' }}>
              {([
                { label: 'Delay',          value: fmtMin(focalDelay) },
                { label: 'Trains Delayed', value: fmtNum(focal.trains_delayed) },
                { label: 'Duration',       value: fmtMin(focalDuration) },
                { label: 'Mins to Resp.',  value: fmtMin(focalResponse) },
              ] as const).map(({ label, value }) => (
                <div key={label} className="px-4 py-2.5" style={{ borderColor: 'var(--line)' }}>
                  <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>{label}</div>
                  <div className="numeric-mono text-base font-light mt-0.5" style={{ color: 'var(--ink-100)' }}>{value}</div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Cohort controls */}
      {focal && (
        <div className="rounded border" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
          <button onClick={() => setShowFilters(f => !f)} className="w-full px-4 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users size={13} style={{ color: hasActiveCohortFilters ? 'var(--nr-orange)' : 'var(--ink-400)' }} />
              <span className="label-micro" style={{ color: hasActiveCohortFilters ? 'var(--nr-orange)' : 'var(--ink-400)' }}>
                Cohort — {cohortIncidents.length.toLocaleString()} incidents
              </span>
              {hasActiveCohortFilters && <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--nr-orange)' }} />}
            </div>
            <div className="flex items-center gap-3">
              {hasActiveCohortFilters && (
                <button onClick={e => { e.stopPropagation(); setCohort(EMPTY_COHORT) }} className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--ink-500)' }}>
                  <RotateCcw size={9} /> Reset
                </button>
              )}
              {showFilters ? <ChevronUp size={12} style={{ color: 'var(--ink-500)' }} /> : <ChevronDown size={12} style={{ color: 'var(--ink-500)' }} />}
            </div>
          </button>

          {showFilters && (
            <div className="px-4 pb-4 pt-3 border-t space-y-4" style={{ borderColor: 'var(--line)' }}>
              <div>
                <div className="label-micro text-[9px] mb-2" style={{ color: 'var(--ink-500)' }}>NARROW TO MATCH FOCAL</div>
                <div className="flex flex-wrap gap-2">
                  {([
                    { key: 'matchCategory' as const, label: `Same category — ${CATEGORY_CONFIG[focal.category]?.label ?? focal.category}` },
                    { key: 'matchArea'     as const, label: `Same area — ${focal.area ?? 'unknown'}` },
                    { key: 'matchSeverity' as const, label: `Same severity — ${sevLabel(focal.severity)}` },
                  ]).map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setCohort(c => ({ ...c, [key]: !c[key] }))}
                      className="px-2.5 py-1 rounded-sm text-[10px] border transition-colors"
                      style={{ background: cohort[key] ? 'var(--nr-orange-glow)' : 'transparent', borderColor: cohort[key] ? 'var(--nr-orange)' : 'var(--line)', color: cohort[key] ? 'var(--nr-orange)' : 'var(--ink-400)' }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="label-micro text-[9px] mb-2" style={{ color: 'var(--ink-500)' }}>FILTER COHORT BY CATEGORY</div>
                <div className="flex flex-wrap gap-1.5">
                  {catOptions.map(cat => {
                    const cfg = CATEGORY_CONFIG[cat]; const active = cohort.categories.includes(cat)
                    return (
                      <button key={cat} onClick={() => setCohort(c => ({ ...c, categories: active ? c.categories.filter(x => x !== cat) : [...c.categories, cat] }))}
                        className="px-2 py-0.5 rounded-sm text-[9px] font-mono border transition-colors"
                        style={{ background: active ? `${cfg?.color}22` : 'transparent', borderColor: active ? cfg?.color : 'var(--line)', color: active ? cfg?.color : 'var(--ink-500)' }}
                      >
                        {cfg?.label ?? cat}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <div className="label-micro text-[9px] mb-2" style={{ color: 'var(--ink-500)' }}>FILTER COHORT BY SEVERITY</div>
                <div className="flex flex-wrap gap-1.5">
                  {SEV_ORDER.map(sev => {
                    const cfg = SEVERITY_CONFIG[sev]; const active = cohort.severities.includes(sev)
                    return (
                      <button key={sev} onClick={() => setCohort(c => ({ ...c, severities: active ? c.severities.filter(x => x !== sev) : [...c.severities, sev] }))}
                        className="px-2 py-0.5 rounded-sm text-[9px] font-mono border transition-colors"
                        style={{ background: active ? `${cfg.color}22` : 'transparent', borderColor: active ? cfg.color : 'var(--line)', color: active ? cfg.color : 'var(--ink-500)' }}
                      >
                        {sevLabel(sev)}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <div className="label-micro text-[9px] mb-2" style={{ color: 'var(--ink-500)' }}>FILTER COHORT BY AREA</div>
                <div className="flex flex-wrap gap-1.5">
                  {areaOptions.map(area => {
                    const active = cohort.areas.includes(area)
                    return (
                      <button key={area} onClick={() => setCohort(c => ({ ...c, areas: active ? c.areas.filter(x => x !== area) : [...c.areas, area] }))}
                        className="px-2 py-0.5 rounded-sm text-[9px] border transition-colors"
                        style={{ background: active ? 'var(--nr-orange-glow)' : 'transparent', borderColor: active ? 'var(--nr-orange)' : 'var(--line)', color: active ? 'var(--nr-orange)' : 'var(--ink-500)' }}
                      >
                        {area}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Compare banner */}
      {compare && (
        <div className="rounded border px-4 py-2.5 flex items-center gap-3" style={{ background: 'var(--bg-card)', borderColor: '#5B7FA8' }}>
          <ArrowRight size={13} style={{ color: '#5B7FA8', flexShrink: 0 }} />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate" style={{ color: 'var(--ink-200)' }}>{compare.title || compare.location || '—'}</div>
            <div className="flex items-center gap-2 mt-0.5 text-[10px]" style={{ color: 'var(--ink-500)' }}>
              <span>{compare.report_date}</span>
              {compare.ccil && <><span>·</span><span>CCIL {compare.ccil}</span></>}
              <span>·</span><span>{effectiveDelay(compare)}m delay</span>
            </div>
          </div>
          <button onClick={() => setCompareId(null)} className="btn !py-1 !px-2 flex-shrink-0 flex items-center gap-1"><X size={10} /> Remove</button>
        </div>
      )}

      {/* ── Scatter overview ─────────────────────────────────────────────── */}
      {focal && cohortIncidents.length > 0 && scatterCohort.length > 0 && (
        <div className="rounded border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
          <div className="px-4 py-2.5 border-b flex items-center justify-between" style={{ borderColor: 'var(--line)' }}>
            <span className="label-micro" style={{ color: 'var(--nr-orange)' }}>
              Cohort Overview — Delay vs&nbsp;
              {Y_METRIC_OPTS.find(o => o.key === yMetric)?.label}
            </span>
            <div className="flex items-center gap-1">
              {Y_METRIC_OPTS.map(o => (
                <button
                  key={o.key}
                  onClick={() => setYMetric(o.key)}
                  className="px-2 py-0.5 rounded-sm text-[9px] border transition-colors"
                  style={{
                    background:  yMetric === o.key ? 'var(--nr-orange-glow)' : 'transparent',
                    borderColor: yMetric === o.key ? 'var(--nr-orange)'      : 'var(--line)',
                    color:       yMetric === o.key ? 'var(--nr-orange)'      : 'var(--ink-500)',
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="px-4 pt-3 pb-4">
            <ResponsiveContainer width="100%" height={260}>
              <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis
                  dataKey="x"
                  name="Delay (min)"
                  type="number"
                  tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
                  axisLine={false}
                  tickLine={false}
                  label={{ value: 'Delay (min)', position: 'insideBottom', offset: -4, fontSize: 9, fill: 'var(--ink-500)' }}
                />
                <YAxis
                  dataKey="y"
                  name={Y_METRIC_OPTS.find(o => o.key === yMetric)?.label}
                  type="number"
                  tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                />
                <ZAxis range={[28, 28]} />
                <Tooltip content={<ScatterTip />} />

                {/* Focal reference lines */}
                {focalDelay != null && (
                  <ReferenceLine x={focalDelay} stroke="var(--nr-orange)" strokeDasharray="4 3" strokeWidth={1} opacity={0.6} />
                )}
                {scatterFocal[0]?.y != null && (
                  <ReferenceLine y={scatterFocal[0].y} stroke="var(--nr-orange)" strokeDasharray="4 3" strokeWidth={1} opacity={0.6} />
                )}

                {/* Cohort */}
                <Scatter
                  name="Cohort"
                  data={scatterCohort}
                  fill="var(--ink-400)"
                  fillOpacity={0.35}
                />
                {/* Compare */}
                {scatterCompare.length > 0 && (
                  <Scatter
                    name="Compare"
                    data={scatterCompare}
                    fill="#5B7FA8"
                    fillOpacity={0.9}
                  />
                )}
                {/* Focal — rendered last so it sits on top */}
                {scatterFocal.length > 0 && (
                  <Scatter
                    name="Focal"
                    data={scatterFocal}
                    fill="var(--nr-orange)"
                    fillOpacity={1}
                  />
                )}
              </ScatterChart>
            </ResponsiveContainer>

            {/* Legend */}
            <div className="flex items-center gap-4 mt-1">
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full" style={{ background: 'var(--nr-orange)' }} />
                <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>{focalLabel}</span>
              </div>
              {scatterCompare.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-full" style={{ background: '#5B7FA8' }} />
                  <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>{compareLabel}</span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full opacity-35" style={{ background: 'var(--ink-400)' }} />
                <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>Cohort ({scatterCohort.length})</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Range strips ─────────────────────────────────────────────────── */}
      {focal && cohortIncidents.length > 0 && (
        <div className="space-y-3">
          <RangeStrip label="Delay"           focalVal={focalDelay}    compareVal={compareDelay}    sortedVals={sortedDelays}    focalLabel={focalLabel} compareLabel={compareLabel} />
          <RangeStrip label="Incident Duration" focalVal={focalDuration} compareVal={compareDuration} sortedVals={sortedDurations} focalLabel={focalLabel} compareLabel={compareLabel} />
          <RangeStrip label="Mins to Response" focalVal={focalResponse} compareVal={compareResponse} sortedVals={sortedResponses} focalLabel={focalLabel} compareLabel={compareLabel} />
          <RangeStrip label="Mins to Arrival"  focalVal={focalArrival}  compareVal={compareArrival}  sortedVals={sortedArrivals}  focalLabel={focalLabel} compareLabel={compareLabel} />
        </div>
      )}

      {/* ── Profile match ─────────────────────────────────────────────────── */}
      {focal && cohortIncidents.length > 0 && (
        <ProfileBreakdown focal={focal} cohort={cohortIncidents} />
      )}

      {/* ── Similar incidents ─────────────────────────────────────────────── */}
      {focal && similar.length > 0 && (
        <div className="rounded border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
          <div className="px-4 py-2.5 border-b label-micro" style={{ borderColor: 'var(--line)', color: 'var(--nr-orange)' }}>
            Similar Incidents — Same category &amp; area, ordered by delay proximity
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
            {similar.map(i => {
              const isComparing = compareId === i.id
              return (
                <div key={i.id} className="px-4 py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate" style={{ color: 'var(--ink-200)' }}>{i.title || i.location || '—'}</div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px]" style={{ color: 'var(--ink-500)' }}>
                      <span>{i.report_date}</span>
                      {i.ccil && <><span>·</span><span>CCIL {i.ccil}</span></>}
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right mr-2">
                    <div className="numeric-mono text-xs" style={{ color: 'var(--ink-200)' }}>{effectiveDelay(i)}m</div>
                    <div className="text-[9px]" style={{ color: 'var(--ink-500)' }}>delay</div>
                  </div>
                  <div className="flex gap-1.5 flex-shrink-0">
                    <button onClick={() => swapToFocus(i)} className="btn !py-1 !px-2 text-[9px] flex items-center gap-1" title="Make this the focal incident">
                      <Target size={9} /> Focus
                    </button>
                    <button
                      onClick={() => setCompareId(prev => prev === i.id ? null : i.id)}
                      className="btn !py-1 !px-2 text-[9px]"
                      style={{ background: isComparing ? 'var(--nr-orange-glow)' : undefined, borderColor: isComparing ? 'var(--nr-orange)' : undefined, color: isComparing ? 'var(--nr-orange)' : undefined }}
                    >
                      {isComparing ? 'Comparing' : 'Compare'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!focal && (
        <div className="rounded border py-20 flex flex-col items-center gap-3" style={{ borderColor: 'var(--line)', borderStyle: 'dashed' }}>
          <Target size={30} style={{ color: 'var(--ink-500)' }} />
          <div className="text-sm" style={{ color: 'var(--ink-400)' }}>Search for an incident above to begin</div>
          <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>Use a CCIL reference, title, location, or fault number</div>
        </div>
      )}
    </div>
  )
}

// ─── RangeStrip ───────────────────────────────────────────────────────────────
// Shows: full cohort range · IQR box · median tick · focal marker · compare marker
// Answers: "where in the range does this incident sit?"

function RangeStrip({
  label, focalVal, compareVal, sortedVals, focalLabel, compareLabel,
}: {
  label:        string
  focalVal:     number | null
  compareVal:   number | null
  sortedVals:   number[]   // already sorted ascending
  focalLabel:   string
  compareLabel: string
}) {
  if (sortedVals.length < 3 || focalVal == null) {
    return (
      <div className="rounded border px-4 py-3 flex items-center justify-between" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
        <span className="label-micro text-[10px]" style={{ color: 'var(--nr-orange)' }}>{label}</span>
        <span className="text-xs" style={{ color: 'var(--ink-500)' }}>
          {focalVal == null ? 'No data for this incident' : 'Not enough cohort data'}
        </span>
      </div>
    )
  }

  const min = sortedVals[0]
  const max = sortedVals[sortedVals.length - 1]
  const p25 = quantile(sortedVals, 0.25)
  const p50 = quantile(sortedVals, 0.50)
  const p75 = quantile(sortedVals, 0.75)
  const avg = safeAvg(sortedVals)
  const pct = pctileOf(focalVal, sortedVals)

  const range  = max - min || 1
  const pos    = (v: number) => Math.max(0, Math.min(100, ((v - min) / range) * 100))

  const pctColor = pct > 75 ? '#E74C3C' : pct < 25 ? '#27AE60' : 'var(--ink-300)'
  const pctNote  = pct > 75 ? 'above most' : pct < 25 ? 'below most' : 'near median'

  return (
    <div className="rounded border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>

      {/* Header */}
      <div className="px-4 py-2.5 border-b flex items-center gap-4" style={{ borderColor: 'var(--line)' }}>
        <span className="label-micro flex-1" style={{ color: 'var(--nr-orange)' }}>{label}</span>
        {/* Focal value */}
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-4 rounded-sm" style={{ background: 'var(--nr-orange)' }} />
          <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{focalLabel}:</span>
          <span className="numeric-mono text-xs" style={{ color: 'var(--nr-orange)' }}>{fmtMin(focalVal)}</span>
        </div>
        {/* Compare value */}
        {compareVal != null && (
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-4 rounded-sm" style={{ background: '#5B7FA8' }} />
            <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{compareLabel}:</span>
            <span className="numeric-mono text-xs" style={{ color: '#5B7FA8' }}>{fmtMin(compareVal)}</span>
          </div>
        )}
        {/* Avg */}
        <div className="flex items-center gap-1">
          <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>Avg:</span>
          <span className="numeric-mono text-xs" style={{ color: 'var(--ink-400)' }}>{fmtMin(avg)}</span>
        </div>
        {/* Percentile badge */}
        <div className="px-2 py-0.5 rounded-sm text-[9px] font-mono font-bold" style={{ background: `${pctColor}22`, color: pctColor }}>
          {pct}th · {pctNote}
        </div>
      </div>

      {/* Strip */}
      <div className="px-4 py-4">
        <div className="relative h-10">
          {/* Track */}
          <div
            className="absolute top-1/2 left-0 right-0 h-1.5 rounded-full"
            style={{ background: 'var(--line)', transform: 'translateY(-50%)' }}
          />
          {/* IQR box (P25–P75) */}
          <div
            className="absolute top-1/2 h-4 rounded"
            style={{
              left:      `${pos(p25)}%`,
              width:     `${Math.max(0, pos(p75) - pos(p25))}%`,
              background: 'var(--ink-400)',
              opacity:    0.3,
              transform: 'translateY(-50%)',
            }}
          />
          {/* Median tick */}
          <div
            className="absolute top-1/2 w-px h-5"
            style={{ left: `${pos(p50)}%`, background: 'var(--ink-300)', transform: 'translate(-50%, -50%)' }}
          />
          {/* Avg tick (dashed feel — two thin divs) */}
          <div
            className="absolute top-1/2 w-px h-3 opacity-50"
            style={{ left: `${pos(avg)}%`, background: 'var(--ink-400)', transform: 'translate(-50%, -50%)' }}
          />
          {/* Compare marker */}
          {compareVal != null && (
            <div
              className="absolute top-1/2 rounded-sm"
              style={{
                left:      `${pos(compareVal)}%`,
                width:     10,
                height:    22,
                background: '#5B7FA8',
                opacity:    0.85,
                transform: 'translate(-50%, -50%)',
              }}
            />
          )}
          {/* Focal marker */}
          <div
            className="absolute top-1/2 rounded-sm"
            style={{
              left:      `${pos(focalVal)}%`,
              width:     10,
              height:    28,
              background: 'var(--nr-orange)',
              transform: 'translate(-50%, -50%)',
              boxShadow: '0 0 8px var(--nr-orange)',
            }}
          />
        </div>

        {/* Axis labels */}
        <div className="flex items-center mt-2" style={{ position: 'relative' }}>
          <span className="text-[9px] numeric-mono" style={{ color: 'var(--ink-500)' }}>{fmtMin(min)}</span>
          <span
            className="text-[9px] numeric-mono absolute"
            style={{ left: `${pos(p50)}%`, transform: 'translateX(-50%)', color: 'var(--ink-400)' }}
          >
            med {fmtMin(p50)}
          </span>
          <span className="text-[9px] numeric-mono ml-auto" style={{ color: 'var(--ink-500)' }}>{fmtMin(max)}</span>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-5 mt-2.5">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-3 rounded-sm" style={{ background: 'var(--nr-orange)', boxShadow: '0 0 4px var(--nr-orange)' }} />
            <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>{focalLabel}</span>
          </div>
          {compareVal != null && (
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-3 rounded-sm opacity-85" style={{ background: '#5B7FA8' }} />
              <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>{compareLabel}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <div className="w-5 h-2.5 rounded-sm opacity-30" style={{ background: 'var(--ink-400)' }} />
            <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>IQR (P25–P75)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-px h-3" style={{ background: 'var(--ink-300)' }} />
            <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>Median</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── ProfileBreakdown ─────────────────────────────────────────────────────────

function ProfileBreakdown({ focal, cohort }: { focal: IncidentRow; cohort: IncidentRow[] }) {
  if (!cohort.length) return null

  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  const rows: { label: string; value: string; count: number; color?: string }[] = [
    { label: 'Category', value: CATEGORY_CONFIG[focal.category]?.label ?? focal.category, count: cohort.filter(i => i.category === focal.category).length, color: CATEGORY_CONFIG[focal.category]?.color },
    { label: 'Area',     value: focal.area ?? '—',  count: cohort.filter(i => i.area === focal.area).length },
    { label: 'Severity', value: sevLabel(focal.severity), count: cohort.filter(i => i.severity === focal.severity).length, color: SEVERITY_CONFIG[focal.severity]?.color },
  ]

  if (focal.day_of_week != null) {
    rows.push({ label: 'Day of week', value: DOW[focal.day_of_week] ?? `Day ${focal.day_of_week}`, count: cohort.filter(i => i.day_of_week === focal.day_of_week).length })
  }
  if (focal.hour_of_day != null) {
    rows.push({ label: 'Hour (±2h)', value: `${String(focal.hour_of_day).padStart(2, '0')}:00`, count: cohort.filter(i => i.hour_of_day != null && Math.abs(i.hour_of_day - focal.hour_of_day!) <= 2).length })
  }

  return (
    <div className="rounded border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
      <div className="px-4 py-2.5 border-b label-micro" style={{ borderColor: 'var(--line)', color: 'var(--nr-orange)' }}>
        Profile Match — What share of the cohort shares this incident's profile?
      </div>
      <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
        {rows.map(({ label, value, count, color }) => {
          const pct = Math.round((count / cohort.length) * 100)
          return (
            <div key={label} className="px-4 py-3 flex items-center gap-4">
              <div className="w-32 flex-shrink-0">
                <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>{label}</div>
                <div className="text-xs mt-0.5 truncate" style={{ color: color ?? 'var(--ink-200)' }}>{value}</div>
              </div>
              <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color ?? 'var(--nr-orange)', transition: 'width 0.3s' }} />
              </div>
              <div className="w-10 text-right flex-shrink-0">
                <span className="numeric-mono text-xs" style={{ color: 'var(--ink-200)' }}>{pct}%</span>
              </div>
              <div className="w-24 text-right flex-shrink-0">
                <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{count.toLocaleString()} of {cohort.length.toLocaleString()}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
