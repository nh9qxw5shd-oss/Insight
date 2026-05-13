'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Activity, AlertTriangle, BarChart2, Bell, ChevronDown, ChevronLeft, ChevronRight,
  ClipboardCheck, ClipboardList, Clock, Compass, Download, FileText, Filter, GitBranch, Layers, List, MapPin,
  Minus, Moon, RefreshCw, Route, Search, Sun, TrendingDown, TrendingUp, Train, Wrench, X, Zap, type LucideIcon,
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
  IncidentReview, IncidentReviewInput, IncidentClassification, First50Outcome,
  CLASSIFICATION_CONFIG, YesNoNa, MomDepot, MOM_DEPOT_LABELS, StrandedTrainEntry,
  IncidentTeamMember, TeamMemberWorkload, StaffPatternDatum,
} from '@/lib/types'
import {
  railwayPeriodWeek, listPeriods, listWeeks, listRailYears,
  railwayPeriodBounds, railwayWeekBounds,
  defaultPeriodSelection, defaultWeekSelection,
} from '@/lib/railwayCalendar'
import {
  fetchAnalytics, deriveKPIs, deriveTrend, deriveCategorySplit,
  deriveLocationHotspots, deriveRepeatFaults, deriveRepeatAssets,
  deriveInfraFailureMix, deriveDelayDensity, deriveResponderLoad,
  deriveOperatorImpact, deriveHeatmap, deriveAreaList, deriveResponseDistribution,
  deriveSignals, deriveLineBreakdown, deriveDelayAttribution, deriveContinuationChains,
  deriveChangePoints, deriveDelta, deriveHypotheses, deriveIncidentTypeList,
  effectiveDelay, effectiveMinsToArrival, effectiveDuration, SLA_THRESHOLD_MINS,
  searchMatch,
  fetchIncidentsForRange, fetchReportsForRange, fetchReviewsForRange,
  fetchTeamMembersForRange, deriveTeamWorkload, deriveStaffPatterns,
  upsertIncidentReview, deleteIncidentReview, deriveReviewPeriods,
  RawData, ReviewPeriodGroup, ReviewPeriodDay,
} from '@/lib/queries'
import {
  toggleCategoryFilter, toggleAreaFilter, toggleSeverityFilter,
  removeSearchToken, clearCustomDate, clearDelayFilter, toggleIncidentTypeFilter,
  toggleStaffFilter, clearStaffFilter,
} from '@/lib/filterActions'
import { generateSyntheticData } from '@/lib/syntheticData'
import { getSavedViews, saveView, deleteView, SavedView } from '@/lib/savedViews'
import { getFiltersFromUrl, setFiltersInUrl, clearFiltersFromUrl } from '@/lib/filterUrl'
import { exportCSV } from '@/lib/export'
import {
  ReportTemplate, ReportSectionId,
  REPORT_TEMPLATES, TEMPLATE_DEFAULT_SECTIONS, SECTION_LABELS,
} from '@/lib/reports/types'
import { buildReportPlan } from '@/lib/reports/builder'
import { renderReportDocument } from '@/lib/reports/html'
import { openPrintWindow, downloadHtml, reportFilename } from '@/lib/reports/print'

