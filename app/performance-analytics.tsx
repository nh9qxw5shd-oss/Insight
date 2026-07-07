'use client'

// ─── Performance predictive analytics panel ──────────────────────────────────
// Computational analysis between the performance metric history (WhatsApp-
// seeded + live messaging-assistant snapshots) and the CCIL incident log:
//
//   · Driver analysis — which incident factors move each metric the most,
//     ranked from a multi-factor fit over the joint daily history, with a
//     correlation matrix across every metric × factor pair.
//   · Forecast — an autoregressive + factor model projects each metric
//     beyond today with an uncertainty band, driven by expected factor
//     levels learned from recent activity and weekday patterns, plus a
//     projection of the period-end standing vs target.
//
// All computation is client-side and deterministic (lib/perfAnalytics.ts);
// this component only fetches, selects, and renders.

import { useEffect, useMemo, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { PerfSnapshot } from '@/lib/types'
import { fetchPerfSnapshots, fetchIncidentsSlim, SlimIncident } from '@/lib/queries'
import {
  DriverAnalysis, JointDay, MetricForecast,
  FACTOR_KEYS, FACTOR_LABELS, analyzeDrivers, buildJointSeries, forecastMetric, pearson,
} from '@/lib/perfAnalytics'
import { isSupabaseConfigured } from '@/lib/supabase'
import { railwayPeriodWeek, railwayPeriodBounds } from '@/lib/railwayCalendar'

const LOOKBACK_DAYS = 200
const CHART_HISTORY_DAYS = 28
const FORECAST_DAYS = 7

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

function fmt(v: number | null | undefined, dp = 1): string {
  return v == null ? '—' : v.toFixed(dp)
}

// Harm direction: for punctuality metrics a factor that pushes the value DOWN
// is harmful; for cancellation metrics a factor pushing UP is harmful.
function lowerIsBetter(metric: string): boolean {
  return /Can %/.test(metric)
}

// Correlation cell colour: harmful associations red, helpful green.
function corrColour(r: number, metric: string): string {
  const harm = lowerIsBetter(metric) ? r : -r
  const a = Math.min(0.85, Math.abs(r) * 1.6)
  return harm > 0 ? `rgba(231, 76, 60, ${a})` : `rgba(39, 174, 96, ${a})`
}

export function PerformanceAnalyticsPanel() {
  const [snapshots, setSnapshots] = useState<PerfSnapshot[] | null>(null)
  const [incidents, setIncidents] = useState<SlimIncident[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!isSupabaseConfigured()) return
    let cancelled = false
    const from = isoDaysAgo(LOOKBACK_DAYS)
    Promise.all([fetchPerfSnapshots(from, isoToday()), fetchIncidentsSlim(from, isoToday())])
      .then(([snaps, incs]) => { if (!cancelled) { setSnapshots(snaps); setIncidents(incs) } })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [])

  const joint = useMemo<JointDay[]>(
    () => (snapshots && incidents ? buildJointSeries(snapshots, incidents) : []),
    [snapshots, incidents],
  )

  const metricNames = useMemo(() => {
    const seen: string[] = []
    for (const d of joint) for (const name of Object.keys(d.metrics)) {
      if (!seen.includes(name)) seen.push(name)
    }
    // Only headline metrics with enough coverage to analyse.
    return seen.filter(name => joint.filter(d => d.metrics[name] != null).length >= 21)
  }, [joint])

  const [selMetric, setSelMetric] = useState<string | null>(null)
  const metric = selMetric ?? metricNames[0] ?? null

  const period = useMemo(() => {
    const pw = railwayPeriodWeek(isoToday())
    return { ...pw, ...railwayPeriodBounds(pw.period, pw.railYear) }
  }, [])

  const analysis = useMemo<DriverAnalysis | null>(
    () => (metric ? analyzeDrivers(joint, metric) : null),
    [joint, metric],
  )

  const forecast = useMemo<MetricForecast | null>(
    () => (metric ? forecastMetric(joint, metric, FORECAST_DAYS, { from: period.from, to: period.to }) : null),
    [joint, metric, period],
  )

  // Correlation matrix across every analysable metric × factor.
  const matrix = useMemo(() => {
    return metricNames.map(name => {
      const days = joint.filter(d => d.metrics[name] != null)
      const y = days.map(d => d.metrics[name])
      return {
        metric: name,
        cells: FACTOR_KEYS.map(key => ({ key, r: pearson(days.map(d => d.factors[key]), y) })),
      }
    })
  }, [joint, metricNames])

  const chartData = useMemo(() => {
    if (!metric || !forecast) return []
    const hist = joint
      .filter(d => d.metrics[metric] != null)
      .slice(-CHART_HISTORY_DAYS)
      .map(d => ({ date: d.date, actual: d.metrics[metric] as number | null, forecast: null as number | null, band: null as [number, number] | null }))
    // Anchor the forecast line to the last actual so the chart reads as one path.
    const lastActual = hist[hist.length - 1]
    const fc = forecast.points.slice(0, FORECAST_DAYS).map(p => ({
      date: p.date, actual: null as number | null, forecast: p.value as number | null, band: [p.lo, p.hi] as [number, number] | null,
    }))
    if (lastActual && fc.length) {
      lastActual.forecast = lastActual.actual
      lastActual.band = [lastActual.actual as number, lastActual.actual as number]
    }
    return [...hist, ...fc]
  }, [joint, metric, forecast])

  // ── States ─────────────────────────────────────────────────────────────────
  if (!isSupabaseConfigured()) {
    return (
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-1">
          <Activity size={14} style={{ color: 'var(--ink-400)' }} />
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Predictive analytics · performance × CCIL</h3>
        </div>
        <p className="text-[11px]" style={{ color: 'var(--ink-400)' }}>
          Driver analysis and forecasting need the live performance feed and incident log — not available in demo mode.
        </p>
      </div>
    )
  }

  if (failed || (joint.length > 0 && metricNames.length === 0) || (snapshots && incidents && joint.length === 0)) {
    return (
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-1">
          <Activity size={14} style={{ color: 'var(--ink-400)' }} />
          <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Predictive analytics · performance × CCIL</h3>
        </div>
        <p className="text-[11px]" style={{ color: 'var(--ink-400)' }}>
          Not enough overlapping history yet between performance snapshots and the incident log (needs 21+ joint days).
        </p>
      </div>
    )
  }

  if (!snapshots || !incidents) {
    return (
      <div className="card p-5 flex items-center gap-2 text-xs" style={{ color: 'var(--ink-400)' }}>
        <RefreshCw size={12} className="animate-spin" /> Computing performance drivers…
      </div>
    )
  }

  const drivers = analysis?.drivers.filter(d => Math.abs(d.r) >= 0.05).slice(0, 6) ?? []
  const maxAbsPP = Math.max(0.1, ...(forecast?.contributions.map(c => Math.abs(c.pp)) ?? []))

  return (
    <div className="card p-5 tick-corners">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <div className="flex items-center gap-2">
            <Activity size={14} style={{ color: 'var(--nr-orange)' }} />
            <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Predictive analytics · performance × CCIL</h3>
          </div>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
            {joint.length} joint days of history · drivers from a multi-factor fit on daily final standings vs same-day incident load · forecast is autoregressive + expected factor levels
          </p>
        </div>
        <div className="flex gap-1 flex-wrap">
          {metricNames.map(n => (
            <button
              key={n}
              onClick={() => setSelMetric(n)}
              className={`btn !py-0.5 !px-1.5 !text-[9px] ${metric === n ? 'btn-active' : ''}`}
            >
              {n.replace(' %', '')}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        {/* Forecast chart */}
        <div>
          <div className="label-micro mb-2">
            {metric} · last {CHART_HISTORY_DAYS} days + {FORECAST_DAYS}-day forecast
          </div>
          {forecast && chartData.length ? (
            <>
              <ResponsiveContainer width="100%" height={210}>
                <ComposedChart data={chartData} margin={{ top: 6, right: 12, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="2 6" />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono' }} tickFormatter={(d: string) => d.slice(5)} />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono' }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card-hi)', border: '1px solid var(--line-hi)', fontSize: 11 }}
                    labelStyle={{ color: 'var(--ink-300)' }}
                    formatter={(v: number | [number, number], name: string) =>
                      Array.isArray(v) ? [`${fmt(v[0])} – ${fmt(v[1])}`, 'range'] : [fmt(v), name]}
                  />
                  {forecast.target != null && (
                    <ReferenceLine y={forecast.target} stroke="#27AE60" strokeDasharray="5 3" strokeOpacity={0.7}
                      label={{ value: `target ${fmt(forecast.target)}`, position: 'insideTopRight', fill: '#27AE60', fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                  )}
                  <ReferenceLine x={isoToday()} stroke="var(--ink-500)" strokeDasharray="3 3"
                    label={{ value: 'today', position: 'insideTopLeft', fill: 'var(--ink-500)', fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                  <Area dataKey="band" stroke="none" fill="var(--nr-orange)" fillOpacity={0.12} connectNulls={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="actual" stroke="var(--nr-orange)" strokeWidth={1.8} dot={{ r: 2.5 }} connectNulls={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="forecast" stroke="var(--nr-orange)" strokeWidth={1.6} strokeDasharray="6 4" dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="text-[10.5px] mt-1" style={{ color: 'var(--ink-500)' }}>
                Tomorrow: <span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{fmt(forecast.points[0]?.value)}</span>
                {' '}(± {fmt(forecast.points[0] ? forecast.points[0].hi - forecast.points[0].value : null)})
                {forecast.periodEndAvg != null && (
                  <> · projected period average by {period.to}: <span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{fmt(forecast.periodEndAvg)}</span>
                  {forecast.target != null && <> vs target {fmt(forecast.target)}</>}</>
                )}
                {' '}· model MAE ±{fmt(forecast.mae)}pp, R² {fmt(forecast.r2, 2)}, in-sample over {forecast.n} days.
              </div>
            </>
          ) : (
            <div className="text-[11px] py-8 text-center" style={{ color: 'var(--ink-500)' }}>
              Needs at least 21 joint days for this metric.
            </div>
          )}
        </div>

        {/* Driver ranking + tomorrow's contributions */}
        <div>
          <div className="label-micro mb-2">What moves {metric ?? '—'} · strongest factors first</div>
          {drivers.length === 0 ? (
            <div className="text-[11px] py-8 text-center" style={{ color: 'var(--ink-500)' }}>No measurable factor relationships yet.</div>
          ) : (
            <div className="space-y-1.5 mb-4">
              {drivers.map(d => {
                const harm = metric && lowerIsBetter(metric) ? d.r > 0 : d.r < 0
                return (
                  <div key={d.factor} className="flex items-center gap-2 text-[11px]">
                    <span className="w-44 truncate" style={{ color: 'var(--ink-300)' }}>{d.label}</span>
                    <div className="flex-1 h-2 rounded-sm overflow-hidden" style={{ background: 'var(--bg-card-hi)' }}>
                      <div
                        className="h-full"
                        style={{ width: `${Math.min(100, Math.abs(d.r) * 130)}%`, background: harm ? '#E74C3C' : '#27AE60' }}
                      />
                    </div>
                    <span className="numeric-mono w-14 text-right" style={{ color: 'var(--ink-400)' }}>r {d.r.toFixed(2)}</span>
                    <span className="numeric-mono w-28 text-right text-[10px]" style={{ color: 'var(--ink-500)' }}>
                      {d.factor.endsWith('Delay')
                        ? `${d.effectPer100 >= 0 ? '+' : ''}${d.effectPer100.toFixed(1)}pp / +100min`
                        : `${d.effectPer100 >= 0 ? '+' : ''}${(d.effectPer100 / 100).toFixed(2)}pp / +1`}
                    </span>
                  </div>
                )
              })}
              {analysis && (
                <div className="text-[10px] pt-1" style={{ color: 'var(--ink-500)' }}>
                  Together these factors explain {(analysis.r2 * 100).toFixed(0)}% of day-to-day variation over {analysis.n} days (residual σ {fmt(analysis.residualSigma)}pp).
                </div>
              )}
            </div>
          )}

          {forecast && forecast.contributions.length > 0 && (
            <>
              <div className="label-micro mb-2">Tomorrow&apos;s forecast — what&apos;s pulling it</div>
              <div className="space-y-1">
                {forecast.contributions.map(c => (
                  <div key={c.label} className="flex items-center gap-2 text-[11px]">
                    <span className="w-44 truncate" style={{ color: 'var(--ink-300)' }}>{c.label}</span>
                    <div className="flex-1 flex items-center">
                      <div className="w-1/2 flex justify-end">
                        {c.pp < 0 && <div className="h-2 rounded-sm" style={{ width: `${Math.abs(c.pp) / maxAbsPP * 100}%`, background: '#E74C3C' }} />}
                      </div>
                      <div className="w-px h-3" style={{ background: 'var(--line-hi)' }} />
                      <div className="w-1/2">
                        {c.pp > 0 && <div className="h-2 rounded-sm" style={{ width: `${c.pp / maxAbsPP * 100}%`, background: '#27AE60' }} />}
                      </div>
                    </div>
                    <span className="numeric-mono w-14 text-right" style={{ color: 'var(--ink-400)' }}>{c.pp >= 0 ? '+' : ''}{c.pp.toFixed(1)}pp</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Metric × factor correlation matrix */}
      <div className="overflow-x-auto">
        <div className="label-micro mb-2">Correlation matrix · daily metric value vs same-day incident factors</div>
        <table className="text-[10px]" style={{ borderCollapse: 'separate', borderSpacing: 2 }}>
          <thead>
            <tr>
              <th className="text-left pr-2 label-micro text-[9px]" style={{ color: 'var(--ink-400)' }}>Metric</th>
              {FACTOR_KEYS.map(k => (
                <th key={k} className="label-micro text-[8.5px] px-1 text-center" style={{ color: 'var(--ink-400)', maxWidth: 74 }}>
                  {FACTOR_LABELS[k].replace(' (min)', '').replace(' (full+part)', '')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map(row => (
              <tr key={row.metric}>
                <td className="pr-2 whitespace-nowrap" style={{ color: 'var(--ink-300)' }}>{row.metric}</td>
                {row.cells.map(c => (
                  <td
                    key={c.key}
                    className="numeric-mono text-center rounded-sm"
                    style={{ background: corrColour(c.r, row.metric), color: Math.abs(c.r) > 0.25 ? '#fff' : 'var(--ink-300)', minWidth: 46, padding: '3px 4px' }}
                    title={`${row.metric} vs ${FACTOR_LABELS[c.key]}: r = ${c.r.toFixed(2)}`}
                  >
                    {c.r.toFixed(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-[10px] mt-2" style={{ color: 'var(--ink-500)' }}>
          Red = association that worsens the metric, green = improves; intensity follows strength. Correlations are same-day and observational — they suggest, not prove, causation.
          Factor delay minutes are continuation-aware and exclude off-route incidents, matching the rest of Insight. Forecast assumes typical incident load (recent activity blended with weekday patterns); a major event will break it — read the band, not the line.
        </div>
      </div>
    </div>
  )
}
