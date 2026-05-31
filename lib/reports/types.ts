// ─── Report plan: structured intermediate representation ─────────────────────
// The builder produces a ReportPlan from RawData + filters; the renderer turns
// that plan into a fully styled HTML document ready to print as a PDF.

import { IncidentCategory, IncidentReview, IncidentRow, Severity } from '../types'
import type { RecoveryTrendPoint } from '../queries'
export type { RecoveryTrendPoint }

export type ReportTemplate =
  | 'period'        // Railway period (P/W) overview — strategic
  | 'weekly'        // 7-day brief — tactical
  | 'safety'        // Safety-critical roll-up with reviewed commentary
  | 'custom'        // Current dashboard window, every section
  | 'controlPmc'    // Control PMC weekly KPI roll-up by topic

export const REPORT_TEMPLATES: { id: ReportTemplate; name: string; subtitle: string; tagline: string }[] = [
  { id: 'period',  name: 'Period Report',
    subtitle: 'Strategic',
    tagline: 'Full railway period (P/W) summary — KPIs, trend, hotspots, asset failures, narrative.' },
  { id: 'weekly',  name: 'Weekly Brief',
    subtitle: 'Tactical',
    tagline: 'Top-line metrics, key signals, and standout days from the most recent seven days.' },
  { id: 'safety',  name: 'Safety Roll-up',
    subtitle: 'Operational',
    tagline: 'Safety-critical incidents only — radar comparison, location clusters, reviewed commentary.' },
  { id: 'controlPmc', name: 'Control PMC',
    subtitle: 'Weekly · Control',
    tagline: 'Weekly Control PMC roll-up by topic — fatalities, stranded trains, irregular working, PAX, train faults, ITSR adherence and (later) passenger satisfaction.' },
  { id: 'custom',  name: 'Custom Range Report',
    subtitle: 'Bespoke',
    tagline: 'Uses the dashboard\'s current filter window. Toggle individual sections in or out.' },
]

export type ReportSectionId =
  | 'cover'
  | 'executive'
  | 'kpis'
  | 'trend'
  | 'categoryMix'
  | 'safetyRadar'
  | 'geography'
  | 'patterns'
  | 'assets'
  | 'attribution'
  | 'signals'
  | 'narrative'
  | 'appendix'
  // Control PMC sections — each one corresponds to a single KPI topic in the
  // weekly Control PMC pack (one section per topic).
  | 'pmcSummary'
  | 'pmcFatalities'
  | 'pmcStranded'
  | 'pmcRecoveryTrend'
  | 'pmcIrregular'
  | 'pmcPax'
  | 'pmcTrainFaults'
  | 'pmcItsr'
  | 'pmcSatisfaction'
  | 'pmcTopDelay'

export const SECTION_LABELS: Record<ReportSectionId, string> = {
  cover:        'Cover page',
  executive:    'Executive summary',
  kpis:         'Headline KPIs',
  trend:        'Trend & change-points',
  categoryMix:  'Category mix',
  safetyRadar:  'Safety profile vs prior',
  geography:    'Geography & hotspots',
  patterns:     'Day × hour patterns',
  assets:       'Repeat assets',
  attribution:  'Delay attribution',
  signals:      'Anomalies & signals',
  narrative:    'Findings & guidance',
  appendix:     'Incident appendix',
  pmcSummary:         'PMC week summary',
  pmcFatalities:      'Fatalities · Person Struck',
  pmcStranded:        'Stranded train incidents',
  pmcRecoveryTrend:   'Recovery trend (periodic)',
  pmcIrregular:       'Irregular working',
  pmcPax:          'PAX incidents (top 10)',
  pmcTrainFaults:  'Train faults (>200m + top 5)',
  pmcItsr:         'ITSR adherence (>300m)',
  pmcSatisfaction: 'Passenger satisfaction',
  pmcTopDelay:     'Top 5 delay incidents (deep-dive)',
}

