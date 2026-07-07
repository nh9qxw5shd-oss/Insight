'use client'

import { useState, useEffect, useMemo, ReactNode } from 'react'
import { Search, X, Loader2, FileText, Info } from 'lucide-react'
import { IncidentRow, IncidentEvent, CATEGORY_CONFIG } from '@/lib/types'
import { effectiveDelay, fetchIncidentsForRange } from '@/lib/queries'
import { isSupabaseConfigured } from '@/lib/supabase'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtMin(m: number): string {
  // Delay is reported exclusively in minutes across Insight — never hours.
  return `${Math.round(m).toLocaleString()}m`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Safe highlighter — splits on match boundaries and builds React nodes.
// Never feeds user input through dangerouslySetInnerHTML.
function highlight(text: string, terms: string[]): ReactNode {
  if (!text || !terms.length) return text
  const re = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  const parts = text.split(re)
  if (parts.length === 1) return text
  return parts.map((part, idx) =>
    idx % 2 === 1 ? (
      <mark
        key={idx}
        style={{ background: 'var(--nr-orange)', color: '#14100A', borderRadius: 2, padding: '0 1px' }}
      >
        {part}
      </mark>
    ) : (
      <span key={idx}>{part}</span>
    ),
  )
}

// A term matches an incident if it appears in ANY of: title, location, ccil,
// fault_number, or any events[].description. Terms are pre-lowercased.
function termMatchesIncident(i: IncidentRow, term: string): boolean {
  if ((i.title        ?? '').toLowerCase().includes(term)) return true
  if ((i.location     ?? '').toLowerCase().includes(term)) return true
  if ((i.ccil         ?? '').toLowerCase().includes(term)) return true
  if ((i.fault_number ?? '').toLowerCase().includes(term)) return true
  for (const ev of i.events ?? []) {
    if ((ev.description ?? '').toLowerCase().includes(term)) return true
  }
  return false
}

function matchingEvents(i: IncidentRow, terms: string[]): IncidentEvent[] {
  if (!terms.length) return []
  return (i.events ?? []).filter(ev => {
    const d = (ev.description ?? '').toLowerCase()
    return d.length > 0 && terms.some(t => d.includes(t))
  })
}

type RangePreset = 'dashboard' | '30' | '90' | '180' | '365'

const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: '30',        label: '30d' },
  { key: '90',        label: '90d' },
  { key: '180',       label: '180d' },
  { key: '365',       label: '365d' },
  { key: 'dashboard', label: 'Dashboard window' },
]

const DISPLAY_CAP = 100
const COLLAPSED_EVENT_LINES = 3

// ─── SearchTab ───────────────────────────────────────────────────────────────

