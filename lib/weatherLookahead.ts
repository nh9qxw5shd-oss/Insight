'use client'

import { getSupabase } from './supabase'

// ─── Operational weather statement (DLog2 weather_lookahead) ─────────────────
// The daily route weather classification the route was actually working to:
// ongoing rows come from the DLog2 daily report's 5 Day Look Ahead (source =
// 'report', day_offset 1–5); history was backfilled from the EM State of the
// Route WhatsApp morning messages (source = 'whatsapp', day_offset = 0).
// One row per calendar date — weather_date joins straight onto
// reports.report_date / incidents.report_date.
//
// Not to be confused with weather_daily, which holds observed Open-Meteo
// readings (lib/weather.ts). This table is the *forecast risk classification*.

export type WeatherLevel = 'GREEN' | 'AWARE' | 'ADVERSE' | 'EXTREME'

export interface WeatherLookaheadDay {
  weather_date:        string                              // YYYY-MM-DD (PK)
  east_midlands_level: WeatherLevel | null
  london_north_level:  WeatherLevel | null
  overall_level:       WeatherLevel | null                 // worst of the two regions
  east_midlands_risks: Record<string, WeatherLevel> | null // risk name → level
  london_north_risks:  Record<string, WeatherLevel> | null
  risk_types:          string[] | null                     // union of risk names across regions
  risk_note:           string | null                       // source statement text (tooltips / audit)
  source_report_date:  string | null
  source:              'report' | 'whatsapp' | null
  day_offset:          number | null                       // 0 = day-of statement, 1–5 = lookahead
}

// GREEN is the stored value; the route calls it "Normal" everywhere users see it.
export const WEATHER_LEVELS: WeatherLevel[] = ['GREEN', 'AWARE', 'ADVERSE', 'EXTREME']

export const WEATHER_LEVEL_CONFIG: Record<WeatherLevel, { label: string; color: string; rank: number }> = {
  GREEN:   { label: 'Normal',  color: '#27AE60', rank: 0 },
  AWARE:   { label: 'Aware',   color: '#F1C40F', rank: 1 },
  ADVERSE: { label: 'Adverse', color: '#E05206', rank: 2 },
  EXTREME: { label: 'Extreme', color: '#E74C3C', rank: 3 },
}

export function weatherLevelLabel(level: WeatherLevel | null): string {
  return level ? WEATHER_LEVEL_CONFIG[level]?.label ?? level : '—'
}

// Canonical risk-type strings exactly as stored in risk_types.
export const WEATHER_RISK_TYPES: string[] = [
  'Wind', 'Heavy Rain', 'Convective Rainfall', 'Lightning', 'Snow',
  'Frost', 'Min Temp', 'Max Temp', 'Temp Range', 'Ice Day',
]

// First date with a statement. Anything earlier has no row, so it drops out
// of scope whenever a weather-level / weather-risk filter is active.
export const LOOKAHEAD_COVERAGE_START = '2025-04-29'

const LOOKAHEAD_COLS =
  'weather_date, east_midlands_level, london_north_level, overall_level, ' +
  'east_midlands_risks, london_north_risks, risk_types, risk_note, ' +
  'source_report_date, source, day_offset'

export async function fetchWeatherLookahead(from: string, to: string): Promise<WeatherLookaheadDay[]> {
  const sb = getSupabase()
  if (!sb) return []
  // One row per date, ≤366 rows for the longest window — comfortably inside
  // the PostgREST server-side row cap, so no pagination needed.
  const { data, error } = await sb
    .from('weather_lookahead')
    .select(LOOKAHEAD_COLS)
    .gte('weather_date', from)
    .lte('weather_date', to)
    .order('weather_date', { ascending: true })
  if (error || !data) return []
  return data as unknown as WeatherLookaheadDay[]
}

// Short provenance line for tooltips — which statement a row came from.
export function lookaheadProvenance(d: WeatherLookaheadDay): string {
  if (d.source === 'whatsapp') return 'EM morning statement (day-of)'
  if (d.source === 'report') {
    const offset = d.day_offset != null && d.day_offset > 0 ? ` +${d.day_offset}d` : ''
    return `DLog2 report 5-day lookahead${d.source_report_date ? ` (${d.source_report_date}${offset})` : offset}`
  }
  return 'unknown source'
}

// Does this date's statement satisfy the active weather filters? Levels match
// on overall_level; risks match `risk IN risk_types` (multiple selections OR
// together). A date with no row never qualifies while a filter is active.
export function lookaheadDayQualifies(
  day: WeatherLookaheadDay | undefined,
  levels: WeatherLevel[],
  risks: string[],
): boolean {
  if (!day) return false
  if (levels.length && (day.overall_level == null || !levels.includes(day.overall_level))) return false
  if (risks.length && !risks.some(r => (day.risk_types ?? []).includes(r))) return false
  return true
}
