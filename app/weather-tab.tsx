'use client'

import { useState, useMemo } from 'react'
import { CloudRain, SlidersHorizontal, LayoutGrid, TrendingUp, Info, Zap } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { IncidentRow, CATEGORY_CONFIG, IncidentCategory } from '@/lib/types'
import { effectiveDelay, nonContinuation } from '@/lib/queries'
import { WeatherDay, CONDITION_GROUPS, conditionGroup } from '@/lib/weather'
import {
  WeatherLookaheadDay, WeatherLevel, WEATHER_LEVELS, WEATHER_LEVEL_CONFIG,
  LOOKAHEAD_COVERAGE_START, lookaheadProvenance, weatherLevelLabel,
} from '@/lib/weatherLookahead'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MIN_SAMPLE = 5   // area-days below which lift is suppressed
const BASELINE   = 'Clear / Dry'

function fmtMin(n: number): string {
  return `${Math.round(n).toLocaleString()}m`
}

function fmtRate(n: number): string {
  return n.toFixed(2)
}

function liftColor(l: number): string {
  if (l > 1.75) return '#E74C3C'
  if (l > 1.25) return 'var(--nr-amber)'
  if (l <= 1)   return 'var(--ink-500)'
  return 'var(--ink-300)'
}

function fmtLift(l: number): string {
  return `${l.toFixed(2)}×`
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface GroupStat {
  group:     string
  areaDays:  number
  incidents: number   // non-continuation incidents on those area-days
  delay:     number   // effectiveDelay sum on those area-days
  incRate:   number   // incidents per area-day
  delayRate: number   // delay minutes per area-day
}

type WxMetricKey = 'rain' | 'wind' | 'thigh' | 'tlow'

interface WxMetric {
  key:   WxMetricKey
  label: string
  value: (w: WeatherDay) => number | null
  bands: { label: string; test: (v: number) => boolean }[]
}

const WX_METRICS: WxMetric[] = [
  {
    key: 'rain', label: 'Rainfall (mm)',
    value: w => w.rainfall_mm,
    bands: [
      { label: '0',    test: v => v <= 0 },
      { label: '0–2',  test: v => v > 0  && v <= 2 },
      { label: '2–5',  test: v => v > 2  && v <= 5 },
      { label: '5–10', test: v => v > 5  && v <= 10 },
      { label: '10+',  test: v => v > 10 },
    ],
  },
  {
    key: 'wind', label: 'Max wind (km/h)',
    value: w => w.max_wind_kmh,
    bands: [
      { label: '<30',   test: v => v < 30 },
      { label: '30–45', test: v => v >= 30 && v < 45 },
      { label: '45–60', test: v => v >= 45 && v < 60 },
      { label: '60+',   test: v => v >= 60 },
    ],
  },
  {
    key: 'thigh', label: 'Day high (°C)',
    value: w => w.max_temp_c,
    bands: [
      { label: '<2',    test: v => v < 2 },
      { label: '2–10',  test: v => v >= 2  && v < 10 },
      { label: '10–20', test: v => v >= 10 && v < 20 },
      { label: '20–25', test: v => v >= 20 && v < 25 },
      { label: '25+',   test: v => v >= 25 },
    ],
  },
  {
    key: 'tlow', label: 'Day low (°C)',
    value: w => w.min_temp_c,
    bands: [
      { label: '<0',    test: v => v < 0 },
      { label: '0–5',   test: v => v >= 0  && v < 5 },
      { label: '5–10',  test: v => v >= 5  && v < 10 },
      { label: '10–15', test: v => v >= 10 && v < 15 },
      { label: '15+',   test: v => v >= 15 },
    ],
  },
]

// ─── Chart bits ───────────────────────────────────────────────────────────────

// Two-line x-axis tick: band label + area-day count underneath
function BandTick(props: any) {
  const { x, y, index, bands } = props
  const b = bands?.[index]
  if (!b) return <g />
  return (
    <g transform={`translate(${x},${y})`}>
      <text dy={10} textAnchor="middle" fontSize={9} fill="var(--ink-400)" fontFamily="JetBrains Mono, monospace">
        {b.band}
      </text>
      <text dy={22} textAnchor="middle" fontSize={8} fill="var(--ink-500)" fontFamily="JetBrains Mono, monospace">
        {b.days}d
      </text>
    </g>
  )
}

function BandTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  return (
    <div
      className="px-3 py-2 rounded border text-xs space-y-1"
      style={{ background: 'var(--bg-card-hi)', borderColor: 'var(--line-hi)', color: 'var(--ink-200)' }}
    >
      <div className="font-medium" style={{ color: 'var(--ink-100)' }}>{label}</div>
      <div style={{ color: 'var(--ink-500)' }}>
        Incidents / area-day: <span className="numeric-mono" style={{ color: 'var(--nr-orange)' }}>{fmtRate(d.incRate)}</span>
      </div>
      <div style={{ color: 'var(--ink-500)' }}>
        Delay / area-day: <span className="numeric-mono" style={{ color: 'var(--nr-blue)' }}>{fmtMin(d.delayRate)}</span>
      </div>
      <div className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{d.days} area-days in band</div>
    </div>
  )
}

// ─── Operational weather statement impact ────────────────────────────────────
// Analyses what the route's operational weather classification
// (weather_lookahead — DLog2's 5 Day Look Ahead / EM morning statements) does
// to operations. Day counts per level are very unequal, so every comparison
// is normalised per day at that level — never raw totals. The unit here is
// the route-day (one calendar date), unlike the observed-weather sections
// below which work in area-days.

type RegionView = 'overall' | 'east_midlands' | 'london_north'