export const TEMPLATE_DEFAULT_SECTIONS: Record<ReportTemplate, ReportSectionId[]> = {
  period:  ['cover', 'executive', 'kpis', 'trend', 'categoryMix', 'geography', 'patterns', 'assets', 'safetyRadar', 'attribution', 'signals', 'narrative', 'appendix'],
  weekly:  ['cover', 'executive', 'kpis', 'trend', 'categoryMix', 'signals', 'narrative'],
  safety:  ['cover', 'executive', 'kpis', 'safetyRadar', 'geography', 'patterns', 'signals', 'narrative', 'appendix'],
  custom:  ['cover', 'executive', 'kpis', 'trend', 'categoryMix', 'geography', 'patterns', 'assets', 'safetyRadar', 'attribution', 'signals', 'narrative', 'appendix'],
  controlPmc: ['cover', 'pmcSummary', 'pmcFatalities', 'pmcStranded', 'pmcRecoveryTrend', 'pmcIrregular', 'pmcPax', 'pmcTrainFaults', 'pmcItsr', 'pmcSatisfaction', 'pmcTopDelay'],
}

// Sections selectable in the Control PMC builder UI — kept narrow so the
// section toggle row only shows topics that belong to this template.
export const CONTROL_PMC_SECTIONS: ReportSectionId[] = [
  'cover', 'pmcSummary', 'pmcFatalities', 'pmcStranded', 'pmcRecoveryTrend',
  'pmcIrregular', 'pmcPax', 'pmcTrainFaults', 'pmcItsr', 'pmcSatisfaction', 'pmcTopDelay',
]

// Sections selectable in the legacy templates (period / weekly / safety /
// custom) — excludes the Control PMC topic sections.
export const STANDARD_TEMPLATE_SECTIONS: ReportSectionId[] = [
  'cover', 'executive', 'kpis', 'trend', 'categoryMix', 'geography',
  'patterns', 'safetyRadar', 'assets', 'attribution', 'signals', 'narrative', 'appendix',
]

export interface ReportMeta {
  template:    ReportTemplate
  templateName: string
  scopeLabel:  string         // "P02 · W3 → W4 · 2025/26", "Last 7 days", "7 Apr → 6 May 2025"
  windowFrom:  string         // ISO date
  windowTo:    string
  windowDays:  number
  generatedAt: string         // ISO timestamp
  filtersDescriptor: string   // human-readable filter summary (e.g. "Filtered: Derby, Leicester · Categories: SPAD, TPWS")
  demoMode:    boolean
}

export interface ReportKpi {
  label:    string
  value:    string
  delta?:   { signedPct: number | null; deltaInverted: boolean; label: string }
  critical?: boolean
  hint?:    string            // small subtitle under the value
}

export interface CategoryRow {
  category: IncidentCategory
  label:    string
  short:    string
  color:    string
  count:    number
  delayMins: number
  share:    number            // 0..1
}

export interface GeoRow {
  location:  string
  area:      string | null
  count:     number
  delayMins: number
  topCategory: { label: string; color: string } | null
}

export interface AssetRow {
  assetType:    string
  location:     string
  occurrences:  number
  totalDelay:   number
  firstSeen:    string
  lastSeen:     string
  category:     IncidentCategory
}

export interface SignalRow {
  severity: 'critical' | 'warning' | 'info'
  title:    string
  detail:   string
  date?:    string
}

export interface ChangePointRow {
  date:      string
  direction: 'up' | 'down'
  metric:    'incidents' | 'delayMins'
  beforeMean: number
  afterMean:  number
}

export interface SafetyRadarRow {
  category: IncidentCategory
  label:    string
  short:    string
  color:    string
  current:  number
  previous: number
}

export interface AttributionRow {
  label: string
  code:  string
  incidentCount: number
  totalDelay:    number
  pct:           number
}

export interface AppendixRow {
  date:        string
  ccil:        string | null
  category:    IncidentCategory
  categoryShort: string
  categoryColor: string
  severity:    Severity
  title:       string
  location:    string | null
  area:        string | null
  delayMins:   number
  duration:    number | null
  arrival:     number | null
}

export interface TrendPointPlain {
  date:           string
  incidents:      number
  delayMins:      number
  safetyCritical: number
  rolling7Avg?:   number
}

