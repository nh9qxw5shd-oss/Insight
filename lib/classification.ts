// ─── Trusted incident classification ─────────────────────────────────────────
// DLog2 (the upstream CCIL parser) sets the `category` column on every
// incident row. Its rules occasionally mis-classify — administrative log
// roll-ups, passenger-disorder events ("aggressive male"), and staff
// accidents have all been observed tagged as PERSON_STRUCK in production.
// Sometimes the CCIL type code itself is set wrong by the operator entering
// the log, so the upstream "gospel" can still mislead us.
//
// Insight re-derives the category at the query boundary using the rule the
// safety team has agreed on:
//
//   1. CCIL type code is gospel — if it maps to a known category, use it
//   2. but ALWAYS cross-check the title: if the title clearly indicates a
//      different category (assault, refusal-to-alight, staff accident,
//      etc.), don't silently propagate the code — downgrade to LOW
//      confidence so the row goes to "Needs review" instead of the count
//   3. when no code is present, the title's contradiction patterns become
//      the authoritative signal
//   4. otherwise fall back to the type label, then to title patterns
//
// Every row receives a confidence tag (HIGH / MEDIUM / LOW) and a short
// reason string. LOW-confidence rows surface under "Needs review" in the
// Control PMC report rather than counting toward the headline.

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

// Contradiction patterns — titles that clearly describe a specific kind of
// event. Used in two ways:
//
//   • When a CCIL type code IS present but the title says something
//     completely different, we keep the code-driven category but tag the
//     row LOW confidence so it lands in "Needs review" rather than the
//     headline count. (We never silently overrule the gospel.)
//
//   • When no CCIL code is present, the title becomes the authoritative
//     signal: a matching contradiction pattern returns its target with
//     HIGH confidence.
interface ContradictionRule {
  pattern: RegExp
  target:  IncidentCategory
  reason:  string
}

const CONTRADICTION_PATTERNS: ContradictionRule[] = [
  // ── Administrative / log roll-ups ──────────────────────────────────────
  { pattern: /\bTSM\s+TL\b.*\blog\b/i,
    target:  'GENERAL', reason: 'TSM TL log roll-up — not an operational incident' },
  { pattern: /\bASM\s+TL\b.*\blog\b/i,
    target:  'GENERAL', reason: 'ASM TL log roll-up — not an operational incident' },
  { pattern: /\b(?:daily|shift)\b.*\b(?:log|summary|roll[- ]?up|handover)\b/i,
    target:  'GENERAL', reason: 'Daily / shift log entry — not an operational incident' },
  { pattern: /\b(?:fire\s+)?drill\b|\btraining\s+exercise\b|\btabletop\b/i,
    target:  'GENERAL', reason: 'Drill / training exercise — not an operational incident' },

  // ── Disorder / crime (frequently mis-tagged as PST upstream) ──────────
  { pattern: /\bverbal\s+assault\b/i,
    target:  'CRIME', reason: 'Verbal assault — disorder, not person struck' },
  { pattern: /\bphysical\s+assault\b/i,
    target:  'CRIME', reason: 'Physical assault — disorder, not person struck' },
  { pattern: /\bassault\s+(?:on\s+(?:staff|driver|passenger|guard|conductor)|of\s+staff)\b/i,
    target:  'CRIME', reason: 'Assault on staff/driver/passenger — disorder, not person struck' },
  { pattern: /\bstaff\b[^a-z]{1,8}\bassault(?:ed)?\b/i,
    target:  'CRIME', reason: 'Staff assault — disorder, not person struck' },
  { pattern: /\b(?:aggressive|abusive|threatening|hostile)\s+(?:male|female|person|persons|passenger|individual|customer|youth|youths|group|behaviour)\b/i,
    target:  'CRIME', reason: 'Aggressive / abusive person — disorder' },
  { pattern: /\banti[- ]?social\b/i,
    target:  'CRIME', reason: 'Anti-social behaviour — disorder' },
  { pattern: /\bharassment\b/i,
    target:  'CRIME', reason: 'Harassment — disorder' },
  { pattern: /\bvandalism\b|\bgraffiti\b/i,
    target:  'CRIME', reason: 'Vandalism — crime, not person struck' },
  { pattern: /\btrespass(?:er|ing)?\b/i,
    target:  'CRIME', reason: 'Trespass — crime, not person struck' },

  // ── Passenger / staff event (not struck by train) ─────────────────────
  { pattern: /\brefus(?:ing|ed|al)\s+to\s+alight\b/i,
    target:  'PASSENGER_INJURY', reason: 'Refusing to alight — passenger event, not person struck' },
  { pattern: /\bstaff\s+accident\b/i,
    target:  'PASSENGER_INJURY', reason: 'Staff accident — not person struck' },
  { pattern: /\bstaff\s+(?:injury|injured)\b|\binjured\s+staff\b/i,
    target:  'PASSENGER_INJURY', reason: 'Staff injury — not person struck' },
  { pattern: /\bpassenger\s+(?:fell|fall|slipped|tripped|ill|unwell|taken\s+ill|injured)\b/i,
    target:  'PASSENGER_INJURY', reason: 'Passenger fell / ill / injured — not person struck' },
  { pattern: /\b(?:slip|trip|fall|fell)\b.*\b(?:platform|stairs|step|carriage|gap)\b/i,
    target:  'PASSENGER_INJURY', reason: 'Slip / trip / fall — passenger event, not person struck' },
  { pattern: /\begress\s+(?:pulled|activated|operated|alarm|handle)\b/i,
    target:  'PASSENGER_INJURY', reason: 'Egress activation — passenger event, not person struck' },
  { pattern: /\bemergency\s+egress\b/i,
    target:  'PASSENGER_INJURY', reason: 'Emergency egress — passenger event, not person struck' },
  { pattern: /\bpasscom\b|\bpassenger\s+communication\s+(?:cord|alarm)\b/i,
    target:  'PASSENGER_INJURY', reason: 'Passcom activation — passenger event, not person struck' },
  { pattern: /\bperson\s+(?:ill|unwell|taken\s+ill|collapsed|on\s+train)\b/i,
    target:  'PASSENGER_INJURY', reason: 'Person ill / collapsed — not person struck' },
  { pattern: /\bill\s+(?:passenger|customer|traveller|person)\b/i,
    target:  'PASSENGER_INJURY', reason: 'Ill passenger — not person struck' },
  { pattern: /\bmedical\s+(?:emergency|incident|attention)\b/i,
    target:  'PASSENGER_INJURY', reason: 'Medical emergency — not person struck' },
]

