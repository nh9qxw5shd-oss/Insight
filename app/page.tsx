'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, Bell, ChevronDown, ChevronLeft, ChevronRight,
  Clock, Download, Filter, Layers, MapPin, RefreshCw, Route, Search,
  TrendingDown, TrendingUp, Train, Wrench, X, type LucideIcon,
} from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart,
  ResponsiveContainer, Tooltip, Treemap, XAxis, YAxis,
} from 'recharts'
import { isSupabaseConfigured } from '@/lib/supabase'
import {
  AnalyticsFilters, DEFAULT_FILTERS, IncidentCategory, IncidentRow, Severity,
  CATEGORY_CONFIG, SEVERITY_CONFIG, SAFETY_CATEGORIES,
  TIME_WINDOWS, ChartKind, DistributionKind, Signal,
} from '@/lib/types'
import {
  fetchAnalytics, deriveKPIs, deriveTrend, deriveCategorySplit,
  deriveLocationHotspots, deriveRepeatFaults, deriveRepeatAssets,
  deriveInfraFailureMix, deriveDelayDensity, deriveResponderLoad,
  deriveOperatorImpact, deriveHeatmap, deriveAreaList, deriveResponseDistribution,
  deriveSignals, deriveLineBreakdown, deriveDelayAttribution, deriveContinuationChains,
  RawData,
} from '@/lib/queries'
import { generateSyntheticData } from '@/lib/syntheticData'
import { getSavedViews, saveView, deleteView, SavedView } from '@/lib/savedViews'
import { getFiltersFromUrl, setFiltersInUrl, clearFiltersFromUrl } from '@/lib/filterUrl'
import { exportCSV } from '@/lib/export'

// ─── Tabs ────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'safety' | 'performance' | 'geography' | 'patterns' | 'assets' | 'routes'
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'overview',    label: 'Overview',    icon: Activity },
  { id: 'safety',      label: 'Safety',      icon: AlertTriangle },
  { id: 'performance', label: 'Performance', icon: TrendingUp },
  { id: 'geography',   label: 'Geography',   icon: MapPin },
  { id: 'patterns',    label: 'Patterns',    icon: Layers },
  { id: 'assets',      label: 'Assets',      icon: Wrench },
  { id: 'routes',      label: 'Routes',      icon: Route },
]

// ─── Window navigation helper ────────────────────────────────────────────────

