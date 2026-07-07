'use client'

import { useState, useMemo } from 'react'
import { CalendarDays, Clock, List } from 'lucide-react'
import { IncidentRow, CATEGORY_CONFIG } from '@/lib/types'
import { effectiveDelay, nonContinuation } from '@/lib/queries'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtMin(m: number): string {
  // Delay is reported exclusively in minutes across Insight — never hours.
  return `${Math.round(m).toLocaleString()}m`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// Parse "HH:MM" → minutes since midnight; null if absent or malformed.
function startMins(t: string | null): number | null {
  if (!t) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim())
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  if (h > 23 || mm > 59) return null
  return h * 60 + mm
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAY_HEADS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

const MAX_MONTHS      = 13
const UNKNOWN_DUR_MIN = 20    // visual stub for null-duration bars
const LANE_LABEL_W    = 128
const HOUR_STEP       = 3

type HeatMetric = 'delay' | 'incidents'

interface DayAgg { delay: number; count: number }

// ─── CalendarTab ─────────────────────────────────────────────────────────────

export function CalendarTab({ incidents, windowFrom, windowTo, onDrillDown }: {
  incidents: IncidentRow[]
  windowFrom: string
  windowTo: string
  onDrillDown: (v: { title: string; incidents: IncidentRow[] }) => void
}) {
  const [metric,      setMetric]      = useState<HeatMetric>('delay')
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  // Per-day aggregates: delay from every row (effectiveDelay is
  // continuation-aware), counts from non-continuation rows only.
  const dayMap = useMemo(() => {
    const m = new Map<string, DayAgg>()
    for (const i of incidents) {
      const agg = m.get(i.report_date) ?? { delay: 0, count: 0 }
      agg.delay += effectiveDelay(i)
      if (!i.is_continuation) agg.count += 1
      m.set(i.report_date, agg)
    }
    return m
  }, [incidents])

  // Months covering the window, capped at MAX_MONTHS
  const { months, truncated } = useMemo(() => {
    const start = new Date(windowFrom + 'T00:00:00Z')
    const end   = new Date(windowTo   + 'T00:00:00Z')
    const out: { year: number; month: number }[] = []
    let y = start.getUTCFullYear()
    let m = start.getUTCMonth()
    const endY = end.getUTCFullYear()
    const endM = end.getUTCMonth()
    while ((y < endY || (y === endY && m <= endM)) && out.length <= MAX_MONTHS) {
      out.push({ year: y, month: m })
      m += 1
      if (m === 12) { m = 0; y += 1 }
    }
    return { months: out.slice(0, MAX_MONTHS), truncated: out.length > MAX_MONTHS }
  }, [windowFrom, windowTo])

  // Window max for the selected metric — drives cell intensity
  const maxVal = useMemo(() => {
    let max = 0
    for (const [d, agg] of dayMap.entries()) {
      if (d < windowFrom || d > windowTo) continue
      const v = metric === 'delay' ? agg.delay : agg.count
      if (v > max) max = v
    }
    return max
  }, [dayMap, metric, windowFrom, windowTo])

  // Default selected day: the max-delay day in the window
  const defaultDay = useMemo(() => {
    let best: string | null = null
    let bestDelay = -1
    for (const [d, agg] of dayMap.entries()) {
      if (d < windowFrom || d > windowTo) continue
      if (agg.delay > bestDelay) { bestDelay = agg.delay; best = d }
    }
    return best
  }, [dayMap, windowFrom, windowTo])

  const day = selectedDay ?? defaultDay

  // ── Day timeline data ───────────────────────────────────────────────────────

  const dayRows = useMemo(
    () => (day ? incidents.filter(i => i.report_date === day) : []),
    [incidents, day],
  )

  const placed   = useMemo(() => dayRows.filter(i => startMins(i.incident_start) != null), [dayRows])
  const unplaced = useMemo(() => dayRows.filter(i => startMins(i.incident_start) == null), [dayRows])

  // One lane per area, sorted by that day's delay desc; null area → "No area"
  const lanes = useMemo(() => {
    const byArea = new Map<string, { area: string; rows: IncidentRow[]; delay: number }>()
    for (const i of placed) {
      const key = i.area?.trim() || 'No area'
      const lane = byArea.get(key) ?? { area: key, rows: [], delay: 0 }
      lane.rows.push(i)
      lane.delay += effectiveDelay(i)
      byArea.set(key, lane)
    }
    return Array.from(byArea.values()).sort((a, b) => b.delay - a.delay)
  }, [placed])

  const dayDelay  = useMemo(() => dayRows.reduce((s, i) => s + effectiveDelay(i), 0), [dayRows])
  const dayCount  = useMemo(() => nonContinuation(dayRows).length, [dayRows])
  const worst     = useMemo(() => {
    let top: IncidentRow | null = null
    for (const i of dayRows) {
      if (!top || effectiveDelay(i) > effectiveDelay(top)) top = i
    }
    return top
  }, [dayRows])

  function drillIncident(i: IncidentRow) {
    const chain = i.ccil ? incidents.filter(x => x.ccil === i.ccil) : [i]
    onDrillDown({
      title: i.ccil ? `CCIL ${i.ccil}` : (i.title || i.location || 'Incident'),
      incidents: chain,
    })
  }

  const hourMarks = useMemo(() => {
    const out: number[] = []
    for (let h = 0; h <= 24; h += HOUR_STEP) out.push(h)
    return out
  }, [])

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* ── Calendar heat ─────────────────────────────────────────────────── */}
      <div className="card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <CalendarDays size={15} style={{ color: 'var(--nr-orange)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div className="serif text-base" style={{ color: 'var(--ink-100)' }}>Calendar Heat</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-500)' }}>
                Daily intensity across the window — click a day to open its timeline below
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {([
              { key: 'delay'     as const, label: 'Delay' },
              { key: 'incidents' as const, label: 'Incidents' },
            ]).map(o => (
              <button
                key={o.key}
                onClick={() => setMetric(o.key)}
                className={metric === o.key ? 'btn btn-active' : 'btn'}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {truncated && (
          <div className="text-[10px]" style={{ color: 'var(--nr-amber)' }}>
            Window spans more than {MAX_MONTHS} months — showing the first {MAX_MONTHS}
          </div>
        )}

        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
          {months.map(({ year, month }) => (
            <MonthGrid
              key={`${year}-${month}`}
              year={year}
              month={month}
              windowFrom={windowFrom}
              windowTo={windowTo}
              dayMap={dayMap}
              metric={metric}
              maxVal={maxVal}
              selected={day}
              onSelect={setSelectedDay}
            />
          ))}
        </div>
      </div>

      {/* ── Day timeline (swimlane) ───────────────────────────────────────── */}
      <div className="card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <Clock size={15} style={{ color: 'var(--nr-orange)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div className="serif text-base" style={{ color: 'var(--ink-100)' }}>
                Day Timeline{day ? ` — ${day}` : ''}
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-500)' }}>
                Incidents as bars on a 00:00–24:00 axis, one lane per area — dashed bars have unknown duration
              </div>
            </div>
          </div>

          {day && dayRows.length > 0 && (
            <button
              className="btn flex items-center gap-1.5"
              onClick={() => onDrillDown({ title: `Day — ${day}`, incidents: dayRows })}
            >
              <List size={11} /> View incidents
            </button>
          )}
        </div>

        {(!day || dayRows.length === 0) ? (
          <div className="rounded border py-14 flex flex-col items-center gap-2" style={{ borderColor: 'var(--line)', borderStyle: 'dashed' }}>
            <Clock size={24} style={{ color: 'var(--ink-500)' }} />
            <div className="text-sm" style={{ color: 'var(--ink-400)' }}>
              {day ? 'No incidents on this day' : 'No incidents in the current window'}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>Pick a day on the calendar above</div>
          </div>
        ) : (
          <>
            {/* Day summary */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Incidents</div>
                <div className="numeric-mono text-base font-light mt-0.5" style={{ color: 'var(--ink-100)' }}>{dayCount}</div>
              </div>
              <div>
                <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Total Delay</div>
                <div className="numeric-mono text-base font-light mt-0.5" style={{ color: 'var(--nr-orange)' }}>{fmtMin(dayDelay)}</div>
              </div>
              {worst && (
                <div className="min-w-0 max-w-md">
                  <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Worst Incident</div>
                  <div className="text-xs mt-1 truncate" style={{ color: 'var(--ink-200)' }}>
                    {worst.title || worst.location || '—'}
                    <span className="numeric-mono ml-2" style={{ color: 'var(--ink-500)' }}>{fmtMin(effectiveDelay(worst))}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Swimlane */}
            <div className="overflow-x-auto">
              <div style={{ minWidth: 680 }}>

                {/* Hour labels */}
                <div className="flex">
                  <div style={{ width: LANE_LABEL_W, flexShrink: 0 }} />
                  <div className="relative flex-1 h-5">
                    {hourMarks.map(h => (
                      <span
                        key={h}
                        className="absolute numeric-mono text-[9px]"
                        style={{
                          left: `${(h / 24) * 100}%`,
                          transform: h === 0 ? 'none' : h === 24 ? 'translateX(-100%)' : 'translateX(-50%)',
                          color: 'var(--ink-500)',
                        }}
                      >
                        {pad2(h % 24)}:00
                      </span>
                    ))}
                  </div>
                </div>

                {/* Lanes */}
                <div className="border rounded" style={{ borderColor: 'var(--line)' }}>
                  {lanes.map((lane, laneIdx) => (
                    <div
                      key={lane.area}
                      className="flex items-stretch"
                      style={laneIdx > 0 ? { borderTop: '1px solid var(--line)' } : undefined}
                    >
                      <div
                        className="px-3 py-2 flex-shrink-0"
                        style={{ width: LANE_LABEL_W, borderRight: '1px solid var(--line)' }}
                      >
                        <div className="text-[10px] truncate" style={{ color: 'var(--ink-300)' }}>{lane.area}</div>
                        <div className="numeric-mono text-[9px] mt-0.5" style={{ color: 'var(--ink-500)' }}>{fmtMin(lane.delay)}</div>
                      </div>

                      <div className="relative flex-1" style={{ minHeight: 40 }}>
                        {/* Hour gridlines */}
                        {hourMarks.filter(h => h > 0 && h < 24).map(h => (
                          <div
                            key={h}
                            className="absolute top-0 bottom-0"
                            style={{ left: `${(h / 24) * 100}%`, width: 1, background: 'var(--line)', opacity: 0.6 }}
                          />
                        ))}

                        {/* Bars */}
                        {lane.rows.map(i => {
                          const s = startMins(i.incident_start) as number
                          const dur = i.incident_duration != null && i.incident_duration > 0 ? i.incident_duration : null
                          const visMins = Math.min(dur ?? UNKNOWN_DUR_MIN, 1440 - s)
                          const cfg = CATEGORY_CONFIG[i.category]
                          const color = cfg?.color ?? 'var(--nr-blue)'
                          return (
                            <button
                              key={i.id}
                              onClick={() => drillIncident(i)}
                              className="absolute top-1/2 rounded-sm"
                              title={`${i.incident_start} · ${i.title || i.location || '—'} · ${fmtMin(effectiveDelay(i))} delay · ${dur != null ? `${fmtMin(dur)} duration` : 'unknown duration'}`}
                              style={{
                                left:      `${(s / 1440) * 100}%`,
                                width:     `${(visMins / 1440) * 100}%`,
                                minWidth:  6,
                                height:    16,
                                transform: 'translateY(-50%)',
                                background: dur != null ? color : `${color}55`,
                                border:     dur != null ? `1px solid ${color}` : `1px dashed ${color}`,
                              }}
                            />
                          )
                        })}
                      </div>
                    </div>
                  ))}

                  {lanes.length === 0 && (
                    <div className="px-4 py-6 text-xs" style={{ color: 'var(--ink-500)' }}>
                      No incidents on this day carry a start time — see the unplaced list below
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Unplaced incidents — no incident_start */}
            {unplaced.length > 0 && (
              <div>
                <div className="label-micro text-[9px] mb-2" style={{ color: 'var(--ink-500)' }}>
                  NO START TIME — {unplaced.length} INCIDENT{unplaced.length === 1 ? '' : 'S'}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {unplaced.map(i => {
                    const cfg = CATEGORY_CONFIG[i.category]
                    return (
                      <button
                        key={i.id}
                        onClick={() => drillIncident(i)}
                        className="pill flex items-center gap-1.5 max-w-[280px]"
                        title={`${i.title || i.location || '—'} · ${fmtMin(effectiveDelay(i))} delay`}
                      >
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: cfg?.color }} />
                        <span className="truncate text-[10px]" style={{ color: 'var(--ink-300)' }}>
                          {i.title || i.location || '—'}
                        </span>
                        <span className="numeric-mono text-[9px] flex-shrink-0" style={{ color: 'var(--ink-500)' }}>
                          {fmtMin(effectiveDelay(i))}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── MonthGrid ────────────────────────────────────────────────────────────────
// One month, Monday-first columns (Mon..Sun). Cells outside the window are
// dimmed and non-clickable; intensity is value ÷ window max in orange.

function MonthGrid({ year, month, windowFrom, windowTo, dayMap, metric, maxVal, selected, onSelect }: {
  year: number
  month: number
  windowFrom: string
  windowTo: string
  dayMap: Map<string, DayAgg>
  metric: HeatMetric
  maxVal: number
  selected: string | null
  onSelect: (d: string) => void
}) {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  // Monday-first leading blanks: JS getUTCDay() is Sun=0..Sat=6
  const leading = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7

  const cells: (number | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  return (
    <div>
      <div className="text-[11px] mb-1.5" style={{ color: 'var(--ink-300)' }}>
        {MONTH_NAMES[month]} <span style={{ color: 'var(--ink-500)' }}>{year}</span>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {WEEKDAY_HEADS.map((w, idx) => (
          <div key={idx} className="text-center text-[8px]" style={{ color: 'var(--ink-500)' }}>{w}</div>
        ))}
        {cells.map((d, idx) => {
          if (d == null) return <div key={`b-${idx}`} />
          const iso = `${year}-${pad2(month + 1)}-${pad2(d)}`
          const inWindow = iso >= windowFrom && iso <= windowTo
          const agg = dayMap.get(iso)
          const val = agg ? (metric === 'delay' ? agg.delay : agg.count) : 0
          const t = inWindow && maxVal > 0 ? val / maxVal : 0
          const isSelected = selected === iso
          return (
            <button
              key={iso}
              disabled={!inWindow}
              onClick={() => onSelect(iso)}
              className="rounded-sm px-0.5 pt-0.5 pb-1 text-center"
              style={{
                background: t > 0 ? `rgba(224, 82, 6, ${0.08 + t * 0.55})` : 'transparent',
                border:     `1px solid ${isSelected ? 'var(--nr-orange)' : 'var(--line)'}`,
                opacity:    inWindow ? 1 : 0.25,
                cursor:     inWindow ? 'pointer' : 'default',
                minHeight:  34,
              }}
            >
              <div className="text-[9px] leading-none" style={{ color: 'var(--ink-300)' }}>{d}</div>
              <div className="numeric-mono text-[8px] leading-none mt-1" style={{ color: 'var(--ink-500)' }}>
                {inWindow && val > 0 ? Math.round(val).toLocaleString() : ' '}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
