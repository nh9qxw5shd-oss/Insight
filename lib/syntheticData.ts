'use client'

import { IncidentRow, ReportRow, IncidentCategory, Severity, SAFETY_CATEGORIES } from './types'
import { RawData } from './queries'

// Deterministic PRNG so the demo data is stable across reloads
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const AREAS = [
  'E - EM - Derby', 'E - EM - Leicester', 'E - EM - Nottingham',
  'E - EM - Lincoln', 'E - EM - Bedford', 'E - EM - Route Wide',
]

const LOCATIONS_BY_AREA: Record<string, string[]> = {
  'E - EM - Derby':       ['Willington Level Crossing', 'Derby Station', 'Burton-on-Trent', 'Spondon', 'Long Eaton', 'Newstead'],
  'E - EM - Leicester':   ['Leicester Station', 'Wigston South Junction', 'Syston East Junction', 'Frisby Level Crossing', 'Market Harborough'],
  'E - EM - Nottingham':  ['Nottingham Station', 'Newark Castle', 'Mansfield', 'Worksop', 'Beeston'],
  'E - EM - Lincoln':     ['Lincoln Station', 'Swinderby', 'Collingham', 'Sleaford', 'Boston'],
  'E - EM - Bedford':     ['Bedford South Junction', 'West Hampstead Thameslink', 'Cricklewood South', 'Luton', 'Flitwick'],
  'E - EM - Route Wide':  ['EM Area', 'St Pancras Approach', 'MML Mainline'],
}

const LINES = ['Down Fast', 'Up Fast', 'Down Slow', 'Up Slow', 'Down Hendon', 'Up Hendon', 'Down Peterborough', 'Up Erewash Fast']

const COMPANIES = ['EMR', 'GTR', 'NR', 'XC', 'FL', 'DBS', 'GBRf']

const RESPONDER_POOL = ['MB', 'SB', 'AW', 'NJ', 'BK', 'LH', 'JH', 'KP', 'PT', 'RD', 'SC', 'JM']

interface CategoryWeight { cat: IncidentCategory; w: number; baseDelay: [number, number]; severityBias: Severity }
const CATEGORY_WEIGHTS: CategoryWeight[] = [
  { cat: 'INFRASTRUCTURE',    w: 18, baseDelay: [20, 600],  severityBias: 'LOW'      },
  { cat: 'TRAIN_FAULT',       w: 14, baseDelay: [10, 250],  severityBias: 'LOW'      },
  { cat: 'LEVEL_CROSSING',    w: 9,  baseDelay: [10, 220],  severityBias: 'MEDIUM'   },
  { cat: 'TPWS',              w: 7,  baseDelay: [5, 80],    severityBias: 'MEDIUM'   },
  { cat: 'NEAR_MISS',         w: 5,  baseDelay: [0, 50],    severityBias: 'MEDIUM'   },
  { cat: 'CRIME',             w: 8,  baseDelay: [0, 90],    severityBias: 'MEDIUM'   },
  { cat: 'PASSENGER_INJURY',  w: 6,  baseDelay: [10, 120],  severityBias: 'MEDIUM'   },
  { cat: 'IRREGULAR_WORKING', w: 5,  baseDelay: [0, 60],    severityBias: 'MEDIUM'   },
  { cat: 'TRACTION_FAILURE',  w: 4,  baseDelay: [40, 800],  severityBias: 'LOW'      },
  { cat: 'POSSESSION',        w: 6,  baseDelay: [0, 30],    severityBias: 'INFO'     },
  { cat: 'STATION_OVERRUN',   w: 3,  baseDelay: [5, 30],    severityBias: 'LOW'      },
  { cat: 'STRANDED_TRAIN',    w: 2,  baseDelay: [30, 200],  severityBias: 'LOW'      },
  { cat: 'WEATHER',           w: 3,  baseDelay: [0, 100],   severityBias: 'INFO'     },
  { cat: 'BRIDGE_STRIKE',     w: 2,  baseDelay: [40, 400],  severityBias: 'HIGH'     },
  { cat: 'HABD_WILD',         w: 3,  baseDelay: [10, 100],  severityBias: 'MEDIUM'   },
  { cat: 'FIRE',              w: 1.5, baseDelay: [60, 500], severityBias: 'HIGH'     },
  { cat: 'SPAD',              w: 2,  baseDelay: [5, 60],    severityBias: 'HIGH'     },
  { cat: 'PERSON_STRUCK',     w: 0.4, baseDelay: [120, 800], severityBias: 'CRITICAL' },
  { cat: 'GENERAL',           w: 6,  baseDelay: [0, 20],    severityBias: 'INFO'     },
]
const TOTAL_W = CATEGORY_WEIGHTS.reduce((s, c) => s + c.w, 0)

