'use client'

import { getSupabase } from './supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WeatherDay {
  area:         string
  date:         string        // YYYY-MM-DD
  min_temp_c:   number | null
  max_temp_c:   number | null
  rainfall_mm:  number | null
  max_wind_kmh: number | null
  wind_dir_deg: number | null
  weather_code: number | null
  conditions:   string | null
  is_forecast:  boolean
}

export interface WeatherLocation {
  area: string
  name: string  // representative station / town name
  lat:  number
  lon:  number
}

// ─── Route locations ──────────────────────────────────────────────────────────
// One representative weather point per EMCC area, aligned with incident.area values.

export const WEATHER_LOCATIONS: WeatherLocation[] = [
  { area: 'E - EM - Bedford',    name: 'Bedford',    lat: 52.136, lon: -0.467 },
  { area: 'E - EM - Leicester',  name: 'Leicester',  lat: 52.636, lon: -1.133 },
  { area: 'E - EM - Nottingham', name: 'Nottingham', lat: 52.954, lon: -1.158 },
  { area: 'E - EM - Derby',      name: 'Derby',      lat: 52.921, lon: -1.476 },
  { area: 'E - EM - Lincoln',    name: 'Lincoln',    lat: 53.234, lon: -0.538 },
  { area: 'E - EM - Route Wide', name: 'Kettering',  lat: 52.396, lon: -0.727 },
]

// ─── WMO weather code decoder ─────────────────────────────────────────────────
// WMO Weather Interpretation Codes → human label + emoji + severity tier.
// Gaps in the spec are filled by the nearest lower defined code.

interface WMOEntry { label: string; emoji: string; severity: 'normal' | 'moderate' | 'severe' }

const WMO_TABLE: Record<number, WMOEntry> = {
  0:  { label: 'Clear',               emoji: '☀️',  severity: 'normal' },
  1:  { label: 'Mainly Clear',        emoji: '🌤️', severity: 'normal' },
  2:  { label: 'Partly Cloudy',       emoji: '⛅',  severity: 'normal' },
  3:  { label: 'Overcast',            emoji: '☁️',  severity: 'normal' },
  45: { label: 'Fog',                 emoji: '🌫️', severity: 'moderate' },
  48: { label: 'Freezing Fog',        emoji: '🌫️', severity: 'moderate' },
  51: { label: 'Light Drizzle',       emoji: '🌦️', severity: 'normal' },
  53: { label: 'Drizzle',             emoji: '🌦️', severity: 'normal' },
  55: { label: 'Heavy Drizzle',       emoji: '🌦️', severity: 'moderate' },
  56: { label: 'Freezing Drizzle',    emoji: '🌧️', severity: 'moderate' },
  57: { label: 'Heavy Freezing Drizzle', emoji: '🌧️', severity: 'severe' },
  61: { label: 'Light Rain',          emoji: '🌧️', severity: 'normal' },
  63: { label: 'Rain',                emoji: '🌧️', severity: 'moderate' },
  65: { label: 'Heavy Rain',          emoji: '🌧️', severity: 'moderate' },
  66: { label: 'Freezing Rain',       emoji: '🌧️', severity: 'severe' },
  67: { label: 'Heavy Freezing Rain', emoji: '🌧️', severity: 'severe' },
  71: { label: 'Light Snow',          emoji: '❄️',  severity: 'moderate' },
  73: { label: 'Snow',                emoji: '❄️',  severity: 'severe' },
  75: { label: 'Heavy Snow',          emoji: '❄️',  severity: 'severe' },
  77: { label: 'Snow Grains',         emoji: '❄️',  severity: 'moderate' },
  80: { label: 'Light Showers',       emoji: '🌦️', severity: 'normal' },
  81: { label: 'Showers',             emoji: '🌦️', severity: 'moderate' },
  82: { label: 'Heavy Showers',       emoji: '🌦️', severity: 'moderate' },
  85: { label: 'Light Snow Showers',  emoji: '🌨️', severity: 'moderate' },
  86: { label: 'Snow Showers',        emoji: '🌨️', severity: 'severe' },
  95: { label: 'Thunderstorm',        emoji: '⛈️',  severity: 'severe' },
  96: { label: 'Thunderstorm + Hail', emoji: '⛈️',  severity: 'severe' },
  99: { label: 'Severe Thunderstorm', emoji: '⛈️',  severity: 'severe' },
}

const WMO_CODES_DESC = Object.keys(WMO_TABLE).map(Number).sort((a, b) => b - a)

export function decodeWeather(code: number | null): WMOEntry {
  if (code == null) return { label: 'Unknown', emoji: '—', severity: 'normal' }
  const match = WMO_CODES_DESC.find(k => k <= code)
  return match != null ? WMO_TABLE[match] : { label: 'Unknown', emoji: '—', severity: 'normal' }
}

// Grouped condition labels for filter chips — keeps the filter UI manageable
export const CONDITION_GROUPS: { label: string; conditions: string[] }[] = [
  { label: 'Clear / Dry',      conditions: ['Clear', 'Mainly Clear', 'Partly Cloudy', 'Overcast'] },
  { label: 'Fog',              conditions: ['Fog', 'Freezing Fog'] },
  { label: 'Rain',             conditions: ['Light Rain', 'Rain', 'Heavy Rain', 'Light Drizzle', 'Drizzle', 'Heavy Drizzle', 'Light Showers', 'Showers', 'Heavy Showers'] },
  { label: 'Freezing',         conditions: ['Freezing Rain', 'Heavy Freezing Rain', 'Freezing Drizzle', 'Heavy Freezing Drizzle'] },
  { label: 'Snow',             conditions: ['Light Snow', 'Snow', 'Heavy Snow', 'Snow Grains', 'Light Snow Showers', 'Snow Showers'] },
  { label: 'Thunderstorm',     conditions: ['Thunderstorm', 'Thunderstorm + Hail', 'Severe Thunderstorm'] },
]

