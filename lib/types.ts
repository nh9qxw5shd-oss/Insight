// ─── Shared types (kept narrow — only what analytics consumes) ───────────────

export type IncidentCategory =
  | 'FATALITY' | 'PERSON_STRUCK' | 'SPAD' | 'TPWS'
  | 'IRREGULAR_WORKING' | 'BRIDGE_STRIKE' | 'NEAR_MISS'
  | 'LEVEL_CROSSING' | 'FIRE' | 'CRIME'
  | 'INFRASTRUCTURE' | 'TRACTION_FAILURE' | 'TRAIN_FAULT'
  | 'DERAILMENT' | 'POSSESSION' | 'STATION_OVERRUN'
  | 'PASSENGER_INJURY' | 'HABD_WILD' | 'STRANDED_TRAIN'
  | 'WEATHER' | 'GENERAL'

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'

export type ChartKind = 'line' | 'area' | 'bar'

export type DistributionKind = 'donut' | 'bar' | 'treemap'

export interface IncidentRow {
  id: string
  report_date: string
  report_id: string
  ccil: string | null
  category: IncidentCategory
  severity: Severity
  title: string | null
  location: string | null
  area: string | null
  incident_start: string | null
  minutes_delay: number
  trains_delayed: number
  cancelled: number
  part_cancelled: number
  is_highlight: boolean
  is_continuation: boolean
  delay_delta: number | null

  // Extended capture (all nullable for legacy rows)
  incident_type_code: string | null
  incident_type_label: string | null
  line: string | null
  fault_number: string | null
  possession_ref: string | null
  btp_ref: string | null
  third_party_ref: string | null
  action_code: string | null
  responder_initials: string[] | null
  advised_time: string | null
  initial_resp_time: string | null
  arrived_at_time: string | null
  nwr_time: string | null
  mins_to_advised: number | null
  mins_to_response: number | null
  mins_to_arrival: number | null
  incident_duration: number | null
  train_id: string | null
  train_company: string | null
  train_origin: string | null
  train_destination: string | null
  unit_numbers: string[] | null
  trust_ref: string | null
  tda_ref: string | null
  trmc_code: string | null
  fts_div_count: number | null
  event_count: number | null
  has_files: boolean | null
  hour_of_day: number | null
  day_of_week: number | null
}

export interface ReportRow {
  id: string
  report_date: string
  period: string | null
  control_centre: string | null
  created_by: string | null
  total_delay: number
  total_cancelled: number
  total_part_cancelled: number
  incident_count: number
}

// ─── Filter shape used everywhere ────────────────────────────────────────────

export interface AnalyticsFilters {
  windowDays: number              // 7 | 30 | 90 | 180 | 365 (or custom)
  startDate?: string              // YYYY-MM-DD (overrides windowDays)
  endDate?: string
  areas: string[]                 // empty = all
  categories: IncidentCategory[]  // empty = all
  severities: Severity[]          // empty = all
  search: string                  // free-text title / location / fault
}

export const DEFAULT_FILTERS: AnalyticsFilters = {
  windowDays: 30,
  areas: [],
  categories: [],
  severities: [],
  search: '',
}

// ─── Category visual config (mirrors DLog2 master) ───────────────────────────

export const CATEGORY_CONFIG: Record<IncidentCategory, {
  label: string
  short: string
  color: string
  group: 'safety' | 'performance' | 'asset' | 'other'
}> = {
  FATALITY:          { label: 'Fatality / Person Struck',  short: 'FATAL',   color: '#E74C3C', group: 'safety' },
  PERSON_STRUCK:     { label: 'Person Struck by Train',    short: 'PST',     color: '#E74C3C', group: 'safety' },
  SPAD:              { label: 'Signal Passed at Danger',   short: 'SPAD',    color: '#E05206', group: 'safety' },
  TPWS:              { label: 'TPWS Activation',           short: 'TPWS',    color: '#F47A3D', group: 'safety' },
  IRREGULAR_WORKING: { label: 'Irregular Working',         short: 'IRR',     color: '#F39C12', group: 'safety' },
  BRIDGE_STRIKE:     { label: 'Bridge Strike',             short: 'BSTR',    color: '#F39C12', group: 'safety' },
  NEAR_MISS:         { label: 'Near Miss',                 short: 'NM',      color: '#FBBF24', group: 'safety' },
  HABD_WILD:         { label: 'HABD / WILD Activation',    short: 'HABD',    color: '#FBBF24', group: 'safety' },
  CRIME:             { label: 'Railway Crime / Trespass',  short: 'CRIME',   color: '#9B59B6', group: 'safety' },
  LEVEL_CROSSING:    { label: 'Level Crossing',            short: 'LC',      color: '#E05206', group: 'safety' },
  FIRE:              { label: 'Fire',                      short: 'FIRE',    color: '#E74C3C', group: 'safety' },
  PASSENGER_INJURY:  { label: 'Passenger / Public Injury', short: 'PAX',     color: '#E05206', group: 'safety' },
  DERAILMENT:        { label: 'Derailment / Collision',    short: 'DERL',    color: '#E74C3C', group: 'safety' },
  INFRASTRUCTURE:    { label: 'Infrastructure Failure',    short: 'INFRA',   color: '#4A6FA5', group: 'asset'  },
  TRACTION_FAILURE:  { label: 'OHL / Traction Current',    short: 'OLE',     color: '#4A6FA5', group: 'asset'  },
  TRAIN_FAULT:       { label: 'Train Fault / Failure',     short: 'TFLT',    color: '#6B7FA5', group: 'asset'  },
  POSSESSION:        { label: 'Possession Issue',          short: 'POSS',    color: '#5B7FA8', group: 'asset'  },
  STATION_OVERRUN:   { label: 'Station Overrun',           short: 'OVRUN',   color: '#7A8BA8', group: 'performance' },
  STRANDED_TRAIN:    { label: 'Stranded Train',            short: 'STRAND',  color: '#7A8BA8', group: 'performance' },
  WEATHER:           { label: 'Weather Event',             short: 'WX',      color: '#85A3C7', group: 'other' },
  GENERAL:           { label: 'General / Other',           short: 'GEN',     color: '#A9B5C9', group: 'other' },
}

