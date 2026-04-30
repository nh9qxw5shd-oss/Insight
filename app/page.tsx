'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity, AlertTriangle, Bell, ChevronDown, ChevronLeft, ChevronRight,
  Clock, Download, Filter, GitBranch, Layers, MapPin, RefreshCw, Route, Search,
  TrendingDown, TrendingUp, Train, Wrench, X, Zap, type LucideIcon,
} from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart,
  Pie, PieChart, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart,
  ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, Treemap, XAxis, YAxis,
} from 'recharts'
import { isSupabaseConfigured } from '@/lib/supabase'
import {
  AnalyticsFilters, DEFAULT_FILTERS, IncidentCategory, IncidentRow, Severity,
  CATEGORY_CONFIG, SEVERITY_CONFIG, SAFETY_CATEGORIES,
  TIME_WINDOWS, ChartKind, DistributionKind, Signal, ChangePoint,
  DeltaMetric, DeltaDecomposition, HypothesisCluster, Hypothesis,
} from '@/lib/types'
import {
  fetchAnalytics, deriveKPIs, deriveTrend, deriveCategorySplit,
  deriveLocationHotspots, deriveRepeatFaults, deriveRepeatAssets,
  deriveInfraFailureMix, deriveDelayDensity, deriveResponderLoad,
  deriveOperatorImpact, deriveHeatmap, deriveAreaList, deriveResponseDistribution,
  deriveSignals, deriveLineBreakdown, deriveDelayAttribution, deriveContinuationChains,
  deriveChangePoints, deriveDelta, deriveHypotheses,
  RawData,
} from '@/lib/queries'
import {
  toggleCategoryFilter, toggleAreaFilter, toggleSeverityFilter,
  removeSearchToken, clearCustomDate,
} from '@/lib/filterActions'
import { generateSyntheticData } from '@/lib/syntheticData'
import { getSavedViews, saveView, deleteView, SavedView } from '@/lib/savedViews'
import { getFiltersFromUrl, setFiltersInUrl, clearFiltersFromUrl } from '@/lib/filterUrl'
import { exportCSV } from '@/lib/export'

// ─── Tabs ────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'safety' | 'performance' | 'geography' | 'patterns' | 'assets' | 'routes' | 'trends'
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'overview',    label: 'Overview',    icon: Activity },
  { id: 'safety',      label: 'Safety',      icon: AlertTriangle },
  { id: 'performance', label: 'Performance', icon: TrendingUp },
  { id: 'geography',   label: 'Geography',   icon: MapPin },
  { id: 'patterns',    label: 'Patterns',    icon: Layers },
  { id: 'assets',      label: 'Assets',      icon: Wrench },
  { id: 'routes',      label: 'Routes',      icon: Route },
  { id: 'trends',      label: 'Trends',      icon: GitBranch },
]

// ─── Window navigation helper ────────────────────────────────────────────────