// Title confirmation patterns — used as a last resort when both CCIL type
// code and label are absent. Each pattern only confirms a category; it
// never overrides a present-and-valid type code. Most specific first.
interface TitlePattern {
  category: IncidentCategory
  pattern:  RegExp
}

const TITLE_CONFIRMATION: TitlePattern[] = [
  { category: 'PERSON_STRUCK',     pattern: /\bperson\s+struck\b|\bstruck\s+by\s+(?:a\s+|the\s+)?train\b|\bfatality\b|\bfatal\s+(?:incident|injury|collision)\b/i },
  { category: 'BRIDGE_STRIKE',     pattern: /\bbridge\s+strike\b|\bover[- ]?height\s+vehicle\b/i },
  { category: 'NEAR_MISS',         pattern: /\bnear[- ]?miss\b/i },
  { category: 'SPAD',              pattern: /\bSPAD\b|\bsignal\s+passed\s+(?:at\s+)?danger\b/i },
  { category: 'TPWS',              pattern: /\bTPWS\b/i },
  { category: 'LEVEL_CROSSING',    pattern: /\blevel\s+crossing\b/i },
  { category: 'FIRE',              pattern: /\blineside\s+fire\b|\btrain\s+fire\b|\bcarriage\s+fire\b/i },
  { category: 'IRREGULAR_WORKING', pattern: /\birregular\s+working\b/i },
  { category: 'HABD_WILD',         pattern: /\bHABD\b|\bWILD\b/i },
]

function lookupCode(raw: string | null | undefined): IncidentCategory | null {
  if (!raw) return null
  const k = raw.trim().toLowerCase()
  if (!k) return null
  return TYPE_CODE_LOOKUP.get(k) ?? null
}

// Strong evidence the row is administrative rather than operational. A row
// only qualifies when *every* operational signal is absent at once — no
// reference of any kind AND no impact at all. Not every real incident
// carries every reference (a PST may have no fault number; a near-miss may
// have no BTP ref), so requiring joint absence keeps the heuristic safe.
// Used only as a second-stage check after title-only matching or when no
// signal at all is available — never overrides a present CCIL type code.
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

function findContradiction(title: string, label: string): ContradictionRule | null {
  for (const ex of CONTRADICTION_PATTERNS) {
    if ((title && ex.pattern.test(title)) || (label && ex.pattern.test(label))) {
      return ex
    }
  }
  return null
}

export function classifyTrusted(i: IncidentRow): TrustedClassification {
  const title  = (i.title || '').trim()
  const label  = (i.incident_type_label || '').trim()
  const stored: IncidentCategory =
    i.category === 'FATALITY' ? 'PERSON_STRUCK' : i.category

  const contradiction = findContradiction(title, label)

  // Step 1 — CCIL type code is gospel for the code → category mapping, but
  // we still cross-check the title. If the text clearly describes a
  // different kind of event, we keep the code-driven category but tag the
  // row LOW confidence so it lands in "Needs review" instead of the
  // headline count. The reviewer can then confirm or correct.
  const codeCat = lookupCode(i.incident_type_code)
  if (codeCat) {
    if (contradiction && contradiction.target !== codeCat) {
      return {
        category:   codeCat,
        confidence: 'LOW',
        reason:     `CCIL code ${i.incident_type_code} (${codeCat}) but title indicates ${contradiction.target} — ${contradiction.reason}`,
      }
    }
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

  // Step 2 — no CCIL code. The title is now the strongest signal; if it
  // matches a contradiction pattern, use the target directly. This is
  // where DLog2's regex fallback usually goes wrong (no code →
  // substring-matches its way into PERSON_STRUCK) and where we correct it.
  if (contradiction) {
    return {
      category:   contradiction.target,
      confidence: 'HIGH',
      reason:     contradiction.reason,
    }
  }

  // Step 3 — type label fallback when title gave no contradiction signal.
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

  // Step 4 — title-only fallback. LOW confidence because we have no CCIL-
  // side signal at all. Demote to GENERAL outright if the row also looks
  // administrative.
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
