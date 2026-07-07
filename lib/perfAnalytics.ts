// ─── Performance × CCIL analytics ────────────────────────────────────────────
// Joins the daily performance standings (ma_message_snapshots, via
// pickDailyFinal) to daily aggregates of the CCIL incident log, then:
//
//   1. Driver analysis — which incident factors correlate most with each
//      metric's daily behaviour (Pearson r + OLS effect size per factor, and
//      a ridge-regularised multi-factor fit for combined explanatory power).
//   2. Forecast — an autoregressive + factor model fitted on the joint
//      history, driven forward with expected factor levels (blend of recent
//      EWMA and same-weekday medians), producing a daily prediction with an
//      uncertainty band and a projection to period end.
//
// Everything here is pure and deterministic — no fetching, no dates from the
// clock (the caller supplies "today") — so it is directly unit-testable.

import { PerfSnapshot } from './types'
import { SlimIncident, effectiveDelay, pickDailyFinal } from './queries'

// ─── Daily factor aggregation ─────────────────────────────────────────────────

// Factor grouping keeps the driver list readable: raw CCIL categories are
// collapsed into operationally recognisable delay families.
const FACTOR_GROUPS: Record<string, string[]> = {
  infraDelay: ['INFRASTRUCTURE', 'POSSESSION', 'TPWS'],
  fleetDelay: ['TRAIN_FAULT', 'TRACTION_FAILURE'],
  personDelay: ['PERSON_STRUCK', 'FATALITY', 'PASSENGER_INJURY', 'NEAR_MISS'],
  externalDelay: ['CRIME', 'BRIDGE_STRIKE', 'FIRE', 'LEVEL_CROSSING'],
  weatherDelay: ['WEATHER'],
}

export const FACTOR_LABELS: Record<string, string> = {
  infraDelay: 'Infrastructure delay (min)',
  fleetDelay: 'Fleet delay (min)',
  personDelay: 'Person/injury delay (min)',
  externalDelay: 'External delay (min)',
  weatherDelay: 'Weather delay (min)',
  otherDelay: 'Other delay (min)',
  incidentCount: 'Incident count',
  cancellations: 'Cancellations (full+part)',
  trainsDelayed: 'Trains delayed',
}

export const FACTOR_KEYS = Object.keys(FACTOR_LABELS)

export interface DailyFactors {
  date: string
  [factor: string]: string | number
}

export function buildDailyFactors(incidents: SlimIncident[]): Map<string, DailyFactors> {
  const byDate = new Map<string, DailyFactors>()
  const catToGroup = new Map<string, string>()
  for (const [group, cats] of Object.entries(FACTOR_GROUPS)) {
    for (const c of cats) catToGroup.set(c, group)
  }
  for (const inc of incidents) {
    let f = byDate.get(inc.report_date)
    if (!f) {
      f = { date: inc.report_date }
      for (const k of FACTOR_KEYS) f[k] = 0
      byDate.set(inc.report_date, f)
    }
    const delay = effectiveDelay(inc) // continuation-aware, off-route excluded
    const group = catToGroup.get(inc.category as string) ?? 'otherDelay'
    f[group] = (f[group] as number) + delay
    if (!inc.is_continuation && !inc.is_off_route) {
      f.incidentCount = (f.incidentCount as number) + 1
      f.cancellations = (f.cancellations as number) + (inc.cancelled ?? 0) + (inc.part_cancelled ?? 0)
      f.trainsDelayed = (f.trainsDelayed as number) + (inc.trains_delayed ?? 0)
    }
  }
  return byDate
}

// ─── Joint daily series ───────────────────────────────────────────────────────

export interface JointDay {
  date: string
  dow: number                            // 0=Sun … 6=Sat
  metrics: Record<string, number>        // daily final value per metric name
  targets: Record<string, number | null>
  factors: Record<string, number>
}

export function buildJointSeries(
  snapshots: PerfSnapshot[],
  incidents: SlimIncident[],
): JointDay[] {
  const factors = buildDailyFactors(incidents)
  const dates = Array.from(new Set(snapshots.map(s => s.metrics_for_date))).sort()
  const out: JointDay[] = []
  for (const date of dates) {
    const f = factors.get(date)
    if (!f) continue                     // require both sides of the join
    const snap = pickDailyFinal(snapshots, date)
    if (!snap) continue
    const metrics: Record<string, number> = {}
    const targets: Record<string, number | null> = {}
    for (const m of snap.metrics) {
      if (m.value == null) continue
      metrics[m.name] = m.value
      targets[m.name] = m.target
    }
    if (Object.keys(metrics).length === 0) continue
    const fac: Record<string, number> = {}
    for (const k of FACTOR_KEYS) fac[k] = (f[k] as number) ?? 0
    out.push({ date, dow: new Date(date + 'T00:00:00Z').getUTCDay(), metrics, targets, factors: fac })
  }
  return out
}

// ─── Statistics utilities ─────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1))
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return 0
  const mx = mean(xs), my = mean(ys)
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
    syy += (ys[i] - my) ** 2
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0
}

