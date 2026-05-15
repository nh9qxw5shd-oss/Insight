// ─── Incident events log parsing — auto-derive review signals ────────────────
// The CCIL events block is a chronological commentary on an incident. This
// extracts the admin signals an SNDM would otherwise log by hand:
//
//   • the first ITSR mention            → ITSR held / time-huddle time
//   • the first MOM dispatch reference  → MOM dispatched time
//   • the first MOM on-site reference   → MOM arrived time
//
// Everything here is best-effort. The Review tab pre-fills empty fields with
// these values and flags them as auto-derived; the SNDM can always override.

import { IncidentEvent } from './types'

export interface EventSignal {
  time: string | null   // HH:MM, normalised; null when the event carried no time
  eventIndex: number    // index into the events array that triggered the match
}

export interface EventSignals {
  itsr:        EventSignal | null
  momDispatch: EventSignal | null
  momArrival:  EventSignal | null
}

// "1500" / "15:00" / "15:00:00" / "15.00" → "15:00". null when unparseable.
export function normaliseEventTime(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/(\d{1,2})[:.]?(\d{2})/)
  if (!m) return null
  const hh = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  if (isNaN(hh) || isNaN(mm) || hh > 23 || mm > 59) return null
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

const ITSR_RE   = /\bITSR\b/i
const MOM_RE    = /\bMOMs?\b|mobile operations? managers?/i
const ARRIVE_RE = /\barrived?\b|\bon[\s-]?site\b|\bon[\s-]?scene\b|\battend(?:ed|ing|ance)\b/i

// Scan the events block once and pull out the ITSR / MOM signals. Events are
// assumed to be in capture (chronological) order. Dispatch is the first MOM
// event that does NOT also state arrival, so a lone "MOM on site" event is
// recorded as an arrival only — we don't fabricate a dispatch time.
export function parseEventSignals(events: IncidentEvent[] | null | undefined): EventSignals {
  const result: EventSignals = { itsr: null, momDispatch: null, momArrival: null }
  if (!events || events.length === 0) return result

  for (let i = 0; i < events.length; i++) {
    const desc = events[i]?.description ?? ''
    if (!desc) continue
    const time = normaliseEventTime(events[i]?.time)

    if (!result.itsr && ITSR_RE.test(desc)) {
      result.itsr = { time, eventIndex: i }
    }

    if (MOM_RE.test(desc)) {
      if (ARRIVE_RE.test(desc)) {
        if (!result.momArrival) result.momArrival = { time, eventIndex: i }
      } else if (!result.momDispatch) {
        result.momDispatch = { time, eventIndex: i }
      }
    }
  }

  return result
}
