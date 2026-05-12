// Network Rail / GB rail-industry period calendar.
// 13 periods × 4 weeks per financial year, plus an optional 5th week in
// Period 13 of 53-week rail years (handled by giving P13 any week remainder).
// Period 1 Week 1 starts on the Sunday nearest to 1 April; ties (Wednesday
// 1 April) are broken backwards toward the earlier Sunday. This matches the
// convention published in the Network Rail Periodic Calendar / RDG industry
// calendar — verify against the published schedule if a future year edge
// case looks wrong.

function railwayP1Start(railYear: number): Date {
  const apr1 = new Date(Date.UTC(railYear, 3, 1))
  const dow = apr1.getUTCDay() // 0 = Sun
  const prev = dow                  // days back to previous Sunday
  const next = (7 - dow) % 7        // days forward to next Sunday
  // On tie (Wednesday), bias backwards
  const offset = prev <= next ? -prev : next
  return new Date(apr1.getTime() + offset * 86_400_000)
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
