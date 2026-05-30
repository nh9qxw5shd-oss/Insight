// Network Rail / GB rail-industry period calendar.
// 13 periods × 4 weeks per financial year, plus an optional 5th week in
// Period 13 of 53-week rail years (handled by giving P13 any week remainder).
// Period 1 Week 1 starts on the first Sunday on or after 1 April. Days from
// 1 April up to (but not including) that first Sunday form a partial stub at
// the start of the displayed year (they belong to P13 of the prior rail year
// in the data model). Verify against the published Network Rail / RDG
// Periodic Calendar schedule if a future year edge case looks wrong.

function railwayP1Start(railYear: number): Date {
  const apr1 = new Date(Date.UTC(railYear, 3, 1))
  const dow = apr1.getUTCDay() // 0 = Sun
  const daysToNextSunday = dow === 0 ? 0 : 7 - dow
  return new Date(apr1.getTime() + daysToNextSunday * 86_400_000)
}

export interface RailPeriodWeek {
  period: number       // 1..13
  week: number         // 1..4 (or 5 in 53-week years, P13 only)
  railYear: number     // calendar year P01 began (e.g. 2025 for 2025/26)
  label: string        // "P02 · W3"
  yearLabel: string    // "2025/26"
}

export function railwayPeriodWeek(dateInput: Date | string): RailPeriodWeek {
  const date = typeof dateInput === 'string'
    ? new Date(dateInput + 'T00:00:00Z')
    : dateInput
  const y = date.getUTCFullYear()
  let p1 = railwayP1Start(y)
  let railYear = y
  if (date.getTime() < p1.getTime()) {
    p1 = railwayP1Start(y - 1)
    railYear = y - 1
  }
  const daysSince = Math.floor((date.getTime() - p1.getTime()) / 86_400_000)
  const weekIndex = Math.floor(daysSince / 7)  // 0-based
  const period = Math.min(13, Math.floor(weekIndex / 4) + 1)
  const week = weekIndex - (period - 1) * 4 + 1
  const shortYear = String((railYear + 1) % 100).padStart(2, '0')
  return {
    period,
    week,
    railYear,
    label: `P${String(period).padStart(2, '0')} · W${week}`,
    yearLabel: `${railYear}/${shortYear}`,
  }
}

export function railwayPeriodKey(dateInput: Date | string): string {
  const pw = railwayPeriodWeek(dateInput)
  return `${pw.yearLabel} · P${String(pw.period).padStart(2, '0')}`
}

// ─── Period / week bounds ────────────────────────────────────────────────────
// Inverse helpers — given a (railYear, period [, week]) tuple, return the
// inclusive ISO date range that bucket covers. Required by the Reports tab
// so the user can select a discrete railway period or week.

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function yearLabelFor(railYear: number): string {
  const short = String((railYear + 1) % 100).padStart(2, '0')
  return `${railYear}/${short}`
}

// 52- vs 53-week rail year: P13 absorbs the extra week. We detect this by
// counting how many full weeks separate this year's P1 from the next, and
// allocate any remainder beyond 52 to P13.
export function railwayWeeksInPeriod(period: number, railYear: number): number {
  if (period < 1 || period > 13) return 0
  if (period < 13) return 4
  const thisP1 = railwayP1Start(railYear)
  const nextP1 = railwayP1Start(railYear + 1)
  const totalWeeks = Math.round((nextP1.getTime() - thisP1.getTime()) / (7 * 86_400_000))
  return Math.max(4, totalWeeks - 48)  // 48 weeks before P13 starts (12 × 4)
}

export function railwayPeriodBounds(period: number, railYear: number): { from: string; to: string } {
  const p1 = railwayP1Start(railYear)
  const fromMs = p1.getTime() + (period - 1) * 28 * 86_400_000
  const weeks  = railwayWeeksInPeriod(period, railYear)
  const toMs   = fromMs + weeks * 7 * 86_400_000 - 86_400_000   // inclusive end
  return { from: isoDay(new Date(fromMs)), to: isoDay(new Date(toMs)) }
}

export function railwayWeekBounds(period: number, week: number, railYear: number): { from: string; to: string } {
  const p1 = railwayP1Start(railYear)
  const fromMs = p1.getTime() + ((period - 1) * 28 + (week - 1) * 7) * 86_400_000
  const toMs   = fromMs + 6 * 86_400_000   // inclusive 7-day range
  return { from: isoDay(new Date(fromMs)), to: isoDay(new Date(toMs)) }
}