export interface HeatmapCellPlain {
  dow:   number   // 0..6
  hour:  number   // 0..23
  count: number
}

// ─── Control PMC topic plans ─────────────────────────────────────────────────
// Each KPI topic in the Control PMC pack shares the same shape: a header card
// of summary stats, a per-location breakdown, and a per-incident table with
// CCIL / TDA references. Some topics ride on top of incident-review fields
// (stranded trains, ITSR adherence) so they may be empty in demo mode.

export interface PmcIncidentRow {
  date:        string
  ccil:        string | null
  tda:         string | null
  category:    IncidentCategory
  categoryShort: string
  categoryColor: string
  title:       string | null
  location:    string | null
  area:        string | null
  delayMins:   number
  trainsDelayed: number
  cancelled:   number
  partCancelled: number
  // Topic-specific notes the renderer can surface inline.
  note?:       string | null
}

export interface PmcLocationRow {
  location:    string
  area:        string | null
  count:       number
  delayMins:   number
}

export interface PmcTopicSummary {
  count:        number               // distinct (non-continuation) incidents in scope
  prevCount:    number
  countDeltaPct: number | null
  delayMins:    number
  prevDelay:    number
  delayDeltaPct: number | null
  uniqueLocations: number
  uniqueCcil:   number
  uniqueTda:    number
}

export interface PmcTopicPlan {
  topic:       string                // human label
  summary:     PmcTopicSummary
  locations:   PmcLocationRow[]      // top locations by delay
  incidents:   PmcIncidentRow[]      // table rows
  // Optional secondary table for two-section topics (e.g. train faults split,
  // ITSR did-have / didn't-have). When present, the renderer shows two tables.
  secondary?: {
    title:     string
    incidents: PmcIncidentRow[]
  }
  // Topic-level callouts / insights, e.g. "all 3 fatalities were near-miss".
  insights:    string[]
  // Free-text status (e.g. "data not yet captured — implementation pending").
  status?:     string
}

export interface PmcItsrPlan extends PmcTopicPlan {
  // ITSR-specific roll-up. The 300-min threshold is the policy gate.
  itsrPct:        number               // pct of >300m incidents that had ITSR completed
  itsrCount:      number               // total >300m incidents
  itsrCompleted:  number               // those with itsr_required = YES on the review
  itsrMissing:    number               // those without ITSR
  itsrUnreviewed: number               // those with no review at all
}

// Single matching incident found in the 6-month history alongside one of the
// top-5 events — kept compact since each top-5 entry can carry several.
export interface PmcRepeatMatch {
  id:           string
  date:         string
  ccil:         string | null
  title:        string | null
  delayMins:    number
  location:     string | null
  area:         string | null
  matchedOn:    'fault' | 'location-type'  // why this row was considered a repeat
}

// Full data the deep-dive page wants to surface for each top-5 incident —
// covers operational context, references, response timings and any repeat
// matches uncovered in the trailing 6 months.
export interface PmcTopDelayDetail {
  // Headline / identity
  id:                string
  date:              string
  ccil:              string | null
  tda:               string | null
  category:          IncidentCategory
  categoryLabel:     string
  categoryShort:     string
  categoryColor:     string
  severity:          Severity
  title:             string | null
  location:          string | null
  area:              string | null
  line:              string | null
  // Impact
  delayMins:         number
  trainsDelayed:     number
  cancelled:         number
  partCancelled:     number
  // Operational context
  incidentStart:     string | null
  advisedTime:       string | null
  initialRespTime:   string | null
  arrivedAtTime:     string | null
  nwrTime:           string | null
  minsToAdvised:     number | null
  minsToResponse:    number | null
  minsToArrival:     number | null
  incidentDuration:  number | null
  // Asset / reference
  incidentTypeCode:  string | null
  incidentTypeLabel: string | null
  faultNumber:       string | null
  possessionRef:     string | null
  btpRef:            string | null
  thirdPartyRef:     string | null
  trustRef:          string | null
  tdaRef:            string | null
  trmcCode:          string | null
  actionCode:        string | null
  responderInitials: string[] | null
  // Train context
  trainId:           string | null
  trainCompany:      string | null
  trainOrigin:       string | null
  trainDestination:  string | null
  unitNumbers:       string[] | null
  // Misc
  eventCount:        number | null
  ftsDivCount:       number | null
  hasFiles:          boolean | null
  hourOfDay:         number | null
  dayOfWeek:         number | null
  // Repeats in the trailing 6-month window
  matches:           PmcRepeatMatch[]
  matchNote:         string           // human summary of what was matched on
}

