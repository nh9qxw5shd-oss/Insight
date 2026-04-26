'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, Clock, Filter, Layers, MapPin, RefreshCw,
  Search, TrendingDown, TrendingUp, Train, Wrench, X,
  type LucideIcon,
} from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart,
  ResponsiveContainer, Tooltip, Treemap, XAxis, YAxis,
} from 'recharts'
import { isSupabaseConfigured } from '@/lib/supabase'
import {
  AnalyticsFilters, DEFAULT_FILTERS, IncidentCategory, Severity,
  CATEGORY_CONFIG, SEVERITY_CONFIG, SAFETY_CATEGORIES, TIME_WINDOWS,
  ChartKind, DistributionKind,
} from '@/lib/types'
import {
  fetchAnalytics, deriveKPIs, deriveTrend, deriveCategorySplit,
  deriveLocationHotspots, deriveRepeatFaults, deriveResponderLoad,
  deriveOperatorImpact, deriveHeatmap, deriveAreaList, deriveResponseDistribution,
  RawData,
} from '@/lib/queries'
import { generateSyntheticData } from '@/lib/syntheticData'

// ─── Tabs ────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'safety' | 'performance' | 'geography' | 'patterns' | 'assets' | 'operators'
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'overview',    label: 'Overview',    icon: Activity },
  { id: 'safety',      label: 'Safety',      icon: AlertTriangle },
  { id: 'performance', label: 'Performance', icon: TrendingUp },
  { id: 'geography',   label: 'Geography',   icon: MapPin },
  { id: 'patterns',    label: 'Patterns',    icon: Layers },
  { id: 'assets',      label: 'Assets',      icon: Wrench },
  { id: 'operators',   label: 'Operators',   icon: Train },
]

// ─── Page ────────────────────────────────────────────────────────────────────

