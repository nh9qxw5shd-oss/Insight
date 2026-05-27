// ─── Trusted incident classification ─────────────────────────────────────────
// DLog2 (the upstream CCIL parser) sets the `category` column on every
// incident row using a two-stage rule: (1) lookup by CCIL type code, then
// (2) regex fallback on the concatenated title + label + description. When
// the CCIL row is missing a type code, that fallback fires aggressively and
// produces false positives — administrative log roll-ups, passenger
// disorder events, and operations-setup entries get tagged as PERSON_STRUCK
// because the substring matches.
//
// Insight cannot edit DLog2's rows, so we re-derive the category at the
// query boundary using the rule the safety team has agreed on:
//
//   1. incident_type_code is gospel — if it maps to a known category, use it
//   2. otherwise consult incident_type_label
//   3. otherwise fall back to title pattern matching
//   4. always run an exclusion sweep — known admin / disorder titles never
//      count as operational safety events, regardless of what DLog2 said
//
// Every row receives a confidence tag (HIGH / MEDIUM / LOW) and a short
// reason string. LOW-confidence rows are surfaced under a "Needs review"
// subsection in the Control PMC report rather than counted in the headline.

import { IncidentCategory, IncidentRow } from './types'

export type ClassificationConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

export interface TrustedClassification {
  category:   IncidentCategory
  confidence: ClassificationConfidence
  reason:     string
}

// Canonical CCIL type-code → category map. Mirrors the lookup table in
// DLog2's ccilParser; the same list seeds lib/syntheticData.ts so demo
// rows classify identically to the real feed. Keys are stored
// case-insensitive in the lookup Map below.
const TYPE_CODE_CATEGORY_RAW: Record<string, IncidentCategory> = {
  '01a': 'SPAD', '01b': 'SPAD', '01c': 'SPAD',
  '02':  'TPWS',
  '03':  'NEAR_MISS',
  '04':  'BRIDGE_STRIKE',
  '05A': 'INFRASTRUCTURE', '05B': 'INFRASTRUCTURE', '05C': 'INFRASTRUCTURE',
  '05D': 'INFRASTRUCTURE', '05E': 'INFRASTRUCTURE',
  '06':  'IRREGULAR_WORKING', '155': 'IRREGULAR_WORKING',
  '07':  'LEVEL_CROSSING', '07a': 'LEVEL_CROSSING', '07b': 'LEVEL_CROSSING',
  '52':  'LEVEL_CROSSING',
  '08':  'HABD_WILD', '09': 'HABD_WILD',
  '13':  'PERSON_STRUCK',
  '14':  'PASSENGER_INJURY',
  '15':  'CRIME', '15A': 'CRIME', '16': 'CRIME', '70': 'CRIME',
  '17':  'WEATHER', '17A': 'WEATHER',
  '18':  'FIRE',
  '19':  'INFRASTRUCTURE', '20': 'INFRASTRUCTURE', '21': 'INFRASTRUCTURE',
  '22A': 'POSSESSION', '22B': 'POSSESSION', '22C': 'POSSESSION',
  '23A': 'TRACTION_FAILURE',
  '54':  'TRAIN_FAULT', '55': 'TRAIN_FAULT', '71': 'TRAIN_FAULT',
  '58':  'STATION_OVERRUN',
  '76':  'GENERAL', '78': 'GENERAL', '53': 'GENERAL',
  '87':  'PERSON_STRUCK',
}

const TYPE_CODE_LOOKUP: Map<string, IncidentCategory> = new Map(
  Object.entries(TYPE_CODE_CATEGORY_RAW).map(([k, v]) => [k.toLowerCase(), v]),
)

// Public read-only view, used by tests and any UI that needs to display the
// canonical list (e.g. an admin "type code coverage" panel).
export const KNOWN_TYPE_CODES: ReadonlyMap<string, IncidentCategory> = TYPE_CODE_LOOKUP

// Disqualifying title patterns — administrative roll-up entries (logs,
// summaries) and well-known false positives (passenger refusing to alight).
// Each carries an explicit reclass target so the row still appears in the
// dataset under a sensible category for audit purposes.
interface ExclusionRule {
  pattern: RegExp
  target:  IncidentCategory
  reason:  string
}

const EXCLUSION_PATTERNS: ExclusionRule[] = [
  {
    pattern: /\bTSM\s+TL\b.*\blog\b/i,
    target:  'GENERAL',
    reason:  'TSM TL log roll-up entry — not an operational incident',
  },
  {
    pattern: /\bASM\s+TL\b.*\blog\b/i,
    target:  'GENERAL',
    reason:  'ASM TL log roll-up entry — not an operational incident',
  },
  {
    pattern: /\b(daily|shift)\b.*\b(log|summary|roll[- ]?up|handover)\b/i,
    target:  'GENERAL',
    reason:  'Daily / shift log entry — not an operational incident',
  },
  {
    pattern: /\brefus(?:ing|ed|al)\s+to\s+alight\b/i,
    target:  'PASSENGER_INJURY',
    reason:  'Passenger refusal to alight — disorder / passenger event, not person struck',
  },
  {
    pattern: /\b(?:fire\s+)?drill\b|\btraining exercise\b|\btabletop\b/i,
    target:  'GENERAL',
    reason:  'Drill / training exercise — not an operational incident',
  },
]

