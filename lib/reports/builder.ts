// ─── Report builder ──────────────────────────────────────────────────────────
// Assembles a ReportPlan from already-derived analytics (RawData + filters).
// Sections that aren't in `options.sections` are omitted from the plan.

import {
  CATEGORY_CONFIG, IncidentRow, SAFETY_CATEGORIES, Severity,
} from '../types'
import {
  deriveKPIs, deriveTrend, deriveCategorySplit, deriveLocationHotspots,
  deriveRepeatAssets, deriveHeatmap, deriveSignals, deriveDelayAttribution,
  deriveChangePoints, effectiveDelay, effectiveDuration, effectiveMinsToArrival,
  nonContinuation, RawData,
} from '../queries'
import { railwayPeriodWeek } from '../railwayCalendar'
import { buildNarrative } from './narrative'
import {
  AppendixRow, AssetRow, AttributionRow, CategoryRow, ChangePointRow, GeoRow,
  HeatmapCellPlain, ReportKpi, ReportOptions, ReportPlan, ReportSource,
  SafetyRadarRow, SignalRow, TrendPointPlain,
} from './types'

// ─── Scope label ─────────────────────────────────────────────────────────────

function shortDate(iso: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`
}

function buildScopeLabel(template: ReportOptions['template'], from: string, to: string, days: number): string {
  if (template === 'period') {
    const pwFrom = railwayPeriodWeek(from)
    const pwTo   = railwayPeriodWeek(to)
    if (pwFrom.period === pwTo.period && pwFrom.railYear === pwTo.railYear) {
      return `${pwFrom.yearLabel} · P${String(pwFrom.period).padStart(2, '0')} (W${pwFrom.week}–W${pwTo.week})`
    }
    return `${pwFrom.yearLabel} · P${String(pwFrom.period).padStart(2, '0')} W${pwFrom.week} → P${String(pwTo.period).padStart(2, '0')} W${pwTo.week}`
  }
  if (template === 'weekly')  return `${shortDate(from)} → ${shortDate(to)} · 7-day brief`
  if (template === 'safety')  return `${shortDate(from)} → ${shortDate(to)} · safety roll-up`
  return `${shortDate(from)} → ${shortDate(to)} · ${days}-day window`
}

// ─── KPI list builder ────────────────────────────────────────────────────────

function buildKpis(data: RawData): ReportKpi[] {
  const k = deriveKPIs(data)
  const fmt = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: 0 })
  const fmtMins = (n: number) => {
    if (n >= 60) {
      const h = Math.floor(n / 60)
      const m = Math.round(n % 60)
      return m === 0 ? `${h}h` : `${h}h ${m}m`
    }
    return `${Math.round(n)}m`
  }
  return [
    { label: 'Incidents',          value: fmt(k.totalIncidents),                  delta: { signedPct: k.incidentsDeltaPct, deltaInverted: true,  label: 'vs prior' } },
    { label: 'Delay-minutes',      value: fmtMins(k.totalDelayMins),              delta: { signedPct: k.delayDeltaPct,     deltaInverted: true,  label: 'vs prior' } },
    { label: 'Safety-critical',    value: fmt(k.safetyCriticalCount),             delta: { signedPct: k.safetyDeltaPct,    deltaInverted: true,  label: 'vs prior' }, critical: k.safetyCriticalCount > 0 },
    { label: 'Trains delayed',     value: fmt(k.totalTrainsDelayed),              hint: `${fmt(k.totalCancelled)} cancelled · ${fmt(k.totalPartCancelled)} part-cancelled` },
    { label: 'Avg duration',       value: k.avgIncidentDuration != null ? fmtMins(k.avgIncidentDuration) : '—', delta: k.durationDeltaPct != null ? { signedPct: k.durationDeltaPct, deltaInverted: true, label: 'vs prior' } : undefined },
    { label: 'Median arrival',     value: k.medianArrivalMins != null ? `${Math.round(k.medianArrivalMins)}m` : '—' },
    { label: 'Arrival-SLA met',    value: k.slaCompliancePct != null ? `${k.slaCompliancePct.toFixed(0)}%` : '—', delta: k.slaBreachDeltaPct != null ? { signedPct: k.slaBreachDeltaPct, deltaInverted: true, label: 'breach Δ' } : undefined, hint: `${k.slaBreachCount} breach${k.slaBreachCount === 1 ? '' : 'es'} of 45-min target` },
    { label: 'Reports covered',    value: fmt(k.reportsCovered), hint: 'Daily logs intercepted' },
  ]
}

function buildHeroKpis(data: RawData): ReportKpi[] {
  const k = deriveKPIs(data)
  const fmt = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: 0 })
  const fmtMins = (n: number) => {
    if (n >= 60) {
      const h = Math.floor(n / 60)
      const m = Math.round(n % 60)
      return m === 0 ? `${h}h` : `${h}h ${m}m`
    }
    return `${Math.round(n)}m`
  }
  return [
    { label: 'Incidents',       value: fmt(k.totalIncidents),     delta: { signedPct: k.incidentsDeltaPct, deltaInverted: true, label: 'vs prior' } },
    { label: 'Delay-minutes',   value: fmtMins(k.totalDelayMins), delta: { signedPct: k.delayDeltaPct,     deltaInverted: true, label: 'vs prior' } },
    { label: 'Safety-critical', value: fmt(k.safetyCriticalCount),delta: { signedPct: k.safetyDeltaPct,    deltaInverted: true, label: 'vs prior' }, critical: k.safetyCriticalCount > 0 },
    { label: 'Arrival-SLA',     value: k.slaCompliancePct != null ? `${k.slaCompliancePct.toFixed(0)}%` : '—' },
  ]
}

// ─── Categories with share ───────────────────────────────────────────────────

function buildCategoryRows(data: RawData): CategoryRow[] {
  const split = deriveCategorySplit(data)
  const total = split.reduce((s, c) => s + c.count, 0) || 1
  return split.map(c => ({
    category: c.category,
    label:    c.label,
    short:    c.short,
    color:    c.color,
    count:    c.count,
    delayMins: c.delayMins,
    share:    c.count / total,
  }))
}

// ─── Geography ───────────────────────────────────────────────────────────────

function buildGeography(data: RawData, limit = 12): GeoRow[] {
  const hots = deriveLocationHotspots(data, limit)
  // Tag each hotspot with the most-frequent category at that location
  const topCatByLoc = new Map<string, Map<string, number>>()
  for (const i of nonContinuation(data.incidents)) {
    const loc = i.location?.trim()
    if (!loc) continue
    const m = topCatByLoc.get(loc) ?? new Map<string, number>()
    m.set(i.category, (m.get(i.category) ?? 0) + 1)
    topCatByLoc.set(loc, m)
  }
  return hots.map(h => {
    const m = topCatByLoc.get(h.location)
    let topCategory: GeoRow['topCategory'] = null
    if (m) {
      let bestK = ''; let bestV = 0
      for (const [k, v] of m.entries()) if (v > bestV) { bestV = v; bestK = k }
      if (bestK) {
        const cfg = CATEGORY_CONFIG[bestK as keyof typeof CATEGORY_CONFIG]
        if (cfg) topCategory = { label: cfg.label, color: cfg.color }
      }
    }
    return {
      location:  h.location,
      area:      h.area,
      count:     h.count,
      delayMins: h.delayMins,
      topCategory,
    }
  })
}

// ─── Repeat assets ───────────────────────────────────────────────────────────

function buildAssets(data: RawData, limit = 10): AssetRow[] {
  return deriveRepeatAssets(data, limit).map(a => ({
    assetType:   a.assetType,
    location:    a.location,
    occurrences: a.occurrences,
    totalDelay:  a.totalDelay,
    firstSeen:   a.firstSeen,
    lastSeen:    a.lastSeen,
    category:    a.category,
  }))
}

// ─── Signals ─────────────────────────────────────────────────────────────────

function buildSignals(data: RawData, limit = 8): SignalRow[] {
  return deriveSignals(data).slice(0, limit).map(s => ({
    severity: s.severity,
    title:    s.title,
    detail:   s.detail,
    date:     s.date,
  }))
}

function buildChangePoints(trend: ReturnType<typeof deriveTrend>): ChangePointRow[] {
  return deriveChangePoints(trend).map(cp => ({
    date:       cp.date,
    direction:  cp.direction,
    metric:     cp.metric === 'safetyCritical' ? 'incidents' : cp.metric,
    beforeMean: cp.beforeMean,
    afterMean:  cp.afterMean,
  }))
}

// ─── Safety radar ────────────────────────────────────────────────────────────

function buildSafetyRadar(data: RawData): SafetyRadarRow[] {
  const counts = (rows: IncidentRow[]) => {
    const m = new Map<string, number>()
    for (const i of nonContinuation(rows)) {
      if (!SAFETY_CATEGORIES.includes(i.category)) continue
      m.set(i.category, (m.get(i.category) ?? 0) + 1)
    }
    return m
  }
  const cur  = counts(data.incidents)
  const prev = counts(data.prevIncidents)
  // FATALITY rows are normalised to PERSON_STRUCK upstream, so the radar
  // shows PST as a single combined axis.
  const cats = SAFETY_CATEGORIES.filter(c => c !== 'FATALITY')
  return cats.map(c => ({
    category: c,
    label:    CATEGORY_CONFIG[c].label,
    short:    CATEGORY_CONFIG[c].short,
    color:    CATEGORY_CONFIG[c].color,
    current:  cur.get(c)  ?? 0,
    previous: prev.get(c) ?? 0,
  }))
}

// ─── Attribution ─────────────────────────────────────────────────────────────

function buildAttribution(data: RawData): AttributionRow[] {
  return deriveDelayAttribution(data).map(a => ({
    label:         a.label,
    code:          a.code,
    incidentCount: a.incidentCount,
    totalDelay:    a.totalDelay,
    pct:           a.pct,
  }))
}

// ─── Heatmap ─────────────────────────────────────────────────────────────────

function buildHeatmap(data: RawData): HeatmapCellPlain[] {
  return deriveHeatmap(data).map(c => ({ dow: c.dow, hour: c.hour, count: c.count }))
}

// ─── Trend ───────────────────────────────────────────────────────────────────

function buildTrend(trend: ReturnType<typeof deriveTrend>): TrendPointPlain[] {
  return trend.map(p => ({
    date:           p.date,
    incidents:      p.incidents,
    delayMins:      p.delayMins,
    safetyCritical: p.safetyCritical,
    rolling7Avg:    p.rolling7Avg,
  }))
}

// ─── Appendix ────────────────────────────────────────────────────────────────

function buildAppendix(data: RawData, limit: number): AppendixRow[] {
  const rows = nonContinuation(data.incidents)
    .map(i => ({
      row:       i,
      delay:     effectiveDelay(i),
    }))
    .sort((a, b) => b.delay - a.delay)
    .slice(0, limit)

  return rows.map(({ row, delay }) => {
    const cfg = CATEGORY_CONFIG[row.category]
    return {
      date:          row.report_date,
      ccil:          row.ccil,
      category:      row.category,
      categoryShort: cfg.short,
      categoryColor: cfg.color,
      severity:      row.severity as Severity,
      title:         row.title ?? '—',
      location:      row.location,
      area:          row.area,
      delayMins:     delay,
      duration:      effectiveDuration(row),
      arrival:       effectiveMinsToArrival(row),
    }
  })
}

// ─── Public entry ────────────────────────────────────────────────────────────

export function buildReportPlan(src: ReportSource, options: ReportOptions): ReportPlan {
  // For the safety template, restrict the working set to safety-critical rows
  // so every section frames the safety story. The KPIs still compute against
  // the full set so context numbers (delay, SLA) stay meaningful — only the
  // category mix, geography, patterns and appendix get the safety lens.
  const isSafetyTemplate = options.template === 'safety'
  const safetyIncidents     = src.incidents.filter(i => SAFETY_CATEGORIES.includes(i.category))
  const safetyPrevIncidents = src.prevIncidents.filter(i => SAFETY_CATEGORIES.includes(i.category))

  const data: RawData = {
    incidents:     src.incidents,
    prevIncidents: src.prevIncidents,
    reports:       [],
    teamMembers:   [],
    windowFrom:    src.windowFrom,
    windowTo:      src.windowTo,
    windowDays:    src.windowDays,
  }

  const lensData: RawData = isSafetyTemplate
    ? { ...data, incidents: safetyIncidents, prevIncidents: safetyPrevIncidents }
    : data

  const want = new Set(options.sections)

  const trendPts = deriveTrend(data)

  const categories  = buildCategoryRows(lensData)
  const geography   = buildGeography(lensData)
  const assets      = buildAssets(data, 10)
  const signals     = buildSignals(data)
  const changePoints = buildChangePoints(trendPts)
  const kpiSummary  = deriveKPIs(data)

  const narrative = buildNarrative({
    scopeLabel:   buildScopeLabel(options.template, src.windowFrom, src.windowTo, src.windowDays),
    kpis:         kpiSummary,
    categories,
    geography,
    assets,
    signals,
    changePoints,
  })

  const scopeLabel = buildScopeLabel(options.template, src.windowFrom, src.windowTo, src.windowDays)
  const templateName = ({
    period: 'Period Report',
    weekly: 'Weekly Brief',
    safety: 'Safety Roll-up',
    custom: 'Strategic Report',
  } as const)[options.template]

  return {
    meta: {
      template: options.template,
      templateName,
      scopeLabel,
      windowFrom: src.windowFrom,
      windowTo:   src.windowTo,
      windowDays: src.windowDays,
      generatedAt: new Date().toISOString(),
      filtersDescriptor: src.filtersDescriptor,
      demoMode: src.demoMode,
    },
    sections: options.sections,
    heroKpis: buildHeroKpis(data),
    kpis:           want.has('kpis')         ? buildKpis(data) : undefined,
    trend:          want.has('trend')        ? { points: buildTrend(trendPts), changePoints } : undefined,
    categories:     want.has('categoryMix')  ? categories : undefined,
    geography:      want.has('geography')    ? geography : undefined,
    heatmap:        want.has('patterns')     ? buildHeatmap(lensData) : undefined,
    assets:         want.has('assets')       ? assets : undefined,
    safetyRadar:    want.has('safetyRadar')  ? buildSafetyRadar(data) : undefined,
    attribution:    want.has('attribution')  ? buildAttribution(data) : undefined,
    signals:        want.has('signals')      ? signals : undefined,
    narrative:      want.has('narrative')    ? narrative : undefined,
    executive:      want.has('executive')    ? narrative.executive : undefined,
    appendix:       want.has('appendix')     ? buildAppendix(lensData, options.appendixLimit) : undefined,
  }
}