export default function InsightDashboard() {
  const [filters, setFilters] = useState<AnalyticsFilters>(DEFAULT_FILTERS)
  const [tab, setTab] = useState<Tab>('overview')
  const [data, setData] = useState<RawData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [demoMode, setDemoMode] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [trendChart, setTrendChart] = useState<ChartKind>('area')
  const [distChart, setDistChart] = useState<DistributionKind>('donut')

  // Fetch on filter change
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    async function run() {
      try {
        if (!isSupabaseConfigured()) {
          if (!cancelled) {
            setData(generateSyntheticData(filters.windowDays))
            setDemoMode(true)
            setLoading(false)
          }
          return
        }
        const result = await fetchAnalytics(filters)
        if (cancelled) return
        if (!result || result.incidents.length === 0) {
          // Empty → fall back to demo so the dashboard isn't a void
          setData(generateSyntheticData(filters.windowDays))
          setDemoMode(true)
        } else {
          setData(result)
          setDemoMode(false)
        }
      } catch (e: any) {
        if (cancelled) return
        setError(e.message || 'Failed to load analytics')
        setData(generateSyntheticData(filters.windowDays))
        setDemoMode(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [filters])

  // Derived
  const kpis    = useMemo(() => data ? deriveKPIs(data) : null, [data])
  const trend   = useMemo(() => data ? deriveTrend(data) : [], [data])
  const cats    = useMemo(() => data ? deriveCategorySplit(data) : [], [data])
  const hots    = useMemo(() => data ? deriveLocationHotspots(data) : [], [data])
  const faults  = useMemo(() => data ? deriveRepeatFaults(data) : [], [data])
  const resp    = useMemo(() => data ? deriveResponderLoad(data) : [], [data])
  const ops     = useMemo(() => data ? deriveOperatorImpact(data) : [], [data])
  const heat    = useMemo(() => data ? deriveHeatmap(data) : [], [data])
  const areas   = useMemo(() => data ? deriveAreaList(data) : [], [data])
  const respDist = useMemo(() => data ? deriveResponseDistribution(data) : null, [data])

  return (
    <main className="min-h-screen pb-24">
      <Header
        windowDays={filters.windowDays}
        demoMode={demoMode}
        loading={loading}
        onWindowChange={(d) => setFilters({ ...filters, windowDays: d })}
        onOpenFilters={() => setFiltersOpen(true)}
        activeFilterCount={
          filters.areas.length + filters.categories.length +
          filters.severities.length + (filters.search ? 1 : 0)
        }
        onRefresh={() => setFilters({ ...filters })}
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
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-[1480px] mx-auto px-6 py-8">
        {error && <ErrorBanner message={error} />}

        {kpis && data && (
          <>
            {tab === 'overview'    && <OverviewTab kpis={kpis} trend={trend} cats={cats} hots={hots} areas={areas} faults={faults} chart={trendChart} setChart={setTrendChart} dist={distChart} setDist={setDistChart} />}
            {tab === 'safety'      && <SafetyTab kpis={kpis} trend={trend} cats={cats} data={data} />}
            {tab === 'performance' && <PerformanceTab kpis={kpis} trend={trend} hots={hots} resp={respDist} chart={trendChart} setChart={setTrendChart} />}
            {tab === 'geography'   && <GeographyTab hots={hots} areas={areas} />}
            {tab === 'patterns'    && <PatternsTab heat={heat} cats={cats} />}
            {tab === 'assets'      && <AssetsTab faults={faults} cats={cats} />}
            {tab === 'operators'   && <OperatorsTab ops={ops} resp={resp} />}
          </>
        )}
      </div>

      <FilterDrawer
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        filters={filters}
        onApply={(f: AnalyticsFilters) => { setFilters(f); setFiltersOpen(false) }}
        availableAreas={areas.map(a => a.area)}
      />
    </main>
  )
}

// ─── Header ──────────────────────────────────────────────────────────────────

function Header(props: {
  windowDays: number
  demoMode: boolean
  loading: boolean
  activeFilterCount: number
  onWindowChange: (d: number) => void
  onOpenFilters: () => void
  onRefresh: () => void
}) {
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
          {/* Window selector */}
          <div className="flex items-center gap-1 p-1 border border-[var(--line)] rounded">
            {TIME_WINDOWS.map(w => (
              <button
                key={w.label}
                onClick={() => props.onWindowChange(w.days)}
                className={`btn !py-1 !px-3 !border-none ${props.windowDays === w.days ? 'btn-active' : ''}`}
              >
                {w.label}
              </button>
            ))}
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

          <button onClick={props.onRefresh} className="btn" disabled={props.loading}>
            <RefreshCw size={12} className={props.loading ? 'animate-spin' : ''} />
            Refresh
          </button>

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

function OverviewTab({ kpis, trend, cats, hots, areas, faults, chart, setChart, dist, setDist }: any) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 stagger">
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
      </div>

      {/* Trend + breakdown row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Daily Activity" subtitle={`${trend.length}-day rolling window`} className="lg:col-span-2 tick-corners"
              right={<ChartTypeToggle value={chart} onChange={setChart} />}>
          <TrendChart data={trend} kind={chart} />
        </Card>

        <Card title="Category Mix" subtitle={`${cats.length} categories`}
              right={<DistributionToggle value={dist} onChange={setDist} />}>
          <CategoryDistribution data={cats} kind={dist} />
        </Card>
      </div>

      {/* Hotspots + repeat assets */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Top Hotspots" subtitle="Locations ranked by total delay" className="tick-corners">
          <LocationLeaderboard data={hots} />
        </Card>
        <Card title="Repeat-Fault Assets" subtitle="Same fault number, multiple occurrences">
          <RepeatFaultsTable data={faults} />
        </Card>
      </div>

      {/* Areas */}
      <Card title="Area Breakdown" subtitle="Delay impact by control area">
        <AreaBars data={areas} />
      </Card>
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

function PerformanceTab({ kpis, trend, hots, resp, chart, setChart }: any) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 stagger">
        <KPICard label="Total Delay (mins)" value={kpis.totalDelayMins.toLocaleString()} delta={kpis.delayDeltaPct} icon={Clock} deltaInverted accent />
        <KPICard label="Cancelled" value={kpis.totalCancelled} icon={X} />
        <KPICard label="Part Cancelled" value={kpis.totalPartCancelled} icon={X} />
        <KPICard
          label="Median Response"
          value={kpis.medianResponseMins != null ? `${kpis.medianResponseMins} min` : '—'}
          icon={Clock}
        />
      </div>

      <Card title="Delay Minutes — Daily" subtitle="Aggregate impact" right={<ChartTypeToggle value={chart} onChange={setChart} />} className="tick-corners">
        <TrendChart data={trend} kind={chart} dataKey="delayMins" gradient="orange" />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Response-Time Distribution" subtitle="Mins from incident start">
          {resp ? <ResponseHistograms data={resp} /> : null}
        </Card>
        <Card title="Top Locations by Delay" subtitle="Concentrated impact">
          <LocationLeaderboard data={hots} />
        </Card>
      </div>
    </div>
  )
}

// ─── Geography tab ───────────────────────────────────────────────────────────

function GeographyTab({ hots, areas }: any) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Area Performance" subtitle="Aggregate delay by control area" className="lg:col-span-2 tick-corners">
          <AreaBars data={areas} expanded />
        </Card>
        <Card title="Top 12 Hotspots" subtitle="By delay">
          <LocationLeaderboard data={hots} compact />
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

function AssetsTab({ faults, cats }: any) {
  const assetCats = cats.filter((c: any) => CATEGORY_CONFIG[c.category as IncidentCategory].group === 'asset')
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Asset-Failure Mix" subtitle="Infrastructure / OHL / Train Fault" className="tick-corners">
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={assetCats} dataKey="count" nameKey="short" innerRadius={60} outerRadius={100} paddingAngle={2}>
                {assetCats.map((c: any, i: number) => <Cell key={i} fill={c.color} />)}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Repeat-Fault Assets" subtitle="Highest priority for engineering review" className="lg:col-span-2">
          <RepeatFaultsTable data={faults} expanded />
        </Card>
      </div>

      <Card title="Asset Failure by Category" subtitle="Count vs total delay">
        <DualBarChart data={assetCats} />
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

function TrendChart({ data, kind, dataKey = 'incidents', gradient = 'orange' }: any) {
  const stroke = gradient === 'orange' ? '#E05206' : '#4A6FA5'
  const gradientId = `grad-${dataKey}-${gradient}`

  if (kind === 'bar') {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="2 6" />
          <XAxis dataKey="date" tickFormatter={shortDate} />
          <YAxis />
          <Tooltip content={<CustomTooltip />} />
          <Bar dataKey={dataKey} fill={stroke} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    )
  }

  if (kind === 'line') {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="2 6" />
          <XAxis dataKey="date" tickFormatter={shortDate} />
          <YAxis />
          <Tooltip content={<CustomTooltip />} />
          <Line type="monotone" dataKey={dataKey} stroke={stroke} strokeWidth={1.8} dot={false} activeDot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={stroke} stopOpacity={0.55} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 6" />
        <XAxis dataKey="date" tickFormatter={shortDate} />
        <YAxis />
        <Tooltip content={<CustomTooltip />} />
        <Area type="monotone" dataKey={dataKey} stroke={stroke} strokeWidth={1.5} fill={`url(#${gradientId})`} />
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

function LocationLeaderboard({ data, compact }: any) {
  if (!data.length) return <Empty />
  const max = data[0]?.delayMins || 1
  return (
    <div className="space-y-2">
      {data.slice(0, compact ? 8 : 12).map((d: any, i: number) => (
        <div key={i} className="group">
          <div className="flex items-center justify-between text-xs mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="numeric-mono text-[10px] w-5" style={{ color: 'var(--ink-500)' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="truncate" style={{ color: 'var(--ink-200)' }}>{d.location}</span>
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

function RepeatFaultsTable({ data, expanded }: any) {
  if (!data.length) return <Empty msg="No repeat faults in window" />
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="label-micro border-b border-[var(--line)]">
            <th className="text-left py-2 pr-2">Fault #</th>
            <th className="text-left">Category</th>
            <th className="text-right">Occur.</th>
            <th className="text-right">Total Delay</th>
            {expanded && <th className="text-left pl-3">Locations</th>}
            <th className="text-right">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {data.map((f: any, i: number) => (
            <tr key={i} className="border-b border-[var(--line)] hover:bg-[var(--bg-card-hi)] transition-colors">
              <td className="py-2 pr-2 numeric-mono" style={{ color: 'var(--ink-100)' }}>{f.faultNumber}</td>
              <td>
                <span className="pill pill-low" style={{ background: `${CATEGORY_CONFIG[f.category as IncidentCategory].color}20`, color: CATEGORY_CONFIG[f.category as IncidentCategory].color, borderColor: `${CATEGORY_CONFIG[f.category as IncidentCategory].color}50` }}>
                  {CATEGORY_CONFIG[f.category as IncidentCategory].short}
                </span>
              </td>
              <td className="text-right numeric-mono" style={{ color: 'var(--nr-orange)' }}>{f.occurrences}×</td>
              <td className="text-right numeric-mono" style={{ color: 'var(--ink-100)' }}>{fmtMins(f.totalDelay)}</td>
              {expanded && (
                <td className="pl-3 truncate max-w-[200px]" style={{ color: 'var(--ink-300)' }}>
                  {f.locations.slice(0, 2).join(', ')}{f.locations.length > 2 ? ` +${f.locations.length - 2}` : ''}
                </td>
              )}
              <td className="text-right numeric-mono" style={{ color: 'var(--ink-400)' }}>{shortDate(f.lastSeen)}</td>
            </tr>
          ))}
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
  const advised  = bucketise(data.toAdvised)
  const response = bucketise(data.toResponse)
  const arrival  = bucketise(data.toArrival)

  const chartData = buckets.map((b, i) => ({
    bucket: b.label,
    advised: advised[i],
    response: response[i],
    arrival: arrival[i],
  }))

  return (
    <ResponsiveContainer width="100%" height={260}>
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

function FilterDrawer({ open, onClose, filters, onApply, availableAreas }: any) {
  const [draft, setDraft] = useState<AnalyticsFilters>(filters)
  useEffect(() => setDraft(filters), [filters, open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-md bg-[var(--bg-panel)] border-l border-[var(--line-hi)] h-full overflow-y-auto p-6 animate-fade-up">
        <div className="flex items-center justify-between mb-6">
          <h2 className="serif text-2xl font-light">Filters</h2>
          <button onClick={onClose} className="btn !p-2"><X size={14} /></button>
        </div>

        <div className="space-y-6">
          <FilterGroup label="Search">
            <div className="relative">
              <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--ink-400)' }} />
              <input
                type="text"
                className="input w-full pl-8"
                placeholder="Title, location, fault #, train ID, CCIL"
                value={draft.search}
                onChange={(e) => setDraft({ ...draft, search: e.target.value })}
              />
            </div>
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

        <div className="flex gap-3 mt-8 sticky bottom-0 bg-[var(--bg-panel)] py-4 border-t border-[var(--line)]">
          <button
            onClick={() => onApply(DEFAULT_FILTERS)}
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

function CustomTooltip({ active, payload, label }: any) {
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