// Title confirmation patterns — used as a last resort when the CCIL type
// code is missing. Most specific patterns come first. Each pattern only
// confirms a category; it never overrides a present-and-valid type code.
interface TitlePattern {
  category: IncidentCategory
  pattern:  RegExp
}

const TITLE_CONFIRMATION: TitlePattern[] = [
  { category: 'PERSON_STRUCK',     pattern: /\bperson\s+struck\b|\bstruck\s+by\s+(?:a\s+|the\s+)?train\b|\bfatality\b|\bfatal\s+(?:incident|injury)\b/i },
  { category: 'BRIDGE_STRIKE',     pattern: /\bbridge\s+strike\b|\bover[- ]?height\s+vehicle\b/i },
  { category: 'NEAR_MISS',         pattern: /\bnear[- ]?miss\b/i },
  { category: 'SPAD',              pattern: /\bSPAD\b|\bsignal\s+passed\s+(?:at\s+)?danger\b/i },
  { category: 'TPWS',              pattern: /\bTPWS\b/i },
  { category: 'LEVEL_CROSSING',    pattern: /\blevel\s+crossing\b/i },
  { category: 'FIRE',              pattern: /\blineside\s+fire\b|\btrain\s+fire\b|\bcarriage\s+fire\b/i },
  { category: 'IRREGULAR_WORKING', pattern: /\birregular\s+working\b/i },
  { category: 'HABD_WILD',         pattern: /\bHABD\b|\bWILD\b/i },
  { category: 'PASSENGER_INJURY',  pattern: /\bpassenger\s+(?:injury|injured|fell|slip|trip)\b/i },
]

function lookupCode(raw: string | null | undefined): IncidentCategory | null {
  if (!raw) return null
  const k = raw.trim().toLowerCase()
  if (!k) return null
  return TYPE_CODE_LOOKUP.get(k) ?? null
}

// Strong evidence the row is administrative rather than operational: no TDA
// ref, no fault number, no responder dispatched, zero delay and zero trains
// affected. Used to demote LOW-confidence safety classifications and to
// catch unrecognised log entries the exclusion patterns missed.
function looksAdministrative(i: IncidentRow): boolean {
  const noRefs =
    !i.tda_ref &&
    !i.fault_number &&
    !i.btp_ref &&
    (!i.responder_initials || i.responder_initials.length === 0)
  const noImpact =
    (i.minutes_delay   ?? 0) === 0 &&
    (i.trains_delayed  ?? 0) === 0 &&
    (i.cancelled       ?? 0) === 0 &&
    (i.part_cancelled  ?? 0) === 0
  return noRefs && noImpact
}

export function classifyTrusted(i: IncidentRow): TrustedClassification {
  const title  = (i.title || '').trim()
  const label  = (i.incident_type_label || '').trim()
  const stored: IncidentCategory =
    i.category === 'FATALITY' ? 'PERSON_STRUCK' : i.category

  // Step 1 — exclusion sweep. Admin / disorder titles never count as
  // operational safety events even if DLog2 thought they did.
  for (const ex of EXCLUSION_PATTERNS) {
    if (ex.pattern.test(title) || ex.pattern.test(label)) {
      return { category: ex.target, confidence: 'HIGH', reason: ex.reason }
    }
  }

  // Step 2 — CCIL type code (the gospel path). If present and recognised,
  // it overrides whatever DLog2 stored.
  const codeCat = lookupCode(i.incident_type_code)
  if (codeCat) {
    if (codeCat !== stored) {
      return {
        category:   codeCat,
        confidence: 'HIGH',
        reason:     `CCIL type code ${i.incident_type_code} → ${codeCat} (stored as ${stored})`,
      }
    }
    return {
      category:   codeCat,
      confidence: 'HIGH',
      reason:     `CCIL type code ${i.incident_type_code} confirms ${codeCat}`,
    }
  }

  // Step 3 — type code missing or unrecognised. Fall back to type label.
  if (label) {
    for (const conf of TITLE_CONFIRMATION) {
      if (conf.pattern.test(label)) {
        return {
          category:   conf.category,
          confidence: 'MEDIUM',
          reason:     `No CCIL code — matched type label "${label}"`,
        }
      }
    }
  }

  // Step 4 — title-only fallback. LOW confidence because we have no
  // CCIL-side signal at all. Demote to GENERAL outright if the row also
  // looks administrative (no refs, no impact).
  if (title) {
    for (const conf of TITLE_CONFIRMATION) {
      if (conf.pattern.test(title)) {
        if (looksAdministrative(i)) {
          return {
            category:   'GENERAL',
            confidence: 'HIGH',
            reason:     'No CCIL code, no impact, no refs — administrative entry despite matching title',
          }
        }
        return {
          category:   conf.category,
          confidence: 'LOW',
          reason:     `No CCIL code — title-only match for ${conf.category}`,
        }
      }
    }
  }

  // Step 5 — no evidence anywhere. Demote admin-looking rows. Otherwise
  // keep DLog2's call but tag it LOW so the report surfaces it for review.
  if (looksAdministrative(i)) {
    return {
      category:   'GENERAL',
      confidence: 'HIGH',
      reason:     'No CCIL code, no impact metrics — administrative entry',
    }
  }
  return {
    category:   stored,
    confidence: 'LOW',
    reason:     'No CCIL type code — relying on DLog2 fallback classification',
  }
}