// The "data ceiling" — logs cover the previous 24-hour period, so the latest
// available data is yesterday. Anything starting after yesterday is empty.
function dataCeilingMs(): number {
  return Date.now() - 86_400_000
}

export interface PeriodOption {
  period:   number
  label:    string                // "P02"
  longLabel: string               // "P02 · 14 Apr → 11 May"
  from:     string
  to:       string
  status:   'complete' | 'current' | 'future'
}

export function listPeriods(railYear: number): PeriodOption[] {
  const ceiling = dataCeilingMs()
  const out: PeriodOption[] = []
  for (let p = 1; p <= 13; p++) {
    const { from, to } = railwayPeriodBounds(p, railYear)
    const fromMs = new Date(from + 'T00:00:00Z').getTime()
    const toMs   = new Date(to   + 'T00:00:00Z').getTime()
    let status: PeriodOption['status'] = 'complete'
    if (fromMs > ceiling) status = 'future'
    else if (toMs > ceiling) status = 'current'
    out.push({
      period: p,
      label: `P${String(p).padStart(2, '0')}`,
      longLabel: `P${String(p).padStart(2, '0')} · ${shortDateUK(from)} → ${shortDateUK(to)}`,
      from, to, status,
    })
  }
  return out
}

export interface WeekOption {
  week:     number
  label:    string                // "W3"
  longLabel: string               // "W3 · 28 Apr → 4 May"
  from:     string
  to:       string
  status:   'complete' | 'current' | 'future'
}

export function listWeeks(period: number, railYear: number): WeekOption[] {
  const ceiling = dataCeilingMs()
  const weeks = railwayWeeksInPeriod(period, railYear)
  const out: WeekOption[] = []
  for (let w = 1; w <= weeks; w++) {
    const { from, to } = railwayWeekBounds(period, w, railYear)
    const fromMs = new Date(from + 'T00:00:00Z').getTime()
    const toMs   = new Date(to   + 'T00:00:00Z').getTime()
    let status: WeekOption['status'] = 'complete'
    if (fromMs > ceiling) status = 'future'
    else if (toMs > ceiling) status = 'current'
    out.push({
      week: w,
      label: `W${w}`,
      longLabel: `W${w} · ${shortDateUK(from)} → ${shortDateUK(to)}`,
      from, to, status,
    })
  }
  return out
}

// The railway years currently navigable from the Reports tab — the current
// year plus the previous two. Going further back rarely matters for an
// operational tool and keeps the dropdown short.
export function listRailYears(): { railYear: number; label: string }[] {
  const today = new Date()
  const thisRail = today.getTime() >= railwayP1Start(today.getUTCFullYear()).getTime()
    ? today.getUTCFullYear()
    : today.getUTCFullYear() - 1
  return [thisRail, thisRail - 1, thisRail - 2].map(y => ({ railYear: y, label: yearLabelFor(y) }))
}

// Pick a sensible default period for the period report — the most recent
// period that has fully completed. Falls back to the current ongoing period
// at the start of a new rail year.
export function defaultPeriodSelection(): { railYear: number; period: number } {
  const periods = listPeriods(listRailYears()[0].railYear)
  const lastComplete = [...periods].reverse().find(p => p.status === 'complete')
  if (lastComplete) return { railYear: listRailYears()[0].railYear, period: lastComplete.period }
  // Otherwise the most recent in the previous rail year
  const prev = listPeriods(listRailYears()[1].railYear)
  return { railYear: listRailYears()[1].railYear, period: prev[prev.length - 1].period }
}

export function defaultWeekSelection(): { railYear: number; period: number; week: number } {
  const { railYear } = listRailYears()[0]
  const periods = listPeriods(railYear)
  // Find the period containing the most recent complete week.
  for (let i = periods.length - 1; i >= 0; i--) {
    const weeks = listWeeks(periods[i].period, railYear)
    const lastComplete = [...weeks].reverse().find(w => w.status === 'complete')
    if (lastComplete) return { railYear, period: periods[i].period, week: lastComplete.week }
  }
  // Fall back to the previous rail year's last period & week
  const prevYear = listRailYears()[1].railYear
  const prevPeriods = listPeriods(prevYear)
  const lastP = prevPeriods[prevPeriods.length - 1]
  const lastW = listWeeks(lastP.period, prevYear).slice(-1)[0]
  return { railYear: prevYear, period: lastP.period, week: lastW.week }
}

function shortDateUK(iso: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]}`
}