const REGION_OPTIONS: { key: RegionView; label: string }[] = [
  { key: 'overall',       label: 'Route' },
  { key: 'east_midlands', label: 'East Midlands' },
  { key: 'london_north',  label: 'London North' },
]

interface DayLoad { inc: number; delay: number; cancelled: number }

interface LevelStat {
  level:     WeatherLevel
  days:      number
  incidents: number
  delay:     number
  cancelled: number
  incRate:   number
  delayRate: number
  cancRate:  number
}

interface RiskStat {
  risk:             string
  daysWith:         number
  daysWithout:      number
  incRateWith:      number
  incRateWithout:   number
  delayRateWith:    number
  delayRateWithout: number
}

// Share of a level's incidents needed before the weather-sensitivity badge
// can fire, and the elevated-vs-Normal share lift that fires it.
const SENSITIVE_MIN_COUNT = 3
const SENSITIVE_LIFT = 1.5

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`
}

function LookaheadImpact({
  lookahead,
  incidents,
  windowFrom,
  windowTo,
}: {
  lookahead:  WeatherLookaheadDay[]
  incidents:  IncidentRow[]
  windowFrom: string
  windowTo:   string
}) {
  const [region, setRegion] = useState<RegionView>('overall')

  // Statement rows inside the window, keyed by date
  const days = useMemo(
    () => lookahead.filter(d => d.weather_date >= windowFrom && d.weather_date <= windowTo),
    [lookahead, windowFrom, windowTo],
  )
  const byDate = useMemo(() => {
    const m = new Map<string, WeatherLookaheadDay>()
    days.forEach(d => m.set(d.weather_date, d))
    return m
  }, [days])

  // Region view: reclassify each day by the selected region's level / risks.
  // Incidents are always route-wide — the toggle changes day classification only.
  const levelOf = useMemo(() => (d: WeatherLookaheadDay): WeatherLevel | null => (
    region === 'east_midlands' ? d.east_midlands_level :
    region === 'london_north'  ? d.london_north_level :
    d.overall_level
  ), [region])

  const risksOf = useMemo(() => (d: WeatherLookaheadDay): string[] => (
    region === 'east_midlands' ? Object.keys(d.east_midlands_risks ?? {}) :
    region === 'london_north'  ? Object.keys(d.london_north_risks ?? {}) :
    (d.risk_types ?? [])
  ), [region])

  // Per-route-day incident load. Codebase aggregation conventions:
  // continuations excluded from incident counts but their delay_delta counts,
  // off-route delay excluded entirely (both via effectiveDelay).
  const perDay = useMemo(() => {
    const m = new Map<string, DayLoad>()
    incidents.forEach(i => {
      const cur = m.get(i.report_date) ?? { inc: 0, delay: 0, cancelled: 0 }
      cur.delay     += effectiveDelay(i)
      cur.cancelled += (i.cancelled || 0) + (i.part_cancelled || 0)
      if (!i.is_continuation) cur.inc += 1
      m.set(i.report_date, cur)
    })
    return m
  }, [incidents])

  // All dates in the window, for the timeline strip + coverage note
  const allDates = useMemo(() => {
    const out: string[] = []
    const end = new Date(windowTo + 'T00:00:00Z').getTime()
    for (let t = new Date(windowFrom + 'T00:00:00Z').getTime(); t <= end; t += 86_400_000) {
      out.push(new Date(t).toISOString().slice(0, 10))
    }
    return out
  }, [windowFrom, windowTo])

  const uncoveredDays = allDates.length - days.length

  // ── 1 · Impact by level ─────────────────────────────────────────────────────
  const levelStats = useMemo<LevelStat[]>(() => {
    const acc = new Map<WeatherLevel, { days: number; inc: number; delay: number; cancelled: number }>()
    days.forEach(d => {
      const level = levelOf(d)
      if (!level) return
      const cur  = acc.get(level) ?? { days: 0, inc: 0, delay: 0, cancelled: 0 }
      const load = perDay.get(d.weather_date) ?? { inc: 0, delay: 0, cancelled: 0 }
      cur.days      += 1
      cur.inc       += load.inc
      cur.delay     += load.delay
      cur.cancelled += load.cancelled
      acc.set(level, cur)
    })
    return WEATHER_LEVELS
      .map(level => {
        const v = acc.get(level) ?? { days: 0, inc: 0, delay: 0, cancelled: 0 }
        return {
          level,
          days:      v.days,
          incidents: v.inc,
          delay:     v.delay,
          cancelled: v.cancelled,
          incRate:   v.days ? v.inc / v.days : 0,
          delayRate: v.days ? v.delay / v.days : 0,
          cancRate:  v.days ? v.cancelled / v.days : 0,
        }
      })
      .filter(s => s.days > 0)
  }, [days, perDay, levelOf])

  const normalStat = levelStats.find(s => s.level === 'GREEN') ?? null

  // ── 2 · Category mix by level ───────────────────────────────────────────────
  const catMix = useMemo(() => {
    const catTotals  = new Map<IncidentCategory, number>()
    const cells      = new Map<string, number>()          // `${category}::${level}` → count
    const levelTotal = new Map<WeatherLevel, number>()    // incidents per level
    nonContinuation(incidents).forEach(i => {
      const d = byDate.get(i.report_date)
      const level = d ? levelOf(d) : null
      if (!level) return
      catTotals.set(i.category, (catTotals.get(i.category) ?? 0) + 1)
      levelTotal.set(level, (levelTotal.get(level) ?? 0) + 1)
      const key = `${i.category}::${level}`
      cells.set(key, (cells.get(key) ?? 0) + 1)
    })
    const topCats = [...catTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([cat]) => cat)
    const cols = levelStats.map(s => s.level)

    // Weather-sensitive marker, derived from the data: a category whose share
    // of incidents on Adverse+Extreme days is well above its Normal-day share.
    const normShareOf = (cat: IncidentCategory): number => {
      const n = levelTotal.get('GREEN') ?? 0
      return n > 0 ? (cells.get(`${cat}::GREEN`) ?? 0) / n : 0
    }
    const sensitive = new Set<IncidentCategory>()
    const elevatedTotal = (levelTotal.get('ADVERSE') ?? 0) + (levelTotal.get('EXTREME') ?? 0)
    if (elevatedTotal > 0 && (levelTotal.get('GREEN') ?? 0) > 0) {
      topCats.forEach(cat => {
        const elevatedCount = (cells.get(`${cat}::ADVERSE`) ?? 0) + (cells.get(`${cat}::EXTREME`) ?? 0)
        const elevatedShare = elevatedCount / elevatedTotal
        const normShare = normShareOf(cat)
        if (elevatedCount >= SENSITIVE_MIN_COUNT &&
            (normShare === 0 ? elevatedShare > 0 : elevatedShare / normShare >= SENSITIVE_LIFT)) {
          sensitive.add(cat)
        }
      })
    }
    return { topCats, cols, cells, levelTotal, sensitive }
  }, [incidents, byDate, levelOf, levelStats])

  // ── 3 · Impact by risk type ─────────────────────────────────────────────────
  const riskStats = useMemo<RiskStat[]>(() => {
    const out: RiskStat[] = []
    // Universe = covered days only, so "days without" isn't polluted by
    // dates that simply have no statement.
    const universe = days
    for (const risk of Array.from(new Set(universe.flatMap(d => risksOf(d)))).sort()) {
      let dWith = 0, dWithout = 0
      const withLoad    = { inc: 0, delay: 0 }
      const withoutLoad = { inc: 0, delay: 0 }
      universe.forEach(d => {
        const load = perDay.get(d.weather_date) ?? { inc: 0, delay: 0, cancelled: 0 }
        if (risksOf(d).includes(risk)) {
          dWith += 1; withLoad.inc += load.inc; withLoad.delay += load.delay
        } else {
          dWithout += 1; withoutLoad.inc += load.inc; withoutLoad.delay += load.delay
        }
      })
      if (dWith === 0) continue
      out.push({
        risk,
        daysWith:         dWith,
        daysWithout:      dWithout,
        incRateWith:      dWith    ? withLoad.inc / dWith : 0,
        incRateWithout:   dWithout ? withoutLoad.inc / dWithout : 0,
        delayRateWith:    dWith    ? withLoad.delay / dWith : 0,
        delayRateWithout: dWithout ? withoutLoad.delay / dWithout : 0,
      })
    }
    return out.sort((a, b) => b.delayRateWith - a.delayRateWith)
  }, [days, perDay, risksOf])

  const regionToggle = (
    <div className="flex items-center gap-1 flex-wrap">
      {REGION_OPTIONS.map(o => (
        <button
          key={o.key}
          onClick={() => setRegion(o.key)}
          className={o.key === region ? 'btn btn-active' : 'btn'}
        >
          {o.label}
        </button>
      ))}
    </div>
  )

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (days.length === 0) {
    return (
      <div className="card p-5">
        <div className="mb-4">
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Operational Weather Impact</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            {windowFrom} – {windowTo}
          </p>
        </div>
        <div className="py-10 flex flex-col items-center gap-2 text-center">
          <CloudRain size={24} style={{ color: 'var(--ink-500)' }} />
          <div className="text-sm" style={{ color: 'var(--ink-400)' }}>
            No operational weather statements in this window
          </div>
          <div className="text-[11px] max-w-sm" style={{ color: 'var(--ink-500)' }}>
            Statements cover {LOOKAHEAD_COVERAGE_START} onwards — written by DLog2 on report save
            and backfilled from the EM State of the Route morning messages.
          </div>
        </div>
      </div>
    )
  }

  const maxIncRate = Math.max(...levelStats.map(s => s.incRate), 0.0001)
  const greenShare = (cat: IncidentCategory): number => {
    const n = catMix.levelTotal.get('GREEN') ?? 0
    return n > 0 ? (catMix.cells.get(`${cat}::GREEN`) ?? 0) / n : 0
  }

  return (
    <>
      {/* ── 1 · Impact by weather level ─────────────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Impact by Weather Level</h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
              Operational statement ({region === 'overall' ? 'route overall level' : `${REGION_OPTIONS.find(o => o.key === region)?.label} level`}) ·
              all figures per day at that level · {windowFrom} – {windowTo}
            </p>
          </div>
          {regionToggle}
        </div>

        {/* Timeline strip — one cell per day, coloured by that day's level */}
        <div className="mb-4">
          <div className="flex items-stretch h-3.5 rounded-sm overflow-hidden">
            {allDates.map(date => {
              const d = byDate.get(date)
              const level = d ? levelOf(d) : null
              const cfg = level ? WEATHER_LEVEL_CONFIG[level] : null
              const title = d
                ? `${date} · ${weatherLevelLabel(levelOf(d))}${region === 'overall' ? ` (EM ${weatherLevelLabel(d.east_midlands_level)} / LN ${weatherLevelLabel(d.london_north_level)})` : ''}` +
                  `${risksOf(d).length ? ` · ${risksOf(d).join(', ')}` : ''} · ${lookaheadProvenance(d)}${d.risk_note ? `\n${d.risk_note}` : ''}`
                : `${date} · no statement`
              return (
                <div
                  key={date}
                  className="flex-1"
                  title={title}
                  style={{ background: cfg ? cfg.color : 'var(--line)', opacity: cfg ? 0.85 : 0.4, minWidth: 1 }}
                />
              )
            })}
          </div>
          <div className="flex items-center gap-4 mt-1.5 flex-wrap">
            {WEATHER_LEVELS.map(l => (
              <div key={l} className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-sm" style={{ background: WEATHER_LEVEL_CONFIG[l].color }} />
                <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>{WEATHER_LEVEL_CONFIG[l].label}</span>
              </div>
            ))}
            <span className="text-[9px] ml-auto" style={{ color: 'var(--ink-500)' }}>
              Hover a day for risks, source statement and provenance
              {uncoveredDays > 0 ? ` · ${uncoveredDays} day${uncoveredDays === 1 ? '' : 's'} without a statement (coverage from ${LOOKAHEAD_COVERAGE_START})` : ''}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs" style={{ minWidth: 680 }}>
            <thead>
              <tr className="text-left" style={{ color: 'var(--ink-500)' }}>
                <th className="label-micro text-[9px] font-normal pb-2 pr-3">Level</th>
                <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Days</th>
                <th className="label-micro text-[9px] font-normal pb-2 pr-3" style={{ width: '24%' }}>Incidents / day</th>
                <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Delay / day</th>
                <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right" title="Full + part cancellations per day at this level">Cancels / day</th>
                <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Incident lift</th>
                <th className="label-micro text-[9px] font-normal pb-2 text-right">Delay lift</th>
              </tr>
            </thead>
            <tbody>
              {levelStats.map(s => {
                const cfg = WEATHER_LEVEL_CONFIG[s.level]
                const isBaseline = s.level === 'GREEN'
                const lowSample  = s.days < MIN_SAMPLE
                const incLift   = normalStat && normalStat.incRate   > 0 ? s.incRate   / normalStat.incRate   : null
                const delayLift = normalStat && normalStat.delayRate > 0 ? s.delayRate / normalStat.delayRate : null
                return (
                  <tr key={s.level} className="border-t" style={{ borderColor: 'var(--line)' }}>
                    <td className="py-2.5 pr-3">
                      <span className="inline-flex items-center gap-2" style={{ color: cfg.color }}>
                        <span className="w-2 h-2 rounded-sm inline-block" style={{ background: cfg.color }} />
                        {cfg.label}
                      </span>
                      {isBaseline && (
                        <span className="ml-1.5 text-[9px]" style={{ color: 'var(--ink-500)' }}>baseline</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-300)' }}>
                      {s.days.toLocaleString()}
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.min(100, (s.incRate / maxIncRate) * 100)}%`, background: cfg.color }}
                          />
                        </div>
                        <span className="numeric-mono w-10 text-right" style={{ color: 'var(--ink-200)' }}>{fmtRate(s.incRate)}</span>
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-200)' }}>
                      {fmtMin(s.delayRate)}
                    </td>
                    <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-200)' }}>
                      {fmtRate(s.cancRate)}
                    </td>
                    {isBaseline ? (
                      <td colSpan={2} className="py-2.5 text-right text-[10px]" style={{ color: 'var(--ink-500)' }}>1.00× reference</td>
                    ) : lowSample ? (
                      <td colSpan={2} className="py-2.5 text-right text-[10px]" style={{ color: 'var(--ink-500)' }}>low sample (&lt;{MIN_SAMPLE} days)</td>
                    ) : (
                      <>
                        <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: incLift != null ? liftColor(incLift) : 'var(--ink-500)' }}>
                          {incLift != null ? fmtLift(incLift) : '—'}
                        </td>
                        <td className="py-2.5 text-right numeric-mono" style={{ color: delayLift != null ? liftColor(delayLift) : 'var(--ink-500)' }}>
                          {delayLift != null ? fmtLift(delayLift) : '—'}
                        </td>
                      </>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-start gap-2 mt-3">
          <Info size={11} style={{ color: 'var(--ink-500)', flexShrink: 0, marginTop: 1 }} />
          <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>
            Cancellations include part-cancellations. Region views reclassify the <em>day</em> by that
            region&apos;s level — incidents are always route-wide.
            {!normalStat && ' No Normal days in this window — lift columns unavailable.'}
            {normalStat && normalStat.days < MIN_SAMPLE && ` Only ${normalStat.days} Normal day${normalStat.days === 1 ? '' : 's'} in this window — treat lifts as indicative.`}
          </span>
        </div>
      </div>

      {/* ── 2 · Category mix by level ───────────────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4">
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Category Mix by Weather Level</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            Share of each level&apos;s incidents by category — heat shows the shift vs the Normal-day mix ·
            <Zap size={9} className="inline mx-1" style={{ color: 'var(--nr-amber)', verticalAlign: '-1px' }} />
            marks categories over-represented on Adverse / Extreme days
          </p>
        </div>

        {catMix.topCats.length === 0 ? (
          <div className="py-10 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
            Not enough statement-joined incidents to build the matrix
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th className="label-micro text-[9px] font-normal text-left pb-2 pr-3" style={{ color: 'var(--ink-500)' }}>Category</th>
                  {catMix.cols.map(level => (
                    <th key={level} className="label-micro text-[9px] font-normal text-right pb-2 px-2" style={{ color: WEATHER_LEVEL_CONFIG[level].color }}>
                      {WEATHER_LEVEL_CONFIG[level].label}
                      <div className="text-[8px] normal-case" style={{ color: 'var(--ink-500)' }}>
                        {(catMix.levelTotal.get(level) ?? 0).toLocaleString()} inc
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {catMix.topCats.map(cat => {
                  const cfg = CATEGORY_CONFIG[cat]
                  const baseShare = greenShare(cat)
                  return (
                    <tr key={cat} className="border-t" style={{ borderColor: 'var(--line)' }}>
                      <td className="py-2 pr-3 whitespace-nowrap" style={{ color: cfg?.color ?? 'var(--ink-200)' }}>
                        {cfg?.label ?? cat}
                        {catMix.sensitive.has(cat) && (
                          <Zap size={9} className="inline ml-1.5" style={{ color: 'var(--nr-amber)', verticalAlign: '-1px' }} />
                        )}
                      </td>
                      {catMix.cols.map(level => {
                        const total = catMix.levelTotal.get(level) ?? 0
                        const count = catMix.cells.get(`${cat}::${level}`) ?? 0
                        const share = total > 0 ? count / total : 0
                        const ratio = baseShare > 0 ? share / baseShare : (share > 0 ? 3 : 0)
                        const alpha = level === 'GREEN' ? 0 : Math.min(0.7, Math.max(0, (ratio - 1)) * 0.35)
                        return (
                          <td
                            key={level}
                            className="py-2 px-2 text-right numeric-mono"
                            title={`${cfg?.label ?? cat} · ${WEATHER_LEVEL_CONFIG[level].label}: ${count} of ${total} incidents = ${fmtPct(share)}${baseShare > 0 && level !== 'GREEN' ? ` (${ratio.toFixed(2)}× the Normal-day share of ${fmtPct(baseShare)})` : ''}`}
                            style={{
                              background: alpha > 0 ? `rgba(224, 82, 6, ${alpha})` : 'transparent',
                              color: 'var(--ink-200)',
                            }}
                          >
                            {total > 0 ? fmtPct(share) : '—'}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="flex items-center gap-2 mt-3">
              <LayoutGrid size={10} style={{ color: 'var(--ink-500)' }} />
              <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>
                Shares are within-level (each column sums to ~100% over all categories) · hover a cell for exact numbers
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── 3 · Impact by risk type ─────────────────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4">
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Impact by Risk Type</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            Days carrying each named risk vs statement days without it — rates per day, so unequal day
            counts compare fairly{region !== 'overall' ? ` · ${REGION_OPTIONS.find(o => o.key === region)?.label} risks` : ''}
          </p>
        </div>

        {riskStats.length === 0 ? (
          <div className="py-10 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
            No named risks in this window
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ minWidth: 720 }}>
              <thead>
                <tr className="text-left" style={{ color: 'var(--ink-500)' }}>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3">Risk</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Days</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Inc / day (risk days)</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Inc / day (other days)</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Inc lift</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Delay / day (risk days)</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Delay / day (other days)</th>
                  <th className="label-micro text-[9px] font-normal pb-2 text-right">Delay lift</th>
                </tr>
              </thead>
              <tbody>
                {riskStats.map(r => {
                  const lowSample = r.daysWith < MIN_SAMPLE || r.daysWithout < MIN_SAMPLE
                  const incLift   = r.incRateWithout   > 0 ? r.incRateWith   / r.incRateWithout   : null
                  const delayLift = r.delayRateWithout > 0 ? r.delayRateWith / r.delayRateWithout : null
                  return (
                    <tr key={r.risk} className="border-t" style={{ borderColor: 'var(--line)' }}>
                      <td className="py-2.5 pr-3" style={{ color: 'var(--ink-200)' }}>{r.risk}</td>
                      <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-300)' }}>
                        {r.daysWith.toLocaleString()}
                      </td>
                      <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-200)' }}>{fmtRate(r.incRateWith)}</td>
                      <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-400)' }}>{fmtRate(r.incRateWithout)}</td>
                      <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: lowSample ? 'var(--ink-500)' : incLift != null ? liftColor(incLift) : 'var(--ink-500)' }}>
                        {incLift != null ? fmtLift(incLift) : '—'}{lowSample && incLift != null ? '*' : ''}
                      </td>
                      <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-200)' }}>{fmtMin(r.delayRateWith)}</td>
                      <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-400)' }}>{fmtMin(r.delayRateWithout)}</td>
                      <td className="py-2.5 text-right numeric-mono" style={{ color: lowSample ? 'var(--ink-500)' : delayLift != null ? liftColor(delayLift) : 'var(--ink-500)' }}>
                        {delayLift != null ? fmtLift(delayLift) : '—'}{lowSample && delayLift != null ? '*' : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="flex items-center gap-2 mt-3">
              <Info size={10} style={{ color: 'var(--ink-500)' }} />
              <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>
                &quot;Other days&quot; = statement days not carrying the risk · * low sample (&lt;{MIN_SAMPLE} days on one side) ·
                a day can carry several risks, so rows overlap · correlation, not cause
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

// ─── WeatherTab ───────────────────────────────────────────────────────────────

export function WeatherTab({
  incidents,
  weatherData,
  lookahead = [],
  windowFrom,
  windowTo,
}: {
  incidents:   IncidentRow[]
  weatherData: WeatherDay[]
  lookahead?:  WeatherLookaheadDay[]
  windowFrom:  string
  windowTo:    string
}) {
  const [metricKey, setMetricKey] = useState<WxMetricKey>('rain')

  // Weather rows inside the window; the unit of analysis is the "area-day" —
  // one (area, date) pair that has a weather row.
  const wxInWindow = useMemo(
    () => weatherData.filter(w => w.date >= windowFrom && w.date <= windowTo),
    [weatherData, windowFrom, windowTo],
  )

  const wxMap = useMemo(() => {
    const m = new Map<string, WeatherDay>()
    wxInWindow.forEach(w => m.set(`${w.area}::${w.date}`, w))
    return m
  }, [wxInWindow])

  // Per-area-day incident load: count (non-continuation) + delay (effective)
  const perDayLoad = useMemo(() => {
    const m = new Map<string, { inc: number; delay: number }>()
    const counted = new Set(nonContinuation(incidents).map(i => i.id))
    incidents.forEach(i => {
      if (!i.area) return
      const key = `${i.area}::${i.report_date}`
      if (!wxMap.has(key)) return
      const cur = m.get(key) ?? { inc: 0, delay: 0 }
      cur.delay += effectiveDelay(i)
      if (counted.has(i.id)) cur.inc += 1
      m.set(key, cur)
    })
    return m
  }, [incidents, wxMap])

  // Condition-group aggregates
  const groupStats = useMemo<GroupStat[]>(() => {
    const acc = new Map<string, { areaDays: number; incidents: number; delay: number }>()
    wxInWindow.forEach(w => {
      const g   = conditionGroup(w.conditions)
      const cur = acc.get(g) ?? { areaDays: 0, incidents: 0, delay: 0 }
      const load = perDayLoad.get(`${w.area}::${w.date}`) ?? { inc: 0, delay: 0 }
      cur.areaDays  += 1
      cur.incidents += load.inc
      cur.delay     += load.delay
      acc.set(g, cur)
    })
    // Order: CONDITION_GROUPS order first, then anything else (Unknown etc.)
    const order = CONDITION_GROUPS.map(g => g.label)
    return [...acc.entries()]
      .sort((a, b) => {
        const ia = order.indexOf(a[0]); const ib = order.indexOf(b[0])
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
      })
      .map(([group, v]) => ({
        group,
        areaDays:  v.areaDays,
        incidents: v.incidents,
        delay:     v.delay,
        incRate:   v.areaDays ? v.incidents / v.areaDays : 0,
        delayRate: v.areaDays ? v.delay / v.areaDays : 0,
      }))
  }, [wxInWindow, perDayLoad])

  const baseline = useMemo(
    () => groupStats.find(g => g.group === BASELINE) ?? null,
    [groupStats],
  )

  // Category × condition matrix
  const matrix = useMemo(() => {
    const cols = groupStats.filter(g => g.areaDays >= MIN_SAMPLE)
    const catCounts = new Map<IncidentCategory, number>()
    const cells     = new Map<string, number>()   // `${category}::${group}` → count
    nonContinuation(incidents).forEach(i => {
      if (!i.area) return
      const wx = wxMap.get(`${i.area}::${i.report_date}`)
      if (!wx) return
      const g = conditionGroup(wx.conditions)
      catCounts.set(i.category, (catCounts.get(i.category) ?? 0) + 1)
      const key = `${i.category}::${g}`
      cells.set(key, (cells.get(key) ?? 0) + 1)
    })
    const topCats = [...catCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([cat]) => cat)
    return { cols, topCats, cells }
  }, [groupStats, incidents, wxMap])

  // Threshold explorer buckets for the selected metric
  const metric = WX_METRICS.find(m => m.key === metricKey) ?? WX_METRICS[0]
  const bucketData = useMemo(() => {
    const acc = metric.bands.map(b => ({ band: b.label, days: 0, inc: 0, delay: 0 }))
    wxInWindow.forEach(w => {
      const v = metric.value(w)
      if (v == null) return
      const idx = metric.bands.findIndex(b => b.test(v))
      if (idx === -1) return
      const load = perDayLoad.get(`${w.area}::${w.date}`) ?? { inc: 0, delay: 0 }
      acc[idx].days  += 1
      acc[idx].inc   += load.inc
      acc[idx].delay += load.delay
    })
    return acc.map(b => ({
      ...b,
      incRate:   b.days ? b.inc / b.days : 0,
      delayRate: b.days ? b.delay / b.days : 0,
    }))
  }, [wxInWindow, perDayLoad, metric])

  // Weather-attributable delay estimate
  const attribution = useMemo(() => {
    const windowTotalDelay = incidents.reduce((s, i) => s + effectiveDelay(i), 0)
    const adverse = groupStats.filter(g => g.group !== BASELINE && g.group !== 'Unknown')
    const adverseAreaDays = adverse.reduce((s, g) => s + g.areaDays, 0)
    const adverseDelay    = adverse.reduce((s, g) => s + g.delay, 0)
    const baselineRate    = baseline && baseline.areaDays > 0 ? baseline.delayRate : null
    const excess = baselineRate != null ? adverseDelay - baselineRate * adverseAreaDays : null
    const sharePct = excess != null && windowTotalDelay > 0 ? (excess / windowTotalDelay) * 100 : null
    return { windowTotalDelay, adverseAreaDays, adverseDelay, baselineRate, excess, sharePct }
  }, [incidents, groupStats, baseline])

  const maxIncRate = Math.max(...groupStats.map(g => g.incRate), 0.0001)
  const clearAreaDays = matrix.cols.find(c => c.group === BASELINE)?.areaDays ?? 0

  // ── Render ──────────────────────────────────────────────────────────────────
  // Operational statement analysis first — it's the classification the route
  // was actually working to — then the observed Open-Meteo sections.

  const observedEmpty = (
    <div className="card p-5">
      <div className="mb-4">
        <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Observed Weather Impact</h3>
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
          {windowFrom} – {windowTo}
        </p>
      </div>
      <div className="py-14 flex flex-col items-center gap-3 text-center">
        <CloudRain size={28} style={{ color: 'var(--ink-500)' }} />
        <div className="text-sm" style={{ color: 'var(--ink-400)' }}>
          Weather data hasn&apos;t synced for this window yet
        </div>
        <div className="text-[11px] max-w-sm" style={{ color: 'var(--ink-500)' }}>
          Daily weather is fetched per area on load and cached. If you&apos;re in demo mode,
          weather sync is disabled — connect a live database to enable this tab.
        </div>
      </div>
    </div>
  )

  return (
    <div className="space-y-6">

      {/* ═══ Operational weather statement (weather_lookahead) ═══════════════ */}
      <div className="label-micro" style={{ color: 'var(--ink-500)' }}>
        Operational weather statement · DLog2 5 Day Look Ahead / EM morning messages
      </div>
      <LookaheadImpact
        lookahead={lookahead}
        incidents={incidents}
        windowFrom={windowFrom}
        windowTo={windowTo}
      />

      {/* ═══ Observed weather (Open-Meteo) ═══════════════════════════════════ */}
      <div className="label-micro pt-2" style={{ color: 'var(--ink-500)' }}>
        Observed weather · Open-Meteo per-area readings
      </div>
      {weatherData.length === 0 ? observedEmpty : (<>

      {/* ── 1 · Condition impact ─────────────────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4">
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Condition Impact</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            Incident and delay rates per area-day by condition group — lift vs the {BASELINE} baseline · {windowFrom} – {windowTo}
          </p>
        </div>

        {groupStats.length === 0 ? (
          <div className="py-10 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
            No weather rows overlap this window
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ minWidth: 640 }}>
              <thead>
                <tr className="text-left" style={{ color: 'var(--ink-500)' }}>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3">Condition</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Area-days</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3" style={{ width: '26%' }}>Incidents / area-day</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Delay / area-day</th>
                  <th className="label-micro text-[9px] font-normal pb-2 pr-3 text-right">Incident lift</th>
                  <th className="label-micro text-[9px] font-normal pb-2 text-right">Delay lift</th>
                </tr>
              </thead>
              <tbody>
                {groupStats.map(g => {
                  const isBaseline = g.group === BASELINE
                  const lowSample  = g.areaDays < MIN_SAMPLE
                  const incLift    = baseline && baseline.incRate   > 0 ? g.incRate   / baseline.incRate   : null
                  const delayLift  = baseline && baseline.delayRate > 0 ? g.delayRate / baseline.delayRate : null
                  return (
                    <tr key={g.group} className="border-t" style={{ borderColor: 'var(--line)' }}>
                      <td className="py-2.5 pr-3" style={{ color: 'var(--ink-200)' }}>
                        {g.group}
                        {isBaseline && (
                          <span className="ml-1.5 text-[9px]" style={{ color: 'var(--ink-500)' }}>baseline</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-300)' }}>
                        {g.areaDays.toLocaleString()}
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line)' }}>
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.min(100, (g.incRate / maxIncRate) * 100)}%`,
                                background: isBaseline ? 'var(--ink-400)' : 'var(--nr-orange)',
                              }}
                            />
                          </div>
                          <span className="numeric-mono w-10 text-right" style={{ color: 'var(--ink-200)' }}>{fmtRate(g.incRate)}</span>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: 'var(--ink-200)' }}>
                        {fmtMin(g.delayRate)}
                      </td>
                      {isBaseline ? (
                        <td colSpan={2} className="py-2.5 text-right text-[10px]" style={{ color: 'var(--ink-500)' }}>1.00× reference</td>
                      ) : lowSample ? (
                        <td colSpan={2} className="py-2.5 text-right text-[10px]" style={{ color: 'var(--ink-500)' }}>low sample (&lt;{MIN_SAMPLE} area-days)</td>
                      ) : (
                        <>
                          <td className="py-2.5 pr-3 text-right numeric-mono" style={{ color: incLift != null ? liftColor(incLift) : 'var(--ink-500)' }}>
                            {incLift != null ? fmtLift(incLift) : '—'}
                          </td>
                          <td className="py-2.5 text-right numeric-mono" style={{ color: delayLift != null ? liftColor(delayLift) : 'var(--ink-500)' }}>
                            {delayLift != null ? fmtLift(delayLift) : '—'}
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!baseline && groupStats.length > 0 && (
          <div className="mt-3 text-[10px]" style={{ color: 'var(--ink-500)' }}>
            No {BASELINE} area-days in this window — lift columns unavailable.
          </div>
        )}
      </div>

      {/* ── 2 · Category × condition matrix ──────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4">
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Category × Condition</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            Incidents per area-day for the top categories under each condition — heat shows the ratio vs that category&apos;s {BASELINE} rate
          </p>
        </div>

        {matrix.topCats.length === 0 || matrix.cols.length === 0 ? (
          <div className="py-10 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
            Not enough weather-joined incidents to build the matrix
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th className="label-micro text-[9px] font-normal text-left pb-2 pr-3" style={{ color: 'var(--ink-500)' }}>Category</th>
                  {matrix.cols.map(c => (
                    <th key={c.group} className="label-micro text-[9px] font-normal text-right pb-2 px-2" style={{ color: 'var(--ink-500)' }}>
                      {c.group}
                      <div className="text-[8px] normal-case" style={{ color: 'var(--ink-500)' }}>{c.areaDays}d</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.topCats.map(cat => {
                  const cfg = CATEGORY_CONFIG[cat]
                  const clearCount = matrix.cells.get(`${cat}::${BASELINE}`) ?? 0
                  const clearRate  = clearAreaDays > 0 ? clearCount / clearAreaDays : 0
                  return (
                    <tr key={cat} className="border-t" style={{ borderColor: 'var(--line)' }}>
                      <td className="py-2 pr-3 whitespace-nowrap" style={{ color: cfg?.color ?? 'var(--ink-200)' }}>
                        {cfg?.label ?? cat}
                      </td>
                      {matrix.cols.map(c => {
                        const count = matrix.cells.get(`${cat}::${c.group}`) ?? 0
                        const rate  = c.areaDays > 0 ? count / c.areaDays : 0
                        const ratio = clearRate > 0 ? rate / clearRate : (rate > 0 ? 3 : 0)
                        const alpha = Math.min(0.7, ratio * 0.22)
                        return (
                          <td
                            key={c.group}
                            className="py-2 px-2 text-right numeric-mono"
                            title={`${cfg?.label ?? cat} · ${c.group}: ${count} incidents over ${c.areaDays} area-days = ${fmtRate(rate)}/day${clearRate > 0 ? ` (${ratio.toFixed(2)}× vs ${BASELINE} ${fmtRate(clearRate)}/day)` : ''}`}
                            style={{
                              background: alpha > 0 ? `rgba(224, 82, 6, ${alpha})` : 'transparent',
                              color: 'var(--ink-200)',
                            }}
                          >
                            {fmtRate(rate)}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="flex items-center gap-2 mt-3">
              <LayoutGrid size={10} style={{ color: 'var(--ink-500)' }} />
              <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>
                Columns limited to conditions with ≥{MIN_SAMPLE} area-days · hover a cell for exact numbers
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── 3 · Threshold explorer ────────────────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Threshold Explorer</h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
              Incident and delay rates per area-day across fixed bands of {metric.label.toLowerCase()}
            </p>
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            <SlidersHorizontal size={11} style={{ color: 'var(--ink-500)' }} />
            {WX_METRICS.map(m => (
              <button
                key={m.key}
                onClick={() => setMetricKey(m.key)}
                className={m.key === metricKey ? 'btn btn-active' : 'btn'}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {bucketData.every(b => b.days === 0) ? (
          <div className="py-10 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
            No area-days have {metric.label.toLowerCase()} readings in this window
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={bucketData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barGap={3}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis
                  dataKey="band"
                  axisLine={false}
                  tickLine={false}
                  height={34}
                  interval={0}
                  tick={<BandTick bands={bucketData} />}
                />
                <YAxis
                  yAxisId="inc"
                  axisLine={false}
                  tickLine={false}
                  width={36}
                  tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <YAxis
                  yAxisId="delay"
                  orientation="right"
                  axisLine={false}
                  tickLine={false}
                  width={44}
                  tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}
                />
                <Tooltip content={<BandTip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                <Bar yAxisId="inc"   dataKey="incRate"   fill="var(--nr-orange)" radius={[2, 2, 0, 0]} maxBarSize={36} />
                <Bar yAxisId="delay" dataKey="delayRate" fill="var(--nr-blue)"   radius={[2, 2, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
            <div className="flex items-center gap-5 mt-2">
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--nr-orange)' }} />
                <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>Incidents / area-day (left axis)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--nr-blue)' }} />
                <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>Delay minutes / area-day (right axis)</span>
              </div>
              <span className="text-[9px] ml-auto" style={{ color: 'var(--ink-500)' }}>Area-day counts shown under each band</span>
            </div>
          </>
        )}
      </div>

      {/* ── 4 · Weather-attributable delay ────────────────────────────────── */}
      <div className="card p-5">
        <div className="mb-4">
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Weather-Attributable Delay</h3>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            Excess vs dry-day baseline — correlation, not cause
          </p>
        </div>

        {attribution.baselineRate == null ? (
          <div className="py-8 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
            No {BASELINE} area-days in this window — a baseline rate can&apos;t be established
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded overflow-hidden border" style={{ borderColor: 'var(--line)', background: 'var(--line)' }}>
              <div className="px-4 py-3" style={{ background: 'var(--bg-card)' }}>
                <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Est. excess delay</div>
                <div className="numeric-mono text-xl font-light mt-1" style={{ color: (attribution.excess ?? 0) > 0 ? 'var(--nr-orange)' : 'var(--ink-300)' }}>
                  {attribution.excess != null ? `${attribution.excess < 0 ? '−' : ''}${fmtMin(Math.abs(attribution.excess))}` : '—'}
                </div>
                <div className="text-[9px] mt-0.5" style={{ color: 'var(--ink-500)' }}>on adverse-weather area-days</div>
              </div>
              <div className="px-4 py-3" style={{ background: 'var(--bg-card)' }}>
                <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Share of window delay</div>
                <div className="numeric-mono text-xl font-light mt-1" style={{ color: 'var(--ink-100)' }}>
                  {attribution.sharePct != null ? `${attribution.sharePct.toFixed(1)}%` : '—'}
                </div>
                <div className="text-[9px] mt-0.5" style={{ color: 'var(--ink-500)' }}>of {fmtMin(attribution.windowTotalDelay)} total</div>
              </div>
              <div className="px-4 py-3" style={{ background: 'var(--bg-card)' }}>
                <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Adverse area-days</div>
                <div className="numeric-mono text-xl font-light mt-1" style={{ color: 'var(--ink-100)' }}>
                  {attribution.adverseAreaDays.toLocaleString()}
                </div>
                <div className="text-[9px] mt-0.5" style={{ color: 'var(--ink-500)' }}>carrying {fmtMin(attribution.adverseDelay)} delay</div>
              </div>
              <div className="px-4 py-3" style={{ background: 'var(--bg-card)' }}>
                <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Dry-day baseline</div>
                <div className="numeric-mono text-xl font-light mt-1" style={{ color: 'var(--ink-100)' }}>
                  {fmtMin(attribution.baselineRate)}
                </div>
                <div className="text-[9px] mt-0.5" style={{ color: 'var(--ink-500)' }}>delay per {BASELINE} area-day</div>
              </div>
            </div>
            <div className="flex items-start gap-2 mt-3">
              <Info size={11} style={{ color: 'var(--ink-500)', flexShrink: 0, marginTop: 1 }} />
              <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>
                Estimate only: total delay on adverse area-days minus what the {BASELINE} baseline rate would predict
                for the same number of area-days. Weather correlates with — but does not prove it caused — the excess.
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <TrendingUp size={11} style={{ color: 'var(--ink-500)', flexShrink: 0 }} />
              <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>
                Window {windowFrom} – {windowTo} · {wxInWindow.length.toLocaleString()} weather area-days joined
              </span>
            </div>
          </>
        )}
      </div>
      </>)}
    </div>
  )
}