export interface PmcTopDelayPlan {
  topic:        string
  windowFrom:   string                 // ISO date the historical search starts from
  windowTo:     string                 // ISO date the historical search ends on
  incidents:    PmcTopDelayDetail[]    // up to 5 rows, sorted by delay desc
  insights:     string[]
}

export interface ControlPmcPlan {
  fatalities:    PmcTopicPlan
  stranded:      PmcTopicPlan
  irregular:     PmcTopicPlan
  pax:           PmcTopicPlan
  trainFaults:   PmcTopicPlan          // primary >200m, secondary top 5 below 200m
  itsr:          PmcItsrPlan
  satisfaction:  PmcTopicPlan          // placeholder topic
  topDelay:      PmcTopDelayPlan       // top 5 highest-delay incidents (deep-dive)
  // Periodic recovery trend — avg time to recover and avg time stranded per period.
  recoveryTrend: RecoveryTrendPoint[]
  // Headline KPIs surfaced in the PMC summary section / cover.
  headline:      ReportKpi[]
}

export interface ReportPlan {
  meta:        ReportMeta
  sections:    ReportSectionId[]
  // Section payloads — all optional, only present when the section is enabled
  // and the underlying data exists.
  kpis?:           ReportKpi[]
  trend?:          { points: TrendPointPlain[]; changePoints: ChangePointRow[] }
  categories?:     CategoryRow[]
  safetyRadar?:    SafetyRadarRow[]
  geography?:      GeoRow[]
  heatmap?:        HeatmapCellPlain[]
  assets?:         AssetRow[]
  attribution?:    AttributionRow[]
  signals?:        SignalRow[]
  narrative?:      { headline: string; paragraphs: string[]; bullets: { kind: 'positive' | 'warning' | 'neutral'; text: string }[] }
  executive?:      string                  // 2–3 sentence summary
  appendix?:       AppendixRow[]
  // Control PMC composite payload — only set when template === 'controlPmc'.
  controlPmc?:     ControlPmcPlan
  // Heroes shown on the cover even if KPI section is disabled
  heroKpis?:       ReportKpi[]
}

export interface ReportOptions {
  template:  ReportTemplate
  sections:  ReportSectionId[]
  // Optional appendix cap — surface only the top-N highest-delay incidents
  appendixLimit: number
  // Optional client / brand line that appears under the title block
  clientLine: string
  // Author shown in footer
  preparedBy: string
}

export const DEFAULT_OPTIONS = (template: ReportTemplate): ReportOptions => ({
  template,
  sections: TEMPLATE_DEFAULT_SECTIONS[template],
  appendixLimit: 40,
  clientLine:    'Network Rail · East Midlands Control Centre',
  preparedBy:    'EMCC Insight',
})

// Source bundle the builder consumes. Filled by the page from already-derived
// analytics so reports don't need a second fetch pass.
export interface ReportSource {
  filtersDescriptor: string
  windowFrom:        string
  windowTo:          string
  windowDays:        number
  demoMode:          boolean
  incidents:         IncidentRow[]
  prevIncidents:     IncidentRow[]
  // Reviews keyed by incident id — required for the Control PMC template
  // (stranded train detection, ITSR adherence). Optional for other templates.
  reviews?:          IncidentReview[]
  prevReviews?:      IncidentReview[]
  // Trailing-6-month incidents used by the Control PMC top-5 deep-dive to look
  // up repeat issues at the same location / asset type. May span the current
  // week too — the builder excludes the target incident itself.
  historicalIncidents?: IncidentRow[]
  // Trailing-6-month reviews for the recovery trend charts (time to recover +
  // time stranded by period). Same window as historicalIncidents.
  historicalReviews?: IncidentReview[]
}