// Weighted type codes so common infra failures (points, track circuits, signals)
// appear more often than rare ones, giving realistic sub-category distribution
const TYPE_CODES: Partial<Record<IncidentCategory, string[]>> = {
  INFRASTRUCTURE:    ['05B', '05C', '05A', '05B', '05C', '05E', '05B', '05C', '05A', '19', '05D', '20', '21'],
  TRAIN_FAULT:       ['54', '55', '71'],
  LEVEL_CROSSING:    ['07a', '07b', '52', '07', '07a', '07a'],
  TPWS:              ['02'],
  NEAR_MISS:         ['03'],
  CRIME:             ['15', '15A', '16', '70'],
  PASSENGER_INJURY:  ['14'],
  IRREGULAR_WORKING: ['06', '155'],
  TRACTION_FAILURE:  ['23A'],
  POSSESSION:        ['22A', '22B', '22C'],
  STATION_OVERRUN:   ['58'],
  WEATHER:           ['17', '17A'],
  BRIDGE_STRIKE:     ['04'],
  HABD_WILD:         ['08', '09'],
  FIRE:              ['18'],
  SPAD:              ['01a', '01b', '01c'],
  PERSON_STRUCK:     ['13', '87'],
  GENERAL:           ['78', '53', '76'],
}

const TYPE_LABELS: Record<string, string> = {
  '01a': 'SPAD Category A', '01b': 'SPAD Category B', '01c': 'SPAD Category C',
  '02': 'TPWS Activation', '03': 'Near Miss', '04': 'Bridge Strike',
  '05A': 'Signal Failure', '05B': 'Points Failure', '05C': 'Track Circuit Failure',
  '05D': 'Axle Counter Failure', '05E': 'Broken Rail / Track defect',
  '06': 'Irregular Working', '07': 'Level Crossing', '07a': 'Level Crossing Failure',
  '07b': 'Level Crossing Deliberate Misuse', '08': 'HABD Activation',
  '09': 'WILD Activation', '13': 'Person Struck', '14': 'Passenger Injury',
  '15': 'Trespass', '15A': 'Trespass with disruption', '16': 'Crime',
  '17': 'Weather Event', '18': 'Fire', '19': 'Signalling failure',
  '22A': 'Possession Overrun', '22B': 'Possession Late Handback',
  '22C': 'Possession Monitoring', '23A': 'Traction Failure',
  '52': 'Level Crossing System Failure', '54': 'On-Train Defect',
  '55': 'Train Failure on Depot', '70': 'Security Issue', '71': 'On-Train Defect (RB)',
  '76': 'Reportable Rail Head Conditions', '78': 'Performance Improvement Action',
  '87': 'Person Struck by Train',
}

function pickWeighted(rng: () => number): CategoryWeight {
  let r = rng() * TOTAL_W
  for (const c of CATEGORY_WEIGHTS) {
    r -= c.w
    if (r <= 0) return c
  }
  return CATEGORY_WEIGHTS[CATEGORY_WEIGHTS.length - 1]
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]
}

function dailyVolumeFactor(date: Date): number {
  // Slight weekday bias + a wave so the trend isn't flat
  const day = date.getDay()
  const weekday = day === 0 || day === 6 ? 0.7 : 1.0
  const wave = 1 + 0.25 * Math.sin(date.getTime() / (1000 * 60 * 60 * 24 * 11))
  return weekday * wave
}

