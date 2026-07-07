'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Pause, Play } from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { DEFAULT_FILTERS } from '@/lib/types'
import {
  fetchAnalytics, deriveKPIs, deriveTrend, deriveLocationHotspots,
  effectiveDelay, nonContinuation, RawData,
} from '@/lib/queries'
import { isSupabaseConfigured } from '@/lib/supabase'
import { generateSyntheticData } from '@/lib/syntheticData'

const REFRESH_MS = 5 * 60 * 1000   // re-fetch every 5 minutes
const CYCLE_MS   = 15 * 1000       // rotate panels every 15 seconds

const PANELS = ['KPIs', 'Trend', 'Hotspots'] as const

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

// ─── Page ────────────────────────────────────────────────────────────────────

export default function WallboardPage() {
  const [data,      setData]      = useState<RawData | null>(null)
  const [synthetic, setSynthetic] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [panel,     setPanel]     = useState(0)
  const [pinned,    setPinned]    = useState(false)

  const load = useCallback(async () => {
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
  }, [])

  // Initial load + 5-minute refresh
  useEffect(() => {
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  // Auto-cycle panels (stops when a dot is pinned)
  useEffect(() => {
    if (pinned) return
    const t = setInterval(() => setPanel(p => (p + 1) % PANELS.length), CYCLE_MS)
    return () => clearInterval(t)
  }, [pinned])

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

  function pinPanel(i: number) {
    if (pinned && panel === i) {
      setPinned(false)          // clicking the pinned dot resumes cycling
    } else {
      setPanel(i)
      setPinned(true)
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg-panel)' }}>

      {/* Header */}
      <header
        className="flex items-center gap-4 px-8 py-5 border-b"
        style={{ borderColor: 'var(--line)' }}
      >
        <span className={`live-dot ${synthetic ? '' : 'animate-pulse-soft'}`}
          style={synthetic ? { background: 'var(--nr-amber)', boxShadow: '0 0 8px var(--nr-amber)' } : {}}
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
        <div className="ml-auto flex items-center gap-6">
          <span className="numeric-mono text-sm" style={{ color: 'var(--ink-400)' }}>
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

            {/* ── Panel 1 — KPI tiles ─────────────────────────────────────── */}
            {panel === 0 && (
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

            {/* ── Panel 2 — 7-day delay trend ─────────────────────────────── */}
            {panel === 1 && (
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
              </div>
            )}

            {/* ── Panel 3 — hotspots & latest ─────────────────────────────── */}
            {panel === 2 && (
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
          {PANELS.map((name, i) => (
            <button
              key={name}
              onClick={() => pinPanel(i)}
              title={pinned && panel === i ? `${name} (pinned — click to resume cycling)` : `Pin ${name}`}
              className="w-3 h-3 rounded-full transition-colors"
              style={{
                background: panel === i ? 'var(--nr-orange)' : 'var(--line-hi)',
                boxShadow: panel === i ? '0 0 8px var(--nr-orange)' : 'none',
              }}
            />
          ))}
          <span className="mx-2 text-xs" style={{ color: 'var(--ink-500)' }}>
            {pinned ? 'pinned' : 'cycling'}
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
