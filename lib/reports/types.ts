// ─── Report plan: structured intermediate representation ─────────────────────
// The builder produces a ReportPlan from RawData + filters; the renderer turns
// that plan into a fully styled HTML document ready to print as a PDF.

import { IncidentCategory, IncidentRow, Severity } from '../types'

export type ReportTemplate =
  | 'period'        // Railway period (P/W) overview — strategic
  | 'weekly'        // 7-day brief — tactical
  | 'safety'        // Safety-critical roll-up with reviewed commentary
  | 'custom'        // Current dashboard window, every section

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
}

export const TEMPLATE_DEFAULT_SECTIONS: Record<ReportTemplate, ReportSectionId[]> = {
  period:  ['cover', 'executive', 'kpis', 'trend', 'categoryMix', 'geography', 'patterns', 'assets', 'safetyRadar', 'attribution', 'signals', 'narrative', 'appendix'],
  weekly:  ['cover', 'executive', 'kpis', 'trend', 'categoryMix', 'signals', 'narrative'],
  safety:  ['cover', 'executive', 'kpis', 'safetyRadar', 'geography', 'patterns', 'signals', 'narrative', 'appendix'],
  custom:  ['cover', 'executive', 'kpis', 'trend', 'categoryMix', 'geography', 'patterns', 'assets', 'safetyRadar', 'attribution', 'signals', 'narrative', 'appendix'],
}

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
}