export function SearchTab({ windowFrom, windowTo, demoMode, fallbackIncidents }: {
  windowFrom: string
  windowTo: string
  demoMode: boolean
  fallbackIncidents: IncidentRow[]
}) {
  const [preset,     setPreset]     = useState<RangePreset>('dashboard')
  const [query,      setQuery]      = useState('')
  const [debounced,  setDebounced]  = useState('')
  const [rows,       setRows]       = useState<IncidentRow[]>([])
  const [loading,    setLoading]    = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const live = isSupabaseConfigured() && !demoMode

  // Resolved search range — dashboard window by default, or an N-day window
  // ending yesterday (logs cover the previous 24 h, so today never has data).
  const range = useMemo(() => {
    if (preset === 'dashboard') return { from: windowFrom, to: windowTo }
    const days   = parseInt(preset, 10)
    const toMs   = Date.now() - 86_400_000
    const fromMs = toMs - (days - 1) * 86_400_000
    return {
      from: new Date(fromMs).toISOString().slice(0, 10),
      to:   new Date(toMs).toISOString().slice(0, 10),
    }
  }, [preset, windowFrom, windowTo])

  // Own data fetch — fetchIncidentsForRange projects the events jsonb, which
  // the dashboard's incident rows do NOT carry.
  useEffect(() => {
    if (!live) {
      setRows(fallbackIncidents)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    fetchIncidentsForRange(range.from, range.to)
      .then(r => { if (!cancelled) setRows(r) })
      .catch(() => { if (!cancelled) setRows([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [live, range.from, range.to, fallbackIncidents])

  // 250 ms debounce on the query
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 250)
    return () => clearTimeout(t)
  }, [query])

  const terms = useMemo(
    () => debounced.toLowerCase().split(/\s+/).filter(Boolean),
    [debounced],
  )

  // AND across terms; a term matches if it appears in ANY field
  const results = useMemo(() => {
    if (!terms.length) return []
    return rows.filter(i => terms.every(t => termMatchesIncident(i, t)))
  }, [rows, terms])

  const shown = results.slice(0, DISPLAY_CAP)

  const totalDelay = useMemo(
    () => results.reduce((s, i) => s + effectiveDelay(i), 0),
    [results],
  )
  const dateSpan = useMemo(() => {
    if (!results.length) return null
    let min = results[0].report_date
    let max = results[0].report_date
    for (const i of results) {
      if (i.report_date < min) min = i.report_date
      if (i.report_date > max) max = i.report_date
    }
    return { min, max }
  }, [results])

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      <div className="card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="serif text-base" style={{ color: 'var(--ink-100)' }}>Full-Text Search</div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-500)' }}>
              Search incident titles, locations, CCIL refs, fault numbers and the CCIL events commentary
            </div>
          </div>

          {/* Range quick-set */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {RANGE_PRESETS.map(p => (
              <button
                key={p.key}
                onClick={() => setPreset(p.key)}
                disabled={!live}
                className={preset === p.key ? 'btn btn-active' : 'btn'}
                style={!live ? { opacity: 0.4, cursor: 'default' } : undefined}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="text-[10px] numeric-mono" style={{ color: 'var(--ink-500)' }}>
          {range.from} → {range.to}
          {loading && (
            <span className="inline-flex items-center gap-1 ml-3" style={{ color: 'var(--nr-orange)' }}>
              <Loader2 size={10} className="animate-spin" /> loading incidents…
            </span>
          )}
          {!loading && <span className="ml-3">{rows.length.toLocaleString()} incidents in range</span>}
        </div>

        {/* Search input */}
        <div
          className="flex items-center gap-3 px-4 py-3 rounded border"
          style={{ background: 'var(--bg-card-hi)', borderColor: query ? 'var(--nr-orange)' : 'var(--line)', transition: 'border-color 0.15s' }}
        >
          <Search size={16} style={{ color: 'var(--ink-400)', flexShrink: 0 }} />
          <input
            autoFocus
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: 'var(--ink-100)' }}
            placeholder="Search incidents and commentary — space-separated terms are ANDed…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button onClick={() => setQuery('')}>
              <X size={13} style={{ color: 'var(--ink-500)' }} />
            </button>
          )}
        </div>

        {!live && (
          <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--nr-amber)' }}>
            <Info size={11} style={{ flexShrink: 0 }} />
            Demo data carries no CCIL events commentary — matching against incident fields only (title, location, CCIL, fault number)
          </div>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="rounded border py-16 flex flex-col items-center gap-3" style={{ borderColor: 'var(--line)', borderStyle: 'dashed' }}>
          <Loader2 size={24} className="animate-spin" style={{ color: 'var(--nr-orange)' }} />
          <div className="text-xs" style={{ color: 'var(--ink-500)' }}>Fetching incidents with events commentary…</div>
        </div>
      )}

      {/* Prompt state — before first search */}
      {!loading && terms.length === 0 && (
        <div className="rounded border py-20 flex flex-col items-center gap-3" style={{ borderColor: 'var(--line)', borderStyle: 'dashed' }}>
          <FileText size={30} style={{ color: 'var(--ink-500)' }} />
          <div className="text-sm" style={{ color: 'var(--ink-400)' }}>Type to search across incidents and the events commentary</div>
          <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>
            e.g. &ldquo;points bedford&rdquo; finds incidents where both terms appear in any field or commentary line
          </div>
        </div>
      )}

      {/* No matches */}
      {!loading && terms.length > 0 && results.length === 0 && (
        <div className="rounded border py-16 flex flex-col items-center gap-2" style={{ borderColor: 'var(--line)', borderStyle: 'dashed' }}>
          <Search size={24} style={{ color: 'var(--ink-500)' }} />
          <div className="text-sm" style={{ color: 'var(--ink-400)' }}>No matches for &ldquo;{debounced.trim()}&rdquo;</div>
          <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>Try fewer terms or widen the date range</div>
        </div>
      )}

      {/* Results */}
      {!loading && results.length > 0 && (
        <div className="space-y-3">

          {/* Summary strip */}
          <div
            className="rounded border px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--line-hi)' }}
          >
            <span>
              <span className="numeric-mono" style={{ color: 'var(--nr-orange)' }}>{results.length.toLocaleString()}</span>
              <span style={{ color: 'var(--ink-400)' }}> incidents matched</span>
            </span>
            <span style={{ color: 'var(--ink-500)' }}>·</span>
            <span>
              <span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{fmtMin(totalDelay)}</span>
              <span style={{ color: 'var(--ink-400)' }}> total delay</span>
            </span>
            {dateSpan && (
              <>
                <span style={{ color: 'var(--ink-500)' }}>·</span>
                <span className="numeric-mono" style={{ color: 'var(--ink-400)' }}>
                  {dateSpan.min} → {dateSpan.max}
                </span>
              </>
            )}
            {results.length > DISPLAY_CAP && (
              <span className="ml-auto text-[10px]" style={{ color: 'var(--ink-500)' }}>
                showing first {DISPLAY_CAP}
              </span>
            )}
          </div>

          {/* Result rows */}
          {shown.map(i => {
            const cfg      = CATEGORY_CONFIG[i.category]
            const evs      = matchingEvents(i, terms)
            const expanded = expandedId === i.id
            const visible  = expanded ? evs : evs.slice(0, COLLAPSED_EVENT_LINES)
            const hidden   = evs.length - COLLAPSED_EVENT_LINES

            return (
              <div
                key={i.id}
                className="card p-4 cursor-pointer"
                onClick={() => setExpandedId(prev => prev === i.id ? null : i.id)}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>{i.report_date}</span>
                      {i.ccil && (
                        <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-400)' }}>
                          CCIL {highlight(i.ccil, terms)}
                        </span>
                      )}
                      <span
                        className="px-1.5 py-0.5 rounded-sm text-[9px] font-mono font-bold"
                        style={{ background: `${cfg?.color}22`, color: cfg?.color, border: `1px solid ${cfg?.color}44` }}
                      >
                        {cfg?.short ?? i.category}
                      </span>
                    </div>
                    <div className="text-sm mt-1" style={{ color: 'var(--ink-100)' }}>
                      {highlight(i.title || i.location || '—', terms)}
                    </div>
                    {i.location && i.title && (
                      <div className="text-[10px] mt-0.5" style={{ color: 'var(--ink-500)' }}>
                        {highlight(i.location, terms)}
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <div className="numeric-mono text-sm" style={{ color: 'var(--ink-200)' }}>{fmtMin(effectiveDelay(i))}</div>
                    <div className="text-[9px]" style={{ color: 'var(--ink-500)' }}>delay</div>
                  </div>
                </div>

                {/* Matching commentary lines */}
                {evs.length > 0 && (
                  <div className="mt-3 pt-2.5 border-t space-y-1.5" style={{ borderColor: 'var(--line)' }}>
                    {visible.map((ev, idx) => (
                      <div key={idx} className="flex items-start gap-2 text-[11px]">
                        <span className="numeric-mono flex-shrink-0" style={{ color: 'var(--ink-500)' }}>
                          {ev.time || '—:—'}
                        </span>
                        <span style={{ color: 'var(--ink-300)' }}>
                          {highlight(ev.description ?? '', terms)}
                        </span>
                      </div>
                    ))}
                    {!expanded && hidden > 0 && (
                      <div className="text-[10px]" style={{ color: 'var(--nr-orange)' }}>
                        +{hidden} more matching line{hidden === 1 ? '' : 's'} — click to expand
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