// Solve (XᵀX + λI)β = Xᵀy by Gaussian elimination — inputs are standardized,
// K is small, so this is numerically comfortable.
function ridge(X: number[][], y: number[], lambda: number): number[] {
  const n = X.length, k = X[0]?.length ?? 0
  if (!n || !k) return []
  const A: number[][] = Array.from({ length: k }, () => new Array(k + 1).fill(0))
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      let s = 0
      for (let i = 0; i < n; i++) s += X[i][a] * X[i][b]
      A[a][b] = s + (a === b ? lambda * n : 0)
    }
    let s = 0
    for (let i = 0; i < n; i++) s += X[i][a] * y[i]
    A[a][k] = s
  }
  for (let col = 0; col < k; col++) {
    let piv = col
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
    ;[A[col], A[piv]] = [A[piv], A[col]]
    if (Math.abs(A[col][col]) < 1e-12) continue
    for (let r = 0; r < k; r++) {
      if (r === col) continue
      const f = A[r][col] / A[col][col]
      for (let c = col; c <= k; c++) A[r][c] -= f * A[col][c]
    }
  }
  return A.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[k] / row[i]))
}

// ─── Driver analysis ──────────────────────────────────────────────────────────

export interface DriverStat {
  factor: string
  label: string
  r: number                // Pearson correlation with the metric's daily value
  effectPer100: number     // OLS slope × 100 units of the factor (pp of metric)
  beta: number             // standardized coefficient in the multi-factor fit
  meanLevel: number        // average daily level of the factor
}

export interface DriverAnalysis {
  metric: string
  n: number
  r2: number               // multi-factor fit quality
  residualSigma: number
  drivers: DriverStat[]    // sorted by |r| desc — plain association reads
                           // consistently in the UI; β can sign-flip under
                           // collinearity and is kept as supporting data
}