// Resolve an incident-day condition label to its group label
export function conditionGroup(conditions: string | null): string {
  if (!conditions) return 'Unknown'
  for (const g of CONDITION_GROUPS) {
    if (g.conditions.includes(conditions)) return g.label
  }
  return conditions
}

// ─── Open-Meteo fetch ─────────────────────────────────────────────────────────

const DAILY_PARAMS = [
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'windspeed_10m_max',
  'winddirection_10m_dominant',
  'weathercode',
].join(',')

async function openMeteoFetch(loc: WeatherLocation, from: string, to: string): Promise<any> {
  const today = new Date().toISOString().slice(0, 10)
  let url: string

  if (to <= today) {
    url = `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${from}&end_date=${to}&daily=${DAILY_PARAMS}&timezone=Europe%2FLondon`
  } else {
    // Forecast endpoint; request max 16 days and slice to requested range
    url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=${DAILY_PARAMS}&timezone=Europe%2FLondon&forecast_days=16`
  }

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Open-Meteo ${res.status} for ${loc.name}`)
  return res.json()
}

export async function fetchWeatherForArea(
  area: string,
  from: string,
  to: string,
): Promise<WeatherDay[]> {
  const loc = WEATHER_LOCATIONS.find(l => l.area === area)
  if (!loc) return []

  const today = new Date().toISOString().slice(0, 10)
  const data  = await openMeteoFetch(loc, from, to)
  const times: string[] = data.daily?.time ?? []

  return times
    .filter(date => date >= from && date <= to)
    .map((date, i) => {
      const code = data.daily.weathercode?.[i] ?? null
      return {
        area,
        date,
        max_temp_c:   data.daily.temperature_2m_max?.[i]         ?? null,
        min_temp_c:   data.daily.temperature_2m_min?.[i]         ?? null,
        rainfall_mm:  data.daily.precipitation_sum?.[i]           ?? null,
        max_wind_kmh: data.daily.windspeed_10m_max?.[i]          ?? null,
        wind_dir_deg: data.daily.winddirection_10m_dominant?.[i] ?? null,
        weather_code: code,
        conditions:   decodeWeather(code).label,
        is_forecast:  date > today,
      }
    })
}

// ─── Supabase read / write ────────────────────────────────────────────────────

const WEATHER_COLS = 'area, date, min_temp_c, max_temp_c, rainfall_mm, max_wind_kmh, wind_dir_deg, weather_code, conditions, is_forecast'

export async function fetchWeatherFromDB(from: string, to: string): Promise<WeatherDay[]> {
  const sb = getSupabase()
  if (!sb) return []
  const { data, error } = await sb
    .from('weather_daily')
    .select(WEATHER_COLS)
    .gte('date', from)
    .lte('date', to)
    .order('date', { ascending: true })
  if (error || !data) return []
  return data as WeatherDay[]
}

export async function upsertWeatherDays(days: WeatherDay[]): Promise<void> {
  const sb = getSupabase()
  if (!sb || !days.length) return
  await sb
    .from('weather_daily')
    .upsert(
      days.map(d => ({ ...d, fetched_at: new Date().toISOString() })),
      { onConflict: 'area,date' },
    )
}

// ─── Gap detection ────────────────────────────────────────────────────────────
// Returns contiguous date ranges that are missing from the existing DB records.
// One range per area — keeps API calls to a minimum (one call per gap per area).

export function findMissingDays(
  existing: WeatherDay[],
  areas: string[],
  from: string,
  to: string,
): { area: string; from: string; to: string }[] {
  const existingKeys = new Set(existing.map(w => `${w.area}::${w.date}`))
  const results: { area: string; from: string; to: string }[] = []

  for (const area of areas) {
    let gapStart: string | null = null
    const cur = new Date(from + 'T00:00:00Z')
    const end = new Date(to   + 'T00:00:00Z')

    while (cur <= end) {
      const date    = cur.toISOString().slice(0, 10)
      const missing = !existingKeys.has(`${area}::${date}`)

      if (missing && !gapStart)  gapStart = date
      if (!missing && gapStart) {
        results.push({ area, from: gapStart, to: new Date(cur.getTime() - 86_400_000).toISOString().slice(0, 10) })
        gapStart = null
      }
      cur.setUTCDate(cur.getUTCDate() + 1)
    }
    if (gapStart) results.push({ area, from: gapStart, to })
  }

  return results
}

// ─── Sync orchestrator ────────────────────────────────────────────────────────
// Fetches any missing (area, date) pairs from Open-Meteo and upserts them.
// Returns the number of new day-records stored.

export async function syncWeather(
  existing:    WeatherDay[],
  areas:       string[],
  from:        string,
  to:          string,
  onProgress?: (msg: string) => void,
): Promise<number> {
  const gaps = findMissingDays(existing, areas, from, to)
  if (!gaps.length) return 0

  let total = 0
  for (const gap of gaps) {
    onProgress?.(`Fetching ${gap.area} ${gap.from} – ${gap.to}…`)
    try {
      const days = await fetchWeatherForArea(gap.area, gap.from, gap.to)
      await upsertWeatherDays(days)
      total += days.length
    } catch {
      // Non-fatal — partial data is fine; the gap will be retried next session
    }
  }
  return total
}

// ─── Lookup helper ────────────────────────────────────────────────────────────
// Used by tabs to look up the weather day for a specific incident.

export function weatherForIncident(
  weatherData: WeatherDay[],
  area: string | null,
  date: string,
): WeatherDay | null {
  if (!area) return null
  return weatherData.find(w => w.area === area && w.date === date) ?? null
}
