'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import {
  Search, X, Target, RotateCcw, ChevronDown, ChevronUp, Users, ArrowRight,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
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

function safePctile(v: number, vals: number[]): number | null {
  if (!vals.length) return null
  return Math.round((vals.filter(x => x < v).length / vals.length) * 100)
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

function buildDist(
  cohortVals: number[],
  focalVal: number,
  n = 10,
): { label: string; count: number; isFocal: boolean }[] {
  const all = [...cohortVals, focalVal]
  const lo  = Math.min(...all)
  const hi  = Math.max(...all)
  if (lo === hi) return [{ label: String(lo), count: cohortVals.length, isFocal: true }]
  const step = (hi - lo) / n
  return Array.from({ length: n }, (_, idx) => {
    const bLo  = lo + idx * step
    const bHi  = bLo + step
    const last = idx === n - 1
    return {
      label:   Math.round(bLo).toString(),
      count:   cohortVals.filter(v => v >= bLo && (last ? v <= bHi : v < bHi)).length,
      isFocal: focalVal  >= bLo && (last ? focalVal <= bHi : focalVal < bHi),
    }
  })
}

// ─── Chart tooltip ────────────────────────────────────────────────────────────

function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div
      className="px-2.5 py-1.5 text-xs rounded border"
      style={{ background: 'var(--bg-card-hi)', borderColor: 'var(--line-hi)', color: 'var(--ink-200)' }}
    >
      <div className="label-micro mb-1" style={{ color: 'var(--ink-400)' }}>{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: p.fill }} />
          <span className="numeric-mono">{p.value}</span>
          <span style={{ color: 'var(--ink-500)' }}>incidents</span>
        </div>
      ))}
    </div>
  )
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

// ─── FocusTab ────────────────────────────────────────────────────────────────