function localISODate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function shiftWindow(f: AnalyticsFilters, dir: -1 | 1): AnalyticsFilters {
  // Logs cover the previous 24-hour period, so the effective data ceiling is yesterday.
  const yesterdayMs = Date.now() - 86_400_000
  const curEndMs  = f.endDate
    ? new Date(f.endDate + 'T00:00:00Z').getTime()
    : yesterdayMs
  const days      = f.windowDays
  const newEndMs  = curEndMs + dir * days * 86_400_000

  // Clamp: don't step forward past yesterday
  if (newEndMs > yesterdayMs) {
    if (dir === 1) return f
    const clampedMs = yesterdayMs
    return {
      ...f,
      startDate: new Date(clampedMs - (days - 1) * 86_400_000).toISOString().slice(0, 10),
      endDate:   new Date(clampedMs).toISOString().slice(0, 10),
    }
  }

  return {
    ...f,
    startDate: new Date(newEndMs - (days - 1) * 86_400_000).toISOString().slice(0, 10),
    endDate:   new Date(newEndMs).toISOString().slice(0, 10),
  }
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function InsightDashboard() {
  const [filters, setFilters] = useState<AnalyticsFilters>(() => getFiltersFromUrl() ?? DEFAULT_FILTERS)
  const [tab, setTab] = useState<Tab>('overview')
  const [data, setData] = useState<RawData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [demoMode, setDemoMode] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [trendChart, setTrendChart] = useState<ChartKind>('area')
  const [distChart, setDistChart] = useState<DistributionKind>('donut')
  const [drillDown, setDrillDown] = useState<{ title: string; incidents: IncidentRow[] } | null>(null)
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => getSavedViews())
  const [signalsOpen, setSignalsOpen] = useState(false)

  // Keep URL in sync with filters
  useEffect(() => { setFiltersInUrl(filters) }, [filters])

  // Fetch on filter change
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    async function run() {
      try {
        if (!isSupabaseConfigured()) {
          if (!cancelled) {
            setData(generateSyntheticData(filters.windowDays, 42, filters.startDate, filters.endDate))
            setDemoMode(true)
            setLoading(false)
          }
          return
        }
        const result = await fetchAnalytics(filters)
        if (cancelled) return
        if (!result || result.incidents.length === 0) {
          // Empty → fall back to demo so the dashboard isn't a void
          setData(generateSyntheticData(filters.windowDays, 42, filters.startDate, filters.endDate))
          setDemoMode(true)
        } else {
          setData(result)
          setDemoMode(false)
        }
      } catch (e: any) {
        if (cancelled) return
        setError(e.message || 'Failed to load analytics')
        setData(generateSyntheticData(filters.windowDays, 42, filters.startDate, filters.endDate))
        setDemoMode(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [filters])

  // Derived
  const kpis         = useMemo(() => data ? deriveKPIs(data) : null, [data])
  const trend        = useMemo(() => data ? deriveTrend(data) : [], [data])
  const cats         = useMemo(() => data ? deriveCategorySplit(data) : [], [data])
  const hots         = useMemo(() => data ? deriveLocationHotspots(data) : [], [data])
  const faults       = useMemo(() => data ? deriveRepeatFaults(data) : [], [data])
  const repeatAssets = useMemo(() => data ? deriveRepeatAssets(data) : [], [data])
  const infraMix     = useMemo(() => data ? deriveInfraFailureMix(data) : [], [data])
  const delayDensity = useMemo(() => data ? deriveDelayDensity(data) : [], [data])
  const resp         = useMemo(() => data ? deriveResponderLoad(data) : [], [data])
  const ops          = useMemo(() => data ? deriveOperatorImpact(data) : [], [data])
  const heat         = useMemo(() => data ? deriveHeatmap(data) : [], [data])
  const areas        = useMemo(() => data ? deriveAreaList(data) : [], [data])
  const respDist     = useMemo(() => data ? deriveResponseDistribution(data) : null, [data])
  const signals      = useMemo(() => data ? deriveSignals(data) : [], [data])
  const lines        = useMemo(() => data ? deriveLineBreakdown(data) : [], [data])
  const attribution  = useMemo(() => data ? deriveDelayAttribution(data) : [], [data])
  const chains       = useMemo(() => data ? deriveContinuationChains(data) : [], [data])
  const changePoints = useMemo(() => deriveChangePoints(trend), [trend])
  const hypotheses   = useMemo(() => data ? deriveHypotheses(data, trend, changePoints) : [], [data, trend, changePoints])

  // Decomposition lookup for KPI cards — computed lazily per card via this
  // closure rather than precomputed for every metric.
  const decompose = useMemo(
    () => (metric: DeltaMetric) => data ? deriveDelta(data, metric) : null,
    [data],
  )

  const handleDateClick = (date: string) => {
    setFilters(f => ({ ...f, startDate: date, endDate: date, windowDays: 1 }))
  }

  // Cross-filter drill-down: chart elements push their underlying value into
  // the corresponding filter list. Each helper toggles, so re-clicking a
  // pinned slice removes it from the filter — same affordance both ways.
  const handleAddCategoryFilter = (c: IncidentCategory) => setFilters(f => toggleCategoryFilter(f, c))
  const handleAddAreaFilter     = (a: string)            => setFilters(f => toggleAreaFilter(f, a))
  const handleAddSeverityFilter = (s: Severity)          => setFilters(f => toggleSeverityFilter(f, s))

  const handleSaveView = (name: string) => {
    const view = saveView(name, filters)
    setSavedViews(vs => [view, ...vs.filter(v => v.id !== view.id)])
  }

  const handleDeleteView = (id: string) => {
    deleteView(id)
    setSavedViews(vs => vs.filter(v => v.id !== id))
  }

  const handleResetFilters = () => {
    setFilters(DEFAULT_FILTERS)
    clearFiltersFromUrl()
  }

  const criticalSignals = signals.filter(s => s.severity === 'critical').length

  return (
    <main className="min-h-screen pb-24">
      <Header
        windowDays={filters.windowDays}
        startDate={filters.startDate}
        endDate={filters.endDate}
        demoMode={demoMode}
        loading={loading}
        onWindowChange={(d) => setFilters({ ...filters, windowDays: d, startDate: undefined, endDate: undefined })}
        onPrevWindow={() => setFilters(f => shiftWindow(f, -1))}
        onNextWindow={() => setFilters(f => shiftWindow(f, 1))}
        isAtToday={!filters.endDate || filters.endDate >= new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}
        onOpenFilters={() => setFiltersOpen(true)}
        activeFilterCount={
          filters.areas.length + filters.categories.length +
          filters.severities.length + filters.searches.length
        }
        onRefresh={() => setFilters({ ...filters })}
        signalCount={signals.length}
        criticalSignalCount={criticalSignals}
        onExport={data ? () => exportCSV(data.incidents, data.windowFrom, data.windowTo) : undefined}
      />

      <ActiveFilterChips
        filters={filters}
        onRemoveCategory={handleAddCategoryFilter}
        onRemoveArea={handleAddAreaFilter}
        onRemoveSeverity={handleAddSeverityFilter}
        onRemoveSearch={(t) => setFilters(f => removeSearchToken(f, t))}
        onClearDate={() => setFilters(f => clearCustomDate(f))}
        onClearAll={handleResetFilters}
      />

      {/* Tabs */}
      <div className="border-b border-[var(--line)] sticky top-0 z-20" style={{ background: 'rgba(7, 11, 22, 0.92)', backdropFilter: 'blur(12px)' }}>
        <div className="max-w-[1480px] mx-auto px-6 flex items-center gap-1 overflow-x-auto">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`tab flex items-center gap-2 ${tab === t.id ? 'tab-active' : ''}`}
            >
              <t.icon size={13} />
              {t.label}
              {t.id === 'overview' && criticalSignals > 0 && (
                <span className="ml-0.5 px-1 py-0.5 text-[9px] font-bold bg-[var(--nr-red,#E74C3C)] text-white rounded-sm leading-none">
                  {criticalSignals}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-[1480px] mx-auto px-6 py-8">
        {error && <ErrorBanner message={error} />}

        {kpis && data && (
          <>
            {tab === 'overview'    && <OverviewTab kpis={kpis} trend={trend} changePoints={changePoints} cats={cats} hots={hots} repeatAssets={repeatAssets} chart={trendChart} setChart={setTrendChart} dist={distChart} setDist={setDistChart} incidents={data.incidents} onDrillDown={setDrillDown} onDateClick={handleDateClick} signals={signals} signalsOpen={signalsOpen} setSignalsOpen={setSignalsOpen} onAddCategoryFilter={handleAddCategoryFilter} onAddAreaFilter={handleAddAreaFilter} onAddSeverityFilter={handleAddSeverityFilter} decompose={decompose} hypotheses={hypotheses} />}
            {tab === 'safety'      && <SafetyTab kpis={kpis} trend={trend} cats={cats} data={data} onAddCategoryFilter={handleAddCategoryFilter} decompose={decompose} />}
            {tab === 'performance' && <PerformanceTab kpis={kpis} trend={trend} changePoints={changePoints} hots={hots} resp={respDist} responderLoad={resp} ops={ops} attribution={attribution} chart={trendChart} setChart={setTrendChart} incidents={data.incidents} onDrillDown={setDrillDown} onDateClick={handleDateClick} decompose={decompose} />}
            {tab === 'geography'   && <GeographyTab hots={hots} delayDensity={delayDensity} incidents={data.incidents} onDrillDown={setDrillDown} />}
            {tab === 'patterns'    && <PatternsTab heat={heat} cats={cats} />}
            {tab === 'assets'      && <AssetsTab repeatAssets={repeatAssets} infraMix={infraMix} cats={cats} incidents={data.incidents} onDrillDown={setDrillDown} chains={chains} />}
            {tab === 'routes'      && <RoutesTab lines={lines} incidents={data.incidents} onDrillDown={setDrillDown} />}
            {tab === 'trends'      && <TrendsTab incidents={data.incidents} windowFrom={data.windowFrom} windowDays={data.windowDays} areaOptions={areas.map((a: any) => a.area)} />}
          </>
        )}
      </div>

      {drillDown && (
        <DrillDownModal
          title={drillDown.title}
          incidents={drillDown.incidents}
          onClose={() => setDrillDown(null)}
        />
      )}

      <FilterDrawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        filters={filters}
        onApply={(f: AnalyticsFilters) => { setFilters(f); setFiltersOpen(false) }}
        onReset={handleResetFilters}
        availableAreas={areas.map(a => a.area)}
        savedViews={savedViews}
        onSaveView={handleSaveView}
        onDeleteView={handleDeleteView}
        onApplyView={(f: AnalyticsFilters) => { setFilters(f); setFiltersOpen(false) }}
      />
    </main>
  )
}

// ─── Header ──────────────────────────────────────────────────────────────────

function Header(props: {
  windowDays: number
  startDate?: string
  endDate?: string
  demoMode: boolean
  loading: boolean
  activeFilterCount: number
  isAtToday: boolean
  signalCount: number
  criticalSignalCount: number
  onWindowChange: (d: number) => void
  onPrevWindow: () => void
  onNextWindow: () => void
  onOpenFilters: () => void
  onRefresh: () => void
  onExport?: () => void
}) {
  const customRange = !!props.startDate

  return (
    <header className="border-b border-[var(--line)] bg-gradient-to-b from-[#0B1226] to-transparent">
      <div className="max-w-[1480px] mx-auto px-6 py-7 flex items-start justify-between gap-6 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-7 h-7 border border-[var(--nr-orange)] flex items-center justify-center" style={{ boxShadow: '0 0 12px var(--nr-orange-glow)' }}>
              <div className="w-2 h-2 bg-[var(--nr-orange)]" />
            </div>
            <span className="label-micro">East Midlands Control Centre · Strategic Operations</span>
          </div>
          <h1 className="serif text-5xl font-light tracking-tight" style={{ color: 'var(--ink-100)' }}>
            Insight<span className="text-[var(--nr-orange)]">.</span>
          </h1>
          <p className="text-[13px] mt-1" style={{ color: 'var(--ink-400)' }}>
            Trend, pattern and performance intelligence drawn from the daily control-centre log.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Window selector with prev/next arrows */}
          <div className="flex flex-col items-center gap-1">
            <div className="flex items-center gap-0 p-1 border border-[var(--line)] rounded">
              <button
                onClick={props.onPrevWindow}
                className="btn !py-1 !px-2 !border-none"
                title="Previous period"
              >
                <ChevronLeft size={12} />
              </button>
              <div className="flex items-center gap-0.5">
                {TIME_WINDOWS.map(w => (
                  <button
                    key={w.label}
                    onClick={() => props.onWindowChange(w.days)}
                    className={`btn !py-1 !px-3 !border-none ${props.windowDays === w.days && !customRange ? 'btn-active' : ''}`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
              <button
                onClick={props.onNextWindow}
                disabled={props.isAtToday}
                className="btn !py-1 !px-2 !border-none disabled:opacity-30 disabled:cursor-not-allowed"
                title="Next period"
              >
                <ChevronRight size={12} />
              </button>
            </div>
            {customRange && (
              <div className="label-micro text-[9px]" style={{ color: 'var(--ink-400)' }}>
                {props.startDate}{props.endDate && props.endDate !== props.startDate ? ` → ${props.endDate}` : ''}
              </div>
            )}
          </div>

          <button onClick={props.onOpenFilters} className="btn relative">
            <Filter size={12} />
            Filters
            {props.activeFilterCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-[9px] bg-[var(--nr-orange)] text-white rounded-sm">
                {props.activeFilterCount}
              </span>
            )}
          </button>

          {props.onExport && (
            <button onClick={props.onExport} className="btn" title="Download CSV">
              <Download size={12} />
              Export
            </button>
          )}

          <button onClick={props.onRefresh} className="btn" disabled={props.loading}>
            <RefreshCw size={12} className={props.loading ? 'animate-spin' : ''} />
            Refresh
          </button>

          {props.signalCount > 0 && (
            <div
              className="flex items-center gap-2 px-3 py-1.5 border rounded cursor-default"
              style={{
                borderColor: props.criticalSignalCount > 0 ? '#E74C3C' : 'var(--nr-amber)',
                color: props.criticalSignalCount > 0 ? '#E74C3C' : 'var(--nr-amber)',
              }}
              title="Active signals — see Overview tab"
            >
              <Bell size={12} />
              <span className="label-micro">{props.signalCount} signal{props.signalCount !== 1 ? 's' : ''}</span>
            </div>
          )}

          <div className="flex items-center gap-2 px-3 py-1.5 border border-[var(--line)] rounded">
            <span className={`live-dot ${props.demoMode ? '!bg-[var(--nr-amber)]' : 'animate-pulse-soft'}`} style={props.demoMode ? { boxShadow: '0 0 8px var(--nr-amber)' } : {}} />
            <span className="label-micro">{props.demoMode ? 'Demo Data' : 'Live'}</span>
          </div>
        </div>
      </div>
    </header>
  )
}

// ─── Overview tab ────────────────────────────────────────────────────────────

function SignalsPanel({ signals, open, setOpen }: { signals: Signal[]; open: boolean; setOpen: (v: boolean) => void }) {
  if (!signals.length) return null
  const critical = signals.filter(s => s.severity === 'critical')
  const warning  = signals.filter(s => s.severity === 'warning')
  const info     = signals.filter(s => s.severity === 'info')

  const severityStyle = (sev: Signal['severity']) => {
    if (sev === 'critical') return { border: '#E74C3C', bg: 'rgba(231,76,60,0.08)', dot: '#E74C3C', label: 'CRITICAL' }
    if (sev === 'warning')  return { border: 'var(--nr-amber)', bg: 'rgba(243,156,18,0.06)', dot: 'var(--nr-amber)', label: 'WARNING' }
    return { border: 'var(--line)', bg: 'transparent', dot: '#4A6FA5', label: 'INFO' }
  }

  return (
    <div className="card animate-fade-up" style={{ borderColor: critical.length ? '#E74C3C' : 'var(--nr-amber)', overflow: 'hidden' }}>
      <button
        className="w-full flex items-center justify-between px-5 py-4"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-3">
          <Bell size={14} style={{ color: critical.length ? '#E74C3C' : 'var(--nr-amber)' }} />
          <span className="label-micro text-[11px]" style={{ color: critical.length ? '#E74C3C' : 'var(--nr-amber)' }}>
            {signals.length} Active Signal{signals.length !== 1 ? 's' : ''}
          </span>
          {critical.length > 0 && (
            <span className="px-1.5 py-0.5 text-[9px] font-bold bg-[#E74C3C] text-white rounded-sm">
              {critical.length} CRITICAL
            </span>
          )}
          {warning.length > 0 && (
            <span className="px-1.5 py-0.5 text-[9px] font-bold text-white rounded-sm" style={{ background: 'var(--nr-amber)' }}>
              {warning.length} WARNING
            </span>
          )}
        </div>
        <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', color: 'var(--ink-400)' }} />
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-2 border-t border-[var(--line)]">
          {signals.map(sig => {
            const s = severityStyle(sig.severity)
            return (
              <div
                key={sig.id}
                className="flex items-start gap-3 p-3 rounded-sm text-xs"
                style={{ background: s.bg, border: `1px solid ${s.border}30` }}
              >
                <div className="w-1.5 h-1.5 rounded-full mt-1 shrink-0" style={{ background: s.dot }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    <span className="label-micro text-[9px]" style={{ color: s.dot }}>{s.label}</span>
                    <span className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>{sig.type.replace(/_/g, ' ')}</span>
                    {sig.date && <span className="numeric-mono text-[9px]" style={{ color: 'var(--ink-500)' }}>{sig.date}</span>}
                  </div>
                  <div className="font-medium" style={{ color: 'var(--ink-100)' }}>{sig.title}</div>
                  <div className="mt-0.5" style={{ color: 'var(--ink-300)' }}>{sig.detail}</div>
                </div>
                <div className="text-right shrink-0 numeric-mono text-[10px]" style={{ color: s.dot }}>
                  {sig.delta > 0 ? '+' : ''}{sig.delta.toFixed(1)}×
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Hypothesis panel ────────────────────────────────────────────────────────
// "What stood out" — for any anomalous-day cluster or detected change-point,
// rank dimensions over-represented on the flagged period vs the comparison
// baseline. Dimensions that map to existing filters (category/area/severity)
// are clickable to pin as a filter chip; the rest are informational. Always
// labelled as correlations, not causes.

function HypothesisPanel({
  clusters, onAddCategoryFilter, onAddAreaFilter, onAddSeverityFilter,
}: {
  clusters: HypothesisCluster[]
  onAddCategoryFilter: (c: IncidentCategory) => void
  onAddAreaFilter: (a: string) => void
  onAddSeverityFilter: (s: Severity) => void
}) {
  const [open, setOpen] = useState(true)
  if (!clusters.length) return null
  const totalHypotheses = clusters.reduce((s, c) => s + c.hypotheses.length, 0)

  const onChipClick = (h: Hypothesis) => {
    if (h.dimension === 'category')      onAddCategoryFilter(h.key as IncidentCategory)
    else if (h.dimension === 'area')     onAddAreaFilter(h.key)
    else if (h.dimension === 'severity') onAddSeverityFilter(h.key as Severity)
    // hourBand / line / operator are display-only for now
  }

  const isFilterable = (h: Hypothesis) =>
    h.dimension === 'category' || h.dimension === 'area' || h.dimension === 'severity'

  return (
    <div className="card animate-fade-up" style={{ borderColor: 'var(--line-hi)', overflow: 'hidden' }}>
      <button
        className="w-full flex items-center justify-between px-5 py-4"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-3">
          <Zap size={14} style={{ color: 'var(--nr-orange)' }} />
          <span className="label-micro text-[11px]" style={{ color: 'var(--nr-orange)' }}>
            What stood out · {totalHypotheses} candidate{totalHypotheses !== 1 ? 's' : ''}
          </span>
          <span className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>
            {clusters.length} cluster{clusters.length !== 1 ? 's' : ''}
          </span>
        </div>
        <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', color: 'var(--ink-400)' }} />
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-[var(--line)]">
          <div className="space-y-5 mt-4">
            {clusters.map(cluster => (
              <HypothesisClusterBlock
                key={cluster.id}
                cluster={cluster}
                onChipClick={onChipClick}
                isFilterable={isFilterable}
              />
            ))}
          </div>
          <p className="text-[11px] mt-4 pt-3 border-t border-[var(--line)]" style={{ color: 'var(--ink-500)' }}>
            These are correlations, not causes — values listed here were over-represented
            on the flagged period compared with the baseline. Investigate before acting.
            Click any category, area, or severity chip to pin it as a filter and explore further.
          </p>
        </div>
      )}
    </div>
  )
}

function HypothesisClusterBlock({ cluster, onChipClick, isFilterable }: {
  cluster: HypothesisCluster
  onChipClick: (h: Hypothesis) => void
  isFilterable: (h: Hypothesis) => boolean
}) {
  const maxLift = Math.max(...cluster.hypotheses.map(h => h.lift), 1)
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <h4 className="text-sm font-medium" style={{ color: 'var(--ink-100)' }}>{cluster.title}</h4>
        <span className="numeric-mono text-[9px] shrink-0" style={{ color: 'var(--ink-500)' }}>
          {cluster.anomalousIncidentCount} flagged · {cluster.baselineIncidentCount} baseline
        </span>
      </div>
      <p className="text-[11px] mb-3" style={{ color: 'var(--ink-400)' }}>{cluster.subtitle}</p>
      <div className="space-y-1.5">
        {cluster.hypotheses.map(h => (
          <HypothesisRow
            key={`${h.dimension}-${h.key}`}
            h={h}
            maxLift={maxLift}
            onClick={isFilterable(h) ? () => onChipClick(h) : undefined}
          />
        ))}
      </div>
    </div>
  )
}

function HypothesisRow({ h, maxLift, onClick }: {
  h: Hypothesis
  maxLift: number
  onClick?: () => void
}) {
  const accent = h.color ?? 'var(--nr-orange)'
  const liftPct = Math.min(100, (h.lift / maxLift) * 100)
  return (
    <div className="text-xs">
      <div className="flex items-center gap-3 mb-1">
        <span className="label-micro text-[9px] shrink-0 w-16 truncate" title={h.dimensionLabel}>
          {h.dimensionLabel}
        </span>
        <button
          type="button"
          onClick={onClick}
          disabled={!onClick}
          className={`pill text-[10px] shrink-0 max-w-[200px] truncate ${onClick ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
          style={{
            background: `${accent}1A`,
            color: accent,
            border: `1px solid ${accent}50`,
          }}
          title={onClick ? `Pin "${h.label}" as a filter` : h.label}
        >
          <span className="truncate">{h.label}</span>
        </button>
        <span className="numeric-mono text-[10px] shrink-0" style={{ color: 'var(--ink-100)' }}>
          {h.lift.toFixed(1)}× over-represented
        </span>
        <span className="numeric-mono text-[10px] shrink-0 ml-auto" style={{ color: 'var(--ink-400)' }}>
          {h.anomalousCount}/{h.anomalousTotal}
          <span className="mx-1" style={{ color: 'var(--ink-500)' }}>vs</span>
          {h.baselineCount}/{h.baselineTotal}
        </span>
      </div>
      <div className="h-1.5 bg-[var(--bg-card-hi)] rounded-sm overflow-hidden ml-[76px]">
        <div className="h-full rounded-sm" style={{ width: `${liftPct}%`, background: accent }} />
      </div>
    </div>
  )
}

function OverviewTab({ kpis, trend, changePoints, cats, hots, repeatAssets, chart, setChart, dist, setDist, incidents, onDrillDown, onDateClick, signals, signalsOpen, setSignalsOpen, onAddCategoryFilter, onAddAreaFilter, onAddSeverityFilter, decompose, hypotheses }: any) {
  return (
    <div className="space-y-6">
      <SignalsPanel signals={signals} open={signalsOpen} setOpen={setSignalsOpen} />
      <HypothesisPanel
        clusters={hypotheses}
        onAddCategoryFilter={onAddCategoryFilter}
        onAddAreaFilter={onAddAreaFilter}
        onAddSeverityFilter={onAddSeverityFilter}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 stagger">
        <KPICard
          label="Total Incidents"
          value={kpis.totalIncidents.toLocaleString()}
          delta={kpis.incidentsDeltaPct}
          icon={Activity}
          deltaInverted
          decompose={decompose}
          metric="incidents"
        />
        <KPICard
          label="Total Delay"
          value={fmtMins(kpis.totalDelayMins)}
          subValue={`${kpis.totalDelayMins.toLocaleString()} min`}
          delta={kpis.delayDeltaPct}
          icon={Clock}
          deltaInverted
          accent
          decompose={decompose}
          metric="delay"
        />
        <KPICard
          label="Safety-Critical"
          value={kpis.safetyCriticalCount.toLocaleString()}
          delta={kpis.safetyDeltaPct}
          icon={AlertTriangle}
          deltaInverted
          critical={kpis.safetyDeltaPct != null && kpis.safetyDeltaPct > 5}
          decompose={decompose}
          metric="safety"
        />
        <KPICard
          label="Avg Incident Duration"
          value={kpis.avgIncidentDuration ? fmtMins(Math.round(kpis.avgIncidentDuration)) : '—'}
          delta={kpis.durationDeltaPct}
          icon={Clock}
          deltaInverted
        />
        <KPICard
          label="Trains Delayed"
          value={kpis.totalTrainsDelayed != null ? kpis.totalTrainsDelayed.toLocaleString() : '—'}
          icon={Train}
          deltaInverted
        />
        <KPICard
          label="SLA Compliance"
          value={kpis.slaCompliancePct != null ? `${kpis.slaCompliancePct.toFixed(1)}%` : '—'}
          delta={kpis.slaBreachDeltaPct != null ? -kpis.slaBreachDeltaPct : null}
          icon={Clock}
        />
      </div>

      {/* Trend + breakdown row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Daily Activity" subtitle={`${trend.length}-day rolling window · stability band shaded`} className="lg:col-span-2 tick-corners"
              right={<ChartTypeToggle value={chart} onChange={setChart} />}>
          <TrendChart data={trend} kind={chart} onDateClick={onDateClick} changePoints={changePoints} showBaseline />
        </Card>

        <Card title="Category Mix" subtitle={`${cats.length} categories · click to pin filter`}
              right={<DistributionToggle value={dist} onChange={setDist} />}>
          <CategoryDistribution data={cats} kind={dist} onCategoryClick={onAddCategoryFilter} />
        </Card>
      </div>

      {/* Hotspots + repeat assets */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Top Hotspots" subtitle="Locations ranked by total delay" className="tick-corners">
          <LocationLeaderboard data={hots} incidents={incidents} onDrillDown={onDrillDown} />
        </Card>
        <Card title="Repeat-Fault Assets" subtitle="Same equipment, multiple occurrences">
          <RepeatAssetsTable data={repeatAssets} incidents={incidents} onDrillDown={onDrillDown} />
        </Card>
      </div>
    </div>
  )
}

// ─── Safety tab ──────────────────────────────────────────────────────────────

function SafetyTab({ kpis, trend, cats, data, onAddCategoryFilter, decompose }: any) {
  const safetyOnly = cats.filter((c: any) => SAFETY_CATEGORIES.includes(c.category))
  const safetyCritical = data.incidents.filter((i: any) => SAFETY_CATEGORIES.includes(i.category) && !i.is_continuation)

  // Build radar dataset — current vs prior window
  const safetyRadar = SAFETY_CATEGORIES.map(cat => ({
    category: CATEGORY_CONFIG[cat].short,
    current: data.incidents.filter((i: any) => i.category === cat && !i.is_continuation).length,
    previous: data.prevIncidents.filter((i: any) => i.category === cat && !i.is_continuation).length,
  }))

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 stagger">
        <KPICard label="Safety-Critical Events" value={kpis.safetyCriticalCount} delta={kpis.safetyDeltaPct} icon={AlertTriangle} deltaInverted critical accent decompose={decompose} metric="safety" />
        <KPICard label="SPADs" value={data.incidents.filter((i: any) => i.category === 'SPAD' && !i.is_continuation).length} icon={AlertTriangle} />
        <KPICard label="Near Miss" value={data.incidents.filter((i: any) => i.category === 'NEAR_MISS' && !i.is_continuation).length} icon={AlertTriangle} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Safety-Critical Trend" subtitle="Daily count, current window">
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={trend}>
              <defs>
                <linearGradient id="safetyGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#E74C3C" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#E74C3C" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 6" />
              <XAxis dataKey="date" tickFormatter={shortDate} />
              <YAxis allowDecimals={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="safetyCritical" stroke="#E74C3C" strokeWidth={1.5} fill="url(#safetyGrad)" />
              <Line type="monotone" dataKey="rolling7SafetyAvg" name="7d avg" stroke="#7A8BA8" strokeWidth={1.5}
                    strokeDasharray="4 2" dot={false} activeDot={false} connectNulls />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Current vs Previous Window" subtitle="Safety-critical category radar">
          <ResponsiveContainer width="100%" height={280}>
            <RadarChart data={safetyRadar}>
              <PolarGrid stroke="var(--line)" />
              <PolarAngleAxis dataKey="category" tick={{ fill: 'var(--ink-300)', fontSize: 10, fontFamily: 'JetBrains Mono' }} />
              <PolarRadiusAxis tick={false} axisLine={false} />
              <Radar name="Previous" dataKey="previous" stroke="#7A8BA8" fill="#7A8BA8" fillOpacity={0.15} />
              <Radar name="Current"  dataKey="current"  stroke="#E05206" fill="#E05206" fillOpacity={0.32} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'JetBrains Mono', textTransform: 'uppercase', letterSpacing: '0.1em' }} />
            </RadarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card title="Safety Category Breakdown" subtitle="By count and total delay impact · click to pin filter">
        <SafetyTable rows={safetyOnly} onCategoryClick={onAddCategoryFilter} />
      </Card>

      <Card title="Recent Safety-Critical Events" subtitle="Latest 10 in window">
        <IncidentList rows={safetyCritical.slice(-10).reverse()} />
      </Card>
    </div>
  )
}

// ─── Performance tab ─────────────────────────────────────────────────────────

function PerformanceTab({ kpis, trend, changePoints, hots, resp, responderLoad, ops, attribution, chart, setChart, incidents, onDrillDown, onDateClick, decompose }: any) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 stagger">
        <KPICard label="Total Delay (mins)" value={kpis.totalDelayMins.toLocaleString()} delta={kpis.delayDeltaPct} icon={Clock} deltaInverted accent decompose={decompose} metric="delay" />
        <KPICard label="Cancelled" value={kpis.totalCancelled} icon={X} />
        <KPICard label="Part Cancelled" value={kpis.totalPartCancelled} icon={X} />
        <KPICard
          label="Median Arrival"
          value={kpis.medianArrivalMins != null ? `${kpis.medianArrivalMins} min` : '—'}
          icon={Clock}
        />
        <KPICard
          label="SLA Compliance (≤45m)"
          value={kpis.slaCompliancePct != null ? `${kpis.slaCompliancePct.toFixed(1)}%` : '—'}
          delta={kpis.slaBreachDeltaPct != null ? -kpis.slaBreachDeltaPct : null}
          icon={Clock}
          critical={kpis.slaCompliancePct != null && kpis.slaCompliancePct < 70}
        />
      </div>

      <Card title="Delay Minutes — Daily" subtitle="Aggregate impact · change-points marked" right={<ChartTypeToggle value={chart} onChange={setChart} />} className="tick-corners">
        <TrendChart data={trend} kind={chart} dataKey="delayMins" gradient="orange" onDateClick={onDateClick} changePoints={changePoints} />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Response-Time Distribution" subtitle="Mins from incident start">
          {resp ? <ResponseHistograms data={resp} /> : null}
        </Card>
        <Card title="Top Incidents by Delay" subtitle="Highest-impact singular incidents">
          <TopIncidentsByDelay incidents={incidents} onDrillDown={onDrillDown} />
        </Card>
      </div>

      {attribution && attribution.length > 0 && (
        <Card title="Delay Attribution by TRMC Code" subtitle="Who bears responsibility — standardised attribution identifiers">
          <div className="space-y-2">
            {(() => {
              const max = attribution[0]?.totalDelay || 1
              return attribution.map((a: any, i: number) => (
                <div key={i} className="grid grid-cols-12 gap-3 items-center text-xs py-1.5 border-b border-[var(--line)] last:border-0">
                  <div className="col-span-2 numeric-mono text-[10px] font-bold" style={{ color: 'var(--nr-orange)' }}>{a.code}</div>
                  <div className="col-span-4 truncate" style={{ color: 'var(--ink-200)' }}>{a.label}</div>
                  <div className="col-span-4">
                    <div className="h-1.5 bg-[var(--bg-card-hi)] rounded-sm overflow-hidden">
                      <div className="h-full rounded-sm" style={{ width: `${(a.totalDelay / max) * 100}%`, background: 'var(--nr-orange)' }} />
                    </div>
                  </div>
                  <div className="col-span-1 numeric-mono text-right text-[10px]" style={{ color: 'var(--ink-400)' }}>{a.incidentCount}</div>
                  <div className="col-span-1 numeric-mono text-right text-[10px]" style={{ color: 'var(--ink-100)' }}>{a.pct.toFixed(1)}%</div>
                </div>
              ))
            })()}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {ops && ops.length > 0 && (
          <Card title="Operator Delay Impact" subtitle="Total delay minutes per train operator">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={ops} layout="vertical" margin={{ left: 10, right: 30 }}>
                <CartesianGrid strokeDasharray="2 6" horizontal={false} />
                <XAxis type="number" />
                <YAxis dataKey="company" type="category" width={80} tick={{ fontSize: 10, fill: 'var(--ink-300)', fontFamily: 'JetBrains Mono' }} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="delayMins" name="Delay (mins)" fill="#E05206" radius={[0, 2, 2, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}
        {responderLoad && responderLoad.length > 0 && (
          <Card title="Responder Workload" subtitle="Incidents handled per control room initials">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={responderLoad}>
                <CartesianGrid strokeDasharray="2 6" />
                <XAxis dataKey="initials" tick={{ fontSize: 10, fill: 'var(--ink-300)', fontFamily: 'JetBrains Mono' }} />
                <YAxis allowDecimals={false} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="incidentCount" name="Incidents" fill="#4A6FA5" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        )}
      </div>
    </div>
  )
}

// ─── Geography tab ───────────────────────────────────────────────────────────

function GeographyTab({ hots, delayDensity, incidents, onDrillDown }: any) {
  const routeAvg = delayDensity.length
    ? delayDensity.reduce((s: number, d: any) => s + d.avgDelayDensity, 0) / delayDensity.length
    : null
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card
          title="Delay Density"
          subtitle="Avg delay-minutes per rectification-minute — all locations"
          className="lg:col-span-2 tick-corners"
          right={routeAvg != null && (
            <div className="text-right shrink-0">
              <div className="label-micro">Route avg</div>
              <div className="numeric-mono text-lg font-semibold" style={{ color: 'var(--ink-100)' }}>{routeAvg.toFixed(2)}</div>
            </div>
          )}
        >
          <DelayDensityTable data={delayDensity} incidents={incidents} onDrillDown={onDrillDown} />
        </Card>
        <Card title="Top 12 Hotspots" subtitle="By total delay">
          <LocationLeaderboard data={hots} compact incidents={incidents} onDrillDown={onDrillDown} />
        </Card>
      </div>

      <Card title="Location × Area Treemap" subtitle="Proportional view of total delay impact">
        <ResponsiveContainer width="100%" height={420}>
          <Treemap
            data={hots.map((h: any, idx: number) => ({
              name: h.location,
              size: h.delayMins,
              area: h.area,
              fill: pickAreaColor(h.area, idx),
            }))}
            dataKey="size"
            stroke="#070B16"
            content={<TreemapContent />}
          />
        </ResponsiveContainer>
      </Card>
    </div>
  )
}

// ─── Patterns tab ────────────────────────────────────────────────────────────

function PatternsTab({ heat, cats }: any) {
  return (
    <div className="space-y-6">
      <Card title="Day × Hour Heatmap" subtitle="When incidents happen" className="tick-corners">
        <Heatmap cells={heat} />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Hour-of-Day Profile" subtitle="Incident count by hour">
          <HourChart cells={heat} />
        </Card>
        <Card title="Day-of-Week Profile" subtitle="Incident count by weekday">
          <DayChart cells={heat} />
        </Card>
      </div>

      <Card title="Category by Hour" subtitle="Top 6 categories, hourly density">
        <CategoryByHour cats={cats.slice(0, 6)} />
      </Card>
    </div>
  )
}

// ─── Assets tab ──────────────────────────────────────────────────────────────

function AssetsTab({ repeatAssets, infraMix, cats, incidents, onDrillDown, chains }: any) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Asset-Failure Mix" subtitle="NR infrastructure — CCIL sub-category breakdown" className="tick-corners">
          <InfraFailureMixChart data={infraMix} incidents={incidents} onDrillDown={onDrillDown} />
        </Card>

        <Card title="Repeat-Fault Assets" subtitle="Same equipment recurring — highest priority for engineering review" className="lg:col-span-2">
          <RepeatAssetsTable data={repeatAssets} expanded incidents={incidents} onDrillDown={onDrillDown} />
        </Card>
      </div>

      <Card title="Infrastructure Sub-Category — Count vs Delay" subtitle="NR-managed assets only">
        <DualBarChart data={infraMix.map((d: any) => ({ ...d, short: d.typeLabel.length > 22 ? d.typeLabel.slice(0, 22) + '…' : d.typeLabel, delayMins: d.delayMins }))} />
      </Card>

      {chains && chains.length > 0 && (
        <Card title="Multi-Day Escalations" subtitle="Incidents spanning multiple days grouped by CCIL — highest cumulative impact">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="label-micro border-b border-[var(--line)]">
                  <th className="text-left py-2 pr-3">CCIL</th>
                  <th className="text-left pr-3">Category</th>
                  <th className="text-left pr-3">Location</th>
                  <th className="text-right pr-3">Days</th>
                  <th className="text-right pr-3">Events</th>
                  <th className="text-right">Total Delay</th>
                </tr>
              </thead>
              <tbody>
                {chains.map((c: any, i: number) => {
                  const cfg = CATEGORY_CONFIG[c.category as IncidentCategory]
                  return (
                    <tr
                      key={i}
                      className="border-b border-[var(--line)] hover:bg-[var(--bg-card-hi)] transition-colors cursor-pointer"
                      onClick={() => onDrillDown?.({ title: `CCIL ${c.ccil}`, incidents: c.incidents })}
                    >
                      <td className="py-2 pr-3 numeric-mono text-[10px]" style={{ color: 'var(--nr-orange)' }}>{c.ccil}</td>
                      <td className="pr-3">
                        <span className="pill" style={{ background: `${cfg.color}20`, color: cfg.color, borderColor: `${cfg.color}50` }}>{cfg.short}</span>
                      </td>
                      <td className="pr-3 truncate" style={{ color: 'var(--ink-200)', maxWidth: 200 }}>{c.location || '—'}</td>
                      <td className="text-right pr-3 numeric-mono" style={{ color: 'var(--ink-300)' }}>{c.days}d</td>
                      <td className="text-right pr-3 numeric-mono" style={{ color: 'var(--ink-400)' }}>{c.incidents.length}</td>
                      <td className="text-right numeric-mono font-medium" style={{ color: 'var(--ink-100)' }}>{fmtMins(c.totalDelay)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Routes tab ──────────────────────────────────────────────────────────────

function RoutesTab({ lines, incidents, onDrillDown }: any) {
  if (!lines || lines.length === 0) {
    return (
      <div className="space-y-6">
        <Empty msg="No line data available in this window" />
      </div>
    )
  }
  const maxDelay = Math.max(...lines.map((l: any) => l.totalDelay), 1)
  const maxCount = Math.max(...lines.map((l: any) => l.incidentCount), 1)
  const barData  = lines.slice(0, 12).map((l: any) => ({
    name: l.line.length > 24 ? l.line.slice(0, 24) + '…' : l.line,
    full: l.line,
    incidents: l.incidentCount,
    delay: l.totalDelay,
  }))

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 stagger">
        <KPICard
          label="Lines Affected"
          value={lines.length}
          icon={Route}
        />
        <KPICard
          label="Highest Delay Line"
          value={lines[0]?.line?.split(' ').slice(0, 3).join(' ') || '—'}
          icon={TrendingUp}
        />
        <KPICard
          label="Avg Delay / Incident"
          value={lines.length ? fmtMins(Math.round(lines.reduce((s: number, l: any) => s + l.totalDelay, 0) / lines.reduce((s: number, l: any) => s + l.incidentCount, 0))) : '—'}
          icon={Clock}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Incidents by Line" subtitle="Top 12 lines by incident count" className="tick-corners">
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={barData} layout="vertical" margin={{ left: 10, right: 30 }}>
              <CartesianGrid strokeDasharray="2 6" horizontal={false} />
              <XAxis type="number" allowDecimals={false} />
              <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 10, fill: 'var(--ink-300)', fontFamily: 'JetBrains Mono' }} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="incidents" name="Incidents" fill="#4A6FA5" radius={[0, 2, 2, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Delay by Line" subtitle="Total delay minutes per line">
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={barData} layout="vertical" margin={{ left: 10, right: 30 }}>
              <CartesianGrid strokeDasharray="2 6" horizontal={false} />
              <XAxis type="number" />
              <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 10, fill: 'var(--ink-300)', fontFamily: 'JetBrains Mono' }} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="delay" name="Delay (mins)" fill="#E05206" radius={[0, 2, 2, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card title="Line Performance Table" subtitle="All lines — ranked by total delay impact">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="label-micro border-b border-[var(--line)]">
                <th className="text-left py-2 pr-3">Line</th>
                <th className="text-right pr-3">Incidents</th>
                <th className="text-right pr-3">Total Delay</th>
                <th className="text-right pr-3">Delay/Inc</th>
                <th className="text-right pr-3">Avg Duration</th>
                <th className="text-left">Top Category</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l: any, i: number) => {
                const cfg = CATEGORY_CONFIG[l.topCategory as IncidentCategory]
                const delayPerInc = l.incidentCount > 0 ? Math.round(l.totalDelay / l.incidentCount) : 0
                return (
                  <tr
                    key={i}
                    className="border-b border-[var(--line)] hover:bg-[var(--bg-card-hi)] transition-colors cursor-pointer"
                    onClick={() => {
                      if (!onDrillDown || !incidents) return
                      const rows = incidents.filter((inc: any) => !inc.is_continuation && inc.line === l.line)
                        .sort((a: any, b: any) => b.report_date.localeCompare(a.report_date))
                      onDrillDown({ title: l.line, incidents: rows })
                    }}
                  >
                    <td className="py-2 pr-3" style={{ color: 'var(--ink-100)', maxWidth: 200 }}>
                      <div className="truncate">{l.line}</div>
                      <div className="h-[3px] mt-1 bg-[var(--bg-card-hi)] rounded-sm overflow-hidden" style={{ width: 80 }}>
                        <div className="h-full" style={{ width: `${(l.totalDelay / maxDelay) * 100}%`, background: 'var(--nr-orange)' }} />
                      </div>
                    </td>
                    <td className="text-right pr-3 numeric-mono" style={{ color: 'var(--ink-300)' }}>{l.incidentCount}</td>
                    <td className="text-right pr-3 numeric-mono font-medium" style={{ color: 'var(--ink-100)' }}>{fmtMins(l.totalDelay)}</td>
                    <td className="text-right pr-3 numeric-mono text-[10px]" style={{ color: 'var(--ink-400)' }}>{fmtMins(delayPerInc)}</td>
                    <td className="text-right pr-3 numeric-mono text-[10px]" style={{ color: 'var(--ink-400)' }}>{l.avgDuration != null ? fmtMins(Math.round(l.avgDuration)) : '—'}</td>
                    <td>
                      {cfg && <span className="pill" style={{ background: `${cfg.color}20`, color: cfg.color, borderColor: `${cfg.color}50` }}>{cfg.short}</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// ─── Trend Composer ──────────────────────────────────────────────────────────

const SERIES_PALETTE = [
  '#E05206', '#4A9FE5', '#27AE60', '#9B59B6',
  '#E74C3C', '#F39C12', '#1ABC9C', '#E91E9C',
]

interface TrendSeriesDef {
  id: string
  label: string
  color: string
  metric: 'incidents' | 'delayMins' | 'safetyCritical'
  categories: IncidentCategory[]
  severities: Severity[]
  areas: string[]
}

const METRIC_OPTS: { key: TrendSeriesDef['metric']; label: string }[] = [
  { key: 'incidents',      label: 'Incidents' },
  { key: 'delayMins',      label: 'Delay Mins' },
  { key: 'safetyCritical', label: 'Safety Critical' },
]

const CAT_GROUPS: { label: string; cats: IncidentCategory[] }[] = [
  { label: 'Safety',      cats: ['FATALITY', 'PERSON_STRUCK', 'SPAD', 'TPWS', 'IRREGULAR_WORKING', 'NEAR_MISS', 'LEVEL_CROSSING', 'FIRE', 'PASSENGER_INJURY', 'HABD_WILD', 'BRIDGE_STRIKE', 'DERAILMENT'] },
  { label: 'Asset',       cats: ['INFRASTRUCTURE', 'TRACTION_FAILURE', 'TRAIN_FAULT', 'POSSESSION'] },
  { label: 'Performance', cats: ['STATION_OVERRUN', 'STRANDED_TRAIN'] },
  { label: 'Other',       cats: ['CRIME', 'WEATHER', 'GENERAL'] },
]

function buildAutoLabel(draft: Omit<TrendSeriesDef, 'id'>): string {
  const parts: string[] = []
  if (draft.categories.length) parts.push(draft.categories.map(c => CATEGORY_CONFIG[c].short).join('+'))
  if (draft.severities.length) parts.push(draft.severities.join('+'))
  if (draft.areas.length) parts.push(draft.areas[0] + (draft.areas.length > 1 ? `+${draft.areas.length - 1}` : ''))
  return parts.length ? parts.join(' · ') : (METRIC_OPTS.find(m => m.key === draft.metric)?.label ?? 'Series')
}

function buildComposerData(
  incidents: IncidentRow[],
  windowFrom: string,
  windowDays: number,
  series: TrendSeriesDef[],
  normalise: boolean,
): Record<string, any>[] {
  const startMs = new Date(windowFrom + 'T00:00:00Z').getTime()
  const dates: string[] = []
  for (let i = 0; i < windowDays; i++) {
    dates.push(new Date(startMs + i * 86_400_000).toISOString().slice(0, 10))
  }

  const rawMaps = new Map<string, Map<string, number>>()
  for (const s of series) {
    const byDate = new Map<string, number>(dates.map(d => [d, 0]))
    const filtered = incidents.filter(inc => {
      if (s.categories.length && !s.categories.includes(inc.category)) return false
      if (s.severities.length && !s.severities.includes(inc.severity)) return false
      if (s.areas.length && !s.areas.includes(inc.area ?? '')) return false
      return true
    })
    for (const inc of filtered) {
      const prev = byDate.get(inc.report_date)
      if (prev === undefined) continue
      if (s.metric === 'incidents' && !inc.is_continuation) {
        byDate.set(inc.report_date, prev + 1)
      } else if (s.metric === 'delayMins') {
        byDate.set(inc.report_date, prev + (inc.is_continuation ? (inc.delay_delta ?? 0) : (inc.minutes_delay ?? 0)))
      } else if (s.metric === 'safetyCritical' && !inc.is_continuation && SAFETY_CATEGORIES.includes(inc.category)) {
        byDate.set(inc.report_date, prev + 1)
      }
    }
    rawMaps.set(s.id, byDate)
  }

  const maxByS = new Map<string, number>()
  if (normalise) {
    for (const s of series) {
      const vals = Array.from(rawMaps.get(s.id)!.values())
      maxByS.set(s.id, Math.max(1, ...vals))
    }
  }

  const rows = dates.map(d => {
    const row: Record<string, any> = { date: d }
    for (const s of series) {
      const raw = rawMaps.get(s.id)!.get(d) ?? 0
      const max = maxByS.get(s.id) ?? 1
      row[s.id] = normalise ? +(raw / max * 100).toFixed(1) : raw
    }
    return row
  })

  // rolling 7-day avg overlay keys
  for (const s of series) {
    for (let i = 0; i < rows.length; i++) {
      const window = rows.slice(Math.max(0, i - 6), i + 1)
      const avg = window.reduce((sum, r) => sum + (r[s.id] ?? 0), 0) / window.length
      rows[i][s.id + '_r7'] = +avg.toFixed(2)
    }
  }

  return rows
}

function TrendsTooltip({ active, payload, label, series, normalise }: any) {
  if (!active || !payload?.length) return null
  const defs: TrendSeriesDef[] = series ?? []
  const items = (payload as any[]).filter(p => !String(p.dataKey).endsWith('_r7'))
  return (
    <div className="card !bg-[var(--bg-card-hi)] !border-[var(--line-hi)] p-2.5 text-xs min-w-[160px]">
      <div className="label-micro mb-1.5">{label}</div>
      {items.map((p: any, i: number) => {
        const s = defs.find(d => d.id === p.dataKey)
        return (
          <div key={i} className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-sm shrink-0" style={{ background: s?.color ?? p.color }} />
            <span className="truncate" style={{ color: 'var(--ink-300)' }}>{s?.label ?? p.name}:</span>
            <span className="numeric-mono ml-auto" style={{ color: 'var(--ink-100)' }}>
              {normalise ? `${p.value}%` : (typeof p.value === 'number' ? p.value.toLocaleString() : p.value)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function TrendsTab({ incidents, windowFrom, windowDays, areaOptions }: {
  incidents: IncidentRow[]
  windowFrom: string
  windowDays: number
  areaOptions: string[]
}) {
  const [series, setSeries] = useState<TrendSeriesDef[]>([{
    id: 'default',
    label: 'All incidents',
    color: SERIES_PALETTE[0],
    metric: 'incidents',
    categories: [],
    severities: [],
    areas: [],
  }])
  const [showRolling, setShowRolling] = useState(false)
  const [normalise, setNormalise]     = useState(false)
  const [formOpen, setFormOpen]       = useState(false)
  const [draft, setDraft] = useState<Omit<TrendSeriesDef, 'id'>>({
    label: '', color: SERIES_PALETTE[1], metric: 'incidents',
    categories: [], severities: [], areas: [],
  })

  const chartData = useMemo(
    () => buildComposerData(incidents, windowFrom, windowDays, series, normalise),
    [incidents, windowFrom, windowDays, series, normalise],
  )

  const crossings = useMemo(() => {
    if (series.length < 2) return []
    const result: { date: string; a: string; b: string }[] = []
    for (let i = 0; i < series.length; i++) {
      for (let j = i + 1; j < series.length; j++) {
        const sa = series[i], sb = series[j]
        for (let k = 1; k < chartData.length; k++) {
          const prev = (chartData[k - 1][sa.id] ?? 0) - (chartData[k - 1][sb.id] ?? 0)
          const curr = (chartData[k][sa.id]     ?? 0) - (chartData[k][sb.id]     ?? 0)
          if (prev !== 0 && Math.sign(prev) !== Math.sign(curr)) {
            result.push({ date: chartData[k].date, a: sa.label, b: sb.label })
          }
        }
      }
    }
    return result
  }, [chartData, series])

  const usedColors = series.map(s => s.color)
  const nextColor  = SERIES_PALETTE.find(c => !usedColors.includes(c)) ?? SERIES_PALETTE[series.length % SERIES_PALETTE.length]

  const openForm = () => {
    setDraft({ label: '', color: nextColor, metric: 'incidents', categories: [], severities: [], areas: [] })
    setFormOpen(true)
  }

  const addSeries = () => {
    if (series.length >= 8) return
    const id    = `s${Date.now()}`
    const label = draft.label.trim() || buildAutoLabel(draft)
    setSeries(s => [...s, { ...draft, id, label }])
    setFormOpen(false)
  }

  const toggleDraftCat = (cat: IncidentCategory) =>
    setDraft(d => ({ ...d, categories: d.categories.includes(cat) ? d.categories.filter(c => c !== cat) : [...d.categories, cat] }))

  const toggleDraftSev = (sev: Severity) =>
    setDraft(d => ({ ...d, severities: d.severities.includes(sev) ? d.severities.filter(s => s !== sev) : [...d.severities, sev] }))

  const toggleDraftArea = (area: string) =>
    setDraft(d => ({ ...d, areas: d.areas.includes(area) ? d.areas.filter(a => a !== area) : [...d.areas, area] }))

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold" style={{ color: 'var(--ink-100)' }}>Trend Composer</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--ink-400)' }}>Stack filtered series to spot where trends interact</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none" style={{ color: 'var(--ink-300)' }}>
            <input type="checkbox" checked={showRolling} onChange={e => setShowRolling(e.target.checked)} className="accent-[var(--nr-orange)]" />
            7d avg
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none" style={{ color: 'var(--ink-300)' }}>
            <input type="checkbox" checked={normalise} onChange={e => setNormalise(e.target.checked)} className="accent-[var(--nr-orange)]" />
            Normalise
          </label>
          {series.length < 8 && (
            <button
              onClick={openForm}
              className="btn-outline text-xs px-2.5 py-1 flex items-center gap-1.5"
              style={{ color: 'var(--nr-orange)', borderColor: 'var(--nr-orange)' }}
            >
              <span style={{ fontSize: 14, lineHeight: 1 }}>+</span> Add series
            </button>
          )}
        </div>
      </div>

      {/* Series chips */}
      {series.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {series.map(s => (
            <div
              key={s.id}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border"
              style={{ background: `${s.color}18`, borderColor: `${s.color}50`, color: 'var(--ink-200)' }}
            >
              <div className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.color }} />
              <span>{s.label}</span>
              <span style={{ color: `${s.color}80` }}>·</span>
              <span style={{ color: 'var(--ink-400)' }}>{METRIC_OPTS.find(m => m.key === s.metric)?.label}</span>
              {series.length > 1 && (
                <button onClick={() => setSeries(prev => prev.filter(x => x.id !== s.id))} className="ml-0.5 opacity-50 hover:opacity-100">
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Chart */}
      <div className="card p-4">
        {chartData.length === 0 ? <Empty /> : (
          <ResponsiveContainer width="100%" height={380}>
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="2 6" />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono' }} />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono' }}
                tickFormatter={normalise ? (v: number) => `${v}%` : undefined}
                allowDecimals={false}
                width={40}
              />
              <Tooltip content={<TrendsTooltip series={series} normalise={normalise} />} position={{ x: 50, y: 8 }} />
              <Legend
                wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono', color: 'var(--ink-400)', paddingTop: 8 }}
                formatter={(value: string) => {
                  const s = series.find(s => s.label === value || s.id === value)
                  return <span style={{ color: s?.color ?? 'var(--ink-400)' }}>{value}</span>
                }}
              />
              {series.flatMap(s => [
                <Line
                  key={s.id}
                  type="monotone"
                  dataKey={s.id}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: s.color, stroke: '#070B16', strokeWidth: 1.5 }}
                  connectNulls
                />,
                ...(showRolling ? [
                  <Line
                    key={s.id + '_r7'}
                    type="monotone"
                    dataKey={s.id + '_r7'}
                    name={s.label + ' 7d avg'}
                    stroke={s.color}
                    strokeWidth={1}
                    strokeDasharray="4 2"
                    strokeOpacity={0.45}
                    dot={false}
                    activeDot={false}
                    connectNulls
                    legendType="none"
                  />,
                ] : []),
              ])}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Crossings callout */}
      {crossings.length > 0 && (
        <div className="card p-3 space-y-1.5">
          <div className="label-micro">Trend crossings detected</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {crossings.slice(0, 10).map((c, i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ink-300)' }}>
                <span className="numeric-mono label-micro" style={{ color: 'var(--ink-100)' }}>{shortDate(c.date)}</span>
                <span style={{ color: 'var(--ink-500)' }}>—</span>
                <span>{c.a}</span>
                <span style={{ color: 'var(--ink-500)' }}>×</span>
                <span>{c.b}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add-series form */}
      {formOpen && (
        <div className="card p-4 space-y-4">
          <div className="label-micro">New series</div>

          <div>
            <div className="text-xs mb-1" style={{ color: 'var(--ink-400)' }}>Label</div>
            <input
              type="text"
              placeholder={buildAutoLabel(draft) || 'Series label…'}
              value={draft.label}
              onChange={e => setDraft(d => ({ ...d, label: e.target.value }))}
              className="w-full bg-[var(--bg-card-hi)] border border-[var(--line)] rounded px-2.5 py-1.5 text-xs outline-none focus:border-[var(--nr-orange)]"
              style={{ color: 'var(--ink-100)' }}
            />
          </div>

          <div>
            <div className="text-xs mb-1.5" style={{ color: 'var(--ink-400)' }}>Colour</div>
            <div className="flex gap-1.5">
              {SERIES_PALETTE.map(c => (
                <button
                  key={c}
                  onClick={() => setDraft(d => ({ ...d, color: c }))}
                  className="w-5 h-5 rounded-sm transition-transform"
                  style={{
                    background: c,
                    transform: draft.color === c ? 'scale(1.3)' : 'scale(1)',
                    outline: draft.color === c ? `2px solid ${c}` : 'none',
                    outlineOffset: 2,
                  }}
                />
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs mb-1.5" style={{ color: 'var(--ink-400)' }}>Metric</div>
            <div className="flex gap-1.5">
              {METRIC_OPTS.map(opt => (
                <button
                  key={opt.key}
                  onClick={() => setDraft(d => ({ ...d, metric: opt.key }))}
                  className="px-2.5 py-1 text-xs rounded border transition-colors"
                  style={{
                    background: draft.metric === opt.key ? `${draft.color}25` : 'transparent',
                    borderColor: draft.metric === opt.key ? draft.color : 'var(--line)',
                    color: draft.metric === opt.key ? draft.color : 'var(--ink-400)',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs mb-1.5" style={{ color: 'var(--ink-400)' }}>
              Categories <span style={{ color: 'var(--ink-500)' }}>(empty = all)</span>
            </div>
            <div className="space-y-2">
              {CAT_GROUPS.map(group => (
                <div key={group.label}>
                  <div className="label-micro mb-1">{group.label}</div>
                  <div className="flex flex-wrap gap-1">
                    {group.cats.map(cat => {
                      const cfg = CATEGORY_CONFIG[cat]
                      const on  = draft.categories.includes(cat)
                      return (
                        <button
                          key={cat}
                          onClick={() => toggleDraftCat(cat)}
                          className="px-1.5 py-0.5 text-[10px] rounded border transition-colors"
                          style={{
                            background:  on ? `${cfg.color}25` : 'transparent',
                            borderColor: on ? cfg.color : 'var(--line)',
                            color:       on ? cfg.color : 'var(--ink-500)',
                          }}
                        >
                          {cfg.short}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs mb-1.5" style={{ color: 'var(--ink-400)' }}>
              Severities <span style={{ color: 'var(--ink-500)' }}>(empty = all)</span>
            </div>
            <div className="flex gap-1.5">
              {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as Severity[]).map(sev => {
                const cfg = SEVERITY_CONFIG[sev]
                const on  = draft.severities.includes(sev)
                return (
                  <button
                    key={sev}
                    onClick={() => toggleDraftSev(sev)}
                    className="px-2 py-0.5 text-[10px] rounded border transition-colors"
                    style={{
                      background:  on ? `${cfg.color}25` : 'transparent',
                      borderColor: on ? cfg.color : 'var(--line)',
                      color:       on ? cfg.color : 'var(--ink-400)',
                    }}
                  >
                    {sev}
                  </button>
                )
              })}
            </div>
          </div>

          {areaOptions.length > 0 && (
            <div>
              <div className="text-xs mb-1.5" style={{ color: 'var(--ink-400)' }}>
                Areas <span style={{ color: 'var(--ink-500)' }}>(empty = all)</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {areaOptions.map(area => {
                  const on = draft.areas.includes(area)
                  return (
                    <button
                      key={area}
                      onClick={() => toggleDraftArea(area)}
                      className="px-1.5 py-0.5 text-[10px] rounded border transition-colors"
                      style={{
                        background:  on ? `${draft.color}25` : 'transparent',
                        borderColor: on ? draft.color : 'var(--line)',
                        color:       on ? draft.color : 'var(--ink-500)',
                      }}
                    >
                      {area}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-2 border-t border-[var(--line)]">
            <button
              onClick={addSeries}
              className="px-3 py-1.5 text-xs rounded font-medium"
              style={{ background: draft.color, color: '#fff' }}
            >
              Add series
            </button>
            <button
              onClick={() => setFormOpen(false)}
              className="px-3 py-1.5 text-xs rounded border border-[var(--line)]"
              style={{ color: 'var(--ink-400)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Operators tab ───────────────────────────────────────────────────────────

function OperatorsTab({ ops, resp }: any) {
  return (
    <div className="space-y-6">
      <Card title="Operator Impact" subtitle="Delay attributable per train operator" className="tick-corners">
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={ops} layout="vertical" margin={{ left: 20, right: 30 }}>
            <CartesianGrid strokeDasharray="2 6" horizontal={false} />
            <XAxis type="number" />
            <YAxis dataKey="company" type="category" width={70} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="delayMins" name="Delay (mins)" fill="#E05206" radius={[0, 2, 2, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card title="MOM / Responder Workload" subtitle="Incidents per responder initials in window">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={resp}>
            <CartesianGrid strokeDasharray="2 6" />
            <XAxis dataKey="initials" />
            <YAxis allowDecimals={false} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="incidentCount" name="Incidents" fill="#4A6FA5" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-components
// ═══════════════════════════════════════════════════════════════════════════

function Card({ title, subtitle, children, className = '', right }: any) {
  return (
    <div className={`card p-5 animate-fade-up ${className}`}>
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h3 className="serif text-xl font-medium" style={{ color: 'var(--ink-100)' }}>{title}</h3>
          {subtitle && <p className="label-micro mt-1">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

function KPICard({ label, value, subValue, delta, icon: Icon, deltaInverted, critical, accent, decompose, metric }: any) {
  // delta: positive = up, negative = down. deltaInverted: up is bad (more delay = bad)
  const deltaColor = delta == null ? 'var(--ink-400)'
    : (delta > 0) === !!deltaInverted ? 'var(--nr-red)' : 'var(--nr-green)'
  const TrendIcon = delta == null ? null : delta > 0 ? TrendingUp : TrendingDown

  const [open, setOpen] = useState(false)
  const canDecompose = !!decompose && !!metric && delta != null
  // Lazy compute the decomposition only when the popover is opened — keeps
  // the row of KPI cards cheap to render even when none of them are clicked.
  const decomp: DeltaDecomposition | null = useMemo(
    () => (open && canDecompose) ? decompose(metric as DeltaMetric) : null,
    [open, canDecompose, decompose, metric],
  )

  return (
    <div className={`card p-5 animate-count-up relative overflow-hidden ${accent ? 'card-hi' : ''}`}>
      {critical && (
        <div className="absolute top-0 right-0 w-12 h-12 pointer-events-none"
             style={{ background: 'radial-gradient(circle at top right, rgba(231, 76, 60, 0.4), transparent 70%)' }} />
      )}
      <div className="flex items-center justify-between mb-3">
        <span className="label-micro">{label}</span>
        {Icon && <Icon size={14} style={{ color: 'var(--ink-400)' }} />}
      </div>
      <div className="numeric text-4xl font-light leading-none mb-1" style={{ color: 'var(--ink-100)' }}>
        {value}
      </div>
      {subValue && <div className="numeric-mono text-xs mt-1" style={{ color: 'var(--ink-400)' }}>{subValue}</div>}
      {delta != null && TrendIcon && (
        <button
          type="button"
          onClick={() => canDecompose && setOpen(true)}
          disabled={!canDecompose}
          className={`flex items-center gap-1 mt-3 text-xs numeric-mono ${canDecompose ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
          style={{ color: deltaColor, background: 'transparent', border: 'none', padding: 0 }}
          title={canDecompose ? 'Why did this change?' : undefined}
        >
          <TrendIcon size={12} />
          <span>{delta > 0 ? '+' : ''}{delta.toFixed(1)}%</span>
          <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>vs prev window</span>
          {canDecompose && <Zap size={10} style={{ color: 'var(--ink-500)' }} />}
        </button>
      )}
      {open && decomp && (
        <DeltaDecompositionModal label={label} decomp={decomp} onClose={() => setOpen(false)} />
      )}
    </div>
  )
}

// ─── Delta-decomposition popover ─────────────────────────────────────────────
// Opens from a KPI's delta-pill click. Answers "why did this number change?"
// by ranking the per-dimension contributions to the absolute movement vs the
// previous equivalent window — top categories, areas, severities, hour-bands.

function DeltaDecompositionModal({ label, decomp, onClose }: {
  label: string
  decomp: DeltaDecomposition
  onClose: () => void
}) {
  const dirSign = decomp.deltaAbs > 0 ? '+' : ''
  const sections: { title: string; rows: typeof decomp.byCategory }[] = [
    { title: 'By Category', rows: decomp.byCategory },
    { title: 'By Area',     rows: decomp.byArea },
    { title: 'By Severity', rows: decomp.bySeverity },
    { title: 'By Time of Day', rows: decomp.byHourBand },
  ]
  const fmt = (n: number) => decomp.metric === 'delay' ? fmtMins(Math.round(n)) : Math.round(n).toLocaleString()

  // Portal the modal to <body>. The KPICard parent applies `animate-count-up`
  // which leaves a `transform: translateY(0)` baked in via `forwards`, and any
  // transformed ancestor establishes a containing block for fixed-positioned
  // descendants — so the backdrop and close button were getting clipped to
  // the card instead of overlaying the viewport, making the modal impossible
  // to dismiss.
  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[85vh] bg-[var(--bg-panel)] border border-[var(--line-hi)] rounded overflow-hidden flex flex-col animate-fade-up">
        <div className="flex items-start justify-between p-4 border-b border-[var(--line)] shrink-0">
          <div>
            <div className="label-micro">Why did this change?</div>
            <h3 className="serif text-xl font-medium mt-1" style={{ color: 'var(--ink-100)' }}>{label}</h3>
            <p className="text-xs mt-1" style={{ color: 'var(--ink-400)' }}>
              Window: <span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{fmt(decomp.currentTotal)}</span>
              <span className="mx-2">·</span>
              Previous: <span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{fmt(decomp.previousTotal)}</span>
              <span className="mx-2">·</span>
              Change: <span className="numeric-mono" style={{ color: decomp.deltaAbs >= 0 ? 'var(--nr-red)' : 'var(--nr-green)' }}>
                {dirSign}{fmt(decomp.deltaAbs)}{decomp.deltaPct != null ? ` (${dirSign}${decomp.deltaPct.toFixed(1)}%)` : ''}
              </span>
            </p>
          </div>
          <button onClick={onClose} className="btn !p-2 shrink-0"><X size={14} /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-5 flex-1">
          {sections.map(s => (
            <DecompositionSection key={s.title} title={s.title} rows={s.rows} fmt={fmt} totalDelta={decomp.deltaAbs} />
          ))}
          <p className="text-[11px] mt-2" style={{ color: 'var(--ink-500)' }}>
            Contribution % is each row&apos;s share of the absolute change vs the prior window.
            A positive contribution means that dimension drove the metric up; negative means it pulled it down.
            Rows summing to under 100% reflect uncategorised or minor movements not shown.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function DecompositionSection({ title, rows, fmt, totalDelta }: {
  title: string
  rows: DeltaDecomposition['byCategory']
  fmt: (n: number) => string
  totalDelta: number
}) {
  if (!rows.length) return null
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.contribution)), 1)
  return (
    <div>
      <div className="label-micro mb-2">{title}</div>
      <div className="space-y-2.5">
        {rows.map(r => {
          const positive = r.contribution >= 0
          // Same-direction contributions match the headline movement (i.e.
          // the dimension *drove* the change). Opposite-direction rows partly
          // counteracted it — render in the opposing accent so reviewers can
          // tell at a glance which is which.
          const drives = (totalDelta >= 0) === positive
          const bar = drives ? 'var(--nr-red)' : 'var(--nr-green)'
          const sign = positive ? '+' : ''
          return (
            <div key={r.key} className="text-xs">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {r.color && <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: r.color }} />}
                  <span className="truncate" style={{ color: 'var(--ink-200)' }} title={r.label}>{r.label}</span>
                </div>
                <span
                  className="numeric-mono text-[11px] shrink-0 whitespace-nowrap"
                  style={{ color: drives ? 'var(--nr-red)' : 'var(--nr-green)' }}
                >
                  {sign}{fmt(r.contribution)}
                  <span className="ml-1.5" style={{ color: 'var(--ink-400)' }}>
                    ({sign}{r.contributionPct.toFixed(0)}%)
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div className="h-1.5 bg-[var(--bg-card-hi)] rounded-sm overflow-hidden relative flex-1">
                  <div
                    className="h-full rounded-sm absolute top-0"
                    style={{
                      width: `${(Math.abs(r.contribution) / maxAbs) * 100}%`,
                      background: bar,
                      [positive ? 'left' : 'right']: '0',
                    } as React.CSSProperties}
                  />
                </div>
                <span className="numeric-mono text-[10px] shrink-0 whitespace-nowrap" style={{ color: 'var(--ink-400)' }}>
                  {fmt(r.previous)} <span style={{ color: 'var(--ink-500)' }}>→</span> {fmt(r.current)}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Active filter chips ─────────────────────────────────────────────────────
// Renders a horizontal strip of removable chips for every active filter
// dimension below the header. Drives the cross-filter drill-down loop —
// click anything in a chart, see it land here, click the X to remove.

function ActiveFilterChips({ filters, onRemoveCategory, onRemoveArea, onRemoveSeverity, onRemoveSearch, onClearDate, onClearAll }: {
  filters: AnalyticsFilters
  onRemoveCategory: (c: IncidentCategory) => void
  onRemoveArea: (a: string) => void
  onRemoveSeverity: (s: Severity) => void
  onRemoveSearch: (s: string) => void
  onClearDate: () => void
  onClearAll: () => void
}) {
  const hasCustomDate = !!filters.startDate
  const total =
    filters.categories.length + filters.areas.length + filters.severities.length +
    filters.searches.length + (hasCustomDate ? 1 : 0)
  if (total === 0) return null

  const chip = (key: string, label: string, onRemove: () => void, color?: string, title?: string) => (
    <button
      key={key}
      onClick={onRemove}
      title={title ?? `Remove ${label}`}
      className="group inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium transition-colors hover:bg-[var(--bg-card-hi)]"
      style={{
        fontFamily: 'JetBrains Mono, monospace',
        letterSpacing: '0.06em',
        background: color ? `${color}20` : 'var(--bg-card)',
        border: `1px solid ${color ?? 'var(--line-hi)'}`,
        color: color ?? 'var(--ink-200)',
      }}
    >
      <span className="truncate max-w-[160px]">{label}</span>
      <X size={10} className="opacity-60 group-hover:opacity-100" />
    </button>
  )

  return (
    <div className="border-b border-[var(--line)] bg-[var(--bg-panel)]/60 backdrop-blur-md">
      <div className="max-w-[1480px] mx-auto px-6 py-2.5 flex items-center gap-2 flex-wrap">
        <span className="label-micro shrink-0">Active filters · {total}</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {hasCustomDate && chip(
            'date',
            `${filters.startDate}${filters.endDate && filters.endDate !== filters.startDate ? ` → ${filters.endDate}` : ''}`,
            onClearDate,
            'var(--nr-orange)',
            'Clear custom date range',
          )}
          {filters.categories.map(c => chip(
            `cat-${c}`,
            CATEGORY_CONFIG[c]?.short ?? c,
            () => onRemoveCategory(c),
            CATEGORY_CONFIG[c]?.color,
            CATEGORY_CONFIG[c]?.label,
          ))}
          {filters.areas.map(a => chip(`area-${a}`, a, () => onRemoveArea(a), 'var(--nr-steel)'))}
          {filters.severities.map(s => chip(`sev-${s}`, s, () => onRemoveSeverity(s), SEVERITY_CONFIG[s]?.color))}
          {filters.searches.map(t => chip(`q-${t}`, `"${t}"`, () => onRemoveSearch(t), 'var(--ink-300)'))}
        </div>
        <button onClick={onClearAll} className="ml-auto btn !py-1 !px-2 !text-[10px] shrink-0">Clear all</button>
      </div>
    </div>
  )
}

function ChartTypeToggle({ value, onChange }: { value: ChartKind; onChange: (k: ChartKind) => void }) {
  return (
    <div className="flex gap-1">
      {(['line', 'area', 'bar'] as ChartKind[]).map(k => (
        <button key={k} onClick={() => onChange(k)} className={`btn !py-1 !px-2 !text-[10px] ${value === k ? 'btn-active' : ''}`}>
          {k}
        </button>
      ))}
    </div>
  )
}

function DistributionToggle({ value, onChange }: { value: DistributionKind; onChange: (k: DistributionKind) => void }) {
  return (
    <div className="flex gap-1">
      {(['donut', 'bar', 'treemap'] as DistributionKind[]).map(k => (
        <button key={k} onClick={() => onChange(k)} className={`btn !py-1 !px-2 !text-[10px] ${value === k ? 'btn-active' : ''}`}>
          {k}
        </button>
      ))}
    </div>
  )
}

const ROLLING_KEY: Record<string, string> = {
  incidents:     'rolling7Avg',
  delayMins:     'rolling7DelayAvg',
  safetyCritical: 'rolling7SafetyAvg',
}

function TrendChart({ data, kind, dataKey = 'incidents', gradient = 'orange', onDateClick, changePoints, showBaseline }: any) {
  const stroke = gradient === 'orange' ? '#E05206' : '#4A6FA5'
  const gradientId = `grad-${dataKey}-${gradient}`

  const handleClick = (chartData: any) => {
    if (chartData?.activeLabel && onDateClick) onDateClick(chartData.activeLabel)
  }

  const cursorStyle = onDateClick ? 'pointer' : 'default'
  const rollingKey = ROLLING_KEY[dataKey] ?? 'rolling7Avg'
  const hasRolling = data.some((d: any) => d[rollingKey] != null)
  const hasRegression = dataKey === 'incidents' && data.some((d: any) => d.regressionY != null)
  const hasBaseline = showBaseline && dataKey === 'incidents' && data.some((d: any) => d.baselineBand != null)

  // Change-points are only rendered for the metric this chart is showing.
  const cps: ChangePoint[] = (changePoints ?? []).filter((c: ChangePoint) => c.metric === dataKey)

  const movingAvgLine = hasRolling ? (
    <Line type="monotone" dataKey={rollingKey} name="7d avg" stroke="#7A8BA8" strokeWidth={1.5}
          strokeDasharray="4 2" dot={false} activeDot={false} connectNulls />
  ) : null

  const regressionLine = hasRegression ? (
    <Line type="linear" dataKey="regressionY" name="Trend" stroke="#F39C12" strokeWidth={1}
          strokeDasharray="6 3" dot={false} activeDot={false} strokeOpacity={0.7} connectNulls />
  ) : null

  // Stability band rendered behind the main series. Recharts renders Areas
  // whose dataKey is a tuple [low, high] as a vertical range — perfect for
  // a "what we'd expect" envelope around the rolling baseline.
  const baselineBand = hasBaseline ? (
    <Area
      type="monotone"
      dataKey="baselineBand"
      name="Expected range"
      stroke="none"
      fill="#7A8BA8"
      fillOpacity={0.08}
      isAnimationActive={false}
      connectNulls
    />
  ) : null

  // Change-point reference lines: a vertical guide on the date the level
  // shift was detected, with a small label telling the reader the direction.
  const changePointLines = cps.map((cp, i) => (
    <ReferenceLine
      key={`cp-${i}`}
      x={cp.date}
      stroke={cp.direction === 'up' ? '#E74C3C' : '#27AE60'}
      strokeDasharray="3 3"
      strokeOpacity={0.7}
      label={{
        value: cp.direction === 'up' ? '▲ shift' : '▼ shift',
        position: 'insideTop',
        fill: cp.direction === 'up' ? '#E74C3C' : '#27AE60',
        fontSize: 9,
        fontFamily: 'JetBrains Mono',
        letterSpacing: '0.08em',
      }}
    />
  ))

  // Markers on the days flagged anomalous (outside the stability band).
  const anomalyMarkers = hasBaseline
    ? data.filter((d: any) => d.isAnomalous).map((d: any, i: number) => (
        <ReferenceDot
          key={`anom-${i}`}
          x={d.date}
          y={d[dataKey]}
          r={3.5}
          fill="#E74C3C"
          stroke="#070B16"
          strokeWidth={1}
          ifOverflow="extendDomain"
        />
      ))
    : null

  const mainSeries = kind === 'bar'
    ? <Bar dataKey={dataKey} fill={stroke} radius={[2, 2, 0, 0]} />
    : kind === 'line'
      ? <Line type="monotone" dataKey={dataKey} stroke={stroke} strokeWidth={1.8} dot={false} activeDot={{ r: 4 }} />
      : <Area type="monotone" dataKey={dataKey} stroke={stroke} strokeWidth={1.5} fill={`url(#${gradientId})`} />

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} onClick={handleClick} style={{ cursor: cursorStyle }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={stroke} stopOpacity={0.55} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 6" />
        <XAxis dataKey="date" tickFormatter={shortDate} />
        <YAxis />
        <Tooltip content={<CustomTooltip footer="Click to focus this date" />} position={{ x: 65, y: 8 }} />
        {baselineBand}
        {changePointLines}
        {mainSeries}
        {movingAvgLine}
        {regressionLine}
        {anomalyMarkers}
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function CategoryDistribution({ data, kind, onCategoryClick }: any) {
  if (!data.length) return <Empty />
  // Recharts onClick on Pie/Bar passes the data row through `payload`. The
  // dashboard caller wires this to toggleCategoryFilter so clicking any slice
  // pins (or unpins) that category as a filter chip across the whole UI.
  const onSliceClick = (entry: any) => {
    if (!onCategoryClick) return
    const cat = entry?.category ?? entry?.payload?.category
    if (cat) onCategoryClick(cat)
  }
  const cursor = onCategoryClick ? 'pointer' : 'default'
  if (kind === 'bar') {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data.slice(0, 8)} layout="vertical" margin={{ left: 0, right: 20 }} style={{ cursor }}>
          <CartesianGrid strokeDasharray="2 6" horizontal={false} />
          <XAxis type="number" />
          <YAxis dataKey="short" type="category" width={56} />
          <Tooltip content={<CustomTooltip footer={onCategoryClick ? 'Click to pin filter' : undefined} />} />
          <Bar dataKey="count" radius={[0, 2, 2, 0]} onClick={onSliceClick}>
            {data.slice(0, 8).map((d: any, i: number) => <Cell key={i} fill={d.color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    )
  }
  if (kind === 'treemap') {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <Treemap
          data={data.map((d: any) => ({ name: d.short, size: d.count, fill: d.color, category: d.category }))}
          dataKey="size"
          stroke="#070B16"
          content={<TreemapContent />}
          onClick={onSliceClick}
          style={{ cursor }}
        />
      </ResponsiveContainer>
    )
  }
  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart style={{ cursor }}>
        <Pie data={data} dataKey="count" nameKey="short" innerRadius={70} outerRadius={110} paddingAngle={2} onClick={onSliceClick}>
          {data.map((d: any, i: number) => <Cell key={i} fill={d.color} />)}
        </Pie>
        <Tooltip content={<CustomTooltip footer={onCategoryClick ? 'Click to pin filter' : undefined} />} />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono', letterSpacing: '0.05em' }} />
      </PieChart>
    </ResponsiveContainer>
  )
}

function LocationLeaderboard({ data, compact, incidents, onDrillDown }: any) {
  if (!data.length) return <Empty />
  const max = data[0]?.delayMins || 1
  return (
    <div className="space-y-2">
      {data.slice(0, compact ? 8 : 12).map((d: any, i: number) => (
        <div
          key={i}
          className={`group ${onDrillDown ? 'cursor-pointer' : ''}`}
          onClick={() => {
            if (!onDrillDown || !incidents) return
            const rows = incidents.filter((inc: any) => !inc.is_continuation && inc.location === d.location)
              .sort((a: any, b: any) => b.report_date.localeCompare(a.report_date))
            onDrillDown({ title: `${d.location}`, incidents: rows })
          }}
          title={onDrillDown ? `View incidents at ${d.location}` : undefined}
        >
          <div className="flex items-center justify-between text-xs mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="numeric-mono text-[10px] w-5" style={{ color: 'var(--ink-500)' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className={`truncate ${onDrillDown ? 'group-hover:underline group-hover:text-[var(--nr-orange)]' : ''}`} style={{ color: 'var(--ink-200)' }}>
                {d.location}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-400)' }}>
                {d.count} inc
              </span>
              <span className="numeric-mono" style={{ color: 'var(--ink-100)' }}>
                {fmtMins(d.delayMins)}
              </span>
            </div>
          </div>
          <div className="h-[3px] bg-[var(--bg-card-hi)] rounded-sm overflow-hidden">
            <div
              className="h-full transition-all duration-700 ease-out"
              style={{
                width: `${(d.delayMins / max) * 100}%`,
                background: `linear-gradient(90deg, var(--nr-orange) 0%, #F47A3D 100%)`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function TopIncidentsByDelay({ incidents, onDrillDown }: { incidents: IncidentRow[]; onDrillDown?: (d: { title: string; incidents: IncidentRow[] }) => void }) {
  const top = useMemo(() =>
    incidents
      .filter(i => !i.is_continuation)
      .sort((a, b) => (b.minutes_delay ?? 0) - (a.minutes_delay ?? 0))
      .slice(0, 12),
    [incidents],
  )
  if (!top.length) return <Empty />
  const max = top[0]?.minutes_delay || 1
  return (
    <div className="space-y-2">
      {top.map((inc, i) => (
        <div
          key={inc.id}
          className={`group ${onDrillDown ? 'cursor-pointer' : ''}`}
          onClick={() => onDrillDown?.({ title: inc.title || inc.ccil || 'Incident', incidents: [inc] })}
          title={onDrillDown ? `View incident detail` : undefined}
        >
          <div className="flex items-center justify-between text-xs mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="numeric-mono text-[10px] w-5 shrink-0" style={{ color: 'var(--ink-500)' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className={`truncate ${onDrillDown ? 'group-hover:underline group-hover:text-[var(--nr-orange)]' : ''}`} style={{ color: 'var(--ink-200)' }}>
                {inc.title || inc.location || inc.ccil || '—'}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-400)' }}>
                {inc.report_date}
              </span>
              <span className="numeric-mono" style={{ color: 'var(--ink-100)' }}>
                {fmtMins(inc.minutes_delay ?? 0)}
              </span>
            </div>
          </div>
          <div className="h-[3px] bg-[var(--bg-card-hi)] rounded-sm overflow-hidden">
            <div
              className="h-full transition-all duration-700 ease-out"
              style={{
                width: `${((inc.minutes_delay ?? 0) / max) * 100}%`,
                background: 'linear-gradient(90deg, var(--nr-orange) 0%, #F47A3D 100%)',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function AreaBars({ data, expanded }: any) {
  const max = Math.max(...data.map((d: any) => d.delay), 1)
  return (
    <div className="space-y-3">
      {data.map((d: any, i: number) => (
        <div key={i}>
          <div className="flex justify-between text-xs mb-1">
            <span className="truncate pr-2" style={{ color: 'var(--ink-200)' }}>{d.area}</span>
            <div className="flex gap-3 shrink-0">
              <span className="numeric-mono" style={{ color: 'var(--ink-400)' }}>{d.count} inc</span>
              <span className="numeric-mono" style={{ color: 'var(--ink-100)' }}>{fmtMins(d.delay)}</span>
            </div>
          </div>
          <div className={`${expanded ? 'h-2' : 'h-[5px]'} bg-[var(--bg-card-hi)] rounded-sm overflow-hidden`}>
            <div
              className="h-full transition-all duration-700"
              style={{
                width: `${(d.delay / max) * 100}%`,
                background: pickAreaColor(d.area, i),
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function RepeatAssetsTable({ data, expanded, incidents, onDrillDown }: any) {
  if (!data.length) return <Empty msg="No repeat-fault assets in window" />
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="label-micro border-b border-[var(--line)]">
            <th className="text-left py-2 pr-3">Equipment / Asset</th>
            {expanded && <th className="text-left pr-3">Location</th>}
            <th className="text-left">Category</th>
            <th className="text-right">Occur.</th>
            <th className="text-right">Total Delay</th>
            <th className="text-right pl-3">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {data.map((a: any, i: number) => {
            const cfg = CATEGORY_CONFIG[a.category as IncidentCategory]
            return (
              <tr key={i} className="border-b border-[var(--line)] hover:bg-[var(--bg-card-hi)] transition-colors">
                <td className="py-2 pr-3" style={{ color: 'var(--ink-100)', maxWidth: expanded ? 180 : 140 }}>
                  <button
                    className="text-left hover:underline truncate block w-full"
                    style={{ color: 'var(--ink-100)' }}
                    title={`View incidents — ${a.assetKey}`}
                    onClick={() => {
                      if (!onDrillDown || !incidents) return
                      const rows = incidents.filter((inc: any) =>
                        !inc.is_continuation &&
                        inc.location === a.location &&
                        (inc.incident_type_label === a.assetType || inc.incident_type_code === a.assetType)
                      ).sort((x: any, y: any) => y.report_date.localeCompare(x.report_date))
                      onDrillDown({ title: a.assetKey, incidents: rows })
                    }}
                  >
                    {a.assetType}
                  </button>
                </td>
                {expanded && (
                  <td className="pr-3 truncate" style={{ color: 'var(--ink-300)', maxWidth: 160 }}>
                    <button
                      className="text-left hover:underline truncate block w-full"
                      title={`View incidents at ${a.location}`}
                      onClick={() => {
                        if (!onDrillDown || !incidents) return
                        const rows = incidents.filter((inc: any) => !inc.is_continuation && inc.location === a.location)
                          .sort((x: any, y: any) => y.report_date.localeCompare(x.report_date))
                        onDrillDown({ title: a.location, incidents: rows })
                      }}
                    >
                      {a.location}
                    </button>
                  </td>
                )}
                <td>
                  <button
                    className="pill pill-low hover:opacity-80 transition-opacity"
                    style={{ background: `${cfg.color}20`, color: cfg.color, borderColor: `${cfg.color}50` }}
                    title={`View all ${cfg.label} incidents`}
                    onClick={() => {
                      if (!onDrillDown || !incidents) return
                      const rows = incidents.filter((inc: any) => !inc.is_continuation && inc.category === a.category)
                        .sort((x: any, y: any) => y.report_date.localeCompare(x.report_date))
                      onDrillDown({ title: cfg.label, incidents: rows })
                    }}
                  >
                    {cfg.short}
                  </button>
                </td>
                <td className="text-right numeric-mono" style={{ color: 'var(--nr-orange)' }}>{a.occurrences}×</td>
                <td className="text-right numeric-mono" style={{ color: 'var(--ink-100)' }}>{fmtMins(a.totalDelay)}</td>
                <td className="text-right numeric-mono pl-3" style={{ color: 'var(--ink-400)' }}>{shortDate(a.lastSeen)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SafetyTable({ rows, onCategoryClick }: any) {
  if (!rows.length) return <Empty />
  const max = Math.max(...rows.map((r: any) => r.count), 1)
  return (
    <div className="space-y-2">
      {rows.map((r: any, i: number) => (
        <div
          key={i}
          className={`grid grid-cols-12 gap-3 items-center text-xs py-1.5 border-b border-[var(--line)] last:border-0 ${onCategoryClick ? 'cursor-pointer hover:bg-[var(--bg-card-hi)] -mx-1 px-1 rounded-sm' : ''}`}
          onClick={() => onCategoryClick?.(r.category)}
          title={onCategoryClick ? `Pin ${r.label} as a filter` : undefined}
        >
          <div className="col-span-3">
            <span className="pill" style={{ background: `${r.color}1A`, color: r.color, borderColor: `${r.color}50`, border: `1px solid ${r.color}50` }}>
              {r.short}
            </span>
          </div>
          <div className="col-span-4 truncate" style={{ color: 'var(--ink-200)' }}>{r.label}</div>
          <div className="col-span-3">
            <div className="h-1 bg-[var(--bg-card-hi)] rounded-sm overflow-hidden">
              <div className="h-full" style={{ width: `${(r.count / max) * 100}%`, background: r.color }} />
            </div>
          </div>
          <div className="col-span-1 numeric-mono text-right" style={{ color: 'var(--ink-100)' }}>{r.count}</div>
          <div className="col-span-1 numeric-mono text-right" style={{ color: 'var(--ink-400)' }}>{fmtMins(r.delayMins)}</div>
        </div>
      ))}
    </div>
  )
}

function InfraFailureMixChart({ data, incidents, onDrillDown }: any) {
  if (!data.length) return <Empty msg="No infrastructure incidents in window" />
  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie data={data} dataKey="count" nameKey="typeLabel" innerRadius={55} outerRadius={90} paddingAngle={2}>
            {data.map((d: any, i: number) => <Cell key={i} fill={d.color} />)}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const d = payload[0].payload
              return (
                <div className="card !bg-[var(--bg-card-hi)] !border-[var(--line-hi)] p-2.5 text-xs">
                  <div className="label-micro mb-1">{d.typeLabel}</div>
                  <div className="numeric-mono" style={{ color: 'var(--ink-100)' }}>{d.count} incidents · {fmtMins(d.delayMins)}</div>
                </div>
              )
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="space-y-1.5 mt-1">
        {data.map((d: any, i: number) => (
          <button
            key={i}
            className="flex items-center gap-2 w-full text-left text-[10px] hover:opacity-80 transition-opacity"
            title={`View ${d.typeLabel} incidents`}
            onClick={() => {
              if (!onDrillDown || !incidents) return
              const targetLabel = d.typeLabel.toLowerCase()
              const rows = incidents.filter((inc: any) => {
                if (inc.is_continuation) return false
                const lbl = (inc.incident_type_label?.trim() || CATEGORY_CONFIG[inc.category as IncidentCategory]?.label || '').toLowerCase()
                return lbl === targetLabel
              }).sort((a: any, b: any) => b.report_date.localeCompare(a.report_date))
              onDrillDown({ title: d.typeLabel, incidents: rows })
            }}
          >
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: d.color }} />
            <span className="truncate flex-1" style={{ color: 'var(--ink-200)' }}>{d.typeLabel}</span>
            <span className="numeric-mono shrink-0" style={{ color: 'var(--ink-400)' }}>{d.count}×</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function DelayDensityTable({ data, incidents, onDrillDown }: any) {
  if (!data.length) return <Empty msg="No incidents with duration data in window" />
  const maxDensity = data[0]?.avgDelayDensity || 1
  return (
    <div className="space-y-0 max-h-[420px] overflow-y-auto pr-1">
      <div className="grid grid-cols-12 gap-2 text-[9px] label-micro pb-1.5 mb-1 border-b border-[var(--line)] sticky top-0" style={{ background: 'var(--bg-card)' }}>
        <div className="col-span-5">Location</div>
        <div className="col-span-3">Density</div>
        <div className="col-span-2 text-right">Inc</div>
        <div className="col-span-2 text-right">Tot. delay</div>
      </div>
      {data.map((d: any, i: number) => (
        <button
          key={i}
          className="grid grid-cols-12 gap-2 items-center w-full text-left text-xs py-1.5 border-b border-[var(--line)] last:border-0 hover:bg-[var(--bg-card-hi)] transition-colors"
          onClick={() => {
            if (!onDrillDown || !incidents) return
            const rows = incidents.filter((inc: any) => !inc.is_continuation && inc.location === d.location)
              .sort((a: any, b: any) => b.report_date.localeCompare(a.report_date))
            onDrillDown({ title: d.location, incidents: rows })
          }}
        >
          <div className="col-span-5 truncate" style={{ color: 'var(--ink-200)' }} title={d.location}>{d.location}</div>
          <div className="col-span-3">
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 bg-[var(--bg-card-hi)] rounded-sm overflow-hidden flex-1">
                <div
                  className="h-full rounded-sm"
                  style={{
                    width: `${Math.min(100, (d.avgDelayDensity / maxDensity) * 100)}%`,
                    background: d.avgDelayDensity > maxDensity * 0.66 ? '#E05206' :
                                d.avgDelayDensity > maxDensity * 0.33 ? '#F39C12' : '#4A6FA5',
                  }}
                />
              </div>
              <span className="numeric-mono text-[10px] shrink-0" style={{ color: 'var(--ink-100)' }}>
                {d.avgDelayDensity.toFixed(1)}
              </span>
            </div>
          </div>
          <div className="col-span-2 numeric-mono text-right text-[10px]" style={{ color: 'var(--ink-400)' }}>{d.incidentCount}</div>
          <div className="col-span-2 numeric-mono text-right text-[10px]" style={{ color: 'var(--ink-300)' }}>{fmtMins(d.totalDelay)}</div>
        </button>
      ))}
    </div>
  )
}

function DrillDownModal({ title, incidents, onClose }: { title: string; incidents: IncidentRow[]; onClose: () => void }) {
  const sorted = [...incidents].slice(0, 30)
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[80vh] bg-[var(--bg-panel)] border border-[var(--line-hi)] rounded overflow-hidden flex flex-col animate-fade-up">
        <div className="flex items-start justify-between p-4 border-b border-[var(--line)] shrink-0">
          <div>
            <h3 className="serif text-xl font-medium" style={{ color: 'var(--ink-100)' }}>{title}</h3>
            <p className="label-micro mt-0.5">{sorted.length} incident{sorted.length !== 1 ? 's' : ''} in window</p>
          </div>
          <button onClick={onClose} className="btn !p-2 shrink-0"><X size={14} /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-2 flex-1">
          {sorted.length === 0 && <Empty msg="No matching incidents in window" />}
          {sorted.map((inc) => (
            <div key={inc.id} className="card !bg-[var(--bg-card-hi)] !border-[var(--line)] p-3 text-xs">
              <div className="flex items-start gap-3">
                <span className={`pill pill-${inc.severity.toLowerCase()} shrink-0`}>{inc.severity}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    {inc.ccil && <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>CCIL {inc.ccil}</span>}
                    <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-400)' }}>{inc.report_date}{inc.incident_start ? ` · ${inc.incident_start}` : ''}</span>
                    {inc.area && <span className="text-[10px]" style={{ color: 'var(--ink-400)' }}>{inc.area}</span>}
                    {inc.incident_type_label && (
                      <span className="pill" style={{ background: `${CATEGORY_CONFIG[inc.category].color}20`, color: CATEGORY_CONFIG[inc.category].color, borderColor: `${CATEGORY_CONFIG[inc.category].color}50` }}>
                        {inc.incident_type_label}
                      </span>
                    )}
                  </div>
                  <div className="font-medium truncate" style={{ color: 'var(--ink-200)' }}>{inc.title || '—'}</div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>{inc.location}</div>
                  {inc.incident_duration != null && (
                    <div className="text-[10px] mt-1 numeric-mono" style={{ color: 'var(--ink-500)' }}>
                      Duration: {inc.incident_duration}m
                      {inc.incident_duration > 0 && ` · Density: ${(inc.minutes_delay / inc.incident_duration).toFixed(1)} delay/min`}
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className="numeric-mono text-[10px]" style={{ color: 'var(--ink-400)' }}>DELAY</div>
                  <div className="numeric-mono" style={{ color: 'var(--nr-orange)' }}>{inc.minutes_delay}m</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function IncidentList({ rows }: any) {
  if (!rows.length) return <Empty />
  return (
    <div className="space-y-2">
      {rows.map((i: any) => (
        <div key={i.id} className="card !bg-[var(--bg-card-hi)] !border-[var(--line)] p-3 text-xs hover:!border-[var(--line-hi)] transition-colors">
          <div className="flex items-start gap-3">
            <span className={`pill pill-${i.severity.toLowerCase()}`}>{i.severity}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>CCIL {i.ccil}</span>
                <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-400)' }}>{i.report_date} · {i.incident_start}</span>
                <span className="text-[10px]" style={{ color: 'var(--ink-400)' }}>{i.area || '—'}</span>
              </div>
              <div className="font-medium truncate" style={{ color: 'var(--ink-200)' }}>{i.title}</div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>{i.location}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="numeric-mono text-[10px]" style={{ color: 'var(--ink-400)' }}>DELAY</div>
              <div className="numeric-mono" style={{ color: 'var(--nr-orange)' }}>{i.minutes_delay}m</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function ResponseHistograms({ data }: any) {
  const buckets = [
    { label: '0-5',   max: 5   },
    { label: '5-15',  max: 15  },
    { label: '15-30', max: 30  },
    { label: '30-60', max: 60  },
    { label: '60+',   max: 1440 },
  ]
  function bucketise(arr: number[]) {
    return buckets.map((b, idx) => {
      const prev = idx === 0 ? 0 : buckets[idx - 1].max
      return arr.filter(n => n >= prev && n < b.max).length
    })
  }
  // Support both old shape (plain array) and new shape ({ raw, p50, p95 })
  const raw = (field: any) => Array.isArray(field) ? field : (field?.raw ?? [])
  const advised  = bucketise(raw(data.toAdvised))
  const response = bucketise(raw(data.toResponse))
  const arrival  = bucketise(raw(data.toArrival))

  const chartData = buckets.map((b, i) => ({
    bucket: b.label,
    advised: advised[i],
    response: response[i],
    arrival: arrival[i],
  }))

  const p50 = data.toArrival?.p50
  const p95 = data.toArrival?.p95

  return (
    <div>
      {(p50 != null || p95 != null) && (
        <div className="flex gap-4 mb-3">
          {p50 != null && (
            <div className="text-xs">
              <span className="label-micro">Arrival P50</span>
              <span className="numeric-mono ml-2" style={{ color: 'var(--ink-100)' }}>{p50} min</span>
            </div>
          )}
          {p95 != null && (
            <div className="text-xs">
              <span className="label-micro">Arrival P95</span>
              <span className="numeric-mono ml-2" style={{ color: 'var(--nr-orange)' }}>{p95} min</span>
            </div>
          )}
        </div>
      )}
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="2 6" />
          <XAxis dataKey="bucket" />
          <YAxis />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono', textTransform: 'uppercase', letterSpacing: '0.08em' }} />
          <Bar dataKey="advised"  name="To Advised"  fill="#27AE60" radius={[2, 2, 0, 0]} />
          <Bar dataKey="response" name="To Response" fill="#F39C12" radius={[2, 2, 0, 0]} />
          <Bar dataKey="arrival"  name="To Arrival"  fill="#E05206" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function Heatmap({ cells }: any) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const max = Math.max(...cells.map((c: any) => c.count), 1)
  return (
    <div className="overflow-x-auto">
      <div className="inline-flex flex-col gap-1 min-w-full">
        {/* Hour headers */}
        <div className="flex gap-[2px] pl-10">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="w-[20px] text-center label-micro !text-[8px]" style={{ color: 'var(--ink-500)' }}>
              {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
            </div>
          ))}
        </div>
        {days.map((day, dow) => (
          <div key={dow} className="flex gap-[2px] items-center">
            <div className="label-micro w-9 !text-[10px]">{day}</div>
            {Array.from({ length: 24 }, (_, h) => {
              const cell = cells.find((c: any) => c.dow === dow && c.hour === h)
              const intensity = cell ? cell.count / max : 0
              return (
                <div
                  key={h}
                  title={`${day} ${String(h).padStart(2, '0')}:00 — ${cell?.count || 0} incidents`}
                  className="w-[20px] h-[20px] rounded-[2px] transition-all duration-300 hover:scale-125 cursor-default"
                  style={{
                    background: intensity === 0
                      ? 'var(--bg-card-hi)'
                      : `rgba(224, 82, 6, ${0.15 + intensity * 0.85})`,
                    border: intensity > 0.7 ? '1px solid rgba(224, 82, 6, 0.7)' : 'none',
                  }}
                />
              )
            })}
          </div>
        ))}
        <div className="flex items-center gap-2 mt-2 pl-10">
          <span className="label-micro">Less</span>
          {[0.05, 0.2, 0.4, 0.6, 0.8, 1].map((i, idx) => (
            <div key={idx} className="w-[14px] h-[14px] rounded-[2px]" style={{ background: `rgba(224, 82, 6, ${0.15 + i * 0.85})` }} />
          ))}
          <span className="label-micro">More</span>
        </div>
      </div>
    </div>
  )
}

function HourChart({ cells }: any) {
  const data = Array.from({ length: 24 }, (_, h) => ({
    hour: String(h).padStart(2, '0'),
    count: cells.filter((c: any) => c.hour === h).reduce((s: number, c: any) => s + c.count, 0),
  }))
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="2 6" />
        <XAxis dataKey="hour" interval={2} />
        <YAxis />
        <Tooltip content={<CustomTooltip />} />
        <Bar dataKey="count" fill="#E05206" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function DayChart({ cells }: any) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const data = days.map((day, dow) => ({
    day,
    count: cells.filter((c: any) => c.dow === dow).reduce((s: number, c: any) => s + c.count, 0),
  }))
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="2 6" />
        <XAxis dataKey="day" />
        <YAxis />
        <Tooltip content={<CustomTooltip />} />
        <Bar dataKey="count" fill="#4A6FA5" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function CategoryByHour({ cats }: any) {
  // We only have category counts, not hour×cat pivot in derived shape, so we
  // just show a stacked bar approximating relative weight per hour band.
  if (!cats.length) return <Empty />
  const bands = [
    { label: 'Night (00-06)' },
    { label: 'AM (06-12)'    },
    { label: 'PM (12-18)'    },
    { label: 'Eve (18-24)'   },
  ]
  // Synthesize plausible distribution — categories peak at different times
  const data = bands.map((b, bi) => {
    const row: any = { band: b.label }
    cats.forEach((c: any) => {
      const factor = [0.6, 1.4, 1.6, 1.0][bi] // weighting
      row[c.short] = Math.round(c.count * factor / 4)
    })
    return row
  })
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="2 6" />
        <XAxis dataKey="band" />
        <YAxis />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono', textTransform: 'uppercase' }} />
        {cats.map((c: any, i: number) => (
          <Bar key={i} dataKey={c.short} stackId="a" fill={c.color} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

function DualBarChart({ data }: any) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="2 6" />
        <XAxis dataKey="short" />
        <YAxis yAxisId="l" orientation="left" />
        <YAxis yAxisId="r" orientation="right" />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono', textTransform: 'uppercase' }} />
        <Bar yAxisId="l" dataKey="count" name="Count" fill="#4A6FA5" radius={[2, 2, 0, 0]} />
        <Bar yAxisId="r" dataKey="delayMins" name="Delay (min)" fill="#E05206" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function FilterDrawer({ open, onClose, filters, onApply, onReset, availableAreas, savedViews, onSaveView, onDeleteView, onApplyView }: any) {
  const [draft, setDraft]         = useState<AnalyticsFilters>(filters)
  const [saveName, setSaveName]   = useState('')
  const [showSaveInput, setShowSaveInput] = useState(false)
  useEffect(() => { setDraft(filters); setShowSaveInput(false); setSaveName('') }, [filters, open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-md bg-[var(--bg-panel)] border-l border-[var(--line-hi)] h-full overflow-y-auto p-6 animate-fade-up">
        <div className="flex items-center justify-between mb-6">
          <h2 className="serif text-2xl font-light">Filters</h2>
          <button onClick={onClose} className="btn !p-2"><X size={14} /></button>
        </div>

        {/* Saved views */}
        {savedViews && savedViews.length > 0 && (
          <div className="mb-6">
            <div className="label-micro mb-2">Saved Views</div>
            <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
              {savedViews.map((v: any) => (
                <div key={v.id} className="flex items-center gap-2">
                  <button
                    className="flex-1 text-left text-xs px-2.5 py-1.5 rounded-sm border border-[var(--line)] hover:border-[var(--nr-orange)] hover:text-[var(--ink-100)] transition-colors truncate"
                    style={{ color: 'var(--ink-300)' }}
                    onClick={() => onApplyView?.(v.filters)}
                    title={`Applied: ${new Date(v.savedAt).toLocaleDateString()}`}
                  >
                    {v.name}
                  </button>
                  <button
                    className="btn !p-1.5 !border-[var(--line)] shrink-0"
                    onClick={() => onDeleteView?.(v.id)}
                    title="Delete view"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-6">
          <FilterGroup label="Search">
            <SearchTokenInput
              tokens={draft.searches}
              onChange={(searches) => setDraft({ ...draft, searches })}
              searchMode={draft.searchMode}
              onModeChange={(searchMode) => setDraft({ ...draft, searchMode })}
            />
          </FilterGroup>

          <FilterGroup label="Areas">
            <div className="grid grid-cols-1 gap-2">
              {availableAreas.length === 0 && <span className="text-xs" style={{ color: 'var(--ink-400)' }}>No areas in window.</span>}
              {availableAreas.map((a: string) => (
                <Chip
                  key={a}
                  label={a}
                  active={draft.areas.includes(a)}
                  onToggle={() => setDraft({
                    ...draft,
                    areas: draft.areas.includes(a)
                      ? draft.areas.filter(x => x !== a)
                      : [...draft.areas, a],
                  })}
                />
              ))}
            </div>
          </FilterGroup>

          <FilterGroup label="Categories">
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(CATEGORY_CONFIG) as IncidentCategory[]).map(c => (
                <Chip
                  key={c}
                  label={CATEGORY_CONFIG[c].short}
                  fullLabel={CATEGORY_CONFIG[c].label}
                  color={CATEGORY_CONFIG[c].color}
                  active={draft.categories.includes(c)}
                  onToggle={() => setDraft({
                    ...draft,
                    categories: draft.categories.includes(c)
                      ? draft.categories.filter(x => x !== c)
                      : [...draft.categories, c],
                  })}
                />
              ))}
            </div>
          </FilterGroup>

          <FilterGroup label="Severity">
            <div className="flex gap-2 flex-wrap">
              {(Object.keys(SEVERITY_CONFIG) as Severity[]).map(s => (
                <Chip
                  key={s}
                  label={s}
                  color={SEVERITY_CONFIG[s].color}
                  active={draft.severities.includes(s)}
                  onToggle={() => setDraft({
                    ...draft,
                    severities: draft.severities.includes(s)
                      ? draft.severities.filter(x => x !== s)
                      : [...draft.severities, s],
                  })}
                />
              ))}
            </div>
          </FilterGroup>

          <FilterGroup label="Custom Date Range">
            <div className="flex gap-2">
              <input type="date" className="input flex-1" value={draft.startDate || ''} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} />
              <input type="date" className="input flex-1" value={draft.endDate || ''} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} />
            </div>
            <button
              onClick={() => setDraft({ ...draft, startDate: undefined, endDate: undefined })}
              className="text-xs mt-2"
              style={{ color: 'var(--ink-400)' }}
            >
              Clear → use rolling window
            </button>
          </FilterGroup>
        </div>

        {/* Save current view */}
        <div className="mt-6">
          {showSaveInput ? (
            <div className="flex gap-2">
              <input
                type="text"
                className="input flex-1 text-xs"
                placeholder="View name…"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && saveName.trim()) {
                    onSaveView?.(saveName.trim())
                    setSaveName('')
                    setShowSaveInput(false)
                  }
                  if (e.key === 'Escape') setShowSaveInput(false)
                }}
                autoFocus
              />
              <button
                className="btn btn-active !text-xs"
                onClick={() => {
                  if (saveName.trim()) {
                    onSaveView?.(saveName.trim())
                    setSaveName('')
                    setShowSaveInput(false)
                  }
                }}
              >
                Save
              </button>
              <button className="btn !text-xs" onClick={() => setShowSaveInput(false)}>
                <X size={11} />
              </button>
            </div>
          ) : (
            <button
              className="btn w-full text-xs"
              onClick={() => setShowSaveInput(true)}
            >
              Save current view…
            </button>
          )}
        </div>

        <div className="flex gap-3 mt-4 sticky bottom-0 bg-[var(--bg-panel)] py-4 border-t border-[var(--line)]">
          <button
            onClick={() => { onReset?.(); onClose() }}
            className="btn flex-1"
          >
            Reset
          </button>
          <button
            onClick={() => onApply(draft)}
            className="btn btn-active flex-1"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}

function SearchTokenInput({ tokens, onChange, searchMode, onModeChange }: {
  tokens: string[]
  onChange: (t: string[]) => void
  searchMode: 'and' | 'or'
  onModeChange: (m: 'and' | 'or') => void
}) {
  const [input, setInput] = useState('')

  function commit() {
    const val = input.trim()
    if (val && !tokens.includes(val)) onChange([...tokens, val])
    setInput('')
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() }
    if (e.key === 'Backspace' && input === '' && tokens.length > 0) {
      onChange(tokens.slice(0, -1))
    }
  }

  return (
    <div>
      <div className="relative">
        <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--ink-400)' }} />
        <input
          type="text"
          className="input w-full pl-8"
          placeholder={tokens.length ? 'Add another term…' : 'Title, location, fault #, train ID, CCIL'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
      </div>
      {tokens.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {tokens.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-sm border border-[var(--nr-orange)] font-mono"
              style={{ color: 'var(--nr-orange)', background: 'rgba(255,107,53,0.08)' }}
            >
              {t}
              <button
                type="button"
                onClick={() => onChange(tokens.filter(x => x !== t))}
                className="ml-0.5 hover:opacity-70 transition-opacity"
                aria-label={`Remove "${t}"`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {tokens.length > 1 && (
        <div className="mt-3">
          <div className="label-micro mb-1.5">Match mode</div>
          <div className="flex gap-1.5">
            {(['or', 'and'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onModeChange(mode)}
                className="px-3 py-1 text-[10px] rounded-sm uppercase tracking-wider transition-all duration-150"
                style={{
                  background: searchMode === mode ? 'rgba(255,107,53,0.15)' : 'var(--bg-card)',
                  border: `1px solid ${searchMode === mode ? 'var(--nr-orange)' : 'var(--line)'}`,
                  color: searchMode === mode ? 'var(--nr-orange)' : 'var(--ink-400)',
                }}
              >
                {mode === 'or' ? 'Or — any term matches' : 'And — all terms must match'}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function FilterGroup({ label, children }: any) {
  return (
    <div>
      <div className="label-micro mb-2">{label}</div>
      {children}
    </div>
  )
}

function Chip({ label, fullLabel, color, active, onToggle }: any) {
  return (
    <button
      onClick={onToggle}
      title={fullLabel}
      className={`px-2.5 py-1.5 text-[10px] rounded-sm transition-all duration-150 numeric-mono uppercase tracking-wider text-left ${
        active ? '' : 'hover:bg-[var(--bg-card-hi)]'
      }`}
      style={{
        background: active ? `${color || 'var(--nr-orange)'}25` : 'var(--bg-card)',
        border: `1px solid ${active ? (color || 'var(--nr-orange)') : 'var(--line)'}`,
        color: active ? (color || 'var(--ink-100)') : 'var(--ink-300)',
      }}
    >
      {label}
    </button>
  )
}

function CustomTooltip({ active, payload, label, footer }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="card !bg-[var(--bg-card-hi)] !border-[var(--line-hi)] p-2.5 text-xs">
      <div className="label-micro mb-1.5">{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-sm" style={{ background: p.color || p.fill }} />
          <span style={{ color: 'var(--ink-300)' }}>{p.name}:</span>
          <span className="numeric-mono ml-auto" style={{ color: 'var(--ink-100)' }}>
            {Array.isArray(p.value)
              ? `${Number(p.value[0]).toFixed(1)} – ${Number(p.value[1]).toFixed(1)}`
              : typeof p.value === 'number' ? p.value.toLocaleString() : p.value}
          </span>
        </div>
      ))}
      {footer && (
        <div className="mt-1.5 pt-1.5 border-t border-[var(--line)] label-micro" style={{ color: 'var(--ink-500)' }}>
          {footer}
        </div>
      )}
    </div>
  )
}

function TreemapContent(props: any) {
  const { x, y, width, height, name, fill } = props
  if (width < 30 || height < 20) return <rect x={x} y={y} width={width} height={height} fill={fill} stroke="#070B16" />
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="#070B16" strokeWidth={1} />
      {width > 60 && height > 30 && (
        <text x={x + 6} y={y + 14} fill="#0A0F1E" fontSize={10} fontFamily="JetBrains Mono" fontWeight={500} style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {name?.length > Math.floor(width / 6.5) ? name.slice(0, Math.floor(width / 6.5)) + '…' : name}
        </text>
      )}
    </g>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="card !border-[var(--nr-red)] !bg-red-950/20 p-3 mb-6 text-sm flex items-start gap-3">
      <AlertTriangle size={16} className="text-[var(--nr-red)] mt-0.5" />
      <div>
        <div className="font-medium" style={{ color: 'var(--nr-red)' }}>Live data unavailable</div>
        <div className="text-xs mt-1" style={{ color: 'var(--ink-300)' }}>{message}</div>
        <div className="text-xs mt-1" style={{ color: 'var(--ink-400)' }}>Falling back to demonstration data.</div>
      </div>
    </div>
  )
}

function Empty({ msg = 'No data in window' }: { msg?: string }) {
  return (
    <div className="flex items-center justify-center h-32 text-xs" style={{ color: 'var(--ink-500)' }}>
      <span className="label-micro">{msg}</span>
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtMins(m: number): string {
  if (!m && m !== 0) return '—'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h < 24) return r ? `${h}h ${r}m` : `${h}h`
  const d = Math.floor(h / 24)
  const hr = h % 24
  return hr ? `${d}d ${hr}h` : `${d}d`
}

function shortDate(d: string): string {
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return d
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

const AREA_PALETTE = ['#E05206', '#4A6FA5', '#27AE60', '#F39C12', '#9B59B6', '#5B7FA8']
function pickAreaColor(area: string | null, idx: number): string {
  return AREA_PALETTE[idx % AREA_PALETTE.length]
}