function localISODate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function shiftWindow(f: AnalyticsFilters, dir: -1 | 1): AnalyticsFilters {
  const todayStr  = localISODate()
  const todayMs   = new Date(todayStr + 'T00:00:00Z').getTime()
  const curEndMs  = new Date((f.endDate ?? todayStr) + 'T00:00:00Z').getTime()
  const days      = f.windowDays
  const newEndMs  = curEndMs + dir * days * 86_400_000

  // Clamp: don't step forward past today
  if (newEndMs > todayMs) {
    if (dir === 1) return f
    // Defensive — going backward can't exceed today, but clamp anyway
    const clampedMs = todayMs
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

  const handleDateClick = (date: string) => {
    setFilters(f => ({ ...f, startDate: date, endDate: date, windowDays: 1 }))
  }

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
        isAtToday={!filters.endDate || filters.endDate >= localISODate()}
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
            {tab === 'overview'    && <OverviewTab kpis={kpis} trend={trend} cats={cats} hots={hots} repeatAssets={repeatAssets} chart={trendChart} setChart={setTrendChart} dist={distChart} setDist={setDistChart} incidents={data.incidents} onDrillDown={setDrillDown} onDateClick={handleDateClick} signals={signals} signalsOpen={signalsOpen} setSignalsOpen={setSignalsOpen} />}
            {tab === 'safety'      && <SafetyTab kpis={kpis} trend={trend} cats={cats} data={data} />}
            {tab === 'performance' && <PerformanceTab kpis={kpis} trend={trend} hots={hots} resp={respDist} responderLoad={resp} ops={ops} attribution={attribution} chart={trendChart} setChart={setTrendChart} incidents={data.incidents} onDrillDown={setDrillDown} onDateClick={handleDateClick} />}
            {tab === 'geography'   && <GeographyTab hots={hots} delayDensity={delayDensity} incidents={data.incidents} onDrillDown={setDrillDown} />}
            {tab === 'patterns'    && <PatternsTab heat={heat} cats={cats} />}
            {tab === 'assets'      && <AssetsTab repeatAssets={repeatAssets} infraMix={infraMix} cats={cats} incidents={data.incidents} onDrillDown={setDrillDown} chains={chains} />}
            {tab === 'routes'      && <RoutesTab lines={lines} incidents={data.incidents} onDrillDown={setDrillDown} />}
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
                  {sig.delta > 0 ? '+' : ''}{sig.delta.toFixed(1)}σ
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function OverviewTab({ kpis, trend, cats, hots, repeatAssets, chart, setChart, dist, setDist, incidents, onDrillDown, onDateClick, signals, signalsOpen, setSignalsOpen }: any) {
  return (
    <div className="space-y-6">
      <SignalsPanel signals={signals} open={signalsOpen} setOpen={setSignalsOpen} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 stagger">
        <KPICard
          label="Total Incidents"
          value={kpis.totalIncidents.toLocaleString()}
          delta={kpis.incidentsDeltaPct}
          icon={Activity}
          deltaInverted
        />
        <KPICard
          label="Total Delay"
          value={fmtMins(kpis.totalDelayMins)}
          subValue={`${kpis.totalDelayMins.toLocaleString()} min`}
          delta={kpis.delayDeltaPct}
          icon={Clock}
          deltaInverted
          accent
        />
        <KPICard
          label="Safety-Critical"
          value={kpis.safetyCriticalCount.toLocaleString()}
          delta={kpis.safetyDeltaPct}
          icon={AlertTriangle}
          deltaInverted
          critical={kpis.safetyDeltaPct != null && kpis.safetyDeltaPct > 5}
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
        <Card title="Daily Activity" subtitle={`${trend.length}-day rolling window`} className="lg:col-span-2 tick-corners"
              right={<ChartTypeToggle value={chart} onChange={setChart} />}>
          <TrendChart data={trend} kind={chart} onDateClick={onDateClick} />
        </Card>

        <Card title="Category Mix" subtitle={`${cats.length} categories`}
              right={<DistributionToggle value={dist} onChange={setDist} />}>
          <CategoryDistribution data={cats} kind={dist} />
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

function SafetyTab({ kpis, trend, cats, data }: any) {
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
        <KPICard label="Safety-Critical Events" value={kpis.safetyCriticalCount} delta={kpis.safetyDeltaPct} icon={AlertTriangle} deltaInverted critical accent />
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

      <Card title="Safety Category Breakdown" subtitle="By count and total delay impact">
        <SafetyTable rows={safetyOnly} />
      </Card>

      <Card title="Recent Safety-Critical Events" subtitle="Latest 10 in window">
        <IncidentList rows={safetyCritical.slice(-10).reverse()} />
      </Card>
    </div>
  )
}

// ─── Performance tab ─────────────────────────────────────────────────────────

function PerformanceTab({ kpis, trend, hots, resp, responderLoad, ops, attribution, chart, setChart, incidents, onDrillDown, onDateClick }: any) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 stagger">
        <KPICard label="Total Delay (mins)" value={kpis.totalDelayMins.toLocaleString()} delta={kpis.delayDeltaPct} icon={Clock} deltaInverted accent />
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

      <Card title="Delay Minutes — Daily" subtitle="Aggregate impact" right={<ChartTypeToggle value={chart} onChange={setChart} />} className="tick-corners">
        <TrendChart data={trend} kind={chart} dataKey="delayMins" gradient="orange" onDateClick={onDateClick} />
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

function KPICard({ label, value, subValue, delta, icon: Icon, deltaInverted, critical, accent }: any) {
  // delta: positive = up, negative = down. deltaInverted: up is bad (more delay = bad)
  const deltaColor = delta == null ? 'var(--ink-400)'
    : (delta > 0) === !!deltaInverted ? 'var(--nr-red)' : 'var(--nr-green)'
  const TrendIcon = delta == null ? null : delta > 0 ? TrendingUp : TrendingDown

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
        <div className="flex items-center gap-1 mt-3 text-xs numeric-mono" style={{ color: deltaColor }}>
          <TrendIcon size={12} />
          <span>{delta > 0 ? '+' : ''}{delta.toFixed(1)}%</span>
          <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>vs prev window</span>
        </div>
      )}
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

function TrendChart({ data, kind, dataKey = 'incidents', gradient = 'orange', onDateClick }: any) {
  const stroke = gradient === 'orange' ? '#E05206' : '#4A6FA5'
  const gradientId = `grad-${dataKey}-${gradient}`

  const handleClick = (chartData: any) => {
    if (chartData?.activeLabel && onDateClick) onDateClick(chartData.activeLabel)
  }

  const cursorStyle = onDateClick ? 'pointer' : 'default'
  const hasRolling = dataKey === 'incidents' && data.some((d: any) => d.rolling7Avg != null)
  const hasRegression = dataKey === 'incidents' && data.some((d: any) => d.regressionY != null)

  const sharedOverlays = hasRolling || hasRegression ? (
    <>
      {hasRolling && (
        <Line type="monotone" dataKey="rolling7Avg" name="7d avg" stroke="#7A8BA8" strokeWidth={1.5}
              strokeDasharray="4 2" dot={false} activeDot={false} connectNulls />
      )}
      {hasRegression && (
        <Line type="linear" dataKey="regressionY" name="Trend" stroke="#F39C12" strokeWidth={1}
              strokeDasharray="6 3" dot={false} activeDot={false} strokeOpacity={0.7} connectNulls />
      )}
    </>
  ) : null

  if (kind === 'bar') {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} onClick={handleClick} style={{ cursor: cursorStyle }}>
          <CartesianGrid strokeDasharray="2 6" />
          <XAxis dataKey="date" tickFormatter={shortDate} />
          <YAxis />
          <Tooltip content={<CustomTooltip footer="Click to focus this date" />} />
          <Bar dataKey={dataKey} fill={stroke} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  if (kind === 'line') {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} onClick={handleClick} style={{ cursor: cursorStyle }}>
          <CartesianGrid strokeDasharray="2 6" />
          <XAxis dataKey="date" tickFormatter={shortDate} />
          <YAxis />
          <Tooltip content={<CustomTooltip footer="Click to focus this date" />} />
          <Line type="monotone" dataKey={dataKey} stroke={stroke} strokeWidth={1.8} dot={false} activeDot={{ r: 4 }} />
          {sharedOverlays}
        </LineChart>
      </ResponsiveContainer>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} onClick={handleClick} style={{ cursor: cursorStyle }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={stroke} stopOpacity={0.55} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 6" />
        <XAxis dataKey="date" tickFormatter={shortDate} />
        <YAxis />
        <Tooltip content={<CustomTooltip footer="Click to focus this date" />} />
        <Area type="monotone" dataKey={dataKey} stroke={stroke} strokeWidth={1.5} fill={`url(#${gradientId})`} />
        {sharedOverlays}
      </AreaChart>
    </ResponsiveContainer>
  )
}

function CategoryDistribution({ data, kind }: any) {
  if (!data.length) return <Empty />
  if (kind === 'bar') {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data.slice(0, 8)} layout="vertical" margin={{ left: 0, right: 20 }}>
          <CartesianGrid strokeDasharray="2 6" horizontal={false} />
          <XAxis type="number" />
          <YAxis dataKey="short" type="category" width={56} />
          <Tooltip content={<CustomTooltip />} />
          <Bar dataKey="count" radius={[0, 2, 2, 0]}>
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
          data={data.map((d: any) => ({ name: d.short, size: d.count, fill: d.color }))}
          dataKey="size"
          stroke="#070B16"
          content={<TreemapContent />}
        />
      </ResponsiveContainer>
    )
  }
  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie data={data} dataKey="count" nameKey="short" innerRadius={70} outerRadius={110} paddingAngle={2}>
          {data.map((d: any, i: number) => <Cell key={i} fill={d.color} />)}
        </Pie>
        <Tooltip content={<CustomTooltip />} />
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

function SafetyTable({ rows }: any) {
  if (!rows.length) return <Empty />
  const max = Math.max(...rows.map((r: any) => r.count), 1)
  return (
    <div className="space-y-2">
      {rows.map((r: any, i: number) => (
        <div key={i} className="grid grid-cols-12 gap-3 items-center text-xs py-1.5 border-b border-[var(--line)] last:border-0">
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

function SearchTokenInput({ tokens, onChange }: { tokens: string[]; onChange: (t: string[]) => void }) {
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
            {typeof p.value === 'number' ? p.value.toLocaleString() : p.value}
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