export const SEVERITY_CONFIG: Record<Severity, { color: string; rank: number }> = {
  CRITICAL: { color: '#E74C3C', rank: 0 },
  HIGH:     { color: '#E05206', rank: 1 },
  MEDIUM:   { color: '#F39C12', rank: 2 },
  LOW:      { color: '#5B7FA8', rank: 3 },
  INFO:     { color: '#7A8BA8', rank: 4 },
}

export const SAFETY_CATEGORIES: IncidentCategory[] = [
  'FATALITY', 'PERSON_STRUCK', 'SPAD', 'TPWS',
  'NEAR_MISS', 'BRIDGE_STRIKE', 'LEVEL_CROSSING',
  'IRREGULAR_WORKING', 'FIRE', 'DERAILMENT',
]

// Focused safety categories for repeat-asset and operational safety views
export const INFRA_SAFETY_CATEGORIES: IncidentCategory[] = [
  'NEAR_MISS', 'IRREGULAR_WORKING', 'TPWS', 'SPAD', 'PERSON_STRUCK',
]

// Categories included in the Repeat-Fault Assets view
export const REPEAT_ASSET_CATEGORIES: IncidentCategory[] = [
  'INFRASTRUCTURE', 'TRACTION_FAILURE', 'LEVEL_CROSSING',
  'NEAR_MISS', 'IRREGULAR_WORKING', 'TPWS', 'SPAD', 'PERSON_STRUCK',
]

// Categories included in the Infrastructure failure mix (NR-managed assets only)
export const INFRA_MIX_CATEGORIES: IncidentCategory[] = [
  'INFRASTRUCTURE', 'TRACTION_FAILURE',
]

export const TIME_WINDOWS = [
  { label: '7d',   days: 7   },
  { label: '30d',  days: 30  },
  { label: '90d',  days: 90  },
  { label: '6m',   days: 180 },
  { label: '1y',   days: 365 },
] as const

// ─── Derived shapes used by the dashboard ────────────────────────────────────

export interface KPISummary {
  totalIncidents: number
  totalDelayMins: number
  totalCancelled: number
  totalPartCancelled: number
  avgIncidentDuration: number | null   // mean of incident_duration where present
  medianResponseMins: number | null    // median of mins_to_response
  safetyCriticalCount: number
  reportsCovered: number

  // % deltas vs the previous equivalent window (null when prev window empty)
  delayDeltaPct: number | null
  incidentsDeltaPct: number | null
  safetyDeltaPct: number | null
  durationDeltaPct: number | null
}

export interface TrendPoint {
  date: string
  incidents: number
  delayMins: number
  safetyCritical: number
}

export interface CategoryDatum {
  category: IncidentCategory
  label: string
  short: string
  color: string
  count: number
  delayMins: number
}

export interface LocationDatum {
  location: string
  area: string | null
  count: number
  delayMins: number
}

export interface RepeatFault {
  faultNumber: string
  occurrences: number
  totalDelay: number
  locations: string[]
  firstSeen: string
  lastSeen: string
  category: IncidentCategory
}

export interface RepeatAsset {
  assetKey: string          // "Points Failure — Derby Station"
  assetType: string         // incident_type_label
  location: string
  occurrences: number
  totalDelay: number
  category: IncidentCategory
  firstSeen: string
  lastSeen: string
}

export interface InfraFailureDatum {
  typeCode: string
  typeLabel: string
  count: number
  delayMins: number
  color: string
}

export interface DelayDensityDatum {
  location: string
  area: string | null
  incidentCount: number
  avgDelayDensity: number   // mean(delay_mins / incident_duration) — delay-minutes per rectification-minute
  totalDelay: number
}

export interface ResponderLoad {
  initials: string
  incidentCount: number
  totalDelay: number
}

export interface OperatorImpact {
  company: string
  trainCount: number
  delayMins: number
  cancellations: number
}

export interface HeatmapCell {
  dow: number   // 0..6 (Sun..Sat)
  hour: number  // 0..23
  count: number
}