function buildIncident(rng: () => number, dateStr: string, idx: number, faultPool: string[]): IncidentRow {
  const cw = pickWeighted(rng)
  const category = cw.cat
  const area = pick(AREAS, rng)
  const location = pick(LOCATIONS_BY_AREA[area], rng)
  const codes = TYPE_CODES[category] || ['78']
  const code = pick(codes, rng)

  // Hour distribution: peak 06-09 and 16-19
  const hourBuckets = [3,2,2,2,3,5,9,12,14,11,10,9,9,10,11,13,15,14,11,8,6,5,4,3]
  const totalHB = hourBuckets.reduce((s, n) => s + n, 0)
  let hr = 0; let r = rng() * totalHB
  for (let i = 0; i < 24; i++) { r -= hourBuckets[i]; if (r <= 0) { hr = i; break } }
  const min = Math.floor(rng() * 60)

  const baseDelay = cw.baseDelay
  const minutesDelay = Math.round(baseDelay[0] + Math.pow(rng(), 2.2) * (baseDelay[1] - baseDelay[0]))
  const cancelled = minutesDelay > 200 ? Math.floor(rng() * 4) : (rng() < 0.06 ? 1 : 0)
  const partCancelled = minutesDelay > 100 ? Math.floor(rng() * 3) : 0
  const trainsDelayed = minutesDelay > 0
    ? Math.max(1, Math.round(minutesDelay / (15 + rng() * 25)))
    : 0

  // Severity: bias-driven, escalate by delay
  let severity: Severity = cw.severityBias
  if (minutesDelay > 800) severity = 'CRITICAL'
  else if (minutesDelay > 400 && severity !== 'CRITICAL') severity = 'HIGH'

  // Response timings — realistic offsets
  const advisedDelta = Math.round(rng() * 3)
  const respDelta    = advisedDelta + Math.round(2 + rng() * 8)
  const arrDelta     = respDelta + Math.round(15 + rng() * 35)
  const durDelta     = Math.round(minutesDelay > 0
    ? minutesDelay * (0.8 + rng() * 0.6)
    : 30 + rng() * 240)

  const incidentStartMin = hr * 60 + min
  const fmt = (t: number) => {
    const m = ((t % (24 * 60)) + 24 * 60) % (24 * 60)
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  }

  // Fault number: infra/safety incidents reuse pool so repeat-asset view has data
  let faultNo: string | null = null
  if (['INFRASTRUCTURE', 'TRACTION_FAILURE', 'LEVEL_CROSSING', 'SPAD', 'TPWS', 'NEAR_MISS', 'IRREGULAR_WORKING', 'PERSON_STRUCK'].includes(category)) {
    if (rng() < 0.4 && faultPool.length) faultNo = pick(faultPool, rng)
    else { faultNo = String(1130000 + Math.floor(rng() * 20000)); faultPool.push(faultNo) }
  }

  const responderInitials: string[] = []
  const respCount = 1 + Math.floor(rng() * 4)
  for (let i = 0; i < respCount; i++) {
    const init = pick(RESPONDER_POOL, rng)
    if (!responderInitials.includes(init)) responderInitials.push(init)
  }

  const isContinuation = false
  const isHighlight = minutesDelay > 250 && rng() < 0.5

  // Compose date for parsed day-of-week
  const dt = new Date(dateStr)
  const dow = dt.getUTCDay()

  return {
    id: `demo-${dateStr}-${idx}`,
    report_date: dateStr,
    report_id: `report-${dateStr}`,
    ccil: String(3200000 + Math.floor(rng() * 40000)),
    category,
    severity,
    title: synthTitle(category, code),
    location,
    area,
    incident_start: fmt(incidentStartMin),
    minutes_delay: minutesDelay,
    trains_delayed: trainsDelayed,
    cancelled,
    part_cancelled: partCancelled,
    is_highlight: isHighlight,
    is_continuation: isContinuation,
    delay_delta: null,
    incident_type_code: code,
    incident_type_label: TYPE_LABELS[code] || cw.cat.replace(/_/g, ' '),
    line: pick(LINES, rng),
    fault_number: faultNo,
    possession_ref: rng() < 0.05 ? `P2026/${4000000 + Math.floor(rng() * 1000000)}` : null,
    btp_ref: rng() < 0.15 ? String(100 + Math.floor(rng() * 900)) : null,
    third_party_ref: null,
    action_code: responderInitials.join(' '),
    responder_initials: responderInitials,
    advised_time: fmt(incidentStartMin + advisedDelta),
    initial_resp_time: fmt(incidentStartMin + respDelta),
    arrived_at_time: fmt(incidentStartMin + arrDelta),
    nwr_time: fmt(incidentStartMin + durDelta),
    mins_to_advised: advisedDelta,
    mins_to_response: respDelta,
    mins_to_arrival: arrDelta,
    incident_duration: durDelta,
    train_id: rng() < 0.6 ? `${Math.floor(rng() * 9) + 1}${pick(['L','M','N','D','F','U','V','C'], rng)}${String(Math.floor(rng() * 99)).padStart(2, '0')}` : null,
    train_company: rng() < 0.7 ? pick(COMPANIES, rng) : null,
    train_origin: rng() < 0.4 ? pick(['Nottingham','St Pancras','Sheffield','Lincoln','Derby','Leicester','Bedford'], rng) : null,
    train_destination: rng() < 0.4 ? pick(['Nottingham','St Pancras','Sheffield','Lincoln','Derby','Leicester','Bedford'], rng) : null,
    unit_numbers: rng() < 0.3 ? [`${66000 + Math.floor(rng() * 1000)}`] : null,
    trust_ref: null,
    tda_ref: rng() < 0.7 ? String(190000 + Math.floor(rng() * 200000)) : null,
    trmc_code: rng() < 0.7 ? pick(['IQVL','IQVR','IQV9','MXHA','IQGR'], rng) : null,
    fts_div_count: 0,
    event_count: 1 + Math.floor(rng() * 12),
    has_files: rng() < 0.18,
    hour_of_day: hr,
    day_of_week: dow,
  }
}