export function FocusTab({ incidents }: { incidents: IncidentRow[] }) {
  const [query,       setQuery]       = useState('')
  const [showDrop,    setShowDrop]    = useState(false)
  const [focalId,     setFocalId]     = useState<string | null>(null)
  const [compareId,   setCompareId]   = useState<string | null>(null)
  const [cohort,      setCohort]      = useState<CohortFilters>(EMPTY_COHORT)
  const [showFilters, setShowFilters] = useState(false)

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

  // Search candidates
  const candidates = useMemo(() => {
    if (!query.trim()) return []
    return incidents.filter(i => searchMatch(i, query.trim())).slice(0, 15)
  }, [incidents, query])

  // Cohort — everything except focal + compare, with optional filters
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

  // Metric value arrays from cohort
  const cohortDelays    = useMemo(() => cohortIncidents.map(effectiveDelay).filter(v => v > 0), [cohortIncidents])
  const cohortDurations = useMemo(() => cohortIncidents.map(i => i.incident_duration ?? 0).filter(v => v > 0), [cohortIncidents])
  const cohortResponses = useMemo(() => cohortIncidents.map(i => i.mins_to_response  ?? 0).filter(v => v > 0), [cohortIncidents])
  const cohortArrivals  = useMemo(() => cohortIncidents.map(i => effectiveMinsToArrival(i) ?? 0).filter(v => v > 0), [cohortIncidents])

  const focalDelay    = focal ? effectiveDelay(focal) : null
  const focalDuration = focal?.incident_duration ?? null
  const focalResponse = focal?.mins_to_response  ?? null
  const focalArrival  = focal ? effectiveMinsToArrival(focal) : null

  const compareDelay    = compare ? effectiveDelay(compare)           : null
  const compareDuration = compare?.incident_duration                   ?? null
  const compareResponse = compare?.mins_to_response                    ?? null
  const compareArrival  = compare ? effectiveMinsToArrival(compare)   : null

  // Distribution data per metric
  const delayDist    = useMemo(() => focalDelay    != null && cohortDelays.length    > 1 ? buildDist(cohortDelays,    focalDelay)    : [], [focalDelay,    cohortDelays])
  const durationDist = useMemo(() => focalDuration != null && cohortDurations.length > 1 ? buildDist(cohortDurations, focalDuration) : [], [focalDuration, cohortDurations])
  const responseDist = useMemo(() => focalResponse != null && cohortResponses.length > 1 ? buildDist(cohortResponses, focalResponse) : [], [focalResponse, cohortResponses])
  const arrivalDist  = useMemo(() => focalArrival  != null && cohortArrivals.length  > 1 ? buildDist(cohortArrivals,  focalArrival)  : [], [focalArrival,  cohortArrivals])

  // Similar incidents — same category + area, ordered by delay proximity
  const similar = useMemo(() => {
    if (!focal) return []
    return cohortIncidents
      .filter(i => i.category === focal.category && i.area === focal.area)
      .sort((a, b) =>
        Math.abs(effectiveDelay(a) - (focalDelay ?? 0)) -
        Math.abs(effectiveDelay(b) - (focalDelay ?? 0))
      )
      .slice(0, 8)
  }, [focal, cohortIncidents, focalDelay])

  // Option lists for manual cohort filters
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

  function toggleCompare(i: IncidentRow) {
    setCompareId(prev => prev === i.id ? null : i.id)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* Page heading */}
      <div className="flex items-center gap-3">
        <Target size={15} style={{ color: 'var(--nr-orange)', flexShrink: 0 }} />
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--ink-100)' }}>Incident Focus</div>
          <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>
            Select an incident by CCIL ref, title, or location to compare it against the loaded cohort
          </div>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative" ref={dropRef}>
        <div
          className="flex items-center gap-2 px-3 py-2 rounded border"
          style={{
            background: 'var(--bg-card)',
            borderColor: showDrop && query ? 'var(--nr-orange)' : 'var(--line)',
            transition: 'border-color 0.15s',
          }}
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
          {query && (
            <button onClick={() => { setQuery(''); setShowDrop(false) }}>
              <X size={12} style={{ color: 'var(--ink-500)' }} />
            </button>
          )}
        </div>

        {/* Dropdown results */}
        {showDrop && query.trim() && (
          <div
            className="absolute z-30 w-full mt-1 rounded border shadow-xl overflow-hidden"
            style={{ background: 'var(--bg-card-hi)', borderColor: 'var(--line-hi)' }}
          >
            {candidates.length === 0 ? (
              <div className="px-4 py-3 text-xs" style={{ color: 'var(--ink-500)' }}>
                No incidents found in the current window — adjust the global date range if needed
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
                        <div className="text-xs truncate" style={{ color: 'var(--ink-100)' }}>
                          {i.title || i.location || '—'}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-[10px]" style={{ color: 'var(--ink-500)' }}>
                          <span>{i.report_date}</span>
                          {i.ccil && <><span>·</span><span>CCIL {i.ccil}</span></>}
                          {i.area && <><span>·</span><span>{i.area}</span></>}
                        </div>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <div className="numeric-mono text-xs" style={{ color: 'var(--ink-200)' }}>
                          {effectiveDelay(i)}m
                        </div>
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

      {/* Focal incident card */}
      {focal && (() => {
        const cfg    = CATEGORY_CONFIG[focal.category]
        const sevCfg = SEVERITY_CONFIG[focal.severity]
        return (
          <div
            className="rounded border overflow-hidden"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--line)', borderLeftColor: cfg?.color, borderLeftWidth: 3 }}
          >
            {/* Header row */}
            <div className="px-4 py-3 flex items-start gap-3">
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  {focal.ccil && (
                    <span
                      className="px-1.5 py-0.5 rounded-sm text-[9px] font-mono font-bold"
                      style={{ background: 'var(--nr-orange-glow)', color: 'var(--nr-orange)', border: '1px solid var(--line-glow)' }}
                    >
                      CCIL {focal.ccil}
                    </span>
                  )}
                  <span
                    className="px-1.5 py-0.5 rounded-sm text-[9px] font-mono font-bold"
                    style={{ background: `${cfg?.color}22`, color: cfg?.color }}
                  >
                    {cfg?.label ?? focal.category}
                  </span>
                  <span
                    className="px-1.5 py-0.5 rounded-sm text-[9px] font-mono font-bold"
                    style={{ background: `${sevCfg?.color}22`, color: sevCfg?.color }}
                  >
                    {sevLabel(focal.severity)}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{focal.report_date}</span>
                  {focal.area && <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{focal.area}</span>}
                </div>
                <div className="text-sm font-medium" style={{ color: 'var(--ink-100)' }}>
                  {focal.title || focal.location || '—'}
                </div>
                {focal.location && focal.title && (
                  <div className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{focal.location}</div>
                )}
              </div>
              <button onClick={clearFocal} className="btn !py-1 !px-2 flex-shrink-0 flex items-center gap-1">
                <X size={10} /> Clear
              </button>
            </div>

            {/* Quick stats strip */}
            <div
              className="grid grid-cols-2 sm:grid-cols-4 border-t divide-x"
              style={{ borderColor: 'var(--line)' }}
            >
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
          <button
            onClick={() => setShowFilters(f => !f)}
            className="w-full px-4 py-2.5 flex items-center justify-between"
          >
            <div className="flex items-center gap-2">
              <Users size={13} style={{ color: hasActiveCohortFilters ? 'var(--nr-orange)' : 'var(--ink-400)' }} />
              <span
                className="label-micro"
                style={{ color: hasActiveCohortFilters ? 'var(--nr-orange)' : 'var(--ink-400)' }}
              >
                Cohort — {cohortIncidents.length.toLocaleString()} incidents
              </span>
              {hasActiveCohortFilters && (
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--nr-orange)' }} />
              )}
            </div>
            <div className="flex items-center gap-3">
              {hasActiveCohortFilters && (
                <button
                  onClick={e => { e.stopPropagation(); setCohort(EMPTY_COHORT) }}
                  className="flex items-center gap-1 text-[10px]"
                  style={{ color: 'var(--ink-500)' }}
                >
                  <RotateCcw size={9} /> Reset
                </button>
              )}
              {showFilters
                ? <ChevronUp  size={12} style={{ color: 'var(--ink-500)' }} />
                : <ChevronDown size={12} style={{ color: 'var(--ink-500)' }} />
              }
            </div>
          </button>

          {showFilters && (
            <div className="px-4 pb-4 pt-3 border-t space-y-4" style={{ borderColor: 'var(--line)' }}>

              {/* Quick presets */}
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
                      style={{
                        background:   cohort[key] ? 'var(--nr-orange-glow)' : 'transparent',
                        borderColor:  cohort[key] ? 'var(--nr-orange)'      : 'var(--line)',
                        color:        cohort[key] ? 'var(--nr-orange)'      : 'var(--ink-400)',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Category filter */}
              <div>
                <div className="label-micro text-[9px] mb-2" style={{ color: 'var(--ink-500)' }}>FILTER COHORT BY CATEGORY</div>
                <div className="flex flex-wrap gap-1.5">
                  {catOptions.map(cat => {
                    const cfg    = CATEGORY_CONFIG[cat]
                    const active = cohort.categories.includes(cat)
                    return (
                      <button
                        key={cat}
                        onClick={() => setCohort(c => ({
                          ...c,
                          categories: active ? c.categories.filter(x => x !== cat) : [...c.categories, cat],
                        }))}
                        className="px-2 py-0.5 rounded-sm text-[9px] font-mono border transition-colors"
                        style={{
                          background:  active ? `${cfg?.color}22` : 'transparent',
                          borderColor: active ?  cfg?.color       : 'var(--line)',
                          color:       active ?  cfg?.color       : 'var(--ink-500)',
                        }}
                      >
                        {cfg?.label ?? cat}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Severity filter */}
              <div>
                <div className="label-micro text-[9px] mb-2" style={{ color: 'var(--ink-500)' }}>FILTER COHORT BY SEVERITY</div>
                <div className="flex flex-wrap gap-1.5">
                  {SEV_ORDER.map(sev => {
                    const cfg    = SEVERITY_CONFIG[sev]
                    const active = cohort.severities.includes(sev)
                    return (
                      <button
                        key={sev}
                        onClick={() => setCohort(c => ({
                          ...c,
                          severities: active ? c.severities.filter(x => x !== sev) : [...c.severities, sev],
                        }))}
                        className="px-2 py-0.5 rounded-sm text-[9px] font-mono border transition-colors"
                        style={{
                          background:  active ? `${cfg.color}22` : 'transparent',
                          borderColor: active ?  cfg.color       : 'var(--line)',
                          color:       active ?  cfg.color       : 'var(--ink-500)',
                        }}
                      >
                        {sevLabel(sev)}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Area filter */}
              <div>
                <div className="label-micro text-[9px] mb-2" style={{ color: 'var(--ink-500)' }}>FILTER COHORT BY AREA</div>
                <div className="flex flex-wrap gap-1.5">
                  {areaOptions.map(area => {
                    const active = cohort.areas.includes(area)
                    return (
                      <button
                        key={area}
                        onClick={() => setCohort(c => ({
                          ...c,
                          areas: active ? c.areas.filter(x => x !== area) : [...c.areas, area],
                        }))}
                        className="px-2 py-0.5 rounded-sm text-[9px] border transition-colors"
                        style={{
                          background:  active ? 'var(--nr-orange-glow)' : 'transparent',
                          borderColor: active ? 'var(--nr-orange)'      : 'var(--line)',
                          color:       active ? 'var(--nr-orange)'      : 'var(--ink-500)',
                        }}
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

      {/* Compare banner (when a comparison incident is active) */}
      {compare && (
        <div
          className="rounded border px-4 py-2.5 flex items-center gap-3"
          style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}
        >
          <ArrowRight size={13} style={{ color: 'var(--ink-400)', flexShrink: 0 }} />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate" style={{ color: 'var(--ink-200)' }}>
              Comparing: {compare.title || compare.location || '—'}
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[10px]" style={{ color: 'var(--ink-500)' }}>
              <span>{compare.report_date}</span>
              {compare.ccil && <><span>·</span><span>CCIL {compare.ccil}</span></>}
              <span>·</span>
              <span>{effectiveDelay(compare)}m delay</span>
            </div>
          </div>
          <button
            onClick={() => setCompareId(null)}
            className="btn !py-1 !px-2 flex-shrink-0 flex items-center gap-1"
          >
            <X size={10} /> Remove
          </button>
        </div>
      )}

      {/* Metric panels — 2×2 grid */}
      {focal && cohortIncidents.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <MetricPanel
            label="Delay"
            noDataNote="No delay recorded"
            focalVal={focalDelay}
            compareVal={compareDelay}
            cohortVals={cohortDelays}
            dist={delayDist}
            focalLabel={focalLabel}
            compareLabel={compareLabel}
          />
          <MetricPanel
            label="Incident Duration"
            noDataNote="No duration captured"
            focalVal={focalDuration}
            compareVal={compareDuration}
            cohortVals={cohortDurations}
            dist={durationDist}
            focalLabel={focalLabel}
            compareLabel={compareLabel}
          />
          <MetricPanel
            label="Mins to Response"
            noDataNote="No response time captured"
            focalVal={focalResponse}
            compareVal={compareResponse}
            cohortVals={cohortResponses}
            dist={responseDist}
            focalLabel={focalLabel}
            compareLabel={compareLabel}
          />
          <MetricPanel
            label="Mins to Arrival"
            noDataNote="No arrival time captured"
            focalVal={focalArrival}
            compareVal={compareArrival}
            cohortVals={cohortArrivals}
            dist={arrivalDist}
            focalLabel={focalLabel}
            compareLabel={compareLabel}
          />
        </div>
      )}

      {/* Profile breakdown */}
      {focal && cohortIncidents.length > 0 && (
        <ProfileBreakdown focal={focal} cohort={cohortIncidents} />
      )}

      {/* Similar incidents */}
      {focal && similar.length > 0 && (
        <div className="rounded border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
          <div
            className="px-4 py-2.5 border-b label-micro"
            style={{ borderColor: 'var(--line)', color: 'var(--nr-orange)' }}
          >
            Similar Incidents — Same category &amp; area, ordered by delay proximity
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
            {similar.map(i => {
              const isComparing = compareId === i.id
              return (
                <div key={i.id} className="px-4 py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate" style={{ color: 'var(--ink-200)' }}>
                      {i.title || i.location || '—'}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px]" style={{ color: 'var(--ink-500)' }}>
                      <span>{i.report_date}</span>
                      {i.ccil && <><span>·</span><span>CCIL {i.ccil}</span></>}
                      {i.location && i.title && <><span>·</span><span>{i.location}</span></>}
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right mr-2">
                    <div className="numeric-mono text-xs" style={{ color: 'var(--ink-200)' }}>{effectiveDelay(i)}m</div>
                    <div className="text-[9px]" style={{ color: 'var(--ink-500)' }}>delay</div>
                  </div>
                  <div className="flex gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => swapToFocus(i)}
                      className="btn !py-1 !px-2 text-[9px] flex items-center gap-1"
                      title="Make this the focal incident"
                    >
                      <Target size={9} /> Focus
                    </button>
                    <button
                      onClick={() => toggleCompare(i)}
                      className="btn !py-1 !px-2 text-[9px]"
                      style={{
                        background:  isComparing ? 'var(--nr-orange-glow)' : undefined,
                        borderColor: isComparing ? 'var(--nr-orange)'      : undefined,
                        color:       isComparing ? 'var(--nr-orange)'      : undefined,
                      }}
                      title="Overlay this incident on the metric charts"
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
        <div
          className="rounded border py-20 flex flex-col items-center gap-3"
          style={{ borderColor: 'var(--line)', borderStyle: 'dashed' }}
        >
          <Target size={30} style={{ color: 'var(--ink-500)' }} />
          <div className="text-sm" style={{ color: 'var(--ink-400)' }}>Search for an incident above to begin</div>
          <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>
            Use a CCIL reference, title, location, or fault number
          </div>
        </div>
      )}
    </div>
  )
}

// ─── MetricPanel ──────────────────────────────────────────────────────────────

interface MetricPanelProps {
  label:        string
  noDataNote:   string
  focalVal:     number | null
  compareVal:   number | null
  cohortVals:   number[]
  dist:         { label: string; count: number; isFocal: boolean }[]
  focalLabel:   string
  compareLabel: string
}

function MetricPanel({
  label, noDataNote, focalVal, compareVal, cohortVals, dist, focalLabel, compareLabel,
}: MetricPanelProps) {
  const cohortAvg = safeAvg(cohortVals)
  const pct       = focalVal != null ? safePctile(focalVal, cohortVals) : null

  if (focalVal == null) {
    return (
      <div
        className="rounded border flex items-center justify-center py-10"
        style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}
      >
        <div className="text-xs" style={{ color: 'var(--ink-500)' }}>{noDataNote}</div>
      </div>
    )
  }

  const pctColor =
    pct == null       ? 'var(--ink-200)' :
    pct > 75          ? '#E74C3C' :
    pct < 25          ? '#27AE60' :
                        'var(--ink-200)'

  const pctNote =
    pct == null ? undefined :
    pct > 75    ? 'above most'  :
    pct < 25    ? 'below most'  :
                  'near median'

  return (
    <div className="rounded border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>

      {/* Section label */}
      <div
        className="px-4 py-2 border-b label-micro"
        style={{ borderColor: 'var(--line)', color: 'var(--nr-orange)' }}
      >
        {label}
      </div>

      {/* Stat trio */}
      <div className="grid grid-cols-3 divide-x" style={{ borderColor: 'var(--line)' }}>
        <StatCell label={focalLabel}    value={fmtMin(focalVal)}  accent="var(--nr-orange)" />
        <StatCell label="Cohort avg"    value={fmtMin(cohortAvg)}  />
        <StatCell label="Percentile"    value={pct != null ? `${pct}th` : '—'} accent={pctColor} sub={pctNote} />
      </div>

      {/* Compare row */}
      {compareVal != null && (
        <div
          className="px-4 py-2 border-t flex items-center gap-3"
          style={{ borderColor: 'var(--line)' }}
        >
          <span className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>{compareLabel}</span>
          <span className="numeric-mono text-xs" style={{ color: 'var(--ink-200)' }}>{fmtMin(compareVal)}</span>
          {focalVal != null && (
            <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>
              {compareVal > focalVal
                ? `+${Math.round(compareVal - focalVal)}m vs focal`
                : `-${Math.round(focalVal - compareVal)}m vs focal`
              }
            </span>
          )}
        </div>
      )}

      {/* Distribution chart */}
      {dist.length > 0 && (
        <div className="px-4 pb-4 pt-3 border-t space-y-2" style={{ borderColor: 'var(--line)' }}>
          <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>
            DISTRIBUTION — cohort ({cohortVals.length}) · focal highlighted
          </div>
          <ResponsiveContainer width="100%" height={72}>
            <BarChart data={dist} barSize={8} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 8, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis hide />
              <Tooltip content={<ChartTip />} />
              <Bar dataKey="count" name="Incidents" radius={[2, 2, 0, 0]}>
                {dist.map((d, i) => (
                  <Cell
                    key={i}
                    fill={d.isFocal ? 'var(--nr-orange)' : 'var(--ink-500)'}
                    opacity={d.isFocal ? 1 : 0.45}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-sm" style={{ background: 'var(--nr-orange)' }} />
              <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>Focal incident</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-sm opacity-50" style={{ background: 'var(--ink-500)' }} />
              <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>Cohort</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatCell({
  label, value, accent, sub,
}: { label: string; value: string; accent?: string; sub?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>{label}</div>
      <div className="numeric-mono text-lg font-light leading-none mt-1" style={{ color: accent ?? 'var(--ink-200)' }}>
        {value}
      </div>
      {sub && <div className="text-[9px] mt-0.5" style={{ color: 'var(--ink-500)' }}>{sub}</div>}
    </div>
  )
}

// ─── ProfileBreakdown ────────────────────────────────────────────────────────

function ProfileBreakdown({ focal, cohort }: { focal: IncidentRow; cohort: IncidentRow[] }) {
  if (!cohort.length) return null

  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  const rows: { label: string; value: string; count: number; color?: string }[] = [
    {
      label: 'Category',
      value: CATEGORY_CONFIG[focal.category]?.label ?? focal.category,
      count: cohort.filter(i => i.category === focal.category).length,
      color: CATEGORY_CONFIG[focal.category]?.color,
    },
    {
      label: 'Area',
      value: focal.area ?? '—',
      count: cohort.filter(i => i.area === focal.area).length,
    },
    {
      label: 'Severity',
      value: sevLabel(focal.severity),
      count: cohort.filter(i => i.severity === focal.severity).length,
      color: SEVERITY_CONFIG[focal.severity]?.color,
    },
  ]

  if (focal.day_of_week != null) {
    rows.push({
      label: 'Day of week',
      value: DOW[focal.day_of_week] ?? `Day ${focal.day_of_week}`,
      count: cohort.filter(i => i.day_of_week === focal.day_of_week).length,
    })
  }

  if (focal.hour_of_day != null) {
    rows.push({
      label: 'Hour (±2h window)',
      value: `${String(focal.hour_of_day).padStart(2, '0')}:00`,
      count: cohort.filter(i => i.hour_of_day != null && Math.abs(i.hour_of_day - focal.hour_of_day!) <= 2).length,
    })
  }

  return (
    <div className="rounded border overflow-hidden" style={{ background: 'var(--bg-card)', borderColor: 'var(--line)' }}>
      <div
        className="px-4 py-2.5 border-b label-micro"
        style={{ borderColor: 'var(--line)', color: 'var(--nr-orange)' }}
      >
        Profile Match — How common is this incident's profile in the cohort?
      </div>
      <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
        {rows.map(({ label, value, count, color }) => {
          const pct = Math.round((count / cohort.length) * 100)
          return (
            <div key={label} className="px-4 py-3 flex items-center gap-4">
              <div className="w-36 flex-shrink-0">
                <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>{label}</div>
                <div className="text-xs mt-0.5 truncate" style={{ color: color ?? 'var(--ink-200)' }}>{value}</div>
              </div>
              <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
                <div
                  className="h-full rounded-full"
                  style={{ width: `${pct}%`, background: color ?? 'var(--nr-orange)', transition: 'width 0.3s' }}
                />
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