export function analyzeDrivers(joint: JointDay[], metric: string): DriverAnalysis | null {
  const days = joint.filter(d => d.metrics[metric] != null)
  if (days.length < 14) return null
  const y = days.map(d => d.metrics[metric])
  const my = mean(y), sy = stdev(y) || 1

  const stats: DriverStat[] = []
  const cols: number[][] = []
  for (const key of FACTOR_KEYS) {
    const xs = days.map(d => d.factors[key])
    const sx = stdev(xs)
    const r = pearson(xs, y)
    // OLS slope in natural units: r × (σy/σx); scaled to a +100-unit change.
    const effectPer100 = sx > 0 ? r * (sy / sx) * 100 : 0
    stats.push({ factor: key, label: FACTOR_LABELS[key], r, effectPer100, beta: 0, meanLevel: mean(xs) })
    cols.push(sx > 0 ? xs.map(v => (v - mean(xs)) / sx) : xs.map(() => 0))
  }

  // Multi-factor ridge fit on standardized factors → relative contributions.
  const X = days.map((_, i) => cols.map(c => c[i]))
  const yStd = y.map(v => (v - my) / sy)
  const betas = ridge(X, yStd, 0.05)
  stats.forEach((s, i) => { s.beta = betas[i] ?? 0 })

  // Fit quality on the same data (in-sample, honest label in the UI).
  let ssRes = 0, ssTot = 0
  for (let i = 0; i < days.length; i++) {
    const pred = X[i].reduce((s, v, j) => s + v * (betas[j] ?? 0), 0)
    ssRes += (yStd[i] - pred) ** 2
    ssTot += yStd[i] ** 2
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0

  return {
    metric,
    n: days.length,
    r2,
    residualSigma: Math.sqrt(ssRes / Math.max(1, days.length - FACTOR_KEYS.length)) * sy,
    drivers: [...stats].sort((a, b) => Math.abs(b.r) - Math.abs(a.r)),
  }
}

// ─── Forecast ─────────────────────────────────────────────────────────────────

export interface ForecastPoint {
  date: string
  value: number
  lo: number
  hi: number
  factorLoad: number       // expected total delay minutes driving this day
}

export interface MetricForecast {
  metric: string
  n: number
  r2: number
  mae: number
  points: ForecastPoint[]
  periodEndAvg: number | null   // projected mean daily standing over the period
  target: number | null
  contributions: { label: string; pp: number }[]  // tomorrow's deviation drivers
}

function addDaysIso(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Expected factor level for a future date: recency-weighted average (EWMA,
// half-life 5 days) blended equally with the median for that weekday.
function expectFactor(days: JointDay[], key: string, dow: number): number {
  const recent = days.slice(-21)
  let w = 0, sw = 0
  recent.forEach((d, i) => {
    const weight = Math.pow(0.5, (recent.length - 1 - i) / 5)
    w += weight * d.factors[key]
    sw += weight
  })
  const ewma = sw > 0 ? w / sw : 0
  const sameDow = days.filter(d => d.dow === dow).map(d => d.factors[key])
  const dowMed = sameDow.length >= 3 ? median(sameDow) : ewma
  return (ewma + dowMed) / 2
}

// Autoregressive + factor model:
//   y_t = α + φ·y_{t-1} + Σ βk·factor_k(t) + weekend term
// fitted with ridge on standardized features, then iterated forward with
// expected factor levels. The band grows with horizon via residual σ·√step.
export function forecastMetric(
  joint: JointDay[],
  metric: string,
  horizonDays: number,
  period: { from: string; to: string } | null,
): MetricForecast | null {
  const periodEnd = period?.to ?? null
  const days = joint.filter(d => d.metrics[metric] != null)
  if (days.length < 21) return null

  // Feature rows: predict day i from day i-1's value + day i's factors.
  const featKeys = ['prev', 'weekend', ...FACTOR_KEYS]
  const rawRows: number[][] = []
  const rawY: number[] = []
  for (let i = 1; i < days.length; i++) {
    // Only use consecutive-ish pairs — a gap of more than 3 days breaks the
    // autoregressive link (e.g. missing reports around disruption).
    const gap = (new Date(days[i].date).getTime() - new Date(days[i - 1].date).getTime()) / 86_400_000
    if (gap > 3) continue
    rawRows.push([
      days[i - 1].metrics[metric],
      days[i].dow === 0 || days[i].dow === 6 ? 1 : 0,
      ...FACTOR_KEYS.map(k => days[i].factors[k]),
    ])
    rawY.push(days[i].metrics[metric])
  }
  if (rawRows.length < 14) return null

  const mus = featKeys.map((_, j) => mean(rawRows.map(r => r[j])))
  const sds = featKeys.map((_, j) => stdev(rawRows.map(r => r[j])) || 1)
  const X = rawRows.map(r => r.map((v, j) => (v - mus[j]) / sds[j]))
  const my = mean(rawY), sy = stdev(rawY) || 1
  const yStd = rawY.map(v => (v - my) / sy)
  const betas = ridge(X, yStd, 0.05)

  const predictStd = (feat: number[]) =>
    feat.map((v, j) => (v - mus[j]) / sds[j]).reduce((s, v, j) => s + v * (betas[j] ?? 0), 0)
  const predict = (feat: number[]) => my + sy * predictStd(feat)

  // In-sample quality.
  let ssRes = 0, ssTot = 0, absErr = 0
  for (let i = 0; i < X.length; i++) {
    const p = my + sy * X[i].reduce((s, v, j) => s + v * (betas[j] ?? 0), 0)
    ssRes += (rawY[i] - p) ** 2
    ssTot += (rawY[i] - my) ** 2
    absErr += Math.abs(rawY[i] - p)
  }
  const sigma = Math.sqrt(ssRes / Math.max(1, X.length - featKeys.length))

  // Iterate forward from the last observed day.
  const last = days[days.length - 1]
  const points: ForecastPoint[] = []
  let prevValue = last.metrics[metric]
  const horizon = periodEnd
    ? Math.max(horizonDays, Math.min(28, Math.round((new Date(periodEnd).getTime() - new Date(last.date).getTime()) / 86_400_000)))
    : horizonDays
  for (let k = 1; k <= horizon; k++) {
    const date = addDaysIso(last.date, k)
    const dow = new Date(date + 'T00:00:00Z').getUTCDay()
    const facs = FACTOR_KEYS.map(key => expectFactor(days, key, dow))
    const feat = [prevValue, dow === 0 || dow === 6 ? 1 : 0, ...facs]
    const value = predict(feat)
    const band = sigma * Math.sqrt(k)
    points.push({
      date,
      value,
      lo: value - band,
      hi: value + band,
      factorLoad: facs.slice(0, 6).reduce((s, v) => s + v, 0),  // delay-minute factors
    })
    prevValue = value
  }

  // Tomorrow's deviation drivers: per-feature contribution (in pp) away from
  // the historical mean, from the standardized fit.
  const tomorrow = points[0]
  const tomorrowFeat = [last.metrics[metric], new Date(tomorrow.date + 'T00:00:00Z').getUTCDay() % 6 === 0 ? 1 : 0,
    ...FACTOR_KEYS.map(key => expectFactor(days, key, new Date(tomorrow.date + 'T00:00:00Z').getUTCDay()))]
  const contributions = featKeys.map((key, j) => ({
    label: key === 'prev' ? 'Momentum (yesterday)' : key === 'weekend' ? 'Weekend effect' : FACTOR_LABELS[key],
    pp: sy * ((tomorrowFeat[j] - mus[j]) / sds[j]) * (betas[j] ?? 0),
  })).sort((a, b) => Math.abs(b.pp) - Math.abs(a.pp))

  // Period-end projection: mean of period-to-date actuals + forecast days
  // through the period end (only meaningful when a period frame is given).
  let periodEndAvg: number | null = null
  if (period) {
    const ptd = days.filter(d => d.date >= period.from && d.date <= period.to).map(d => d.metrics[metric])
    const future = points.filter(p => p.date <= period.to).map(p => p.value)
    const all = [...ptd, ...future]
    periodEndAvg = all.length ? mean(all) : null
  }

  return {
    metric,
    n: rawRows.length,
    r2: ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0,
    mae: absErr / Math.max(1, X.length),
    points,
    periodEndAvg,
    target: last.targets[metric] ?? null,
    contributions: contributions.filter(c => Math.abs(c.pp) >= 0.05).slice(0, 5),
  }
}