// ─── Tabs ────────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'safety' | 'performance' | 'geography' | 'patterns' | 'assets' | 'routes' | 'trends' | 'explore' | 'analytics' | 'review' | 'reports'
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'overview',    label: 'Overview',    icon: Activity },
  { id: 'safety',      label: 'Safety',      icon: AlertTriangle },
  { id: 'performance', label: 'Performance', icon: TrendingUp },
  { id: 'geography',   label: 'Geography',   icon: MapPin },
  { id: 'patterns',    label: 'Patterns',    icon: Layers },
  { id: 'assets',      label: 'Assets',      icon: Wrench },
  { id: 'routes',      label: 'Routes',      icon: Route },
  { id: 'trends',      label: 'Trends',      icon: GitBranch },
  { id: 'explore',     label: 'Explore',     icon: Compass },
  { id: 'analytics',   label: 'Analytics',   icon: BarChart2 },
  { id: 'review',      label: 'Review',      icon: ClipboardCheck },
  { id: 'reports',     label: 'Reports',     icon: FileText },
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
  // Always initialise from DEFAULT_FILTERS so server and client render identically.
  // URL-stored filters are loaded in a useEffect after hydration completes —
  // using them in the useState initializer caused React hydration error #418
  // because Next.js calls the initializer on the server (window undefined → null)
  // and again on the client (window present → different result).
  const [filters, setFilters] = useState<AnalyticsFilters>(DEFAULT_FILTERS)
  const [tab, setTab] = useState<Tab>('overview')
  const [data, setData] = useState<RawData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [demoMode, setDemoMode] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [trendChart, setTrendChart] = useState<ChartKind>('area')
  const [distChart, setDistChart] = useState<DistributionKind>('donut')
  const [drillDown, setDrillDown] = useState<{ title: string; incidents: IncidentRow[] } | null>(null)
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => getSavedViews())

  // Review-tab data — fetched separately so the SNDM sees every incident in
  // the window regardless of the analytics filter selection.
  const [reviewIncidents, setReviewIncidents] = useState<IncidentRow[] | null>(null)
  const [reviewReports, setReviewReports]     = useState<{ id: string; report_date: string; period: string | null; control_centre: string | null; created_by: string | null; total_delay: number; total_cancelled: number; total_part_cancelled: number; incident_count: number }[] | null>(null)
  const [reviewRows, setReviewRows]           = useState<IncidentReview[]>([])
  const [reviewTeamMembers, setReviewTeamMembers] = useState<IncidentTeamMember[]>([])
  const [reviewLoading, setReviewLoading]     = useState(false)
  const [reviewError, setReviewError]         = useState<string | null>(null)

  // After hydration, restore any filters saved in the URL. This runs once and
  // must come before the URL-sync effect so a stale DEFAULT_FILTERS write
  // doesn't permanently overwrite saved state.
  useEffect(() => {
    const urlFilters = getFiltersFromUrl()
    if (urlFilters) setFilters(urlFilters)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync theme from localStorage after hydration, then apply on every change.
  useEffect(() => {
    const saved = (localStorage.getItem('theme') || 'dark') as 'dark' | 'light'
    setTheme(saved)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

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
        const hasActiveFilters =
          filters.categories.length > 0 || filters.areas.length > 0 ||
          filters.severities.length > 0 || filters.searches.length > 0 ||
          filters.incidentTypes.length > 0 || filters.staffNames.length > 0 ||
          filters.minDelay != null || filters.maxDelay != null ||
          filters.startDate != null || filters.endDate != null
        if (!result || (result.incidents.length === 0 && !hasActiveFilters)) {
          // No data and no filters → fall back to demo so the dashboard isn't a void
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

  // Staff filter — applied client-side on top of server-filtered incidents.
  // teamMembers are fetched for the full window (no staff filter applied server-side)
  // so we have all members available for the filter UI and patterns charts.
  const effectiveData = useMemo((): RawData | null => {
    if (!data) return null
    if (filters.staffNames.length === 0) return data
    const staffIncidentIds = new Set(
      data.teamMembers
        .filter(tm => filters.staffNames.includes(tm.name))
        .map(tm => tm.incident_id),
    )
    return { ...data, incidents: data.incidents.filter(i => staffIncidentIds.has(i.id)) }
  }, [data, filters.staffNames])

  const availableStaff = useMemo(() => {
    if (!data) return []
    return Array.from(new Set(data.teamMembers.map(tm => tm.name))).sort()
  }, [data])

  // Derived — use effectiveData so all analytics respect the staff filter
  const kpis         = useMemo(() => effectiveData ? deriveKPIs(effectiveData) : null, [effectiveData])
  const trend        = useMemo(() => effectiveData ? deriveTrend(effectiveData) : [], [effectiveData])
  const cats         = useMemo(() => effectiveData ? deriveCategorySplit(effectiveData) : [], [effectiveData])
  const hots         = useMemo(() => effectiveData ? deriveLocationHotspots(effectiveData) : [], [effectiveData])
  const faults       = useMemo(() => effectiveData ? deriveRepeatFaults(effectiveData) : [], [effectiveData])
  const repeatAssets = useMemo(() => effectiveData ? deriveRepeatAssets(effectiveData) : [], [effectiveData])
  const infraMix     = useMemo(() => effectiveData ? deriveInfraFailureMix(effectiveData) : [], [effectiveData])
  const delayDensity = useMemo(() => effectiveData ? deriveDelayDensity(effectiveData) : [], [effectiveData])
  const resp         = useMemo(() => effectiveData ? deriveResponderLoad(effectiveData) : [], [effectiveData])
  const ops          = useMemo(() => effectiveData ? deriveOperatorImpact(effectiveData) : [], [effectiveData])
  const heat         = useMemo(() => effectiveData ? deriveHeatmap(effectiveData) : [], [effectiveData])
  const areas        = useMemo(() => data ? deriveAreaList(data) : [], [data])
  const incidentTypeList = useMemo(() => data ? deriveIncidentTypeList(data) : [], [data])
  const respDist     = useMemo(() => effectiveData ? deriveResponseDistribution(effectiveData) : null, [effectiveData])
  const lines        = useMemo(() => effectiveData ? deriveLineBreakdown(effectiveData) : [], [effectiveData])
  const attribution  = useMemo(() => effectiveData ? deriveDelayAttribution(effectiveData) : [], [effectiveData])
  const chains       = useMemo(() => effectiveData ? deriveContinuationChains(effectiveData) : [], [effectiveData])
  const changePoints = useMemo(() => deriveChangePoints(trend), [trend])
  // Staff patterns — always from full data so the Patterns tab shows everyone,
  // regardless of which staff members are currently pinned in the filter.
  const staffPatterns = useMemo(() => data ? deriveStaffPatterns(data) : [], [data])

  // Decomposition lookup for KPI cards — uses effectiveData so deltas respect staff filter.
  const decompose = useMemo(
    () => (metric: DeltaMetric) => effectiveData ? deriveDelta(effectiveData, metric) : null,
    [effectiveData],
  )

  const handleDateClick = (date: string) => {
    setFilters(f => ({ ...f, startDate: date, endDate: date, windowDays: 1 }))
  }

  // Cross-filter drill-down: chart elements push their underlying value into
  // the corresponding filter list. Each helper toggles, so re-clicking a
  // pinned slice removes it from the filter — same affordance both ways.
  const handleAddCategoryFilter      = (c: IncidentCategory) => setFilters(f => toggleCategoryFilter(f, c))
  const handleAddAreaFilter          = (a: string)            => setFilters(f => toggleAreaFilter(f, a))
  const handleAddSeverityFilter      = (s: Severity)          => setFilters(f => toggleSeverityFilter(f, s))
  const handleToggleIncidentType     = (label: string)        => setFilters(f => toggleIncidentTypeFilter(f, label))
  const handleToggleStaffFilter      = (name: string)         => setFilters(f => toggleStaffFilter(f, name))
  const handleClearStaffFilter       = ()                     => setFilters(f => clearStaffFilter(f))

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

  // ─── Review-tab data fetch ─────────────────────────────────────────────────
  // Resolves the same window the analytics tabs use, but bypasses category /
  // severity / search filters so the SNDM sees every incident in the period.
  useEffect(() => {
    if (tab !== 'review') return
    let cancelled = false
    setReviewLoading(true); setReviewError(null)

    const resolveBounds = (): { from: string; to: string } => {
      if (filters.startDate && filters.endDate) return { from: filters.startDate, to: filters.endDate }
      const toMs = Date.now() - 86_400_000
      const fromMs = toMs - (filters.windowDays - 1) * 86_400_000
      return {
        from: new Date(fromMs).toISOString().slice(0, 10),
        to:   new Date(toMs).toISOString().slice(0, 10),
      }
    }

    async function run() {
      try {
        const { from, to } = resolveBounds()
        if (!isSupabaseConfigured()) {
          // Reuse demo data already loaded — it spans the same window
          if (data) {
            const fakeReports = Array.from(new Set(data.incidents.map(i => i.report_date)))
              .map(d => ({
                id: `demo-${d}`,
                report_date: d,
                period: data.reports.find(r => r.report_date === d)?.period ?? null,
                control_centre: 'Demo', created_by: 'Demo',
                total_delay: 0, total_cancelled: 0, total_part_cancelled: 0, incident_count: 0,
              }))
            if (!cancelled) {
              setReviewIncidents(data.incidents)
              setReviewReports(fakeReports)
              setReviewRows([])
            }
          }
          return
        }
        const [incs, reps, revs, members] = await Promise.all([
          fetchIncidentsForRange(from, to),
          fetchReportsForRange(from, to),
          fetchReviewsForRange(from, to),
          fetchTeamMembersForRange(from, to),
        ])
        if (cancelled) return
        setReviewIncidents(incs)
        setReviewReports(reps)
        setReviewRows(revs)
        setReviewTeamMembers(members)
      } catch (e: any) {
        if (cancelled) return
        setReviewError(e?.message || 'Failed to load review data')
      } finally {
        if (!cancelled) setReviewLoading(false)
      }
    }
    run()
    return () => { cancelled = true }
  }, [tab, filters.windowDays, filters.startDate, filters.endDate, data])

  const reviewByIncidentId = useMemo(() => {
    const m = new Map<string, IncidentReview>()
    for (const r of reviewRows) m.set(r.incident_id, r)
    return m
  }, [reviewRows])

  const reviewPeriods = useMemo(() => {
    if (!reviewIncidents) return []
    return deriveReviewPeriods(reviewIncidents, reviewByIncidentId)
  }, [reviewIncidents, reviewByIncidentId])

  const teamMembersByIncidentId = useMemo(() => {
    const m = new Map<string, IncidentTeamMember[]>()
    for (const tm of reviewTeamMembers) {
      const arr = m.get(tm.incident_id) ?? []
      arr.push(tm)
      m.set(tm.incident_id, arr)
    }
    return m
  }, [reviewTeamMembers])

  const teamWorkload = useMemo(() => {
    const delayMap = new Map<string, number>()
    for (const i of reviewIncidents ?? []) delayMap.set(i.id, effectiveDelay(i))
    return deriveTeamWorkload(reviewTeamMembers, delayMap)
  }, [reviewTeamMembers, reviewIncidents])

  const handleReviewSave = async (input: IncidentReviewInput, incidentStart: string | null) => {
    const saved = await upsertIncidentReview(input, incidentStart)
    if (saved) {
      setReviewRows(prev => {
        const others = prev.filter(r => r.incident_id !== saved.incident_id)
        return [...others, saved]
      })
    }
  }

  const handleReviewDelete = async (incidentId: string) => {
    await deleteIncidentReview(incidentId)
    setReviewRows(prev => prev.filter(r => r.incident_id !== incidentId))
  }


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
          filters.severities.length + filters.searches.length +
          filters.incidentTypes.length + filters.staffNames.length +
          (filters.minDelay != null || filters.maxDelay != null ? 1 : 0) +
          (filters.metricFocus === 'cancellations' ? 1 : 0)
        }
        onRefresh={() => setFilters({ ...filters })}
        onExport={effectiveData ? () => exportCSV(effectiveData.incidents, effectiveData.windowFrom, effectiveData.windowTo) : undefined}
        theme={theme}
        onToggleTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
      />

      <ActiveFilterChips
        filters={filters}
        onRemoveCategory={handleAddCategoryFilter}
        onRemoveArea={handleAddAreaFilter}
        onRemoveSeverity={handleAddSeverityFilter}
        onRemoveSearch={(t) => setFilters(f => removeSearchToken(f, t))}
        onRemoveIncidentType={handleToggleIncidentType}
        onRemoveStaff={handleToggleStaffFilter}
        onClearDate={() => setFilters(f => clearCustomDate(f))}
        onClearDelay={() => setFilters(f => clearDelayFilter(f))}
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
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-[1480px] mx-auto px-6 py-8">
        {error && <ErrorBanner message={error} />}

        {kpis && effectiveData && (
          <>
            {tab === 'overview'    && <OverviewTab kpis={kpis} trend={trend} changePoints={changePoints} cats={cats} hots={hots} repeatAssets={repeatAssets} chart={trendChart} setChart={setTrendChart} dist={distChart} setDist={setDistChart} incidents={effectiveData.incidents} onDrillDown={setDrillDown} onDateClick={handleDateClick} onAddCategoryFilter={handleAddCategoryFilter} onAddAreaFilter={handleAddAreaFilter} onAddSeverityFilter={handleAddSeverityFilter} decompose={decompose} />}
            {tab === 'safety'      && <SafetyTab kpis={kpis} trend={trend} cats={cats} data={effectiveData} onAddCategoryFilter={handleAddCategoryFilter} decompose={decompose} />}
            {tab === 'performance' && <PerformanceTab kpis={kpis} trend={trend} changePoints={changePoints} hots={hots} resp={respDist} responderLoad={resp} ops={ops} attribution={attribution} chart={trendChart} setChart={setTrendChart} incidents={effectiveData.incidents} onDrillDown={setDrillDown} onDateClick={handleDateClick} decompose={decompose} metricFocus={filters.metricFocus} />}
            {tab === 'geography'   && <GeographyTab hots={hots} delayDensity={delayDensity} incidents={effectiveData.incidents} onDrillDown={setDrillDown} />}
            {tab === 'patterns'    && <PatternsTab heat={heat} cats={cats} staffPatterns={staffPatterns} />}
            {tab === 'assets'      && <AssetsTab repeatAssets={repeatAssets} infraMix={infraMix} cats={cats} incidents={effectiveData.incidents} onDrillDown={setDrillDown} chains={chains} />}
            {tab === 'routes'      && <RoutesTab lines={lines} incidents={effectiveData.incidents} onDrillDown={setDrillDown} />}
            {tab === 'trends'      && <TrendsTab incidents={effectiveData.incidents} windowFrom={effectiveData.windowFrom} windowDays={effectiveData.windowDays} areaOptions={areas.map((a: any) => a.area)} />}
            {tab === 'explore'     && <ExploreTab incidents={effectiveData.incidents} areaOptions={areas.map((a: any) => a.area)} />}
            {tab === 'analytics'   && <AnalyticsTab incidents={effectiveData.incidents} />}
            {tab === 'review'      && (
              reviewLoading && !reviewIncidents
                ? <div className="flex items-center justify-center py-24"><RefreshCw size={16} className="animate-spin" style={{ color: 'var(--ink-400)' }} /></div>
                : <>
                    {reviewError && <ErrorBanner message={reviewError} />}
                    <ReviewTab
                      periods={reviewPeriods}
                      reviewByIncidentId={reviewByIncidentId}
                      teamMembersByIncidentId={teamMembersByIncidentId}
                      teamWorkload={teamWorkload}
                      onSave={handleReviewSave}
                      onDelete={handleReviewDelete}
                      demoMode={demoMode}
                      supabaseConfigured={isSupabaseConfigured()}
                    />
                  </>
            )}
            {tab === 'reports'     && <ReportsTab data={effectiveData} filters={filters} demoMode={demoMode} />}
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
        availableIncidentTypes={incidentTypeList}
        availableStaff={availableStaff}
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
  onWindowChange: (d: number) => void
  onPrevWindow: () => void
  onNextWindow: () => void
  onOpenFilters: () => void
  onRefresh: () => void
  onExport?: () => void
  theme: 'dark' | 'light'
  onToggleTheme: () => void
}) {
  const customRange = !!props.startDate

  return (
    <header className="border-b border-[var(--line)] header-gradient">
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

          <button
            onClick={props.onToggleTheme}
            className="btn"
            title={props.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {props.theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
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
  const [open, setOpen] = useState(false)
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

function OverviewTab({ kpis, trend, changePoints, cats, hots, repeatAssets, chart, setChart, dist, setDist, incidents, onDrillDown, onDateClick, onAddCategoryFilter, onAddAreaFilter, onAddSeverityFilter, decompose }: any) {
  return (
    <div className="space-y-6">

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 stagger">
        <KPICard
          label="Total Incidents"
          value={kpis.totalIncidents.toLocaleString()}
          delta={kpis.incidentsDeltaPct}
          icon={Activity}
          deltaInverted
          decompose={decompose}
          metric="incidents"
          onListClick={() => onDrillDown({
            title: 'All Incidents',
            incidents: [...incidents].sort((a: any, b: any) => b.report_date.localeCompare(a.report_date)),
          })}
        />
        <KPICard
          label="Total Delay"
          value={fmtMins(kpis.totalDelayMins)}
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
          label="Arrival SLA (≤45 min)"
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
  // Operational safety (excluding PAX which is tracked separately)
  const CORE_SAFETY = SAFETY_CATEGORIES.filter(c => c !== 'PASSENGER_INJURY')
  const safetyCore = cats.filter((c: any) => CORE_SAFETY.includes(c.category))
  const safetyPax  = cats.filter((c: any) => c.category === 'PASSENGER_INJURY')
  const safetyCritical = data.incidents.filter((i: any) => SAFETY_CATEGORIES.includes(i.category) && !i.is_continuation)
  const paxCount   = data.incidents.filter((i: any) => i.category === 'PASSENGER_INJURY' && !i.is_continuation).length
  const coreCount  = safetyCritical.length - paxCount

  // Radar excludes PAX so operational categories are readable at scale
  const coreRadar = CORE_SAFETY.filter(c => c !== 'FATALITY').map(cat => ({
    category: CATEGORY_CONFIG[cat].short,
    current:  data.incidents.filter((i: any) => i.category === cat && !i.is_continuation).length,
    previous: data.prevIncidents.filter((i: any) => i.category === cat && !i.is_continuation).length,
  }))

  const paxIncidents = data.incidents.filter((i: any) => i.category === 'PASSENGER_INJURY' && !i.is_continuation)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 stagger">
        <KPICard label="Safety-Critical (Total)" value={kpis.safetyCriticalCount} delta={kpis.safetyDeltaPct} icon={AlertTriangle} deltaInverted critical accent decompose={decompose} metric="safety" />
        <KPICard label="Operational Safety" value={coreCount} icon={AlertTriangle} hint="Excl. passenger injuries" />
        <KPICard label="PAX / Public Injuries" value={paxCount} icon={AlertTriangle} critical={paxCount > 0} hint="Passenger &amp; public injuries" />
        <KPICard label="SPADs" value={data.incidents.filter((i: any) => i.category === 'SPAD' && !i.is_continuation).length} icon={AlertTriangle} />
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

        <Card title="Operational Safety Radar" subtitle="Excl. PAX — current vs previous window">
          <ResponsiveContainer width="100%" height={280}>
            <RadarChart data={coreRadar}>
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

      <Card title="Operational Safety Breakdown" subtitle="SPAD · TPWS · Near Miss · Derailment · Person Struck etc. · click to pin filter">
        <SafetyTable rows={safetyCore} onCategoryClick={onAddCategoryFilter} />
      </Card>

      <Card
        title="Passenger & Public Injuries (PAX)"
        subtitle="Tracked separately — high volume category; click to pin filter"
        right={
          <span className="pill text-[10px]" style={{ background: '#E0520615', color: '#E05206', border: '1px solid #E0520640' }}>
            {paxCount} incident{paxCount !== 1 ? 's' : ''}
          </span>
        }
      >
        {safetyPax.length > 0
          ? <SafetyTable rows={safetyPax} onCategoryClick={onAddCategoryFilter} />
          : <Empty msg="No passenger injury incidents in window" />}
        {paxIncidents.length > 0 && (
          <div className="mt-4">
            <p className="label-micro mb-2" style={{ color: 'var(--ink-400)' }}>Recent PAX incidents</p>
            <IncidentList rows={paxIncidents.slice(-10).reverse()} />
          </div>
        )}
      </Card>

      <Card title="Recent Safety-Critical Events" subtitle="Latest 10 across all categories">
        <IncidentList rows={safetyCritical.slice(-10).reverse()} />
      </Card>
    </div>
  )
}

// ─── Performance tab ─────────────────────────────────────────────────────────

function DelayThresholdSplitter({ incidents }: { incidents: any[] }) {
  const [threshold, setThreshold] = useState(200)
  const [input, setInput]         = useState('200')

  const validThreshold = threshold > 0

  const above = incidents.filter(i => (i.minutes_delay ?? 0) >  threshold)
  const below = incidents.filter(i => (i.minutes_delay ?? 0) <= threshold)

  const stats = (group: any[]) => {
    const count     = group.length
    const total     = group.reduce((s: number, i: any) => s + (i.minutes_delay ?? 0), 0)
    const avg       = count > 0 ? total / count : 0
    const pct       = incidents.length > 0 ? (count / incidents.length) * 100 : 0
    const delayPct  = incidents.reduce((s: number, i: any) => s + (i.minutes_delay ?? 0), 0)
    const delayShare = delayPct > 0 ? (total / delayPct) * 100 : 0
    return { count, total, avg, pct, delayShare }
  }

  const aboveStats = stats(above)
  const belowStats = stats(below)

  return (
    <Card title="Delay Threshold Analysis" subtitle="Split incidents above and below a delay demarcation line">
      <div className="flex items-end gap-3 mb-6">
        <div>
          <label className="label-micro mb-1 block">Threshold (minutes)</label>
          <input
            type="number"
            min={1}
            className="input w-36"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onBlur={() => {
              const v = parseInt(input, 10)
              if (!isNaN(v) && v > 0) setThreshold(v)
              else setInput(String(threshold))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = parseInt(input, 10)
                if (!isNaN(v) && v > 0) setThreshold(v)
                else setInput(String(threshold));
                (e.target as HTMLInputElement).blur()
              }
            }}
          />
        </div>
        <div className="text-xs pb-2" style={{ color: 'var(--ink-400)' }}>
          Splitting {incidents.length} incident{incidents.length !== 1 ? 's' : ''} at {threshold} min
        </div>
      </div>

      {validThreshold && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[
            { label: `Above ${threshold} min`, s: aboveStats, color: 'var(--nr-orange)', bg: 'rgba(224,82,6,0.08)', border: 'rgba(224,82,6,0.35)' },
            { label: `At or below ${threshold} min`, s: belowStats, color: 'var(--nr-steel)', bg: 'rgba(74,111,165,0.08)', border: 'rgba(74,111,165,0.3)' },
          ].map(({ label, s, color, bg, border }) => (
            <div key={label} className="rounded p-4 space-y-3" style={{ background: bg, border: `1px solid ${border}` }}>
              <div className="label-micro" style={{ color }}>{label}</div>
              <div className="grid grid-cols-2 gap-y-3">
                <div>
                  <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Incidents</div>
                  <div className="numeric text-2xl font-light" style={{ color: 'var(--ink-100)' }}>{s.count.toLocaleString()}</div>
                  <div className="text-[10px] numeric-mono" style={{ color: 'var(--ink-400)' }}>{s.pct.toFixed(1)}% of total</div>
                </div>
                <div>
                  <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Total Delay</div>
                  <div className="numeric text-2xl font-light" style={{ color: 'var(--ink-100)' }}>{s.total.toLocaleString()}</div>
                  <div className="text-[10px] numeric-mono" style={{ color: 'var(--ink-400)' }}>{s.delayShare.toFixed(1)}% of delay</div>
                </div>
                <div>
                  <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Avg Delay</div>
                  <div className="numeric-mono text-lg font-semibold" style={{ color }}>{s.count > 0 ? Math.round(s.avg).toLocaleString() : '—'} min</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function PerformanceTab({ kpis, trend, changePoints, hots, resp, responderLoad, ops, attribution, chart, setChart, incidents, onDrillDown, onDateClick, decompose, metricFocus }: any) {
  const [attrExpanded, setAttrExpanded] = useState(false)
  const isCancMode = metricFocus === 'cancellations'

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 stagger">
        <KPICard label="Total Delay (mins)" value={kpis.totalDelayMins.toLocaleString()} delta={kpis.delayDeltaPct} icon={Clock} deltaInverted accent={!isCancMode} decompose={decompose} metric="delay" />
        <KPICard label="Cancelled" value={kpis.totalCancelled} icon={X} accent={isCancMode} />
        <KPICard label="Part Cancelled" value={kpis.totalPartCancelled} icon={Minus} accent={isCancMode} />
        <KPICard
          label="Median Arrival"
          value={kpis.medianArrivalMins != null ? `${kpis.medianArrivalMins} min` : '—'}
          icon={Clock}
        />
        <KPICard
          label="Arrival SLA (≤45 min)"
          value={kpis.slaCompliancePct != null ? `${kpis.slaCompliancePct.toFixed(1)}%` : '—'}
          delta={kpis.slaBreachDeltaPct != null ? -kpis.slaBreachDeltaPct : null}
          icon={Clock}
          critical={kpis.slaCompliancePct != null && kpis.slaCompliancePct < 70}
        />
      </div>

      {isCancMode ? (
        <Card title="Cancellations — Daily" subtitle="Cancelled and part-cancelled trains per day" right={<ChartTypeToggle value={chart} onChange={setChart} />} className="tick-corners">
          <CancellationsTrendChart data={trend} kind={chart} />
        </Card>
      ) : (
        <Card title="Delay Minutes — Daily" subtitle="Aggregate impact · change-points marked" right={<ChartTypeToggle value={chart} onChange={setChart} />} className="tick-corners">
          <TrendChart data={trend} kind={chart} dataKey="delayMins" gradient="orange" onDateClick={onDateClick} changePoints={changePoints} />
        </Card>
      )}

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
              const visible = attrExpanded ? attribution : attribution.slice(0, 5)
              return (
                <>
                  {visible.map((a: any, i: number) => (
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
                  ))}
                  {attribution.length > 5 && (
                    <button
                      onClick={() => setAttrExpanded(e => !e)}
                      className="text-xs w-full text-center pt-2"
                      style={{ color: 'var(--ink-400)' }}
                    >
                      {attrExpanded ? 'Show top 5 only' : `Show all ${attribution.length} codes`}
                    </button>
                  )}
                </>
              )
            })()}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {ops && ops.length > 0 && (
          <Card
            title={isCancMode ? 'Operator Cancellation Impact' : 'Operator Delay Impact'}
            subtitle={isCancMode ? 'Total cancellations per train operator' : 'Total delay minutes per train operator'}
          >
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={ops} layout="vertical" margin={{ left: 10, right: 30 }}>
                <CartesianGrid strokeDasharray="2 6" horizontal={false} />
                <XAxis type="number" />
                <YAxis dataKey="company" type="category" width={80} tick={{ fontSize: 10, fill: 'var(--ink-300)', fontFamily: 'JetBrains Mono' }} />
                <Tooltip content={<CustomTooltip />} />
                {isCancMode
                  ? <Bar dataKey="cancellations" name="Cancellations" fill="#4A6FA5" radius={[0, 2, 2, 0]} />
                  : <Bar dataKey="delayMins" name="Delay (mins)" fill="#E05206" radius={[0, 2, 2, 0]} />
                }
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

      <DelayThresholdSplitter incidents={incidents} />
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

function PatternsTab({ heat, cats, staffPatterns }: { heat: any[]; cats: any[]; staffPatterns: StaffPatternDatum[] }) {
  const totalDay   = staffPatterns.reduce((s, p) => s + p.dayShifts, 0)
  const totalNight = staffPatterns.reduce((s, p) => s + p.nightShifts, 0)
  const totalShifts = totalDay + totalNight

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

      {staffPatterns.length > 0 && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Staff Incident Workload" subtitle="Incidents and delay per team member in this window">
              <ResponsiveContainer width="100%" height={Math.max(180, staffPatterns.length * 36)}>
                <BarChart
                  data={staffPatterns.map(p => ({ name: p.name, role: p.role, incidents: p.incidentCount, delay: p.totalDelay }))}
                  layout="vertical"
                  margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--ink-400)' }} />
                  <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 10, fill: 'var(--ink-200)' }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--line-hi)', borderRadius: 4, fontSize: 11 }}
                    formatter={(v: any, name: string) => [
                      name === 'incidents' ? `${v} incidents` : `${v} min delay`,
                      name === 'incidents' ? 'Incidents' : 'Total delay',
                    ]}
                  />
                  <Bar dataKey="incidents" name="incidents" fill="var(--nr-orange)" radius={[0, 2, 2, 0]} maxBarSize={20} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Day vs Night Shift Split" subtitle="Shift distribution across team members">
              {totalShifts > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs" style={{ color: 'var(--nr-amber)' }}>Day</span>
                        <span className="numeric-mono text-xs" style={{ color: 'var(--nr-amber)' }}>{totalDay} ({((totalDay / totalShifts) * 100).toFixed(0)}%)</span>
                      </div>
                      <div className="h-2 rounded-sm overflow-hidden" style={{ background: 'var(--bg-card-hi)' }}>
                        <div className="h-full rounded-sm" style={{ width: `${(totalDay / totalShifts) * 100}%`, background: 'var(--nr-amber)' }} />
                      </div>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs" style={{ color: 'var(--nr-blue)' }}>Night</span>
                        <span className="numeric-mono text-xs" style={{ color: 'var(--nr-blue)' }}>{totalNight} ({((totalNight / totalShifts) * 100).toFixed(0)}%)</span>
                      </div>
                      <div className="h-2 rounded-sm overflow-hidden" style={{ background: 'var(--bg-card-hi)' }}>
                        <div className="h-full rounded-sm" style={{ width: `${(totalNight / totalShifts) * 100}%`, background: 'var(--nr-blue)' }} />
                      </div>
                    </div>
                  </div>

                  <ResponsiveContainer width="100%" height={Math.max(160, staffPatterns.length * 32)}>
                    <BarChart
                      data={staffPatterns.map(p => ({ name: p.name, Day: p.dayShifts, Night: p.nightShifts }))}
                      layout="vertical"
                      margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--ink-400)' }} allowDecimals={false} />
                      <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 10, fill: 'var(--ink-200)' }} />
                      <Tooltip
                        contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--line-hi)', borderRadius: 4, fontSize: 11 }}
                      />
                      <Bar dataKey="Day" stackId="a" fill="var(--nr-amber)" radius={[0, 0, 0, 0]} maxBarSize={16} />
                      <Bar dataKey="Night" stackId="a" fill="var(--nr-blue)" radius={[0, 2, 2, 0]} maxBarSize={16} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
          </div>

          <Card title="Staff Breakdown" subtitle="Roles, incident counts and delay by team member">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--line)]">
                    <th className="text-left pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Name</th>
                    <th className="text-left pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Role</th>
                    <th className="text-right pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Incidents</th>
                    <th className="text-right pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Total Delay</th>
                    <th className="text-right pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Day</th>
                    <th className="text-right pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Night</th>
                    <th className="text-left pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Top Category</th>
                  </tr>
                </thead>
                <tbody>
                  {staffPatterns.map(p => {
                    const cfg = p.topCategory ? CATEGORY_CONFIG[p.topCategory] : null
                    return (
                      <tr key={`${p.name}-${p.role}`} className="border-b border-[var(--line)] last:border-0">
                        <td className="py-2 font-medium" style={{ color: 'var(--ink-100)' }}>{p.name}</td>
                        <td className="py-2" style={{ color: 'var(--ink-300)' }}>{p.role}</td>
                        <td className="py-2 text-right numeric-mono" style={{ color: 'var(--ink-100)' }}>{p.incidentCount}</td>
                        <td className="py-2 text-right numeric-mono" style={{ color: 'var(--nr-orange)' }}>{fmtMins(p.totalDelay)}</td>
                        <td className="py-2 text-right numeric-mono" style={{ color: 'var(--nr-amber)' }}>{p.dayShifts}</td>
                        <td className="py-2 text-right numeric-mono" style={{ color: 'var(--nr-blue)' }}>{p.nightShifts}</td>
                        <td className="py-2">
                          {cfg && (
                            <span className="pill text-[9px]" style={{ background: `${cfg.color}20`, color: cfg.color, borderColor: `${cfg.color}50` }}>
                              {cfg.short}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
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

type SeriesMetric =
  | 'incidents' | 'delayMins' | 'safetyCritical'
  | 'delayPerIncident' | 'avgArrival' | 'avgDuration' | 'pctSlaBreach'

interface TrendSeriesDef {
  id: string
  label: string
  color: string
  metric: SeriesMetric
  categories: IncidentCategory[]
  severities: Severity[]
  areas: string[]
}

const METRIC_OPTS: { key: SeriesMetric; label: string; unit: string; ratio: boolean; risingIsBad: boolean }[] = [
  { key: 'incidents',         label: 'Incidents',         unit: '',     ratio: false, risingIsBad: true  },
  { key: 'delayMins',         label: 'Delay Mins',        unit: 'm',    ratio: false, risingIsBad: true  },
  { key: 'safetyCritical',    label: 'Safety Critical',   unit: '',     ratio: false, risingIsBad: true  },
  { key: 'delayPerIncident',  label: 'Delay / Incident',  unit: 'm',    ratio: true,  risingIsBad: true  },
  { key: 'avgArrival',        label: 'Avg Arrival',       unit: 'm',    ratio: true,  risingIsBad: true  },
  { key: 'avgDuration',       label: 'Avg Duration',      unit: 'm',    ratio: true,  risingIsBad: true  },
  { key: 'pctSlaBreach',      label: '% Arrival SLA breach',      unit: '%',    ratio: true,  risingIsBad: true  },
]

function isRatioMetric(m: SeriesMetric): boolean {
  return METRIC_OPTS.find(o => o.key === m)?.ratio ?? false
}

function metricUnit(m: SeriesMetric): string {
  return METRIC_OPTS.find(o => o.key === m)?.unit ?? ''
}

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

  const rawMaps = new Map<string, Map<string, number | null>>()
  for (const s of series) {
    const byDate = new Map<string, number | null>(dates.map(d => [d, isRatioMetric(s.metric) ? null : 0]))
    const filtered = incidents.filter(inc => {
      if (s.categories.length && !s.categories.includes(inc.category)) return false
      if (s.severities.length && !s.severities.includes(inc.severity)) return false
      if (s.areas.length && !s.areas.includes(inc.area ?? '')) return false
      return true
    })

    if (s.metric === 'incidents' || s.metric === 'safetyCritical') {
      for (const inc of filtered) {
        if (inc.is_continuation) continue
        if (s.metric === 'safetyCritical' && !SAFETY_CATEGORIES.includes(inc.category)) continue
        const cur = byDate.get(inc.report_date)
        if (cur === undefined) continue
        byDate.set(inc.report_date, (cur as number) + 1)
      }
    } else if (s.metric === 'delayMins') {
      for (const inc of filtered) {
        const cur = byDate.get(inc.report_date)
        if (cur === undefined) continue
        const add = inc.is_continuation ? (inc.delay_delta ?? 0) : (inc.minutes_delay ?? 0)
        byDate.set(inc.report_date, (cur as number) + add)
      }
    } else {
      // ratio metrics — accumulate per day as { sum, count } and average at the end
      const acc = new Map<string, { sum: number; count: number }>(dates.map(d => [d, { sum: 0, count: 0 }]))
      for (const inc of filtered) {
        if (inc.is_continuation) continue
        const a = acc.get(inc.report_date)
        if (!a) continue
        if (s.metric === 'delayPerIncident') {
          a.sum += (inc.minutes_delay ?? 0); a.count += 1
        } else if (s.metric === 'avgArrival') {
          const v = effectiveMinsToArrival(inc)
          if (v != null) { a.sum += v; a.count += 1 }
        } else if (s.metric === 'avgDuration') {
          const v = effectiveDuration(inc)
          if (v != null) { a.sum += v; a.count += 1 }
        } else if (s.metric === 'pctSlaBreach') {
          const v = effectiveMinsToArrival(inc)
          if (v != null) { a.sum += v > SLA_THRESHOLD_MINS ? 1 : 0; a.count += 1 }
        }
      }
      for (const d of dates) {
        const a = acc.get(d)!
        if (a.count === 0) byDate.set(d, null)
        else if (s.metric === 'pctSlaBreach') byDate.set(d, +(a.sum / a.count * 100).toFixed(1))
        else byDate.set(d, +(a.sum / a.count).toFixed(1))
      }
    }
    rawMaps.set(s.id, byDate)
  }

  const maxByS = new Map<string, number>()
  if (normalise) {
    for (const s of series) {
      const vals = Array.from(rawMaps.get(s.id)!.values()).filter((v): v is number => v != null)
      maxByS.set(s.id, Math.max(1, ...vals))
    }
  }

  const rows = dates.map(d => {
    const row: Record<string, any> = { date: d }
    for (const s of series) {
      const raw = rawMaps.get(s.id)!.get(d)
      if (raw == null) {
        row[s.id] = null
      } else {
        const max = maxByS.get(s.id) ?? 1
        row[s.id] = normalise ? +(raw / max * 100).toFixed(1) : raw
      }
    }
    return row
  })

  // rolling 7-day avg overlay keys (skip nulls)
  for (const s of series) {
    for (let i = 0; i < rows.length; i++) {
      const window = rows.slice(Math.max(0, i - 6), i + 1)
      const vals = window.map(r => r[s.id]).filter((v): v is number => v != null)
      rows[i][s.id + '_r7'] = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null
    }
  }

  return rows
}

// Linear-regression slope expressed as "% change end-to-start". null when the
// series has too few points or starts at zero (where % change is undefined).
function trendDirection(rows: Record<string, any>[], key: string): {
  slopePct: number | null
  first: number | null
  last: number | null
  n: number
} {
  const series: number[] = []
  for (const r of rows) {
    const v = r[key]
    if (v != null && !Number.isNaN(v)) series.push(v as number)
  }
  const n = series.length
  if (n < 4) return { slopePct: null, first: null, last: null, n }
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += series[i]; sumXY += i * series[i]; sumXX += i * i
  }
  const denom = n * sumXX - sumX * sumX
  if (denom === 0) return { slopePct: null, first: null, last: null, n }
  const slope = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  const first = intercept
  const last = intercept + slope * (n - 1)
  if (Math.abs(first) < 1e-9) return { slopePct: null, first, last, n }
  return { slopePct: ((last - first) / Math.abs(first)) * 100, first, last, n }
}

function TrendsTooltip({ active, payload, label, series, normalise }: any) {
  if (!active || !payload?.length) return null
  const defs: TrendSeriesDef[] = series ?? []
  const items = (payload as any[]).filter(p => !String(p.dataKey).endsWith('_r7'))
  return (
    <div className="card !bg-[var(--bg-card-hi)] !border-[var(--line-hi)] p-2.5 text-xs min-w-[180px]">
      <div className="label-micro mb-1.5">{label}</div>
      {items.map((p: any, i: number) => {
        const s = defs.find(d => d.id === p.dataKey)
        const unit = s ? metricUnit(s.metric) : ''
        const valStr = p.value == null
          ? '—'
          : normalise
            ? `${p.value}%`
            : typeof p.value === 'number' ? `${p.value.toLocaleString()}${unit}` : String(p.value)
        return (
          <div key={i} className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-sm shrink-0" style={{ background: s?.color ?? p.color }} />
            <span className="truncate" style={{ color: 'var(--ink-300)' }}>{s?.label ?? p.name}:</span>
            <span className="numeric-mono ml-auto" style={{ color: 'var(--ink-100)' }}>{valStr}</span>
          </div>
        )
      })}
    </div>
  )
}

function TrendBadge({ slopePct, risingIsBad }: { slopePct: number | null; risingIsBad: boolean }) {
  if (slopePct == null || !Number.isFinite(slopePct)) {
    return <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>· —</span>
  }
  const flat = Math.abs(slopePct) < 3
  if (flat) {
    return (
      <span className="flex items-center gap-0.5 numeric-mono text-[10px]" style={{ color: 'var(--ink-400)' }}>
        <Minus size={9} /> steady
      </span>
    )
  }
  const up = slopePct > 0
  const bad = up ? risingIsBad : !risingIsBad
  const color = bad ? 'var(--nr-orange)' : '#27AE60'
  const Icon = up ? TrendingUp : TrendingDown
  return (
    <span className="flex items-center gap-0.5 numeric-mono text-[10px]" style={{ color }}>
      <Icon size={9} /> {up ? '+' : ''}{Math.round(slopePct)}%
    </span>
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
          {series.map(s => {
            const opt = METRIC_OPTS.find(m => m.key === s.metric)
            const dir = trendDirection(chartData, s.id + '_r7')
            const fallback = dir.slopePct == null ? trendDirection(chartData, s.id) : dir
            return (
              <div
                key={s.id}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border"
                style={{ background: `${s.color}18`, borderColor: `${s.color}50`, color: 'var(--ink-200)' }}
              >
                <div className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.color }} />
                <span>{s.label}</span>
                <span style={{ color: `${s.color}80` }}>·</span>
                <span style={{ color: 'var(--ink-400)' }}>{opt?.label}</span>
                <span style={{ color: `${s.color}60` }}>·</span>
                <TrendBadge slopePct={fallback.slopePct} risingIsBad={opt?.risingIsBad ?? true} />
                {series.length > 1 && (
                  <button onClick={() => setSeries(prev => prev.filter(x => x.id !== s.id))} className="ml-0.5 opacity-50 hover:opacity-100">
                    <X size={10} />
                  </button>
                )}
              </div>
            )
          })}
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

function KPICard({ label, value, subValue, delta, icon: Icon, deltaInverted, critical, accent, decompose, metric, onListClick }: any) {
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
    <div
      className={`card p-5 animate-count-up relative overflow-hidden group ${accent ? 'card-hi' : ''} ${onListClick ? 'cursor-pointer hover:border-[var(--line-hi)] transition-colors' : ''}`}
      onClick={onListClick}
    >
      {critical && (
        <div className="absolute top-0 right-0 w-12 h-12 pointer-events-none"
             style={{ background: 'radial-gradient(circle at top right, rgba(231, 76, 60, 0.4), transparent 70%)' }} />
      )}
      <div className="flex items-center justify-between mb-3">
        <span className="label-micro">{label}</span>
        <div className="flex items-center gap-1.5">
          {onListClick && (
            <List size={12} className="opacity-0 group-hover:opacity-60 transition-opacity" style={{ color: 'var(--ink-400)' }} />
          )}
          {Icon && <Icon size={14} style={{ color: 'var(--ink-400)' }} />}
        </div>
      </div>
      <div className="numeric text-4xl font-light leading-none mb-1" style={{ color: 'var(--ink-100)' }}>
        {value}
      </div>
      {subValue && <div className="numeric-mono text-xs mt-1" style={{ color: 'var(--ink-400)' }}>{subValue}</div>}
      {delta != null && TrendIcon && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); canDecompose && setOpen(true) }}
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

function ActiveFilterChips({ filters, onRemoveCategory, onRemoveArea, onRemoveSeverity, onRemoveSearch, onRemoveIncidentType, onRemoveStaff, onClearDate, onClearDelay, onClearAll }: {
  filters: AnalyticsFilters
  onRemoveCategory: (c: IncidentCategory) => void
  onRemoveArea: (a: string) => void
  onRemoveSeverity: (s: Severity) => void
  onRemoveSearch: (s: string) => void
  onRemoveIncidentType: (label: string) => void
  onRemoveStaff: (name: string) => void
  onClearDate: () => void
  onClearDelay: () => void
  onClearAll: () => void
}) {
  const hasCustomDate = !!filters.startDate
  const hasDelay = filters.minDelay != null || filters.maxDelay != null
  const total =
    filters.categories.length + filters.areas.length + filters.severities.length +
    filters.searches.length + filters.incidentTypes.length + filters.staffNames.length +
    (hasCustomDate ? 1 : 0) + (hasDelay ? 1 : 0)
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
          {hasDelay && chip(
            'delay',
            filters.minDelay != null && filters.maxDelay != null
              ? `${filters.minDelay}–${filters.maxDelay} min delay`
              : filters.minDelay != null
              ? `≥${filters.minDelay} min delay`
              : `≤${filters.maxDelay} min delay`,
            onClearDelay,
            'var(--nr-steel)',
            'Clear delay range filter',
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
          {filters.incidentTypes.map(t => chip(`itype-${t}`, t, () => onRemoveIncidentType(t), 'var(--nr-orange)'))}
          {filters.staffNames.map(n => chip(`staff-${n}`, n, () => onRemoveStaff(n), 'var(--nr-blue)'))}
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

function CancellationsTrendChart({ data, kind }: { data: any[]; kind: string }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 6" />
        <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 10, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono' }} />
        <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono' }} />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono' }} />
        <Bar dataKey="cancelled" name="Cancelled" stackId="a" fill="#E05206" radius={[0, 0, 0, 0]} />
        <Bar dataKey="partCancelled" name="Part Cancelled" stackId="a" fill="#F39C12" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
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
  // Group by CCIL so multi-day continuations appear under their primary
  const groups: { primary: IncidentRow; continuations: IncidentRow[] }[] = []
  const seen = new Map<string, number>()     // ccil → group index
  const noKey: IncidentRow[] = []            // rows with no CCIL

  const byDate = [...incidents].sort((a, b) => a.report_date.localeCompare(b.report_date))
  for (const inc of byDate) {
    const key = inc.ccil?.trim()
    if (!key) { noKey.push(inc); continue }
    if (seen.has(key)) {
      groups[seen.get(key)!].continuations.push(inc)
    } else {
      seen.set(key, groups.length)
      groups.push({ primary: inc, continuations: [] })
    }
  }
  // Uncategorised rows (no CCIL) each get their own group
  for (const inc of noKey) groups.push({ primary: inc, continuations: [] })

  // Sort groups newest-primary-first for display
  groups.sort((a, b) => b.primary.report_date.localeCompare(a.primary.report_date))

  const uniqueCount = groups.length

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[80vh] bg-[var(--bg-panel)] border border-[var(--line-hi)] rounded overflow-hidden flex flex-col animate-fade-up">
        <div className="flex items-start justify-between p-4 border-b border-[var(--line)] shrink-0">
          <div>
            <h3 className="serif text-xl font-medium" style={{ color: 'var(--ink-100)' }}>{title}</h3>
            <p className="label-micro mt-0.5">
              {uniqueCount} incident{uniqueCount !== 1 ? 's' : ''} in window
              {incidents.length > uniqueCount && ` · ${incidents.length - uniqueCount} carried over`}
            </p>
          </div>
          <button onClick={onClose} className="btn !p-2 shrink-0"><X size={14} /></button>
        </div>
        <div className="overflow-y-auto p-4 space-y-3 flex-1">
          {groups.length === 0 && <Empty msg="No matching incidents in window" />}
          {groups.map(({ primary: inc, continuations }) => (
            <div key={inc.id} className="rounded border border-[var(--line)] overflow-hidden">
              {/* Primary row */}
              <div className="card !rounded-none !border-0 !bg-[var(--bg-card-hi)] p-3 text-xs">
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
              {/* Continuation rows */}
              {continuations.map((c) => (
                <div key={c.id} className="border-t border-[var(--line)] px-3 py-2 text-xs flex items-center gap-3" style={{ background: 'var(--bg-card)' }}>
                  <span className="label-micro shrink-0" style={{ color: 'var(--ink-500)' }}>↪ carried over</span>
                  <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-400)' }}>{c.report_date}</span>
                  <span className="truncate flex-1 text-[11px]" style={{ color: 'var(--ink-400)' }}>{c.title || c.location || '—'}</span>
                  {c.delay_delta != null && c.delay_delta > 0 && (
                    <span className="numeric-mono text-[10px] shrink-0" style={{ color: 'var(--nr-orange)' }}>+{c.delay_delta}m</span>
                  )}
                </div>
              ))}
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

// ─── CalendarPicker ───────────────────────────────────────────────────────────
// Inline calendar that expands in-flow inside the filter drawer so it never
// overlaps the sticky Apply bar or clips against the panel edge.
// value / onChange use ISO 'YYYY-MM-DD' strings.

function CalendarPicker({ value, onChange, placeholder = 'Select date' }: {
  value: string | undefined
  onChange: (v: string | undefined) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)

  const seed = value ? new Date(value + 'T00:00:00') : new Date()
  const [viewYear,  setViewYear]  = useState(seed.getFullYear())
  const [viewMonth, setViewMonth] = useState(seed.getMonth())

  useEffect(() => {
    if (value) {
      const d = new Date(value + 'T00:00:00')
      setViewYear(d.getFullYear())
      setViewMonth(d.getMonth())
    }
  }, [value])

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const DAYS   = ['Su','Mo','Tu','We','Th','Fr','Sa']

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1) }
    else setViewMonth(m => m - 1)
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1) }
    else setViewMonth(m => m + 1)
  }

  const firstDow   = new Date(viewYear, viewMonth, 1).getDay()
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
  const cells: (number | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  function select(day: number) {
    const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    onChange(iso)
    setOpen(false)
  }

  const today = new Date().toISOString().slice(0, 10)
  const displayLabel = value
    ? (() => {
        const [y, m, d] = value.split('-')
        return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]} ${y}`
      })()
    : placeholder

  return (
    <div>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="input w-full text-left flex items-center gap-2"
        style={{ color: value ? 'var(--ink-100)' : 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px' }}
      >
        <ChevronDown size={11} style={{ opacity: 0.5, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
        {displayLabel}
      </button>

      {/* Inline calendar — expands in document flow, no overlap */}
      {open && (
        <div
          className="rounded border border-[var(--line-hi)] p-3 mt-1"
          style={{ background: 'var(--bg-card)' }}
        >
          {/* Month / Year navigation */}
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={prevMonth} className="btn !p-1"><ChevronLeft size={12} /></button>
            <span className="text-xs font-medium" style={{ color: 'var(--ink-100)', fontFamily: 'JetBrains Mono, monospace' }}>
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button type="button" onClick={nextMonth} className="btn !p-1"><ChevronRight size={12} /></button>
          </div>
          {/* Day-of-week headers */}
          <div className="grid grid-cols-7 mb-1">
            {DAYS.map(d => (
              <div key={d} className="text-center text-[10px]" style={{ color: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }}>{d}</div>
            ))}
          </div>
          {/* Date cells */}
          <div className="grid grid-cols-7">
            {cells.map((day, i) => {
              if (!day) return <div key={`e-${i}`} />
              const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
              const isSelected = iso === value
              const isToday    = iso === today
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => select(day)}
                  className="rounded text-[11px] py-1.5 transition-colors hover:bg-[var(--bg-card-hi)]"
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    background: isSelected ? 'var(--nr-orange)' : isToday ? 'var(--bg-card-hi)' : undefined,
                    color: isSelected ? '#fff' : isToday ? 'var(--nr-orange)' : 'var(--ink-200)',
                    fontWeight: isSelected || isToday ? 600 : undefined,
                  }}
                >
                  {day}
                </button>
              )
            })}
          </div>
          {/* Clear */}
          {value && (
            <button
              type="button"
              onClick={() => { onChange(undefined); setOpen(false) }}
              className="mt-2 text-[10px] w-full text-center"
              style={{ color: 'var(--ink-400)' }}
            >
              Clear date
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function FilterDrawer({ open, onClose, filters, onApply, onReset, availableAreas, availableIncidentTypes, availableStaff, savedViews, onSaveView, onDeleteView, onApplyView }: any) {
  const [draft, setDraft]               = useState<AnalyticsFilters>(filters)
  const [saveName, setSaveName]         = useState('')
  const [showSaveInput, setShowSaveInput] = useState(false)
  const [typeSearch, setTypeSearch]     = useState('')
  const [typesExpanded, setTypesExpanded] = useState(false)
  useEffect(() => { setDraft(filters); setShowSaveInput(false); setSaveName(''); setTypeSearch('') }, [filters, open])

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
          <FilterGroup label="Primary Metric">
            <div className="flex gap-2">
              <button
                onClick={() => setDraft({ ...draft, metricFocus: 'delay' })}
                className={`btn flex-1 justify-center ${draft.metricFocus !== 'cancellations' ? 'btn-active' : ''}`}
              >
                <Clock size={11} />
                Delay (mins)
              </button>
              <button
                onClick={() => setDraft({ ...draft, metricFocus: 'cancellations' })}
                className={`btn flex-1 justify-center ${draft.metricFocus === 'cancellations' ? 'btn-active' : ''}`}
              >
                <X size={11} />
                Cancellations
              </button>
            </div>
            <p className="text-[10px] mt-2" style={{ color: 'var(--ink-500)' }}>
              Switches the primary metric used in trend charts, operator tables, and KPI emphasis across the performance view.
            </p>
          </FilterGroup>

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

          {availableStaff && availableStaff.length > 0 && (
            <FilterGroup label="Staff on Duty">
              <div className="space-y-1.5">
                {availableStaff.map((name: string) => (
                  <Chip
                    key={name}
                    label={name}
                    active={draft.staffNames.includes(name)}
                    onToggle={() => setDraft({
                      ...draft,
                      staffNames: draft.staffNames.includes(name)
                        ? draft.staffNames.filter(x => x !== name)
                        : [...draft.staffNames, name],
                    })}
                  />
                ))}
              </div>
              {draft.staffNames.length > 0 && (
                <button
                  onClick={() => setDraft({ ...draft, staffNames: [] })}
                  className="text-xs mt-2"
                  style={{ color: 'var(--ink-400)' }}
                >
                  Clear staff filter
                </button>
              )}
            </FilterGroup>
          )}

          <FilterGroup label="Categories">
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(CATEGORY_CONFIG) as IncidentCategory[]).filter(c => c !== 'FATALITY').map(c => (
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

          {/* CCIL incident type filter — derived from live data in the current window */}
          {availableIncidentTypes && availableIncidentTypes.length > 0 && (
            <FilterGroup label="CCIL Incident Type">
              <div className="space-y-2">
                <input
                  type="text"
                  className="input w-full text-xs"
                  placeholder="Search types…"
                  value={typeSearch}
                  onChange={(e) => { setTypeSearch(e.target.value); setTypesExpanded(true) }}
                />
                {draft.incidentTypes.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {draft.incidentTypes.map((t: string) => (
                      <button
                        key={t}
                        onClick={() => setDraft({ ...draft, incidentTypes: draft.incidentTypes.filter((x: string) => x !== t) })}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px]"
                        style={{ background: 'var(--nr-orange)20', border: '1px solid var(--nr-orange)', color: 'var(--nr-orange)', fontFamily: 'JetBrains Mono, monospace' }}
                      >
                        {t}<X size={9} />
                      </button>
                    ))}
                  </div>
                )}
                <div className={typesExpanded ? '' : 'max-h-48 overflow-y-auto'}>
                  {(typeSearch
                    ? availableIncidentTypes.filter((t: any) => t.label.toLowerCase().includes(typeSearch.toLowerCase()))
                    : typesExpanded
                      ? availableIncidentTypes
                      : availableIncidentTypes.slice(0, 8)
                  ).map((t: any) => (
                    <button
                      key={t.label}
                      onClick={() => setDraft({
                        ...draft,
                        incidentTypes: draft.incidentTypes.includes(t.label)
                          ? draft.incidentTypes.filter((x: string) => x !== t.label)
                          : [...draft.incidentTypes, t.label],
                      })}
                      className="w-full flex items-center justify-between px-2 py-1.5 rounded-sm text-xs transition-colors hover:bg-[var(--bg-card-hi)] text-left"
                      style={{
                        background: draft.incidentTypes.includes(t.label) ? 'var(--nr-orange)15' : undefined,
                        border: `1px solid ${draft.incidentTypes.includes(t.label) ? 'var(--nr-orange)' : 'var(--line)'}`,
                        color: draft.incidentTypes.includes(t.label) ? 'var(--nr-orange)' : 'var(--ink-200)',
                        marginBottom: '4px',
                        fontFamily: 'JetBrains Mono, monospace',
                      }}
                    >
                      <span className="truncate">{t.label}</span>
                      <span className="shrink-0 ml-2 text-[10px]" style={{ color: 'var(--ink-400)' }}>{t.count}</span>
                    </button>
                  ))}
                </div>
                {!typeSearch && availableIncidentTypes.length > 8 && (
                  <button
                    onClick={() => setTypesExpanded(e => !e)}
                    className="text-xs w-full text-center pt-1"
                    style={{ color: 'var(--ink-400)' }}
                  >
                    {typesExpanded ? 'Show less' : `Show all ${availableIncidentTypes.length} types`}
                  </button>
                )}
              </div>
            </FilterGroup>
          )}

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

          <FilterGroup label="Delay Range (minutes)">
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <label className="label-micro mb-1 block">Min</label>
                <input
                  type="number"
                  min={0}
                  className="input w-full"
                  placeholder="e.g. 1000"
                  value={draft.minDelay ?? ''}
                  onChange={(e) => setDraft({ ...draft, minDelay: e.target.value === '' ? undefined : Number(e.target.value) })}
                />
              </div>
              <div className="flex-1">
                <label className="label-micro mb-1 block">Max</label>
                <input
                  type="number"
                  min={0}
                  className="input w-full"
                  placeholder="no limit"
                  value={draft.maxDelay ?? ''}
                  onChange={(e) => setDraft({ ...draft, maxDelay: e.target.value === '' ? undefined : Number(e.target.value) })}
                />
              </div>
            </div>
            {(draft.minDelay != null || draft.maxDelay != null) && (
              <button
                onClick={() => setDraft({ ...draft, minDelay: undefined, maxDelay: undefined })}
                className="text-xs mt-2"
                style={{ color: 'var(--ink-400)' }}
              >
                Clear delay range
              </button>
            )}
          </FilterGroup>

          <FilterGroup label="Custom Date Range">
            <div className="space-y-2">
              <div>
                <label className="label-micro mb-1 block">From</label>
                <CalendarPicker
                  value={draft.startDate}
                  onChange={(v) => setDraft({ ...draft, startDate: v })}
                  placeholder="Start date"
                />
              </div>
              <div>
                <label className="label-micro mb-1 block">To</label>
                <CalendarPicker
                  value={draft.endDate}
                  onChange={(v) => setDraft({ ...draft, endDate: v })}
                  placeholder="End date"
                />
              </div>
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
  return `${Math.round(m).toLocaleString()} min`
}

// ─── Review Tab ──────────────────────────────────────────────────────────────
// SNDM workflow: open a log period, drill into individual days, expand each
// incident to see what CCIL captured, then add the optional review details
// (classification, MOM response, recovery times, stranded-train detail, etc.)
// and refine any CCIL-captured values that need correcting. All review fields
// are optional — a saved row just means an SNDM has touched the incident.

function ReviewTab({
  periods, reviewByIncidentId, teamMembersByIncidentId, teamWorkload, onSave, onDelete, demoMode, supabaseConfigured,
}: {
  periods: ReviewPeriodGroup[]
  reviewByIncidentId: Map<string, IncidentReview>
  teamMembersByIncidentId: Map<string, IncidentTeamMember[]>
  teamWorkload: TeamMemberWorkload[]
  onSave: (input: IncidentReviewInput, incidentStart: string | null) => Promise<void>
  onDelete: (incidentId: string) => Promise<void>
  demoMode: boolean
  supabaseConfigured: boolean
}) {
  const totalIncidents = periods.reduce((s, g) => s + g.totalIncidents, 0)
  const totalReviewed  = periods.reduce((s, g) => s + g.totalReviewed, 0)
  const reviewPct = totalIncidents > 0 ? (totalReviewed / totalIncidents) * 100 : 0

  return (
    <div className="space-y-6">
      {!supabaseConfigured && (
        <div className="card p-4 text-xs flex items-start gap-3" style={{ borderColor: 'var(--nr-amber)' }}>
          <AlertTriangle size={14} style={{ color: 'var(--nr-amber)' }} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium" style={{ color: 'var(--ink-100)' }}>Demo mode — review edits will not be saved</div>
            <div className="mt-1" style={{ color: 'var(--ink-400)' }}>
              The Supabase environment variables are not configured. You can explore the form, but saving requires a live connection.
            </div>
          </div>
        </div>
      )}
      {supabaseConfigured && demoMode && (
        <div className="card p-4 text-xs flex items-start gap-3" style={{ borderColor: 'var(--nr-amber)' }}>
          <AlertTriangle size={14} style={{ color: 'var(--nr-amber)' }} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium" style={{ color: 'var(--ink-100)' }}>No incidents in the current window — showing demo data</div>
            <div className="mt-1" style={{ color: 'var(--ink-400)' }}>
              Saves are disabled for demo rows. Adjust the date window above to view real data.
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 stagger">
        <KPICard label="Open Log Periods" value={periods.length.toLocaleString()} icon={ClipboardList} />
        <KPICard label="Incidents in Window" value={totalIncidents.toLocaleString()} icon={Activity} />
        <KPICard
          label="Reviewed"
          value={`${totalReviewed.toLocaleString()} / ${totalIncidents.toLocaleString()}`}
          subValue={`${reviewPct.toFixed(0)}% complete`}
          icon={ClipboardCheck}
          accent
        />
      </div>

      {teamWorkload.length > 0 && (
        <Card title="Team on Duty" subtitle="Who was recorded on shift across incidents in this window">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--line)]">
                  <th className="text-left pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Name</th>
                  <th className="text-left pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Role</th>
                  <th className="text-right pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Incidents</th>
                  <th className="text-right pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Total Delay</th>
                  <th className="text-right pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Avg / Incident</th>
                  <th className="text-right pb-2 label-micro" style={{ color: 'var(--ink-400)' }}>Shifts</th>
                </tr>
              </thead>
              <tbody>
                {teamWorkload.map((w, i) => (
                  <tr key={`${w.name}-${w.role}`} className="border-b border-[var(--line)] last:border-0">
                    <td className="py-2 font-medium" style={{ color: 'var(--ink-100)' }}>{w.name}</td>
                    <td className="py-2" style={{ color: 'var(--ink-300)' }}>{w.role}</td>
                    <td className="py-2 text-right numeric-mono" style={{ color: 'var(--ink-100)' }}>{w.incidentCount}</td>
                    <td className="py-2 text-right numeric-mono" style={{ color: 'var(--nr-orange)' }}>{fmtMins(w.totalDelay)}</td>
                    <td className="py-2 text-right numeric-mono" style={{ color: 'var(--ink-300)' }}>
                      {w.incidentCount > 0 ? fmtMins(w.totalDelay / w.incidentCount) : '—'}
                    </td>
                    <td className="py-2 text-right">
                      <span className="inline-flex items-center gap-1.5">
                        {w.dayShifts > 0 && (
                          <span className="pill text-[9px]" style={{ background: 'rgba(243,156,18,0.12)', color: 'var(--nr-amber)', borderColor: 'rgba(243,156,18,0.3)' }}>
                            Day ×{w.dayShifts}
                          </span>
                        )}
                        {w.nightShifts > 0 && (
                          <span className="pill text-[9px]" style={{ background: 'rgba(74,111,165,0.12)', color: 'var(--nr-blue)', borderColor: 'rgba(74,111,165,0.3)' }}>
                            Night ×{w.nightShifts}
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Log Periods" subtitle="Expand a period to drill into its days and incidents" className="tick-corners">
        {periods.length === 0 ? (
          <Empty msg="No incidents in the current date range" />
        ) : (
          <div className="space-y-2">
            {periods.map(g => (
              <PeriodGroupRow
                key={g.key}
                group={g}
                reviewByIncidentId={reviewByIncidentId}
                teamMembersByIncidentId={teamMembersByIncidentId}
                onSave={onSave}
                onDelete={onDelete}
                canSave={supabaseConfigured && !demoMode}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function PeriodGroupRow({
  group, reviewByIncidentId, teamMembersByIncidentId, onSave, onDelete, canSave,
}: {
  group: ReviewPeriodGroup
  reviewByIncidentId: Map<string, IncidentReview>
  teamMembersByIncidentId: Map<string, IncidentTeamMember[]>
  onSave: (input: IncidentReviewInput, incidentStart: string | null) => Promise<void>
  onDelete: (incidentId: string) => Promise<void>
  canSave: boolean
}) {
  const [open, setOpen] = useState(false)
  const complete = group.totalIncidents > 0 && group.totalReviewed >= group.totalIncidents
  const pct = group.totalIncidents > 0 ? (group.totalReviewed / group.totalIncidents) * 100 : 0

  return (
    <div className="rounded border border-[var(--line)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--bg-card-hi)] transition-colors"
        style={{ background: open ? 'var(--bg-card-hi)' : 'transparent' }}
      >
        <ChevronDown size={14} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s', color: 'var(--ink-400)' }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="serif text-base font-medium" style={{ color: 'var(--ink-100)' }}>{group.periodLabel}</span>
            <span className="label-micro" style={{ color: 'var(--ink-400)' }}>{group.yearLabel}</span>
            <span className="label-micro">{group.days.length} day{group.days.length !== 1 ? 's' : ''}</span>
            <span className="label-micro" style={{ color: 'var(--ink-500)' }}>
              {group.days[group.days.length - 1]?.date} → {group.days[0]?.date}
            </span>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-4 shrink-0">
          <div className="text-right">
            <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Incidents</div>
            <div className="numeric-mono text-xs" style={{ color: 'var(--ink-100)' }}>{group.totalIncidents}</div>
          </div>
          <div className="text-right">
            <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Delay</div>
            <div className="numeric-mono text-xs" style={{ color: 'var(--nr-orange)' }}>{fmtMins(group.totalDelay)}</div>
          </div>
          <div className="text-right w-28">
            <div className="label-micro text-[9px]" style={{ color: 'var(--ink-500)' }}>Reviewed</div>
            <div className="flex items-center gap-2">
              <div className="h-1 flex-1 bg-[var(--bg-card-hi)] rounded-sm overflow-hidden">
                <div className="h-full" style={{ width: `${pct}%`, background: complete ? 'var(--nr-green)' : 'var(--nr-orange)' }} />
              </div>
              <span className="numeric-mono text-[10px]" style={{ color: complete ? 'var(--nr-green)' : 'var(--ink-300)' }}>
                {group.totalReviewed}/{group.totalIncidents}
              </span>
            </div>
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-[var(--line)]" style={{ background: 'var(--bg-card)' }}>
          {group.days.map(d => (
            <ReviewDayRow
              key={d.date}
              day={d}
              reviewByIncidentId={reviewByIncidentId}
              teamMembersByIncidentId={teamMembersByIncidentId}
              onSave={onSave}
              onDelete={onDelete}
              canSave={canSave}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ReviewDayRow({
  day, reviewByIncidentId, teamMembersByIncidentId, onSave, onDelete, canSave,
}: {
  day: ReviewPeriodDay
  reviewByIncidentId: Map<string, IncidentReview>
  teamMembersByIncidentId: Map<string, IncidentTeamMember[]>
  onSave: (input: IncidentReviewInput, incidentStart: string | null) => Promise<void>
  onDelete: (incidentId: string) => Promise<void>
  canSave: boolean
}) {
  const [open, setOpen] = useState(false)
  const complete = day.incidentCount > 0 && day.reviewedCount >= day.incidentCount

  const uniques = day.incidents.filter(i => !i.is_continuation)
                                .sort((a, b) => (a.incident_start || '').localeCompare(b.incident_start || ''))

  return (
    <div className="border-b border-[var(--line)] last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-6 py-2 text-left hover:bg-[var(--bg-card-hi)] transition-colors text-xs"
      >
        <ChevronDown size={12} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s', color: 'var(--ink-400)' }} />
        <span className="numeric-mono shrink-0" style={{ color: 'var(--ink-100)' }}>{formatDayLabel(day.date)}</span>
        <span className="label-micro" style={{ color: 'var(--nr-orange)' }}>{day.weekLabel}</span>
        <span className="label-micro" style={{ color: 'var(--ink-500)' }}>{day.incidentCount} incident{day.incidentCount !== 1 ? 's' : ''}</span>
        <span className="label-micro" style={{ color: 'var(--ink-500)' }}>{fmtMins(day.totalDelay)} delay</span>
        <span className="ml-auto numeric-mono text-[10px]" style={{ color: complete ? 'var(--nr-green)' : 'var(--ink-400)' }}>
          {day.reviewedCount}/{day.incidentCount} reviewed
        </span>
      </button>

      {open && (
        <div className="px-6 pb-3 space-y-2">
          {uniques.length === 0 ? (
            <div className="text-[11px] py-2" style={{ color: 'var(--ink-500)' }}>No primary incidents on this day.</div>
          ) : (
            uniques.map(inc => (
              <ReviewIncidentRow
                key={inc.id}
                incident={inc}
                review={reviewByIncidentId.get(inc.id)}
                teamMembers={teamMembersByIncidentId.get(inc.id) ?? []}
                onSave={onSave}
                onDelete={onDelete}
                canSave={canSave}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function ReviewIncidentRow({
  incident, review, teamMembers, onSave, onDelete, canSave,
}: {
  incident: IncidentRow
  review: IncidentReview | undefined
  teamMembers: IncidentTeamMember[]
  onSave: (input: IncidentReviewInput, incidentStart: string | null) => Promise<void>
  onDelete: (incidentId: string) => Promise<void>
  canSave: boolean
}) {
  const [open, setOpen] = useState(false)
  const cfg = CATEGORY_CONFIG[incident.category]
  const reviewed = !!review
  const cls = review?.incident_classification ?? null

  return (
    <div className="rounded border border-[var(--line)] overflow-hidden" style={{ background: 'var(--bg-card)' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-start gap-3 px-3 py-2.5 text-left text-xs hover:bg-[var(--bg-card-hi)] transition-colors"
      >
        <ChevronDown size={11} className="mt-1" style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s', color: 'var(--ink-400)' }} />
        <span className={`pill pill-${incident.severity.toLowerCase()} shrink-0`}>{incident.severity}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            {incident.ccil && <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>CCIL {incident.ccil}</span>}
            {incident.incident_start && <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-400)' }}>{incident.incident_start}</span>}
            <span className="pill text-[9px]" style={{ background: `${cfg.color}20`, color: cfg.color, borderColor: `${cfg.color}50` }}>
              {cfg.short}
            </span>
            {incident.area && <span className="text-[10px]" style={{ color: 'var(--ink-400)' }}>{incident.area}</span>}
          </div>
          <div className="font-medium truncate" style={{ color: 'var(--ink-200)' }}>
            {review?.title_override ?? incident.title ?? '—'}
          </div>
          {(review?.location_override || incident.location) && (
            <div className="text-[10px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
              {review?.location_override ?? incident.location}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {cls && <ClassificationPill value={cls} />}
          {reviewed
            ? <span className="pill text-[9px]" style={{ background: 'rgba(39, 174, 96, 0.12)', color: 'var(--nr-green)', borderColor: 'rgba(39, 174, 96, 0.4)' }}><ClipboardCheck size={9} /> Reviewed</span>
            : <span className="pill text-[9px]" style={{ background: 'rgba(122, 139, 168, 0.12)', color: 'var(--ink-400)', borderColor: 'var(--line)' }}>Pending</span>}
          <div className="text-right w-16">
            <div className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>DELAY</div>
            <div className="numeric-mono text-[11px]" style={{ color: 'var(--nr-orange)' }}>
              {(review?.minutes_delay_override ?? incident.minutes_delay)}m
            </div>
          </div>
        </div>
      </button>

      {open && (
        <ReviewForm
          incident={incident}
          review={review}
          teamMembers={teamMembers}
          onSave={onSave}
          onDelete={onDelete}
          canSave={canSave}
        />
      )}
    </div>
  )
}

function ClassificationPill({ value }: { value: IncidentClassification }) {
  const cfg = CLASSIFICATION_CONFIG[value]
  return (
    <span className="pill text-[9px] font-bold" style={{ background: cfg.color, color: cfg.textColor, borderColor: cfg.color }}>
      {cfg.label.toUpperCase()}
    </span>
  )
}

// Form rendered when an incident is expanded. Top section is read-only CCIL
// detail; below is the editable SNDM review form (all optional) and a
// "Refine CCIL" disclosure for overriding captured values.
function ReviewForm({
  incident, review, teamMembers, onSave, onDelete, canSave,
}: {
  incident: IncidentRow
  review: IncidentReview | undefined
  teamMembers: IncidentTeamMember[]
  onSave: (input: IncidentReviewInput, incidentStart: string | null) => Promise<void>
  onDelete: (incidentId: string) => Promise<void>
  canSave: boolean
}) {
  type FormState = Omit<IncidentReviewInput, 'incident_id' | 'report_date'>

  const initial: FormState = useMemo(() => ({
    technical_conference_outcome: review?.technical_conference_outcome ?? null,
    commentary: review?.commentary ?? null,
    stranded_trains_occurred: review?.stranded_trains_occurred ?? null,
    stranded_trains: review?.stranded_trains ?? null,
    itsr_required: review?.itsr_required ?? null,
    time_huddle_held: review?.time_huddle_held ?? null,
    incident_classification: review?.incident_classification ?? null,
    mom_responded: review?.mom_responded ?? null,
    mom_depot: review?.mom_depot ?? null,
    mom_response_time: review?.mom_response_time ?? null,
    first_50_30min_target_met: review?.first_50_30min_target_met ?? null,
    target_recovery_time: review?.target_recovery_time ?? null,
    actual_recovery_time: review?.actual_recovery_time ?? null,
    title_override: review?.title_override ?? null,
    location_override: review?.location_override ?? null,
    area_override: review?.area_override ?? null,
    minutes_delay_override: review?.minutes_delay_override ?? null,
    trains_delayed_override: review?.trains_delayed_override ?? null,
    cancelled_override: review?.cancelled_override ?? null,
    part_cancelled_override: review?.part_cancelled_override ?? null,
    notes: review?.notes ?? null,
    reviewed_by: review?.reviewed_by ?? null,
  }), [review])

  const [form, setForm] = useState<FormState>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showOverrides, setShowOverrides] = useState(false)

  useEffect(() => { setForm(initial); setError(null) }, [initial])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(prev => ({ ...prev, [k]: v }))

  // Period / week derived from incident.report_date (read-only)
  const railPeriod = useMemo(() => railwayPeriodWeek(incident.report_date), [incident.report_date])

  const liveTimeToRecover = useMemo(() => {
    if (!incident.incident_start || !form.actual_recovery_time) return null
    return minsBetweenHHMM(incident.incident_start, form.actual_recovery_time)
  }, [incident.incident_start, form.actual_recovery_time])

  // Stranded-trains array editing
  const strandedList: StrandedTrainEntry[] = (form.stranded_trains as StrandedTrainEntry[] | null | undefined) ?? []
  const updateStrandedTrain = (idx: number, patch: Partial<StrandedTrainEntry>) => {
    const next = strandedList.map((entry, i) => i === idx ? { ...entry, ...patch } : entry)
    set('stranded_trains', next)
  }
  const addStrandedTrain = () => {
    const next = [...strandedList, { headcode: null, location: null, time_stranded: null, time_moved: null }]
    set('stranded_trains', next)
  }
  const removeStrandedTrain = (idx: number) => {
    const next = strandedList.filter((_, i) => i !== idx)
    set('stranded_trains', next.length ? next : null)
  }
  // Seed one row automatically when SNDM selects YES with no entries yet
  useEffect(() => {
    if (form.stranded_trains_occurred === 'YES' && strandedList.length === 0) {
      set('stranded_trains', [{ headcode: null, location: null, time_stranded: null, time_moved: null }])
    }
    if (form.stranded_trains_occurred && form.stranded_trains_occurred !== 'YES') {
      if (strandedList.length > 0) set('stranded_trains', null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.stranded_trains_occurred])

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true); setError(null)
    try {
      const cleaned: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(form)) {
        cleaned[k] = v === '' ? null : v
      }
      // Drop any stranded entries that are completely blank so we don't
      // persist empty objects
      if (Array.isArray(cleaned.stranded_trains)) {
        const arr = (cleaned.stranded_trains as StrandedTrainEntry[]).filter(
          e => e && (e.headcode || e.location || e.time_stranded || e.time_moved),
        )
        cleaned.stranded_trains = arr.length ? arr : null
      }
      await onSave(
        { incident_id: incident.id, report_date: incident.report_date, ...cleaned },
        incident.incident_start,
      )
    } catch (e: any) {
      setError(e?.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    if (!canSave || !review) return
    if (!confirm('Remove this review? The CCIL row will remain untouched.')) return
    setSaving(true); setError(null)
    try {
      await onDelete(incident.id)
      setForm(initial)
    } catch (e: any) {
      setError(e?.message || 'Failed to remove review')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border-t border-[var(--line)] p-4 text-xs space-y-5" style={{ background: 'var(--bg-card-hi)' }}>
      <CcilDetailBlock incident={incident} />

      {teamMembers.length > 0 && (
        <div className="border-t border-[var(--line)] pt-4">
          <div className="label-micro mb-2" style={{ color: 'var(--ink-400)' }}>Team on Duty</div>
          <div className="flex flex-wrap gap-2">
            {teamMembers.map(m => (
              <div key={m.id} className="flex items-center gap-1.5 rounded border border-[var(--line)] px-2 py-1" style={{ background: 'var(--bg-card)' }}>
                <span className="font-medium" style={{ color: 'var(--ink-100)' }}>{m.name}</span>
                <span style={{ color: 'var(--ink-400)' }}>·</span>
                <span style={{ color: 'var(--ink-300)' }}>{m.role}</span>
                <span
                  className="pill text-[9px] ml-1"
                  style={m.shift === 'day'
                    ? { background: 'rgba(243,156,18,0.12)', color: 'var(--nr-amber)', borderColor: 'rgba(243,156,18,0.3)' }
                    : { background: 'rgba(74,111,165,0.12)', color: 'var(--nr-blue)', borderColor: 'rgba(74,111,165,0.3)' }}
                >
                  {m.shift}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-[var(--line)] pt-4 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h4 className="label-micro" style={{ color: 'var(--nr-orange)' }}>SNDM Review · all fields optional</h4>
          {review?.reviewed_at && (
            <span className="numeric-mono text-[9px]" style={{ color: 'var(--ink-500)' }}>
              Last saved {new Date(review.reviewed_at).toLocaleString()}
              {review.reviewed_by ? ` · ${review.reviewed_by}` : ''}
            </span>
          )}
        </div>

        {/* Row 1 — Period / Week (derived from railway calendar, read-only) */}
        <FieldGroup>
          <Field label="Period">
            <ReadOnlyValue value={`${railPeriod.label.split(' · ')[0]} (${railPeriod.yearLabel})`} hint="Railway calendar · from report date" />
          </Field>
          <Field label="Week">
            <ReadOnlyValue value={`W${railPeriod.week}`} hint="13 periods × 4 weeks" />
          </Field>
        </FieldGroup>

        {/* Row 2 — Technical conference */}
        <FieldGroup label="Technical Conference">
          <Field label="Conference Held?">
            <YesNoNaSelect value={form.technical_conference_outcome} onChange={v => set('technical_conference_outcome', v)} />
          </Field>
          {(form.technical_conference_outcome === 'YES' || form.technical_conference_outcome === 'NO') && (
            <div className="sm:col-span-2 lg:col-span-3">
              <Field label={form.technical_conference_outcome === 'YES' ? 'Commentary (statement supporting the YES decision)' : 'Commentary (statement supporting the NO decision)'}>
                <textarea
                  className="input"
                  rows={2}
                  value={form.commentary ?? ''}
                  onChange={e => set('commentary', e.target.value)}
                  placeholder="Record the statement against the decision…"
                />
              </Field>
            </div>
          )}
        </FieldGroup>

        {/* Row 3 — Stranded trains */}
        <FieldGroup label="Stranded Trains">
          <Field label="Trains Stranded?">
            <YesNoNaSelect value={form.stranded_trains_occurred} onChange={v => set('stranded_trains_occurred', v)} />
          </Field>
          {form.stranded_trains_occurred === 'YES' && (
            <div className="sm:col-span-2 lg:col-span-3 space-y-2">
              {strandedList.map((entry, idx) => (
                <div key={idx} className="border border-[var(--line)] rounded-sm p-3" style={{ background: 'var(--bg-card)' }}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="label-micro text-[9px]" style={{ color: 'var(--ink-400)' }}>Train #{idx + 1}</span>
                    <button type="button" onClick={() => removeStrandedTrain(idx)} className="btn !py-1 !px-2"><X size={10} /> Remove</button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <Field label="Headcode">
                      <input className="input" value={entry.headcode ?? ''} onChange={e => updateStrandedTrain(idx, { headcode: e.target.value.toUpperCase() || null })} placeholder="e.g. 1B23" />
                    </Field>
                    <Field label="Location">
                      <input className="input" value={entry.location ?? ''} onChange={e => updateStrandedTrain(idx, { location: e.target.value || null })} placeholder="Where stranded" />
                    </Field>
                    <Field label="Time Stranded">
                      <input className="input" type="time" value={entry.time_stranded ?? ''} onChange={e => updateStrandedTrain(idx, { time_stranded: e.target.value || null })} />
                    </Field>
                    <Field label="Time Moved">
                      <input className="input" type="time" value={entry.time_moved ?? ''} onChange={e => updateStrandedTrain(idx, { time_moved: e.target.value || null })} />
                    </Field>
                  </div>
                </div>
              ))}
              <button type="button" onClick={addStrandedTrain} className="btn">+ Add Train</button>
            </div>
          )}
        </FieldGroup>

        {/* Row 4 — ITSR */}
        <FieldGroup label="ITSR">
          <Field label="ITSR Required?">
            <YesNoNaSelect value={form.itsr_required} onChange={v => set('itsr_required', v)} />
          </Field>
          {form.itsr_required === 'YES' && (
            <Field label="Time Huddle Held">
              <input className="input" type="time" value={form.time_huddle_held ?? ''} onChange={e => set('time_huddle_held', e.target.value || null)} />
            </Field>
          )}
        </FieldGroup>

        {/* Row 5 — Incident classification */}
        <FieldGroup label="Incident Classification">
          <div className="col-span-full flex gap-2 flex-wrap">
            {(Object.keys(CLASSIFICATION_CONFIG) as IncidentClassification[]).map(k => {
              const cfg = CLASSIFICATION_CONFIG[k]
              const active = form.incident_classification === k
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => set('incident_classification', active ? null : k)}
                  className="px-3 py-1.5 rounded-sm text-[10px] font-bold tracking-wider uppercase transition-all"
                  style={{
                    background: active ? cfg.color : 'transparent',
                    color: active ? cfg.textColor : cfg.color,
                    border: `1px solid ${cfg.color}`,
                    boxShadow: active ? `0 0 12px ${cfg.color}80` : 'none',
                    fontFamily: 'JetBrains Mono, monospace',
                  }}
                >
                  {cfg.label}
                </button>
              )
            })}
          </div>
        </FieldGroup>

        {/* Row 6 — MOM response */}
        <FieldGroup label="MOM Response">
          <Field label="MOM Responded?">
            <YesNoNaSelect value={form.mom_responded} onChange={v => set('mom_responded', v)} />
          </Field>
          {form.mom_responded === 'YES' && (
            <>
              <Field label="Depot">
                <select
                  className="select"
                  value={form.mom_depot ?? ''}
                  onChange={e => set('mom_depot', (e.target.value || null) as MomDepot | null)}
                >
                  <option value="">—</option>
                  {(Object.keys(MOM_DEPOT_LABELS) as MomDepot[]).map(code => (
                    <option key={code} value={code}>{MOM_DEPOT_LABELS[code]}</option>
                  ))}
                </select>
              </Field>
              <Field label="Response Time">
                <input className="input" type="time" value={form.mom_response_time ?? ''} onChange={e => set('mom_response_time', e.target.value || null)} />
              </Field>
              <Field label="First 50 — 30min target">
                <select className="select" value={form.first_50_30min_target_met ?? ''} onChange={e => set('first_50_30min_target_met', (e.target.value || null) as First50Outcome | null)}>
                  <option value="">—</option>
                  <option value="YES">Yes</option>
                  <option value="NO">No</option>
                  <option value="NA">N/A</option>
                </select>
              </Field>
            </>
          )}
        </FieldGroup>

        {/* Row 7 — Recovery */}
        <FieldGroup label="Recovery">
          <Field label="Target Recovery Time">
            <input className="input" type="time" value={form.target_recovery_time ?? ''} onChange={e => set('target_recovery_time', e.target.value || null)} />
          </Field>
          <Field label="Actual Recovery Time">
            <input className="input" type="time" value={form.actual_recovery_time ?? ''} onChange={e => set('actual_recovery_time', e.target.value || null)} />
          </Field>
          <Field label="Time to Recover">
            <ReadOnlyValue
              value={liveTimeToRecover != null ? fmtMins(liveTimeToRecover) : '—'}
              hint="Auto from incident start → actual recovery"
            />
          </Field>
        </FieldGroup>

        {/* Notes */}
        <Field label="Additional Notes">
          <textarea className="input w-full" rows={2} value={form.notes ?? ''} onChange={e => set('notes', e.target.value)} placeholder="Anything else worth recording" />
        </Field>

        {/* Refine CCIL overrides */}
        <div className="border border-[var(--line)] rounded-sm">
          <button
            type="button"
            onClick={() => setShowOverrides(v => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-left"
          >
            <span className="label-micro">Refine CCIL Capture</span>
            <span className="flex items-center gap-2">
              <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>
                Override any captured field — original row stays intact
              </span>
              <ChevronDown size={12} style={{ transform: showOverrides ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', color: 'var(--ink-400)' }} />
            </span>
          </button>
          {showOverrides && (
            <div className="px-3 pb-3 pt-2 space-y-3 border-t border-[var(--line)]">
              <FieldGroup>
                <Field label={`Title  (CCIL: ${incident.title ?? '—'})`}>
                  <input className="input" value={form.title_override ?? ''} onChange={e => set('title_override', e.target.value)} placeholder={incident.title ?? ''} />
                </Field>
              </FieldGroup>
              <FieldGroup>
                <Field label={`Location  (CCIL: ${incident.location ?? '—'})`}>
                  <input className="input" value={form.location_override ?? ''} onChange={e => set('location_override', e.target.value)} placeholder={incident.location ?? ''} />
                </Field>
                <Field label={`Area  (CCIL: ${incident.area ?? '—'})`}>
                  <input className="input" value={form.area_override ?? ''} onChange={e => set('area_override', e.target.value)} placeholder={incident.area ?? ''} />
                </Field>
              </FieldGroup>
              <FieldGroup>
                <Field label={`Delay (mins)  (CCIL: ${incident.minutes_delay})`}>
                  <input className="input" type="number" min={0} value={form.minutes_delay_override ?? ''} onChange={e => set('minutes_delay_override', e.target.value === '' ? null : Number(e.target.value))} placeholder={String(incident.minutes_delay)} />
                </Field>
                <Field label={`Trains Delayed  (CCIL: ${incident.trains_delayed})`}>
                  <input className="input" type="number" min={0} value={form.trains_delayed_override ?? ''} onChange={e => set('trains_delayed_override', e.target.value === '' ? null : Number(e.target.value))} placeholder={String(incident.trains_delayed)} />
                </Field>
                <Field label={`Cancelled  (CCIL: ${incident.cancelled})`}>
                  <input className="input" type="number" min={0} value={form.cancelled_override ?? ''} onChange={e => set('cancelled_override', e.target.value === '' ? null : Number(e.target.value))} placeholder={String(incident.cancelled)} />
                </Field>
                <Field label={`Part Cancelled  (CCIL: ${incident.part_cancelled})`}>
                  <input className="input" type="number" min={0} value={form.part_cancelled_override ?? ''} onChange={e => set('part_cancelled_override', e.target.value === '' ? null : Number(e.target.value))} placeholder={String(incident.part_cancelled)} />
                </Field>
              </FieldGroup>
            </div>
          )}
        </div>

        <FieldGroup>
          <Field label="Reviewed By">
            <input className="input" value={form.reviewed_by ?? ''} onChange={e => set('reviewed_by', e.target.value)} placeholder="Your initials" />
          </Field>
        </FieldGroup>

        {error && (
          <div className="text-xs px-3 py-2 rounded-sm" style={{ background: 'rgba(231,76,60,0.1)', color: 'var(--nr-red)', border: '1px solid rgba(231,76,60,0.4)' }}>
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-2 border-t border-[var(--line)]">
          <div className="text-[10px]" style={{ color: 'var(--ink-500)' }}>
            {canSave ? 'Saves immediately to the incident_reviews table' : 'Saves disabled — Supabase not configured or demo data'}
          </div>
          <div className="flex items-center gap-2">
            {review && (
              <button type="button" onClick={handleClear} disabled={!canSave || saving} className="btn">
                Remove Review
              </button>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave || saving}
              className="btn btn-active"
            >
              {saving ? 'Saving…' : review ? 'Save Changes' : 'Save Review'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CcilDetailBlock({ incident }: { incident: IncidentRow }) {
  const rows: { label: string; value: string | null }[] = [
    { label: 'CCIL Reference',   value: incident.ccil ?? null },
    { label: 'Report Date',      value: incident.report_date },
    { label: 'Incident Start',   value: incident.incident_start ?? null },
    { label: 'Category',         value: CATEGORY_CONFIG[incident.category]?.label ?? incident.category },
    { label: 'Type',             value: incident.incident_type_label ?? incident.incident_type_code ?? null },
    { label: 'Severity',         value: incident.severity },
    { label: 'Title',            value: incident.title ?? null },
    { label: 'Location',         value: incident.location ?? null },
    { label: 'Area',             value: incident.area ?? null },
    { label: 'Line',             value: incident.line ?? null },
    { label: 'Fault Number',     value: incident.fault_number ?? null },
    { label: 'Train ID',         value: incident.train_id ?? null },
    { label: 'Operator',         value: incident.train_company ?? null },
    { label: 'Origin → Dest',    value: incident.train_origin || incident.train_destination ? `${incident.train_origin ?? '—'} → ${incident.train_destination ?? '—'}` : null },
    { label: 'Unit Numbers',     value: incident.unit_numbers?.length ? incident.unit_numbers.join(', ') : null },
    { label: 'Delay (min)',      value: incident.minutes_delay != null ? String(incident.minutes_delay) : null },
    { label: 'Trains Delayed',   value: incident.trains_delayed != null ? String(incident.trains_delayed) : null },
    { label: 'Cancelled',        value: incident.cancelled != null ? String(incident.cancelled) : null },
    { label: 'Part Cancelled',   value: incident.part_cancelled != null ? String(incident.part_cancelled) : null },
    { label: 'Advised',          value: incident.advised_time ?? null },
    { label: 'Initial Response', value: incident.initial_resp_time ?? null },
    { label: 'Arrived',          value: incident.arrived_at_time ?? null },
    { label: 'NWR',              value: incident.nwr_time ?? null },
    { label: 'Duration (min)',   value: incident.incident_duration != null ? String(incident.incident_duration) : null },
    { label: 'Responders',       value: incident.responder_initials?.length ? incident.responder_initials.join(' ') : null },
    { label: 'TRUST Ref',        value: incident.trust_ref ?? null },
    { label: 'TDA Ref',          value: incident.tda_ref ?? null },
    { label: 'TRMC Code',        value: incident.trmc_code ?? null },
    { label: 'Possession',       value: incident.possession_ref ?? null },
    { label: 'BTP Ref',          value: incident.btp_ref ?? null },
    { label: 'Third-Party Ref',  value: incident.third_party_ref ?? null },
  ]

  const populated = rows.filter(r => r.value && r.value.trim() !== '')

  return (
    <div>
      <h4 className="label-micro mb-3" style={{ color: 'var(--ink-300)' }}>CCIL Captured Detail</h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2">
        {populated.map(r => (
          <div key={r.label} className="flex items-start gap-2">
            <span className="label-micro text-[9px] shrink-0 w-32 truncate pt-0.5" title={r.label}>{r.label}</span>
            <span className="text-[11px] break-words" style={{ color: 'var(--ink-200)' }}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label-micro text-[9px]">{label}</span>
      {children}
    </label>
  )
}

function YesNoNaSelect({ value, onChange }: { value: YesNoNa | null | undefined; onChange: (v: YesNoNa | null) => void }) {
  return (
    <select
      className="select"
      value={value ?? ''}
      onChange={e => onChange((e.target.value || null) as YesNoNa | null)}
    >
      <option value="">—</option>
      <option value="YES">Yes</option>
      <option value="NO">No</option>
      <option value="NA">N/A</option>
    </select>
  )
}

function ReadOnlyValue({ value, hint }: { value: string; hint?: string }) {
  return (
    <div
      className="input flex items-center justify-between"
      style={{ background: 'var(--bg-card)', color: 'var(--ink-200)', cursor: 'default' }}
    >
      <span className="numeric-mono">{value}</span>
      {hint && <span className="label-micro text-[9px] ml-3 truncate" style={{ color: 'var(--ink-500)' }}>{hint}</span>}
    </div>
  )
}

function FieldGroup({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div>
      {label && <div className="label-micro text-[10px] mb-2" style={{ color: 'var(--nr-orange)' }}>{label}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">{children}</div>
    </div>
  )
}

function formatDayLabel(iso: string): string {
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getUTCDay()]
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]
  return `${dow} ${Number(d)} ${mon} ${y}`
}

function minsBetweenHHMM(start: string, end: string): number | null {
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    return isNaN(h) || isNaN(m) ? null : h * 60 + m
  }
  const s = toMin(start); const e = toMin(end)
  if (s == null || e == null) return null
  return e >= s ? e - s : e + 1440 - s
}

// ─── Reports Tab ─────────────────────────────────────────────────────────────
// Aesthetically-styled, insight-rich PDF reports generated client-side. Each
// template owns its own date scope independently of the dashboard's filter
// bar — Period reports are locked to railway periods, Weekly briefs to
// railway weeks, and Safety / Custom Range expose a free from–to picker.
// The dashboard's category / area / severity / search filters still apply.

type ReportScope =
  | { kind: 'period';  railYear: number; period: number; from: string; to: string }
  | { kind: 'weekly';  railYear: number; period: number; week: number; from: string; to: string }
  | { kind: 'range';   from: string; to: string }

function daysBetween(from: string, to: string): number {
  const fromMs = new Date(from + 'T00:00:00Z').getTime()
  const toMs   = new Date(to   + 'T00:00:00Z').getTime()
  return Math.max(1, Math.round((toMs - fromMs) / 86_400_000) + 1)
}

function yesterdayISO(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
}

function isoMinusDays(iso: string, days: number): string {
  const ms = new Date(iso + 'T00:00:00Z').getTime() - days * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

function ReportsTab({ data, filters, demoMode }: { data: RawData | null; filters: AnalyticsFilters; demoMode: boolean }) {
  const [template, setTemplate]    = useState<ReportTemplate>('period')
  const [sections, setSections]    = useState<ReportSectionId[]>(TEMPLATE_DEFAULT_SECTIONS['period'])
  const [appendixLimit, setAppendixLimit] = useState<number>(40)
  const [previewKey, setPreviewKey] = useState<number>(0)

  // Per-template scope state, kept side-by-side so switching template doesn't
  // wipe a careful selection in another. Initialised to sensible defaults:
  // the last completed period / week, and the previous 30 days for range
  // templates.
  const [periodSel, setPeriodSel] = useState(() => {
    const d = defaultPeriodSelection()
    const b = railwayPeriodBounds(d.period, d.railYear)
    return { railYear: d.railYear, period: d.period, from: b.from, to: b.to }
  })
  const [weekSel, setWeekSel] = useState(() => {
    const d = defaultWeekSelection()
    const b = railwayWeekBounds(d.period, d.week, d.railYear)
    return { railYear: d.railYear, period: d.period, week: d.week, from: b.from, to: b.to }
  })
  const [safetyRange, setSafetyRange] = useState<{ from: string; to: string }>(() => ({
    from: isoMinusDays(yesterdayISO(), 29),
    to:   yesterdayISO(),
  }))
  const [customRange, setCustomRange] = useState<{ from: string; to: string }>(() => ({
    from: isoMinusDays(yesterdayISO(), 29),
    to:   yesterdayISO(),
  }))

  const scope: ReportScope = useMemo(() => {
    if (template === 'period') return { kind: 'period', ...periodSel }
    if (template === 'weekly') return { kind: 'weekly', ...weekSel }
    if (template === 'safety') return { kind: 'range', ...safetyRange }
    return { kind: 'range', ...customRange }
  }, [template, periodSel, weekSel, safetyRange, customRange])

  // Reset section toggles whenever the template changes.
  useEffect(() => { setSections(TEMPLATE_DEFAULT_SECTIONS[template]) }, [template])

  // ── Independent data fetch for the report's chosen scope ──────────────────
  // The dashboard's data covers a different window most of the time, so the
  // Reports tab fires its own fetch (or synth) keyed on scope + non-date
  // filters. Mirrors fetchAnalytics so all the usual category / area filters
  // still apply.
  const [reportData, setReportData] = useState<RawData | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)

  // Stable signature of the non-date filters so we only re-fetch when
  // something genuinely changes — avoids hammering Supabase on every render.
  const filterSig = useMemo(() => JSON.stringify({
    areas: filters.areas, categories: filters.categories, severities: filters.severities,
    incidentTypes: filters.incidentTypes, staffNames: filters.staffNames,
    searches: filters.searches, searchMode: filters.searchMode,
    minDelay: filters.minDelay, maxDelay: filters.maxDelay,
  }), [filters])

  useEffect(() => {
    let cancelled = false
    const days = daysBetween(scope.from, scope.to)

    async function run() {
      setLoadingReport(true)
      setReportError(null)
      try {
        if (!isSupabaseConfigured() || demoMode) {
          // Demo mode: regenerate synthetic data sized to the chosen window
          // so the preview always has something to draw against.
          const result = generateSyntheticData(days, 42, scope.from, scope.to)
          if (!cancelled) setReportData(result)
          return
        }
        const reportFilters: AnalyticsFilters = {
          ...filters,
          startDate: scope.from,
          endDate:   scope.to,
          windowDays: days,
        }
        const result = await fetchAnalytics(reportFilters)
        if (cancelled) return
        if (result) setReportData(result)
        else setReportData(generateSyntheticData(days, 42, scope.from, scope.to))
      } catch (e: any) {
        if (!cancelled) {
          setReportError(e?.message || 'Failed to load report data')
          setReportData(generateSyntheticData(days, 42, scope.from, scope.to))
        }
      } finally {
        if (!cancelled) setLoadingReport(false)
      }
    }
    run()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.from, scope.to, filterSig, demoMode])

  const filtersDescriptor = useMemo(() => describeFilters(filters), [filters])

  const plan = useMemo(() => {
    if (!reportData) return null
    return buildReportPlan(
      {
        filtersDescriptor,
        windowFrom:    reportData.windowFrom,
        windowTo:      reportData.windowTo,
        windowDays:    reportData.windowDays,
        demoMode:      demoMode || !isSupabaseConfigured(),
        incidents:     reportData.incidents,
        prevIncidents: reportData.prevIncidents,
      },
      { template, sections, appendixLimit, clientLine: 'Network Rail · EMCC', preparedBy: 'EMCC Insight' },
    )
  }, [reportData, filtersDescriptor, demoMode, template, sections, appendixLimit])

  const html = useMemo(() => plan ? renderReportDocument(plan) : '', [plan])

  useEffect(() => { setPreviewKey(k => k + 1) }, [html])

  const handlePrint = () => {
    if (!plan) return
    openPrintWindow(html, `${plan.meta.templateName} · ${plan.meta.scopeLabel}`)
  }
  const handleDownload = () => {
    if (!plan) return
    downloadHtml(html, reportFilename(plan.meta.template, plan.meta.scopeLabel))
  }

  const toggleSection = (id: ReportSectionId) => {
    setSections(prev => prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id])
  }

  if (!data) {
    return (
      <Card title="Reports" subtitle="Generate aesthetically styled, data-driven PDF reports">
        <div className="flex items-center justify-center py-12" style={{ color: 'var(--ink-400)' }}>
          <RefreshCw size={14} className="animate-spin mr-2" /> Waiting for data…
        </div>
      </Card>
    )
  }

  const incidentsCovered = reportData?.incidents.filter(i => !i.is_continuation).length ?? 0

  return (
    <div className="space-y-6">
      <Card
        title="Report Builder"
        subtitle="Pick a template, lock in the window, then print or archive the editorial PDF"
        className="tick-corners"
        right={
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownload}
              className="btn"
              disabled={!plan}
              title="Download as standalone HTML (open and print to PDF later)"
            >
              <Download size={12} /> Save HTML
            </button>
            <button
              onClick={handlePrint}
              className="btn btn-active"
              disabled={!plan}
              title="Open in a new tab and bring up the print dialog (choose Save as PDF)"
            >
              <FileText size={12} /> Print / Save PDF
            </button>
          </div>
        }
      >
        {/* Template picker */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {REPORT_TEMPLATES.map(t => {
            const active = template === t.id
            return (
              <button
                key={t.id}
                onClick={() => setTemplate(t.id)}
                className={`text-left p-4 rounded-sm transition-colors ${active ? 'border-2' : 'border'}`}
                style={{
                  background:   active ? 'var(--nr-orange-glow)' : 'var(--bg-card-hi)',
                  borderColor:  active ? 'var(--nr-orange)' : 'var(--line)',
                }}
              >
                <div className="label-micro mb-2" style={{ color: active ? 'var(--nr-orange)' : 'var(--ink-400)' }}>
                  {t.subtitle}
                </div>
                <div className="serif text-base mb-1" style={{ color: 'var(--ink-100)' }}>{t.name}</div>
                <div className="text-[11px] leading-snug" style={{ color: 'var(--ink-400)' }}>{t.tagline}</div>
              </button>
            )
          })}
        </div>

        {/* Per-template scope picker */}
        <ScopePicker
          template={template}
          periodSel={periodSel}      setPeriodSel={setPeriodSel}
          weekSel={weekSel}          setWeekSel={setWeekSel}
          safetyRange={safetyRange}  setSafetyRange={setSafetyRange}
          customRange={customRange}  setCustomRange={setCustomRange}
        />

        {/* Section toggles */}
        <div className="border-t border-[var(--line)] pt-4 mb-5 mt-5">
          <div className="flex items-baseline justify-between mb-3">
            <div className="label-micro">Sections in this report</div>
            <button
              onClick={() => setSections(TEMPLATE_DEFAULT_SECTIONS[template])}
              className="text-[10px] tracking-wider uppercase hover:text-[var(--ink-100)] transition-colors"
              style={{ color: 'var(--ink-400)' }}
            >
              Reset to template default
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['cover', 'executive', 'kpis', 'trend', 'categoryMix', 'geography', 'patterns', 'safetyRadar', 'assets', 'attribution', 'signals', 'narrative', 'appendix'] as ReportSectionId[]).map(s => {
              const on = sections.includes(s)
              return (
                <button
                  key={s}
                  onClick={() => toggleSection(s)}
                  className={`text-[10.5px] tracking-wider uppercase px-2.5 py-1.5 rounded-sm transition-colors font-mono`}
                  style={{
                    background:   on ? 'var(--nr-orange-glow)' : 'var(--bg-card)',
                    border:       `1px solid ${on ? 'var(--nr-orange)' : 'var(--line)'}`,
                    color:        on ? 'var(--ink-100)' : 'var(--ink-400)',
                  }}
                >
                  {on ? '✓ ' : ''}{SECTION_LABELS[s]}
                </button>
              )
            })}
          </div>
        </div>

        {/* Status row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-2 text-xs">
          <div>
            <div className="label-micro mb-1.5">Resolved window</div>
            <div style={{ color: 'var(--ink-200)' }}>
              {plan?.meta.scopeLabel ?? `${scope.from} → ${scope.to}`}
            </div>
            <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
              {loadingReport
                ? 'Loading data for this window…'
                : `${incidentsCovered} incident${incidentsCovered === 1 ? '' : 's'} in scope · ${daysBetween(scope.from, scope.to)}-day window`}
            </div>
          </div>
          <div>
            <div className="label-micro mb-1.5">Filters from dashboard</div>
            <div style={{ color: 'var(--ink-200)' }}>{filtersDescriptor}</div>
            <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
              Category / area / severity filters carry across — change them from the main filter bar.
            </div>
          </div>
          <div>
            <div className="label-micro mb-1.5">Appendix limit</div>
            <select
              value={appendixLimit}
              onChange={e => setAppendixLimit(Number(e.target.value))}
              className="select w-full"
            >
              {[10, 20, 40, 60, 100].map(n => (
                <option key={n} value={n}>Top {n} incidents</option>
              ))}
            </select>
          </div>
        </div>

        {reportError && (
          <div className="mt-4 text-[11px] px-3 py-2" style={{
            color: '#FF8077',
            background: 'rgba(231, 76, 60, 0.08)',
            border: '1px solid rgba(231, 76, 60, 0.3)',
          }}>{reportError}</div>
        )}
      </Card>

      {/* Live preview */}
      <Card
        title="Live preview"
        subtitle="Exact A4-portrait rendering of the report. What you see is what prints."
        right={
          <div className="label-micro flex items-center gap-3" style={{ color: 'var(--ink-400)' }}>
            {loadingReport && <RefreshCw size={11} className="animate-spin" />}
            <span>
              {sections.filter(s => s !== 'cover').length + (sections.includes('cover') ? 1 : 0)} pages · {plan?.meta.windowDays ?? 0} day window
            </span>
          </div>
        }
      >
        <div
          className="w-full rounded-sm overflow-hidden"
          style={{
            height: 920,
            background: '#E8E1CF',
            border: '1px solid var(--line-hi)',
          }}
        >
          {plan ? (
            <iframe
              key={previewKey}
              title="Report preview"
              srcDoc={html}
              sandbox="allow-same-origin"
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                background: '#FBF7EE',
              }}
            />
          ) : (
            <div className="flex items-center justify-center h-full" style={{ color: 'var(--ink-400)' }}>
              <RefreshCw size={14} className="animate-spin mr-2" /> Building report…
            </div>
          )}
        </div>
        <div className="flex items-center justify-between mt-4 text-[11px]" style={{ color: 'var(--ink-400)' }}>
          <div>
            <strong style={{ color: 'var(--ink-200)' }}>Print → Save as PDF</strong> gives a vector-quality file with selectable text. Use the dialog's "More settings" to disable headers/footers for the cleanest result.
          </div>
          <div className="mono">{plan?.meta.template === 'safety' ? 'Safety lens applied' : null}</div>
        </div>
      </Card>
    </div>
  )
}

// ─── Per-template scope picker ───────────────────────────────────────────────
// Period reports lock to a railway period (4 or 5 weeks). Weekly briefs lock
// to a single railway week. Safety roll-up and Custom Range expose a free
// from–to picker so the user can frame any window they like.

function ScopePicker({
  template, periodSel, setPeriodSel, weekSel, setWeekSel, safetyRange, setSafetyRange, customRange, setCustomRange,
}: {
  template: ReportTemplate
  periodSel:   { railYear: number; period: number; from: string; to: string }
  setPeriodSel: (s: { railYear: number; period: number; from: string; to: string }) => void
  weekSel:     { railYear: number; period: number; week: number; from: string; to: string }
  setWeekSel:  (s: { railYear: number; period: number; week: number; from: string; to: string }) => void
  safetyRange: { from: string; to: string }
  setSafetyRange: (s: { from: string; to: string }) => void
  customRange: { from: string; to: string }
  setCustomRange: (s: { from: string; to: string }) => void
}) {
  const years = useMemo(() => listRailYears(), [])

  if (template === 'period') {
    const periods = listPeriods(periodSel.railYear)
    return (
      <div className="rounded-sm p-4" style={{ background: 'var(--bg-card-hi)', border: '1px solid var(--line)' }}>
        <div className="label-micro mb-3">Period scope · railway calendar (P1 W1 = Sunday nearest 1 April)</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <div className="label-micro mb-1.5">Railway year</div>
            <select
              className="select w-full"
              value={periodSel.railYear}
              onChange={e => {
                const y = Number(e.target.value)
                const b = railwayPeriodBounds(periodSel.period, y)
                setPeriodSel({ railYear: y, period: periodSel.period, from: b.from, to: b.to })
              }}
            >
              {years.map(y => <option key={y.railYear} value={y.railYear}>{y.label}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <div className="label-micro mb-1.5">Period</div>
            <select
              className="select w-full"
              value={periodSel.period}
              onChange={e => {
                const p = Number(e.target.value)
                const b = railwayPeriodBounds(p, periodSel.railYear)
                setPeriodSel({ railYear: periodSel.railYear, period: p, from: b.from, to: b.to })
              }}
            >
              {periods.map(p => {
                const tag = p.status === 'future' ? ' — future' : p.status === 'current' ? ' — in progress' : ''
                return (
                  <option key={p.period} value={p.period} disabled={p.status === 'future'}>
                    {p.longLabel}{tag}
                  </option>
                )
              })}
            </select>
          </div>
        </div>
        <div className="text-[10.5px] mt-3" style={{ color: 'var(--ink-400)' }}>
          Locked to a single Network Rail period (4 weeks, 5 in 53-week years). Comparison runs against the period immediately before.
        </div>
      </div>
    )
  }

  if (template === 'weekly') {
    const periods = listPeriods(weekSel.railYear)
    const weeks = listWeeks(weekSel.period, weekSel.railYear)
    return (
      <div className="rounded-sm p-4" style={{ background: 'var(--bg-card-hi)', border: '1px solid var(--line)' }}>
        <div className="label-micro mb-3">Weekly scope · pick a period then a week within it</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <div className="label-micro mb-1.5">Railway year</div>
            <select
              className="select w-full"
              value={weekSel.railYear}
              onChange={e => {
                const y = Number(e.target.value)
                const b = railwayWeekBounds(weekSel.period, weekSel.week, y)
                setWeekSel({ railYear: y, period: weekSel.period, week: weekSel.week, from: b.from, to: b.to })
              }}
            >
              {years.map(y => <option key={y.railYear} value={y.railYear}>{y.label}</option>)}
            </select>
          </div>
          <div>
            <div className="label-micro mb-1.5">Period</div>
            <select
              className="select w-full"
              value={weekSel.period}
              onChange={e => {
                const p = Number(e.target.value)
                // Reset to W1 when the period changes so we don't end up
                // pointing at a week that doesn't exist (e.g. W5 in a P12).
                const b = railwayWeekBounds(p, 1, weekSel.railYear)
                setWeekSel({ railYear: weekSel.railYear, period: p, week: 1, from: b.from, to: b.to })
              }}
            >
              {periods.map(p => (
                <option key={p.period} value={p.period} disabled={p.status === 'future'}>
                  {p.label}{p.status === 'current' ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="label-micro mb-1.5">Week</div>
            <select
              className="select w-full"
              value={weekSel.week}
              onChange={e => {
                const w = Number(e.target.value)
                const b = railwayWeekBounds(weekSel.period, w, weekSel.railYear)
                setWeekSel({ railYear: weekSel.railYear, period: weekSel.period, week: w, from: b.from, to: b.to })
              }}
            >
              {weeks.map(w => {
                const tag = w.status === 'future' ? ' — future' : w.status === 'current' ? ' — in progress' : ''
                return (
                  <option key={w.week} value={w.week} disabled={w.status === 'future'}>
                    {w.longLabel}{tag}
                  </option>
                )
              })}
            </select>
          </div>
        </div>
        <div className="text-[10.5px] mt-3" style={{ color: 'var(--ink-400)' }}>
          A railway week runs Sunday → Saturday and sits inside the four-week period. Comparison runs against the week immediately before.
        </div>
      </div>
    )
  }

  // Date range pickers for safety / custom
  const range = template === 'safety' ? safetyRange : customRange
  const setRange = template === 'safety' ? setSafetyRange : setCustomRange
  const presets: { label: string; days: number }[] = [
    { label: 'Last 7 days',  days: 7  },
    { label: 'Last 14 days', days: 14 },
    { label: 'Last 30 days', days: 30 },
    { label: 'Last 90 days', days: 90 },
  ]
  return (
    <div className="rounded-sm p-4" style={{ background: 'var(--bg-card-hi)', border: '1px solid var(--line)' }}>
      <div className="label-micro mb-3">
        {template === 'safety' ? 'Safety roll-up · date range' : 'Custom range · date range'}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <div className="label-micro mb-1.5">From</div>
          <input
            type="date"
            className="input w-full"
            value={range.from}
            max={range.to}
            onChange={e => setRange({ from: e.target.value || range.from, to: range.to })}
          />
        </div>
        <div>
          <div className="label-micro mb-1.5">To</div>
          <input
            type="date"
            className="input w-full"
            value={range.to}
            min={range.from}
            max={yesterdayISO()}
            onChange={e => setRange({ from: range.from, to: e.target.value || range.to })}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        {presets.map(p => {
          const to = yesterdayISO()
          const from = isoMinusDays(to, p.days - 1)
          const active = range.from === from && range.to === to
          return (
            <button
              key={p.days}
              onClick={() => setRange({ from, to })}
              className="text-[10.5px] tracking-wider uppercase px-2.5 py-1.5 rounded-sm transition-colors font-mono"
              style={{
                background: active ? 'var(--nr-orange-glow)' : 'var(--bg-card)',
                border: `1px solid ${active ? 'var(--nr-orange)' : 'var(--line)'}`,
                color: active ? 'var(--ink-100)' : 'var(--ink-400)',
              }}
            >
              {p.label}
            </button>
          )
        })}
      </div>
      <div className="text-[10.5px] mt-3" style={{ color: 'var(--ink-400)' }}>
        Comparison runs against the preceding equivalent window of the same length. Data ceiling is yesterday.
      </div>
    </div>
  )
}

// Human-readable summary of the active filter set — appears on the report
// cover so the reader knows what scope they're looking at.
function describeFilters(f: AnalyticsFilters): string {
  const parts: string[] = []
  if (f.areas.length)         parts.push(`Areas: ${f.areas.slice(0, 4).join(', ')}${f.areas.length > 4 ? ` +${f.areas.length - 4}` : ''}`)
  if (f.categories.length)    parts.push(`Categories: ${f.categories.slice(0, 4).map(c => CATEGORY_CONFIG[c]?.short ?? c).join(', ')}${f.categories.length > 4 ? ` +${f.categories.length - 4}` : ''}`)
  if (f.severities.length)    parts.push(`Severity: ${f.severities.join(', ')}`)
  if (f.incidentTypes.length) parts.push(`Types: ${f.incidentTypes.length}`)
  if (f.staffNames.length)    parts.push(`Staff: ${f.staffNames.length}`)
  if (f.searches.length)      parts.push(`Search: "${f.searches.slice(0, 2).join('", "')}"`)
  if (f.minDelay != null || f.maxDelay != null) {
    parts.push(`Delay: ${f.minDelay ?? 0}–${f.maxDelay ?? '∞'} min`)
  }
  return parts.length ? parts.join(' · ') : 'No filters · full route, all categories'
}

// ─── Explore Tab ─────────────────────────────────────────────────────────────
// Pick a base segment (categories / severities / areas), split it by an
// arrival-time band, duration band, hour band, day-of-week, severity, area or
// line — then read per-cohort delay / arrival / duration / SLA stats side by
// side. Click any cohort to open a "Why" panel that ranks dimensions
// over-represented in that cohort vs the segment as a whole.

type CohortDim = 'arrivalBand' | 'durationBand' | 'severity' | 'hourBand' | 'dow' | 'area' | 'line'
type CohortMetric = 'avgDelay' | 'p50Delay' | 'avgArrival' | 'avgDuration' | 'pctSlaBreach' | 'count' | 'totalDelay'

const COHORT_DIM_OPTS: { key: CohortDim; label: string }[] = [
  { key: 'arrivalBand',  label: 'Arrival time band' },
  { key: 'durationBand', label: 'Incident duration band' },
  { key: 'severity',     label: 'Severity' },
  { key: 'hourBand',     label: 'Hour of day' },
  { key: 'dow',          label: 'Day of week' },
  { key: 'area',         label: 'Area' },
  { key: 'line',         label: 'Line' },
]

const COHORT_METRIC_OPTS: { key: CohortMetric; label: string; unit: string; risingIsBad: boolean }[] = [
  { key: 'avgDelay',     label: 'Avg delay / incident', unit: 'm', risingIsBad: true  },
  { key: 'p50Delay',     label: 'Median delay',         unit: 'm', risingIsBad: true  },
  { key: 'avgArrival',   label: 'Avg arrival',          unit: 'm', risingIsBad: true  },
  { key: 'avgDuration',  label: 'Avg duration',         unit: 'm', risingIsBad: true  },
  { key: 'pctSlaBreach', label: '% Arrival SLA breach',  unit: '%', risingIsBad: true  },
  { key: 'count',        label: 'Incident count',       unit: '',  risingIsBad: true  },
  { key: 'totalDelay',   label: 'Total delay',          unit: 'm', risingIsBad: true  },
]

const ARRIVAL_BANDS = [
  { key: '0-5',   label: '0–5 min',   min: 0,  max: 5  },
  { key: '5-15',  label: '5–15 min',  min: 5,  max: 15 },
  { key: '15-30', label: '15–30 min', min: 15, max: 30 },
  { key: '30-60', label: '30–60 min', min: 30, max: 60 },
  { key: '60+',   label: '60 min +',  min: 60, max: Number.POSITIVE_INFINITY },
]

const DURATION_BANDS = [
  { key: '0-30',    label: '0–30 min',  min: 0,   max: 30  },
  { key: '30-60',   label: '30–60 min', min: 30,  max: 60  },
  { key: '60-120',  label: '1–2 h',     min: 60,  max: 120 },
  { key: '120-240', label: '2–4 h',     min: 120, max: 240 },
  { key: '240+',    label: '4 h +',     min: 240, max: Number.POSITIVE_INFINITY },
]

const HOUR_BANDS = [
  { key: 'night',     label: 'Night 00–06',     from: 0,  to: 6  },
  { key: 'morning',   label: 'Morning 06–12',   from: 6,  to: 12 },
  { key: 'afternoon', label: 'Afternoon 12–18', from: 12, to: 18 },
  { key: 'evening',   label: 'Evening 18–24',   from: 18, to: 24 },
]

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function exploreHour(i: IncidentRow): number | null {
  if (i.hour_of_day != null && i.hour_of_day >= 0 && i.hour_of_day < 24) return i.hour_of_day
  if (i.incident_start) {
    const h = parseInt(i.incident_start.split(':')[0], 10)
    if (!Number.isNaN(h) && h >= 0 && h < 24) return h
  }
  return null
}

function exploreDow(i: IncidentRow): number | null {
  if (i.day_of_week != null && i.day_of_week >= 0 && i.day_of_week < 7) return i.day_of_week
  if (i.report_date) {
    const d = new Date(i.report_date + 'T00:00:00Z')
    if (!Number.isNaN(d.getTime())) return d.getUTCDay()
  }
  return null
}

function arrivalBandKey(mins: number): string {
  return ARRIVAL_BANDS.find(b => mins >= b.min && mins < b.max)?.key ?? '60+'
}

function durationBandKey(mins: number): string {
  return DURATION_BANDS.find(b => mins >= b.min && mins < b.max)?.key ?? '240+'
}

function hourBandKey(h: number): string {
  return HOUR_BANDS.find(b => h >= b.from && h < b.to)?.key ?? 'night'
}

function cohortKeyFor(i: IncidentRow, dim: CohortDim): { key: string; label: string } | null {
  switch (dim) {
    case 'arrivalBand': {
      const v = effectiveMinsToArrival(i); if (v == null) return null
      const k = arrivalBandKey(v); const b = ARRIVAL_BANDS.find(x => x.key === k)!
      return { key: k, label: b.label }
    }
    case 'durationBand': {
      const v = effectiveDuration(i); if (v == null) return null
      const k = durationBandKey(v); const b = DURATION_BANDS.find(x => x.key === k)!
      return { key: k, label: b.label }
    }
    case 'severity':
      return { key: i.severity, label: i.severity }
    case 'hourBand': {
      const h = exploreHour(i); if (h == null) return null
      const k = hourBandKey(h); const b = HOUR_BANDS.find(x => x.key === k)!
      return { key: k, label: b.label }
    }
    case 'dow': {
      const d = exploreDow(i); if (d == null) return null
      return { key: String(d), label: DOW_LABELS[d] }
    }
    case 'area':
      return i.area ? { key: i.area, label: i.area } : null
    case 'line':
      return i.line ? { key: i.line, label: i.line } : null
  }
}

function cohortDimOrder(dim: CohortDim): string[] | null {
  switch (dim) {
    case 'arrivalBand':  return ARRIVAL_BANDS.map(b => b.key)
    case 'durationBand': return DURATION_BANDS.map(b => b.key)
    case 'hourBand':     return HOUR_BANDS.map(b => b.key)
    case 'severity':     return ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']
    case 'dow':          return ['1', '2', '3', '4', '5', '6', '0']  // Mon-first
    default:             return null
  }
}

function cohortColor(dim: CohortDim, key: string, idx: number): string {
  if (dim === 'severity') return SEVERITY_CONFIG[key as Severity]?.color ?? SERIES_PALETTE[idx % SERIES_PALETTE.length]
  return SERIES_PALETTE[idx % SERIES_PALETTE.length]
}

interface CohortStat {
  key: string
  label: string
  color: string
  count: number
  totalDelay: number
  avgDelay: number | null
  p50Delay: number | null
  avgArrival: number | null
  avgDuration: number | null
  pctSlaBreach: number | null
  arrivalN: number
  durationN: number
  incidents: IncidentRow[]
}

function buildCohortStats(segment: IncidentRow[], dim: CohortDim): CohortStat[] {
  const groups = new Map<string, { label: string; rows: IncidentRow[] }>()
  for (const i of segment) {
    if (i.is_continuation) continue
    const k = cohortKeyFor(i, dim); if (!k) continue
    const g = groups.get(k.key) ?? { label: k.label, rows: [] }
    g.rows.push(i); groups.set(k.key, g)
  }

  const order = cohortDimOrder(dim)
  const entries = [...groups.entries()]
  entries.sort((a, b) => {
    if (order) {
      const ai = order.indexOf(a[0]), bi = order.indexOf(b[0])
      if (ai !== -1 && bi !== -1) return ai - bi
      if (ai !== -1) return -1
      if (bi !== -1) return 1
    }
    return b[1].rows.length - a[1].rows.length
  })

  const slice = entries.slice(0, 12)  // cap to keep the chart readable

  return slice.map(([key, g], idx) => {
    const rows = g.rows
    const delays = rows.map(r => r.minutes_delay ?? 0)
    const arrivals = rows.map(effectiveMinsToArrival).filter((v): v is number => v != null)
    const durations = rows.map(effectiveDuration).filter((v): v is number => v != null)
    const breach = arrivals.filter(v => v > SLA_THRESHOLD_MINS).length
    const totalDelay = delays.reduce((s, v) => s + v, 0)
    const sortedDelays = [...delays].sort((a, b) => a - b)
    const p50 = sortedDelays.length
      ? (sortedDelays.length % 2
          ? sortedDelays[(sortedDelays.length - 1) / 2]
          : (sortedDelays[sortedDelays.length / 2 - 1] + sortedDelays[sortedDelays.length / 2]) / 2)
      : null
    return {
      key,
      label: g.label,
      color: cohortColor(dim, key, idx),
      count: rows.length,
      totalDelay,
      avgDelay: rows.length ? +(totalDelay / rows.length).toFixed(1) : null,
      p50Delay: p50 != null ? +p50.toFixed(1) : null,
      avgArrival: arrivals.length ? +(arrivals.reduce((s, v) => s + v, 0) / arrivals.length).toFixed(1) : null,
      avgDuration: durations.length ? +(durations.reduce((s, v) => s + v, 0) / durations.length).toFixed(1) : null,
      pctSlaBreach: arrivals.length ? +((breach / arrivals.length) * 100).toFixed(1) : null,
      arrivalN: arrivals.length,
      durationN: durations.length,
      incidents: rows,
    }
  })
}

function metricValueOf(c: CohortStat, m: CohortMetric): number | null {
  switch (m) {
    case 'avgDelay':     return c.avgDelay
    case 'p50Delay':     return c.p50Delay
    case 'avgArrival':   return c.avgArrival
    case 'avgDuration':  return c.avgDuration
    case 'pctSlaBreach': return c.pctSlaBreach
    case 'count':        return c.count
    case 'totalDelay':   return c.totalDelay
  }
}

interface InsightItem {
  dimLabel: string
  key: string
  label: string
  cohortCount: number
  cohortShare: number
  segmentCount: number
  segmentShare: number
  lift: number
  color?: string
}

const WHY_DIMS: { dimLabel: string; getter: (i: IncidentRow) => { key: string; label: string; color?: string } | null }[] = [
  {
    dimLabel: 'Category',
    getter: i => {
      const cfg = CATEGORY_CONFIG[i.category]
      return cfg ? { key: i.category, label: cfg.label, color: cfg.color } : null
    },
  },
  { dimLabel: 'Area',     getter: i => i.area ? { key: i.area, label: i.area } : null },
  { dimLabel: 'Line',     getter: i => i.line ? { key: i.line, label: i.line } : null },
  {
    dimLabel: 'Hour band',
    getter: i => {
      const h = exploreHour(i); if (h == null) return null
      const k = hourBandKey(h); const b = HOUR_BANDS.find(x => x.key === k)!
      return { key: k, label: b.label }
    },
  },
  {
    dimLabel: 'Day of week',
    getter: i => {
      const d = exploreDow(i); if (d == null) return null
      return { key: String(d), label: DOW_LABELS[d] }
    },
  },
  {
    dimLabel: 'Severity',
    getter: i => ({ key: i.severity, label: i.severity, color: SEVERITY_CONFIG[i.severity]?.color }),
  },
  { dimLabel: 'Location', getter: i => i.location ? { key: i.location, label: i.location } : null },
  {
    dimLabel: 'Incident type',
    getter: i => {
      const lbl = i.incident_type_label
      return lbl ? { key: lbl, label: lbl } : null
    },
  },
]

const WHY_LIFT_THRESHOLD  = 1.6
const WHY_MIN_COHORT_HITS = 3
const WHY_MAX_PER_DIM     = 4

function buildInsights(cohort: IncidentRow[], segment: IncidentRow[]): { dimLabel: string; items: InsightItem[] }[] {
  const out: { dimLabel: string; items: InsightItem[] }[] = []
  if (!cohort.length) return out

  for (const dim of WHY_DIMS) {
    const cohortCounts = new Map<string, { label: string; color?: string; n: number }>()
    const segCounts    = new Map<string, number>()

    for (const i of segment) {
      const k = dim.getter(i); if (!k) continue
      segCounts.set(k.key, (segCounts.get(k.key) ?? 0) + 1)
    }
    for (const i of cohort) {
      const k = dim.getter(i); if (!k) continue
      const cur = cohortCounts.get(k.key) ?? { label: k.label, color: k.color, n: 0 }
      cur.n += 1; cohortCounts.set(k.key, cur)
    }

    const cTotal = cohort.length
    const sTotal = segment.length
    const items: InsightItem[] = []
    for (const [key, info] of cohortCounts.entries()) {
      if (info.n < WHY_MIN_COHORT_HITS) continue
      const segN = segCounts.get(key) ?? 0
      if (segN === 0) continue
      const cShare = info.n / cTotal
      const sShare = segN / sTotal
      if (sShare === 0) continue
      const lift = cShare / sShare
      if (lift < WHY_LIFT_THRESHOLD) continue
      items.push({
        dimLabel: dim.dimLabel,
        key,
        label: info.label,
        color: info.color,
        cohortCount: info.n,
        cohortShare: cShare,
        segmentCount: segN,
        segmentShare: sShare,
        lift,
      })
    }
    items.sort((a, b) => b.lift - a.lift)
    if (items.length) out.push({ dimLabel: dim.dimLabel, items: items.slice(0, WHY_MAX_PER_DIM) })
  }
  return out
}

function ExploreTab({ incidents, areaOptions }: { incidents: IncidentRow[]; areaOptions: string[] }) {
  const [cats, setCats]       = useState<IncidentCategory[]>([])
  const [types, setTypes]     = useState<string[]>([])
  const [sevs, setSevs]       = useState<Severity[]>([])
  const [areas, setAreas]     = useState<string[]>([])
  const [searches, setSearches] = useState<string[]>([])
  const [searchInput, setSearchInput] = useState('')
  const [typeFilter, setTypeFilter]   = useState('')
  const [typesOpen, setTypesOpen]     = useState(false)
  const [dim, setDim]         = useState<CohortDim>('arrivalBand')
  const [metric, setMetric]   = useState<CohortMetric>('avgDelay')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  // Specific incident types in the window, sorted by frequency descending
  const typeOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of incidents) {
      if (i.is_continuation) continue
      const lbl = i.incident_type_label?.trim()
      if (!lbl) continue
      counts.set(lbl, (counts.get(lbl) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count }))
  }, [incidents])

  const filteredTypeOptions = useMemo(() => {
    const q = typeFilter.trim().toLowerCase()
    return q ? typeOptions.filter(t => t.label.toLowerCase().includes(q)) : typeOptions
  }, [typeOptions, typeFilter])

  const segment = useMemo(() => {
    return incidents.filter(i => {
      if (i.is_continuation) return false
      if (cats.length  && !cats.includes(i.category))   return false
      if (sevs.length  && !sevs.includes(i.severity))   return false
      if (areas.length && !areas.includes(i.area ?? '')) return false
      if (types.length && !types.includes((i.incident_type_label ?? '').trim())) return false
      if (searches.length && !searches.some(q => searchMatch(i, q))) return false
      return true
    })
  }, [incidents, cats, sevs, areas, types, searches])

  const commitSearch = () => {
    const tok = searchInput.trim()
    if (!tok) return
    if (searches.includes(tok)) { setSearchInput(''); return }
    setSearches(s => [...s, tok])
    setSearchInput('')
  }

  const cohorts = useMemo(() => buildCohortStats(segment, dim), [segment, dim])

  const selectedCohort = selectedKey ? cohorts.find(c => c.key === selectedKey) ?? null : null
  const insights = useMemo(
    () => selectedCohort ? buildInsights(selectedCohort.incidents, segment) : [],
    [selectedCohort, segment],
  )

  // Comparison vs all other cohorts (segment minus selected) for headline contrast
  const segmentMinusSelected = useMemo(() => {
    if (!selectedCohort) return [] as IncidentRow[]
    const ids = new Set(selectedCohort.incidents.map(i => i.id))
    return segment.filter(i => !ids.has(i.id))
  }, [segment, selectedCohort])

  const restStats = useMemo(() => {
    if (!selectedCohort || !segmentMinusSelected.length) return null
    const arrivals = segmentMinusSelected.map(effectiveMinsToArrival).filter((v): v is number => v != null)
    const durations = segmentMinusSelected.map(effectiveDuration).filter((v): v is number => v != null)
    const breach = arrivals.filter(v => v > SLA_THRESHOLD_MINS).length
    const delay = segmentMinusSelected.reduce((s, i) => s + (i.minutes_delay ?? 0), 0)
    return {
      avgDelay:    +(delay / segmentMinusSelected.length).toFixed(1),
      avgArrival:  arrivals.length  ? +(arrivals.reduce((s, v) => s + v, 0) / arrivals.length).toFixed(1) : null,
      avgDuration: durations.length ? +(durations.reduce((s, v) => s + v, 0) / durations.length).toFixed(1) : null,
      pctSlaBreach: arrivals.length ? +((breach / arrivals.length) * 100).toFixed(1) : null,
      count: segmentMinusSelected.length,
    }
  }, [selectedCohort, segmentMinusSelected])

  const toggle = <T,>(arr: T[], v: T): T[] => arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]
  const metricOpt = COHORT_METRIC_OPTS.find(o => o.key === metric)!

  const chartData = cohorts.map(c => ({ label: c.label, value: metricValueOf(c, metric) ?? 0, color: c.color, key: c.key }))

  const segmentActive = cats.length + types.length + sevs.length + areas.length + searches.length > 0

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--ink-100)' }}>Cohort Explorer</h2>
        <p className="text-sm mt-1" style={{ color: 'var(--ink-400)' }}>
          Define a base segment, split it by a dimension, then compare metrics side-by-side. Click a cohort to see why it stands out.
        </p>
      </div>

      {/* Base segment */}
      <div className="card p-5 space-y-5">
        <div className="flex items-center justify-between">
          <div className="label-micro" style={{ fontSize: 11 }}>Base segment <span style={{ color: 'var(--ink-500)' }}>(empty filter = all incidents)</span></div>
          <span className="numeric-mono text-sm px-2.5 py-1 rounded border" style={{ color: 'var(--nr-orange)', borderColor: 'var(--nr-orange)' }}>
            {segment.length} incidents
          </span>
        </div>

        {/* Category groups */}
        <div>
          <div className="label-micro mb-2" style={{ fontSize: 11, color: 'var(--ink-400)' }}>Category groups</div>
          <div className="space-y-2">
            {CAT_GROUPS.map(group => (
              <div key={group.label} className="flex items-center gap-3 flex-wrap">
                <span className="label-micro w-20 shrink-0" style={{ fontSize: 11, color: 'var(--ink-500)' }}>{group.label}</span>
                <div className="flex flex-wrap gap-1.5">
                  {group.cats.map(cat => {
                    const cfg = CATEGORY_CONFIG[cat]
                    const on = cats.includes(cat)
                    return (
                      <button
                        key={cat}
                        onClick={() => setCats(c => toggle(c, cat))}
                        className="px-2 py-1 text-[11px] rounded border transition-colors"
                        style={{
                          background:  on ? `${cfg.color}25` : 'transparent',
                          borderColor: on ? cfg.color : 'var(--line)',
                          color:       on ? cfg.color : 'var(--ink-400)',
                        }}
                        title={cfg.label}
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

        {/* Specific incident types — collapsible to keep the panel compact */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="label-micro" style={{ fontSize: 11, color: 'var(--ink-400)' }}>
              Specific incident types
              <span className="ml-2" style={{ color: 'var(--ink-500)' }}>
                {types.length ? `${types.length} selected` : `${typeOptions.length} available`}
              </span>
            </div>
            <button
              onClick={() => setTypesOpen(o => !o)}
              className="flex items-center gap-1 text-[11px] hover:opacity-80"
              style={{ color: 'var(--ink-300)' }}
            >
              <ChevronDown size={12} style={{ transform: typesOpen ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }} />
              {typesOpen ? 'Collapse' : 'Expand'}
            </button>
          </div>

          {types.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {types.map(t => (
                <span
                  key={t}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border"
                  style={{ background: 'rgba(74,159,229,0.12)', borderColor: '#4A9FE5', color: '#4A9FE5' }}
                >
                  {t}
                  <button onClick={() => setTypes(arr => arr.filter(x => x !== t))} className="opacity-70 hover:opacity-100">
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {typesOpen && (
            <div className="space-y-2">
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--ink-500)' }} />
                <input
                  type="text"
                  placeholder="Filter incident types…"
                  value={typeFilter}
                  onChange={e => setTypeFilter(e.target.value)}
                  className="w-full pl-8 pr-2 py-1.5 text-[12px] rounded border outline-none bg-[var(--bg-card-hi)] focus:border-[var(--nr-orange)] transition-colors"
                  style={{ borderColor: 'var(--line)', color: 'var(--ink-200)' }}
                />
              </div>
              <div className="max-h-56 overflow-y-auto flex flex-wrap gap-1.5 p-0.5">
                {filteredTypeOptions.length === 0 && (
                  <span className="text-[11px] py-2" style={{ color: 'var(--ink-500)' }}>No types match</span>
                )}
                {filteredTypeOptions.map(({ label, count }) => {
                  const on = types.includes(label)
                  return (
                    <button
                      key={label}
                      onClick={() => setTypes(t => toggle(t, label))}
                      className="px-2 py-1 text-[11px] rounded border transition-colors flex items-center gap-1.5"
                      style={{
                        background:  on ? 'rgba(74,159,229,0.18)' : 'transparent',
                        borderColor: on ? '#4A9FE5' : 'var(--line)',
                        color:       on ? '#4A9FE5' : 'var(--ink-300)',
                      }}
                      title={`${label} · ${count} incident${count === 1 ? '' : 's'}`}
                    >
                      <span className="truncate max-w-[280px]">{label}</span>
                      <span className="numeric-mono text-[10px] opacity-70">{count}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Free-text search across title / location / fault number / type / etc. */}
        <div>
          <div className="label-micro mb-2" style={{ fontSize: 11, color: 'var(--ink-400)' }}>
            Free-text segment search
            <span className="ml-2" style={{ color: 'var(--ink-500)' }}>
              matches title, location, type, fault no., train ID, CCIL, line, operator
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--ink-500)' }} />
              <input
                type="text"
                placeholder="Type a token, press Enter to add…"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitSearch() }
                  if (e.key === 'Backspace' && !searchInput && searches.length) {
                    setSearches(s => s.slice(0, -1))
                  }
                }}
                onBlur={commitSearch}
                className="w-full pl-8 pr-2 py-1.5 text-[12px] rounded border outline-none bg-[var(--bg-card-hi)] focus:border-[var(--nr-orange)] transition-colors"
                style={{ borderColor: 'var(--line)', color: 'var(--ink-200)' }}
              />
            </div>
            {searches.map(s => (
              <span
                key={s}
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border"
                style={{ background: 'rgba(224,82,6,0.12)', borderColor: 'var(--nr-orange)', color: 'var(--nr-orange)' }}
              >
                "{s}"
                <button onClick={() => setSearches(arr => arr.filter(x => x !== s))} className="opacity-70 hover:opacity-100">
                  <X size={10} />
                </button>
              </span>
            ))}
            {searches.length > 1 && (
              <span className="numeric-mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-card-hi)', color: 'var(--ink-500)' }}>
                OR
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-x-8 gap-y-4 pt-1">
          <div>
            <div className="label-micro mb-2" style={{ fontSize: 11, color: 'var(--ink-400)' }}>Severities</div>
            <div className="flex gap-1.5">
              {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as Severity[]).map(sev => {
                const cfg = SEVERITY_CONFIG[sev]
                const on  = sevs.includes(sev)
                return (
                  <button
                    key={sev}
                    onClick={() => setSevs(s => toggle(s, sev))}
                    className="px-2.5 py-1 text-[11px] rounded border transition-colors"
                    style={{
                      background:  on ? `${cfg.color}25` : 'transparent',
                      borderColor: on ? cfg.color : 'var(--line)',
                      color:       on ? cfg.color : 'var(--ink-300)',
                    }}
                  >
                    {sev}
                  </button>
                )
              })}
            </div>
          </div>

          {areaOptions.length > 0 && (
            <div className="flex-1 min-w-[220px]">
              <div className="label-micro mb-2" style={{ fontSize: 11, color: 'var(--ink-400)' }}>Areas</div>
              <div className="flex flex-wrap gap-1.5">
                {areaOptions.map(area => {
                  const on = areas.includes(area)
                  return (
                    <button
                      key={area}
                      onClick={() => setAreas(a => toggle(a, area))}
                      className="px-2 py-1 text-[11px] rounded border transition-colors"
                      style={{
                        background:  on ? 'rgba(224,82,6,0.18)' : 'transparent',
                        borderColor: on ? 'var(--nr-orange)' : 'var(--line)',
                        color:       on ? 'var(--nr-orange)' : 'var(--ink-300)',
                      }}
                    >
                      {area}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {segmentActive && (
            <button
              onClick={() => {
                setCats([]); setTypes([]); setSevs([]); setAreas([]); setSearches([]); setSearchInput(''); setSelectedKey(null)
              }}
              className="text-[11px] self-end mb-0.5 hover:opacity-80 flex items-center gap-1"
              style={{ color: 'var(--ink-400)' }}
            >
              <X size={11} /> Clear segment
            </button>
          )}
        </div>
      </div>

      {/* Split + metric controls */}
      <div className="card p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
        <div>
          <div className="label-micro mb-2" style={{ fontSize: 11 }}>Split segment by</div>
          <div className="flex flex-wrap gap-1.5">
            {COHORT_DIM_OPTS.map(opt => (
              <button
                key={opt.key}
                onClick={() => { setDim(opt.key); setSelectedKey(null) }}
                className="px-2.5 py-1.5 text-[12px] rounded border transition-colors"
                style={{
                  background:  dim === opt.key ? 'rgba(74,159,229,0.15)' : 'transparent',
                  borderColor: dim === opt.key ? '#4A9FE5' : 'var(--line)',
                  color:       dim === opt.key ? '#4A9FE5' : 'var(--ink-300)',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="label-micro mb-2" style={{ fontSize: 11 }}>Compare on metric</div>
          <div className="flex flex-wrap gap-1.5">
            {COHORT_METRIC_OPTS.map(opt => (
              <button
                key={opt.key}
                onClick={() => setMetric(opt.key)}
                className="px-2.5 py-1.5 text-[12px] rounded border transition-colors"
                style={{
                  background:  metric === opt.key ? 'rgba(224,82,6,0.18)' : 'transparent',
                  borderColor: metric === opt.key ? 'var(--nr-orange)' : 'var(--line)',
                  color:       metric === opt.key ? 'var(--nr-orange)' : 'var(--ink-300)',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Comparison table */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="label-micro" style={{ fontSize: 11 }}>Cohort comparison</div>
            <p className="text-[12px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
              {cohorts.length} cohort{cohorts.length === 1 ? '' : 's'} · split by {COHORT_DIM_OPTS.find(o => o.key === dim)?.label.toLowerCase()}
              {cohorts.length === 12 && <span> · capped at 12</span>}
            </p>
          </div>
          {selectedCohort && (
            <button onClick={() => setSelectedKey(null)} className="flex items-center gap-1 text-[11px] hover:opacity-70" style={{ color: 'var(--ink-400)' }}>
              <X size={11} /> Clear selection
            </button>
          )}
        </div>

        {cohorts.length === 0 ? <Empty msg="No cohorts in this segment — try a wider filter or a different split." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="label-micro border-b border-[var(--line)]" style={{ fontSize: 11 }}>
                  <th className="text-left py-2.5 pr-3">Cohort</th>
                  <th className="text-right pr-3">n</th>
                  <th className="text-right pr-3">Avg delay</th>
                  <th className="text-right pr-3">Median delay</th>
                  <th className="text-right pr-3">Avg arrival</th>
                  <th className="text-right pr-3">Avg duration</th>
                  <th className="text-right pr-3">% Arrival SLA breach</th>
                  <th className="text-right">Total delay</th>
                </tr>
              </thead>
              <tbody>
                {cohorts.map(c => {
                  const sel = c.key === selectedKey
                  return (
                    <tr
                      key={c.key}
                      onClick={() => setSelectedKey(sel ? null : c.key)}
                      className="border-b border-[var(--line)] last:border-0 cursor-pointer transition-colors"
                      style={{ background: sel ? `${c.color}18` : undefined }}
                    >
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: c.color }} />
                          <span style={{ color: sel ? c.color : 'var(--ink-100)' }}>{c.label}</span>
                        </div>
                      </td>
                      <td className="text-right pr-3 numeric-mono" style={{ color: 'var(--ink-100)' }}>{c.count}</td>
                      <td className="text-right pr-3 numeric-mono" style={{ color: 'var(--ink-100)' }}>{c.avgDelay != null ? fmtMins(Math.round(c.avgDelay)) : '—'}</td>
                      <td className="text-right pr-3 numeric-mono" style={{ color: 'var(--ink-200)' }}>{c.p50Delay != null ? fmtMins(Math.round(c.p50Delay)) : '—'}</td>
                      <td className="text-right pr-3 numeric-mono" style={{ color: c.avgArrival != null ? 'var(--nr-orange)' : 'var(--ink-500)' }}>
                        {c.avgArrival != null ? `${Math.round(c.avgArrival)}m` : '—'}
                      </td>
                      <td className="text-right pr-3 numeric-mono" style={{ color: c.avgDuration != null ? 'var(--nr-steel)' : 'var(--ink-500)' }}>
                        {c.avgDuration != null ? fmtMins(Math.round(c.avgDuration)) : '—'}
                      </td>
                      <td className="text-right pr-3 numeric-mono" style={{ color: c.pctSlaBreach != null ? (c.pctSlaBreach > 30 ? 'var(--nr-red,#E74C3C)' : 'var(--ink-100)') : 'var(--ink-500)' }}>
                        {c.pctSlaBreach != null ? `${c.pctSlaBreach.toFixed(0)}%` : '—'}
                      </td>
                      <td className="text-right numeric-mono" style={{ color: 'var(--ink-100)' }}>{fmtMins(c.totalDelay)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Comparison bar chart */}
      {cohorts.length > 0 && (
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="label-micro" style={{ fontSize: 11 }}>{metricOpt.label} by {COHORT_DIM_OPTS.find(o => o.key === dim)?.label.toLowerCase()}</div>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--ink-400)' }}>Click a bar to drill into a cohort</p>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={Math.max(200, cohorts.length * 32 + 70)}>
            <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 30, top: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="2 6" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11, fill: 'var(--ink-400)', fontFamily: 'JetBrains Mono' }}
                tickFormatter={(v: number) => `${v}${metricOpt.unit}`}
              />
              <YAxis
                dataKey="label"
                type="category"
                width={140}
                tick={{ fontSize: 11, fill: 'var(--ink-200)', fontFamily: 'JetBrains Mono' }}
              />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                content={({ active, payload }: any) => {
                  if (!active || !payload?.length) return null
                  const row = payload[0]?.payload
                  return (
                    <div className="card !bg-[var(--bg-card-hi)] !border-[var(--line-hi)] p-2.5 text-[12px]">
                      <div className="label-micro mb-1" style={{ fontSize: 11 }}>{row.label}</div>
                      <div className="numeric-mono text-sm" style={{ color: row.color }}>
                        {Number(row.value).toLocaleString()}{metricOpt.unit}
                      </div>
                    </div>
                  )
                }}
              />
              <Bar dataKey="value" radius={[0, 2, 2, 0]} onClick={(d: any) => setSelectedKey(d.key === selectedKey ? null : d.key)}>
                {chartData.map(d => (
                  <Cell key={d.key} fill={d.color} fillOpacity={selectedKey && selectedKey !== d.key ? 0.35 : 1} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Why panel */}
      {selectedCohort && (
        <div className="card p-5 space-y-5 tick-corners">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="label-micro" style={{ fontSize: 11 }}>Why does this cohort stand out?</div>
              <h3 className="text-base mt-0.5" style={{ color: selectedCohort.color }}>
                {selectedCohort.label}
                <span className="ml-2 text-[12px]" style={{ color: 'var(--ink-400)' }}>
                  · {selectedCohort.count} of {segment.length} segment incidents
                </span>
              </h3>
            </div>
            <button onClick={() => setSelectedKey(null)} className="flex items-center gap-1 text-[11px] hover:opacity-70" style={{ color: 'var(--ink-400)' }}>
              <X size={11} /> Close
            </button>
          </div>

          {restStats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <CompareTile label="Avg delay"     a={selectedCohort.avgDelay}    b={restStats.avgDelay}     unit="m" goodWhenLower />
              <CompareTile label="Avg arrival"   a={selectedCohort.avgArrival}  b={restStats.avgArrival}   unit="m" goodWhenLower />
              <CompareTile label="Avg duration"  a={selectedCohort.avgDuration} b={restStats.avgDuration}  unit="m" goodWhenLower />
              <CompareTile label="% Arrival SLA breach"  a={selectedCohort.pctSlaBreach} b={restStats.pctSlaBreach} unit="%" goodWhenLower />
            </div>
          )}

          {insights.length === 0 ? (
            <div className="text-[12px] py-3" style={{ color: 'var(--ink-400)' }}>
              No dimension was meaningfully over-represented in this cohort vs the rest of the segment.
              Try widening the base segment or splitting on a different dimension.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {insights.map(group => (
                <div key={group.dimLabel} className="border border-[var(--line)] rounded p-3">
                  <div className="label-micro mb-2" style={{ fontSize: 11, color: 'var(--ink-400)' }}>{group.dimLabel}</div>
                  <div className="space-y-2">
                    {group.items.map(it => (
                      <div key={it.key} className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-sm shrink-0" style={{ background: it.color ?? 'var(--nr-orange)' }} />
                        <span className="truncate text-[12px]" style={{ color: 'var(--ink-100)' }} title={it.label}>{it.label}</span>
                        <span className="ml-auto numeric-mono text-[11px] px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(224,82,6,0.15)', color: 'var(--nr-orange)' }}>
                          ×{it.lift.toFixed(1)}
                        </span>
                        <span className="numeric-mono text-[11px] shrink-0" style={{ color: 'var(--ink-400)' }}>
                          {it.cohortCount}/{it.segmentCount}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="text-[11px] pt-2 border-t border-[var(--line)]" style={{ color: 'var(--ink-500)' }}>
            Lift = how much more frequent a value is in this cohort vs the segment overall. Surfaced when share is at least
            {' '}{WHY_LIFT_THRESHOLD}× the segment baseline and at least {WHY_MIN_COHORT_HITS} incidents fall in the bucket.
            These are correlations, not causes — they help direct further investigation.
          </p>
        </div>
      )}
    </div>
  )
}

function CompareTile({ label, a, b, unit, goodWhenLower }: {
  label: string; a: number | null; b: number | null; unit: string; goodWhenLower: boolean
}) {
  const hasBoth = a != null && b != null
  let deltaPct: number | null = null
  if (hasBoth && b !== 0) deltaPct = ((a - b) / Math.abs(b)) * 100
  const flat = deltaPct == null || Math.abs(deltaPct) < 5
  const up = deltaPct != null && deltaPct > 0
  const bad = deltaPct != null && (goodWhenLower ? up : !up)
  const color = flat ? 'var(--ink-400)' : (bad ? 'var(--nr-orange)' : '#27AE60')
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown
  return (
    <div className="border border-[var(--line)] rounded p-3">
      <div className="label-micro mb-1.5" style={{ fontSize: 11 }}>{label}</div>
      <div className="numeric-mono text-lg" style={{ color: 'var(--ink-100)' }}>
        {a != null ? `${Math.round(a)}${unit}` : '—'}
      </div>
      <div className="flex items-center gap-1 mt-1 text-[11px] numeric-mono" style={{ color }}>
        <Icon size={11} />
        {deltaPct != null ? `${deltaPct > 0 ? '+' : ''}${Math.round(deltaPct)}%` : '—'}
        <span style={{ color: 'var(--ink-400)' }}>vs rest</span>
      </div>
      {b != null && (
        <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-500)' }}>
          rest = {Math.round(b)}{unit}
        </div>
      )}
    </div>
  )
}

// ─── Analytics Tab ───────────────────────────────────────────────────────────
// Pick a location + incident type combination to see average response metrics
// (time to arrive, time to restore) and the matched incident list.

function AnalyticsTab({ incidents }: { incidents: IncidentRow[] }) {
  const [selectedLocation, setSelectedLocation] = useState<string | null>(null)
  const [selectedType, setSelectedType]         = useState<string | null>(null)
  const [locationSearch, setLocationSearch]     = useState('')
  const [typeSearch, setTypeSearch]             = useState('')

  // Derive sorted unique locations
  const locations = useMemo(() => {
    const seen = new Set<string>()
    for (const inc of incidents) {
      if (inc.location) seen.add(inc.location)
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [incidents])

  // Derive sorted unique incident types (label first, fall back to category label)
  const incidentTypes = useMemo(() => {
    const seen = new Set<string>()
    for (const inc of incidents) {
      const label = inc.incident_type_label ?? CATEGORY_CONFIG[inc.category]?.label ?? inc.category
      seen.add(label)
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [incidents])

  // Matched incidents for the selected combination
  const matchedIncidents = useMemo(() => {
    if (!selectedLocation && !selectedType) return []
    return incidents.filter(inc => {
      const typeLabel = inc.incident_type_label ?? CATEGORY_CONFIG[inc.category]?.label ?? inc.category
      const locMatch  = !selectedLocation || inc.location === selectedLocation
      const typeMatch = !selectedType     || typeLabel === selectedType
      return locMatch && typeMatch && !inc.is_continuation
    }).sort((a, b) => b.report_date.localeCompare(a.report_date))
  }, [incidents, selectedLocation, selectedType])

  // Compute averages only over rows that have the timing fields populated
  const stats = useMemo(() => {
    const withArrival  = matchedIncidents.filter(i => i.mins_to_arrival != null)
    const withDuration = matchedIncidents.filter(i => i.incident_duration != null)
    const avgArrival   = withArrival.length
      ? Math.round(withArrival.reduce((s, i) => s + i.mins_to_arrival!, 0) / withArrival.length)
      : null
    const avgDuration  = withDuration.length
      ? Math.round(withDuration.reduce((s, i) => s + i.incident_duration!, 0) / withDuration.length)
      : null
    return { avgArrival, avgDuration, arrivalN: withArrival.length, durationN: withDuration.length }
  }, [matchedIncidents])

  const filteredLocations = locationSearch
    ? locations.filter(l => l.toLowerCase().includes(locationSearch.toLowerCase()))
    : locations

  const filteredTypes = typeSearch
    ? incidentTypes.filter(t => t.toLowerCase().includes(typeSearch.toLowerCase()))
    : incidentTypes

  const hasSelection = selectedLocation || selectedType

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold" style={{ color: 'var(--ink-100)' }}>Response Analytics</h2>
        <p className="text-xs mt-0.5" style={{ color: 'var(--ink-400)' }}>
          Select a location and incident type to compare average arrival and resolution times
        </p>
      </div>

      {/* Pickers */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Location picker */}
        <div className="card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="label-micro">Location</div>
            {selectedLocation && (
              <button
                onClick={() => setSelectedLocation(null)}
                className="flex items-center gap-1 text-[10px] hover:opacity-70 transition-opacity"
                style={{ color: 'var(--ink-400)' }}
              >
                <X size={10} /> Clear
              </button>
            )}
          </div>
          {selectedLocation && (
            <div
              className="px-2.5 py-1.5 rounded text-xs border truncate"
              style={{ background: 'rgba(224,82,6,0.12)', borderColor: 'var(--nr-orange)', color: 'var(--nr-orange)' }}
            >
              <MapPin size={10} className="inline mr-1 shrink-0" />
              {selectedLocation}
            </div>
          )}
          <div className="relative">
            <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--ink-500)' }} />
            <input
              type="text"
              placeholder="Filter locations…"
              value={locationSearch}
              onChange={e => setLocationSearch(e.target.value)}
              className="w-full pl-7 pr-2 py-1.5 text-xs rounded border outline-none bg-[var(--bg-card-hi)] focus:border-[var(--nr-orange)] transition-colors"
              style={{ borderColor: 'var(--line)', color: 'var(--ink-200)' }}
            />
          </div>
          <div className="overflow-y-auto max-h-56 space-y-0.5">
            {filteredLocations.length === 0 && (
              <div className="text-xs py-4 text-center" style={{ color: 'var(--ink-500)' }}>No locations match</div>
            )}
            {filteredLocations.map(loc => (
              <button
                key={loc}
                onClick={() => setSelectedLocation(loc === selectedLocation ? null : loc)}
                className="w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors truncate"
                style={{
                  background: loc === selectedLocation ? 'rgba(224,82,6,0.15)' : 'transparent',
                  color: loc === selectedLocation ? 'var(--nr-orange)' : 'var(--ink-300)',
                  border: `1px solid ${loc === selectedLocation ? 'rgba(224,82,6,0.4)' : 'transparent'}`,
                }}
                title={loc}
              >
                {loc}
              </button>
            ))}
          </div>
          <div className="label-micro pt-1 border-t border-[var(--line)]" style={{ color: 'var(--ink-500)' }}>
            {locations.length} recorded location{locations.length !== 1 ? 's' : ''} in window
          </div>
        </div>

        {/* Incident type picker */}
        <div className="card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="label-micro">Incident Type</div>
            {selectedType && (
              <button
                onClick={() => setSelectedType(null)}
                className="flex items-center gap-1 text-[10px] hover:opacity-70 transition-opacity"
                style={{ color: 'var(--ink-400)' }}
              >
                <X size={10} /> Clear
              </button>
            )}
          </div>
          {selectedType && (
            <div
              className="px-2.5 py-1.5 rounded text-xs border truncate"
              style={{ background: 'rgba(74,111,165,0.15)', borderColor: 'var(--nr-steel)', color: 'var(--nr-steel)' }}
            >
              {selectedType}
            </div>
          )}
          <div className="relative">
            <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--ink-500)' }} />
            <input
              type="text"
              placeholder="Filter types…"
              value={typeSearch}
              onChange={e => setTypeSearch(e.target.value)}
              className="w-full pl-7 pr-2 py-1.5 text-xs rounded border outline-none bg-[var(--bg-card-hi)] focus:border-[var(--nr-orange)] transition-colors"
              style={{ borderColor: 'var(--line)', color: 'var(--ink-200)' }}
            />
          </div>
          <div className="overflow-y-auto max-h-56 space-y-0.5">
            {filteredTypes.length === 0 && (
              <div className="text-xs py-4 text-center" style={{ color: 'var(--ink-500)' }}>No types match</div>
            )}
            {filteredTypes.map(type => (
              <button
                key={type}
                onClick={() => setSelectedType(type === selectedType ? null : type)}
                className="w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors truncate"
                style={{
                  background: type === selectedType ? 'rgba(74,111,165,0.18)' : 'transparent',
                  color: type === selectedType ? 'var(--nr-steel)' : 'var(--ink-300)',
                  border: `1px solid ${type === selectedType ? 'rgba(74,111,165,0.45)' : 'transparent'}`,
                }}
                title={type}
              >
                {type}
              </button>
            ))}
          </div>
          <div className="label-micro pt-1 border-t border-[var(--line)]" style={{ color: 'var(--ink-500)' }}>
            {incidentTypes.length} incident type{incidentTypes.length !== 1 ? 's' : ''} in window
          </div>
        </div>
      </div>

      {/* Results */}
      {!hasSelection ? (
        <div className="card p-8 flex flex-col items-center justify-center gap-2 text-center">
          <BarChart2 size={24} style={{ color: 'var(--ink-500)' }} />
          <p className="text-sm" style={{ color: 'var(--ink-400)' }}>Select a location or incident type above to see response metrics</p>
        </div>
      ) : (
        <>
          {/* Metric summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="card p-4">
              <div className="label-micro mb-2">Matched Events</div>
              <div className="numeric-mono text-2xl font-semibold" style={{ color: 'var(--ink-100)' }}>
                {matchedIncidents.length}
              </div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--ink-500)' }}>total incidents</div>
            </div>

            <div className="card p-4">
              <div className="label-micro mb-2">Avg Time to Arrive</div>
              {stats.avgArrival != null ? (
                <>
                  <div className="numeric-mono text-2xl font-semibold" style={{ color: 'var(--nr-orange)' }}>
                    {fmtMins(stats.avgArrival)}
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--ink-500)' }}>
                    from {stats.arrivalN} of {matchedIncidents.length} events
                  </div>
                </>
              ) : (
                <>
                  <div className="numeric-mono text-2xl" style={{ color: 'var(--ink-500)' }}>—</div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--ink-500)' }}>no arrival data</div>
                </>
              )}
            </div>

            <div className="card p-4">
              <div className="label-micro mb-2">Avg Time to Restore</div>
              {stats.avgDuration != null ? (
                <>
                  <div className="numeric-mono text-2xl font-semibold" style={{ color: 'var(--nr-steel)' }}>
                    {fmtMins(stats.avgDuration)}
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--ink-500)' }}>
                    from {stats.durationN} of {matchedIncidents.length} events
                  </div>
                </>
              ) : (
                <>
                  <div className="numeric-mono text-2xl" style={{ color: 'var(--ink-500)' }}>—</div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--ink-500)' }}>no duration data</div>
                </>
              )}
            </div>

            <div className="card p-4">
              <div className="label-micro mb-2">Total Delay</div>
              <div className="numeric-mono text-2xl font-semibold" style={{ color: 'var(--ink-100)' }}>
                {fmtMins(matchedIncidents.reduce((s, i) => s + i.minutes_delay, 0))}
              </div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--ink-500)' }}>cumulative delay minutes</div>
            </div>
          </div>

          {/* Matched events list */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="label-micro">Matched Events</div>
                <p className="text-xs mt-0.5" style={{ color: 'var(--ink-500)' }}>
                  {selectedLocation && selectedType
                    ? `${selectedType} · ${selectedLocation}`
                    : selectedLocation ?? selectedType}
                </p>
              </div>
              <span className="numeric-mono text-xs px-2 py-1 rounded border" style={{ color: 'var(--ink-400)', borderColor: 'var(--line)' }}>
                {matchedIncidents.length} event{matchedIncidents.length !== 1 ? 's' : ''}
              </span>
            </div>

            {matchedIncidents.length === 0 ? (
              <Empty msg="No incidents match this combination in the current window" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="label-micro border-b border-[var(--line)]">
                      <th className="text-left py-2 pr-3">Date</th>
                      <th className="text-left pr-3">Type</th>
                      <th className="text-left pr-3">Location</th>
                      <th className="text-left pr-3">Severity</th>
                      <th className="text-right pr-3">Arrival</th>
                      <th className="text-right pr-3">Duration</th>
                      <th className="text-right">Delay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matchedIncidents.map(inc => {
                      const cfg      = CATEGORY_CONFIG[inc.category]
                      const typeLabel = inc.incident_type_label ?? cfg?.label ?? inc.category
                      return (
                        <tr key={inc.id} className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--bg-card-hi)] transition-colors">
                          <td className="py-2 pr-3 numeric-mono" style={{ color: 'var(--ink-400)', whiteSpace: 'nowrap' }}>
                            {shortDate(inc.report_date)}
                          </td>
                          <td className="pr-3 max-w-[140px]">
                            <span
                              className="pill truncate block"
                              style={{ background: `${cfg.color}20`, color: cfg.color, borderColor: `${cfg.color}50` }}
                              title={typeLabel}
                            >
                              {typeLabel}
                            </span>
                          </td>
                          <td className="pr-3 truncate max-w-[160px]" style={{ color: 'var(--ink-300)' }} title={inc.location ?? undefined}>
                            {inc.location ?? '—'}
                          </td>
                          <td className="pr-3">
                            <span className={`pill pill-${inc.severity.toLowerCase()}`}>{inc.severity}</span>
                          </td>
                          <td className="text-right pr-3 numeric-mono" style={{ color: inc.mins_to_arrival != null ? 'var(--nr-orange)' : 'var(--ink-500)' }}>
                            {inc.mins_to_arrival != null ? fmtMins(inc.mins_to_arrival) : '—'}
                          </td>
                          <td className="text-right pr-3 numeric-mono" style={{ color: inc.incident_duration != null ? 'var(--nr-steel)' : 'var(--ink-500)' }}>
                            {inc.incident_duration != null ? fmtMins(inc.incident_duration) : '—'}
                          </td>
                          <td className="text-right numeric-mono" style={{ color: 'var(--ink-100)' }}>
                            {fmtMins(inc.minutes_delay)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
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