function synthTitle(cat: IncidentCategory, code: string): string {
  const base = TYPE_LABELS[code] || cat.replace(/_/g, ' ')
  const variants: Partial<Record<IncidentCategory, string[]>> = {
    INFRASTRUCTURE: [`${base} — protective working in place`, `${base} — investigation in progress`, `${base}`],
    TRAIN_FAULT:    [`Unit reported ${base}`, `On-train defect — ${base}`, `${base}`],
    LEVEL_CROSSING: [`${base} reported`, `Misuse — ${base}`, `${base}`],
    TPWS:           [`TPWS activation — ${base}`, `${base}`],
    NEAR_MISS:      [`Near miss reported — ${base}`, `${base}`],
    SPAD:           [`SPAD — ${base}`, `${base}`],
    FIRE:           [`Lineside fire — ${base}`, `${base}`],
  }
  const v = variants[cat] || [base]
  return v[Math.floor(Math.random() * v.length)]
}

export function generateSyntheticData(
  windowDays: number,
  seed = 42,
  startDate?: string,
  endDate?: string,
): RawData {
  const rng = mulberry32(seed)
  const incidents: IncidentRow[] = []
  const reports: ReportRow[] = []
  const faultPool: string[] = []

  // Determine the window end in UTC — use provided endDate or today
  const winEndMs = endDate
    ? new Date(endDate + 'T00:00:00Z').getTime()
    : Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
      )

  // Generate current window + a full previous window for accurate delta calculations
  const totalDays = windowDays * 2
  const genStartMs = winEndMs - (totalDays - 1) * 86_400_000

  for (let d = 0; d < totalDays; d++) {
    const dayMs  = genStartMs + d * 86_400_000
    const dt     = new Date(dayMs)
    const dateStr = dt.toISOString().slice(0, 10)
    const factor = dailyVolumeFactor(dt)
    const count  = Math.max(2, Math.round((4 + rng() * 10) * factor))
    for (let i = 0; i < count; i++) {
      incidents.push(buildIncident(rng, dateStr, i, faultPool))
    }
    reports.push({
      id: `report-${dateStr}`,
      report_date: dateStr,
      period: '06:00 to 06:00',
      control_centre: 'East Midlands Control Centre',
      created_by: 'Demo',
      total_delay: 0,
      total_cancelled: 0,
      total_part_cancelled: 0,
      incident_count: count,
    })
  }

  // Split current vs previous window at UTC boundaries
  const winStartMs = winEndMs - (windowDays - 1) * 86_400_000
  const cutoffStr  = new Date(winStartMs).toISOString().slice(0, 10)
  const winEndStr  = new Date(winEndMs).toISOString().slice(0, 10)

  const cur  = incidents.filter(i => i.report_date >= cutoffStr && i.report_date <= winEndStr)
  const prev = incidents.filter(i => i.report_date < cutoffStr)

  return {
    incidents: cur,
    prevIncidents: prev,
    reports: reports.filter(r => r.report_date >= cutoffStr && r.report_date <= winEndStr),
    windowFrom: cutoffStr,
    windowTo:   winEndStr,
    windowDays,
  }
}
