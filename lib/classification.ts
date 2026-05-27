// ─── Trusted incident classification ─────────────────────────────────────────
// The CCIL `incident_type_label` is the gospel. There are ~85 canonical
// label values the operator picks when creating the CCIL entry, and each
// one deterministically maps to an Insight category. PST in particular has
// exactly two labels: "Person Struck by Train" and "Fatality".
//
// Insight uses the label as the primary classifier, then cross-checks
// against what DLog2 stored in the `category` column:
//
//   1. Label is set AND in the map → use the mapped category (HIGH)
//   2. Label is set BUT not in the map → keep DLog2's category, but tag
//      as MEDIUM so the row surfaces in "Needs review" with the actual
//      label text — extend the map to clear it
//   3. Label is missing → fall back to CCIL numeric code, then title
//      patterns, then the administrative shape heuristic
//
// When DLog2's stored category disagrees with the label-derived one, we
// trust the label and record the override in the reason string. Over
// time DLog2 gets fixed at source so this check stage runs clean.

import { IncidentCategory, IncidentRow } from './types'

export type ClassificationConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

export interface TrustedClassification {
  category:   IncidentCategory
  confidence: ClassificationConfidence
  reason:     string
}

// ─── CCIL incident type label → Insight category ────────────────────────────
// AUTHORITATIVE. The label is the canonical CCIL value, not the title.
// Keys are lower-case + whitespace-normalised; add new rows as the safety
// team confirms additional labels in the 85-strong CCIL list.
//
// PSBT: exactly two labels. Any other label that arrives tagged
// PERSON_STRUCK by DLog2 is a misclassification — surfaced for review.

const LABEL_CATEGORY_RAW: Record<string, IncidentCategory> = {
  // ── Person struck by train (PSBT) — exactly two labels ────────────────
  'person struck by train':                'PERSON_STRUCK',
  'fatality':                              'PERSON_STRUCK',

  // ── Disorder / crime / trespass ───────────────────────────────────────
  'trespass':                              'CRIME',
  'concern for welfare':                   'CRIME',
  'cable crime':                           'CRIME',
  'railway crime':                         'CRIME',
  'criminal damage / vandalism':           'CRIME',
  'graffiti':                              'CRIME',
  'flytipping':                            'CRIME',
  'security issues':                       'CRIME',

  // ── Passenger / public events ─────────────────────────────────────────
  'passenger / public injuries / assaults': 'PASSENGER_INJURY',
  'staff / contractor injuries / assaults': 'PASSENGER_INJURY',
  'passenger illness':                      'PASSENGER_INJURY',
  'egress activation':                      'PASSENGER_INJURY',
  'passcomm activation':                    'PASSENGER_INJURY',
  'call for aid':                           'PASSENGER_INJURY',

  // ── Train faults / rolling-stock defects ──────────────────────────────
  'on train defect - non group standard':   'TRAIN_FAULT',
  'on train defect - rb tw5':               'TRAIN_FAULT',
  'train door incidents':                   'TRAIN_FAULT',
  'train failure on depot':                 'TRAIN_FAULT',
  'train stop & examine':                   'TRAIN_FAULT',
  'unsolicited brake application':          'TRAIN_FAULT',
  'add operation':                          'TRAIN_FAULT',
  'aws brake demand':                       'TRAIN_FAULT',
  'depot operating issues':                 'TRAIN_FAULT',
  'fleet performance':                      'TRAIN_FAULT',
  'rolling stock traction hire':            'TRAIN_FAULT',

  // ── Traction / OHL ────────────────────────────────────────────────────
  'traction failure non-passenger':         'TRACTION_FAILURE',
  'traction failure passenger':             'TRACTION_FAILURE',
  'traction current problem':               'TRACTION_FAILURE',
  'ohl dewirement':                         'TRACTION_FAILURE',
  'object/plastic on ohl':                  'TRACTION_FAILURE',
  'power failure':                          'TRACTION_FAILURE',

  // ── Infrastructure ────────────────────────────────────────────────────
  'axle counter failure':                   'INFRASTRUCTURE',
  'broken rail / track defect':             'INFRASTRUCTURE',
  'earthworks':                             'INFRASTRUCTURE',
  'geometry failure':                       'INFRASTRUCTURE',
  'gsm-r':                                  'INFRASTRUCTURE',
  'lineside fencing and foliage':           'INFRASTRUCTURE',
  'points failure':                         'INFRASTRUCTURE',
  'retb':                                   'INFRASTRUCTURE',
  'rough ride report by mop via control':   'INFRASTRUCTURE',
  'signalling incident':                    'INFRASTRUCTURE',
  'signals / signalling system failure':    'INFRASTRUCTURE',
  'speed restriction issues':               'INFRASTRUCTURE',
  'track circuit failure':                  'INFRASTRUCTURE',
  'train struck an object':                 'INFRASTRUCTURE',
  'unsecured access gate':                  'INFRASTRUCTURE',
  'circuit breaker tripping':               'INFRASTRUCTURE',
  'emergency switch off':                   'INFRASTRUCTURE',
  'outage nr/3rd party':                    'INFRASTRUCTURE',
  'outstation alarm':                       'INFRASTRUCTURE',
  'animals on the line':                    'INFRASTRUCTURE',
  'tree or branch on the line':             'INFRASTRUCTURE',
  'signal obscured by foliage':             'INFRASTRUCTURE',
  'signal obscured by light':               'INFRASTRUCTURE',
  'etcs incident':                          'INFRASTRUCTURE',
  'temporary speed restriction (tsr)':      'INFRASTRUCTURE',
  'emergency speed restrictions':           'INFRASTRUCTURE',
  'item dropped on track':                  'INFRASTRUCTURE',
  'station infrastructure':                 'INFRASTRUCTURE',
  'track circuit failure (leaf fall)':      'INFRASTRUCTURE',

  // ── Level crossing ────────────────────────────────────────────────────
  'level crossing failure':                 'LEVEL_CROSSING',
  'level crossing failure - telephones':    'LEVEL_CROSSING',
  'level crossing deliberate misuse':       'LEVEL_CROSSING',
  'level crossing incident':                'LEVEL_CROSSING',

  // ── Bridge / vehicle incursion ────────────────────────────────────────
  'bridge strike':                                              'BRIDGE_STRIKE',
  'bridge/structural defects or incidents (ex. bridge strikes)':'BRIDGE_STRIKE',
  'road vehicle incursion (non level crossing)':                'BRIDGE_STRIKE',

  // ── Safety event types ────────────────────────────────────────────────
  'signals passed at danger (category a)':                  'SPAD',
  'signals passed at danger (category a) (weather related)':'SPAD',
  'tpws activation':                                        'TPWS',
  'near miss':                                              'NEAR_MISS',
  'wheelchex / wild activation and confirmed hot axle boxes':'HABD_WILD',

  // ── Irregular working — all four institutional flavours plus the
  //    operational rule-compliance labels that fit the same bucket. ─────
  'irregular working : network rail infrastructure':          'IRREGULAR_WORKING',
  'irregular working : network rail infrastructure projects': 'IRREGULAR_WORKING',
  'irregular working : network rail operations':              'IRREGULAR_WORKING',
  'irregular working : toc':                                  'IRREGULAR_WORKING',
  'group standard ge/rt3350':                                 'IRREGULAR_WORKING',
  'group standard ge/rt8250':                                 'IRREGULAR_WORKING',
  'divided train':                                            'IRREGULAR_WORKING',
  'incorrect door release':                                   'IRREGULAR_WORKING',
  'speeding':                                                 'IRREGULAR_WORKING',
  'freight trains over length':                               'IRREGULAR_WORKING',
  'management of early running train':                        'IRREGULAR_WORKING',
  'missed power changeover':                                  'IRREGULAR_WORKING',
  'passenger on ecs':                                         'IRREGULAR_WORKING',
  'staff on ecs':                                             'IRREGULAR_WORKING',
  'planning errors':                                          'IRREGULAR_WORKING',

  // ── Fire ──────────────────────────────────────────────────────────────
  'fires':                          'FIRE',
  'lineside fire':                  'FIRE',
  'smouldering sleepers/sleeper fires': 'FIRE',

  // ── Collisions / derailment / runaway ─────────────────────────────────
  'derailment':                'DERAILMENT',
  'collision':                 'DERAILMENT',
  'train or vehicle runaway':  'DERAILMENT',

  // ── Possession ────────────────────────────────────────────────────────
  'possession overrun':            'POSSESSION',
  'possession monitoring':         'POSSESSION',
  'significant possession problem':'POSSESSION',
  'isolations':                    'POSSESSION',

  // ── Station / overrun ─────────────────────────────────────────────────
  'station overrun':                 'STATION_OVERRUN',
  'station overrun (weather related)':'STATION_OVERRUN',
  'stopping incidents':              'STATION_OVERRUN',
  'station incident':                'STATION_OVERRUN',

  // ── Weather ───────────────────────────────────────────────────────────
  'flooding':                                  'WEATHER',
  'heat speeds':                               'WEATHER',
  'convective rainfall alert tool (cat tool)': 'WEATHER',
  'rainfall – landslip risk':                  'WEATHER',
  'rainfall - landslip risk':                  'WEATHER',  // hyphen variant
  'freight adhesion issues':                   'WEATHER',
  'reportable rail head conditions':           'WEATHER',
  'weather related proactive measures':        'WEATHER',
  'weather related problems - any other':      'WEATHER',

  // ── Administrative / non-incident roll-ups ────────────────────────────
  'building entry':                                        'GENERAL',
  'shift change':                                          'GENERAL',
  'disturbance to/of a projected site/species':            'GENERAL',
  'exclusion zone':                                        'GENERAL',
  'other (environment)':                                   'GENERAL',
  'spills and leaks':                                      'GENERAL',
  'spread of an invasive non-native species':              'GENERAL',
  'statutory nuisance (noise, dust or smoke, light, odour, unsightly conditions)': 'GENERAL',
  'air traffic incidents':                                 'GENERAL',
  'coaches locked out of use':                             'GENERAL',
  'line blockage issues':                                  'GENERAL',
  'miscellaneous':                                         'GENERAL',
  'de-registered vehicles / locomotives and overload rejections': 'GENERAL',
  'real time performance figures':                         'GENERAL',
  'major incident command decision log':                   'GENERAL',
  'dangerous goods incident':                              'GENERAL',
  'i.t. problem':                                          'GENERAL',
  'it/telecoms issues':                                    'GENERAL',
  'actions taken to improve performance':                  'GENERAL',
  'alternative transport issues including rta':            'GENERAL',
  'catering issues':                                       'GENERAL',
  'd.o.o. station equipment':                              'GENERAL',
  'dispatch incidents':                                    'GENERAL',
  'on train cleaning':                                     'GENERAL',
  'passenger loadings':                                    'GENERAL',
  'passenger matters general':                             'GENERAL',
  'passenger special needs':                               'GENERAL',
  'special event (e.g. football incident)':                'GENERAL',
  'staff illness':                                         'GENERAL',
  'staff issues':                                          'GENERAL',
  'timetable / diagram / schedule / notice / simplifier error': 'GENERAL',
  'train crew incident':                                   'GENERAL',
  'train crew hire':                                       'GENERAL',
  'train regulation issues':                               'GENERAL',
  'train service alterations - delay':                     'GENERAL',
}

// ─── Labels marked GENERAL or otherwise judged best-guess. Confirm with
//     the safety team and reassign as needed; the comments mark uncertain
//     calls inline so a code-review pass can sweep them quickly:
//
//   • Isolations → POSSESSION    (electrical isolation for engineering work)
//   • Power Failure → TRACTION_FAILURE (could be lineside power instead)
//   • Heat Speeds → WEATHER       (heat-related ESR; could be INFRASTRUCTURE)
//   • Train Struck an Object → INFRASTRUCTURE (could be CRIME if vandalism)
//   • Unsecured Access Gate → INFRASTRUCTURE (could be CRIME)
//   • Road Vehicle Incursion → BRIDGE_STRIKE (groups with obstructions)
//   • Call for Aid → PASSENGER_INJURY (could be CRIME for assistance calls)
//   • Train or Vehicle Runaway → DERAILMENT
//   • Concern For Welfare → CRIME (confirmed by user)
//   • Group Standard GE/RT3350 + GE/RT8250 → IRREGULAR_WORKING
//   • Dangerous Goods Incident → GENERAL (no dedicated category)
//   • All Train Door Incidents / Train Stop & Examine etc. → TRAIN_FAULT
//   • All admin / log / scheduling rows → GENERAL

function normLabel(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

const LABEL_CATEGORY: Map<string, IncidentCategory> = new Map(
  Object.entries(LABEL_CATEGORY_RAW).map(([k, v]) => [normLabel(k), v]),
)

export const KNOWN_LABELS: ReadonlyMap<string, IncidentCategory> = LABEL_CATEGORY

// ─── CCIL numeric type code → category (secondary signal) ───────────────────
// Used only when `incident_type_label` is empty. The numeric code list
// mirrors DLog2's ccilParser; the same list seeds lib/syntheticData.ts.

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

export const KNOWN_TYPE_CODES: ReadonlyMap<string, IncidentCategory> = TYPE_CODE_LOOKUP

function lookupLabel(raw: string | null | undefined): IncidentCategory | null {
  const k = normLabel(raw)
  if (!k) return null
  return LABEL_CATEGORY.get(k) ?? null
}

function lookupCode(raw: string | null | undefined): IncidentCategory | null {
  if (!raw) return null
  const k = raw.trim().toLowerCase()
  if (!k) return null
  return TYPE_CODE_LOOKUP.get(k) ?? null
}

// ─── Title-only fallback (last resort) ──────────────────────────────────────
// Only consulted when both label and code are absent. Patterns are tight
// to avoid the kind of false positives the upstream regex fallback
// produced (substring matches into PERSON_STRUCK).

interface TitlePattern {
  category: IncidentCategory
  pattern:  RegExp
}

const TITLE_CONFIRMATION: TitlePattern[] = [
  { category: 'PERSON_STRUCK',     pattern: /\bperson\s+struck\s+by\s+(?:a\s+|the\s+)?train\b|\bstruck\s+by\s+(?:a\s+|the\s+)?train\b|\bfatality\b|\bfatal\s+(?:incident|injury|collision)\b/i },
  { category: 'BRIDGE_STRIKE',     pattern: /\bbridge\s+strike\b|\bover[- ]?height\s+vehicle\b/i },
  { category: 'NEAR_MISS',         pattern: /\bnear[- ]?miss\b/i },
  { category: 'SPAD',              pattern: /\bSPAD\b|\bsignal\s+passed\s+(?:at\s+)?danger\b/i },
  { category: 'TPWS',              pattern: /\bTPWS\b/i },
  { category: 'LEVEL_CROSSING',    pattern: /\blevel\s+crossing\b/i },
  { category: 'FIRE',              pattern: /\blineside\s+fire\b|\btrain\s+fire\b|\bcarriage\s+fire\b/i },
  { category: 'IRREGULAR_WORKING', pattern: /\birregular\s+working\b/i },
  { category: 'HABD_WILD',         pattern: /\bHABD\b|\bWILD\b/i },
]

// A row only counts as administrative when every operational signal is
// absent at once — no reference of any kind AND no impact. Requiring
// joint absence keeps the heuristic from demoting legitimate PSTs that
// happen to lack one or two refs.
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
  const title   = (i.title || '').trim()
  const rawLabel = (i.incident_type_label || '').trim()
  const stored: IncidentCategory =
    i.category === 'FATALITY' ? 'PERSON_STRUCK' : i.category

  // ── Step 1. Label is gospel ────────────────────────────────────────────
  if (rawLabel) {
    const labelCat = lookupLabel(rawLabel)
    if (labelCat) {
      if (labelCat !== stored) {
        return {
          category:   labelCat,
          confidence: 'HIGH',
          reason:     `CCIL label "${rawLabel}" → ${labelCat} (DLog2 stored ${stored})`,
        }
      }
      return {
        category:   labelCat,
        confidence: 'HIGH',
        reason:     `CCIL label "${rawLabel}" confirms ${labelCat}`,
      }
    }
    // Label is present but not in the canonical map — surface for review
    // so the safety team can extend LABEL_CATEGORY. Keep DLog2's category
    // for the moment so downstream reports still have something to render.
    return {
      category:   stored,
      confidence: 'MEDIUM',
      reason:     `Unrecognised CCIL label "${rawLabel}" — add to LABEL_CATEGORY map`,
    }
  }

  // ── Step 2. No label. Try CCIL numeric code as a secondary signal. ────
  const codeCat = lookupCode(i.incident_type_code)
  if (codeCat) {
    if (codeCat !== stored) {
      return {
        category:   codeCat,
        confidence: 'MEDIUM',
        reason:     `No label — CCIL code ${i.incident_type_code} → ${codeCat} (stored as ${stored})`,
      }
    }
    return {
      category:   codeCat,
      confidence: 'MEDIUM',
      reason:     `No label — CCIL code ${i.incident_type_code} confirms ${codeCat}`,
    }
  }

  // ── Step 3. Title fallback. LOW confidence (no canonical signal). ─────
  if (title) {
    for (const conf of TITLE_CONFIRMATION) {
      if (conf.pattern.test(title)) {
        if (looksAdministrative(i)) {
          return {
            category:   'GENERAL',
            confidence: 'HIGH',
            reason:     'No label, no code, no impact, no refs — administrative entry despite matching title',
          }
        }
        return {
          category:   conf.category,
          confidence: 'LOW',
          reason:     `No label or code — title-only match for ${conf.category}`,
        }
      }
    }
  }

  // ── Step 4. Admin shape with no signal anywhere → GENERAL. ────────────
  if (looksAdministrative(i)) {
    return {
      category:   'GENERAL',
      confidence: 'HIGH',
      reason:     'No label, no code, no impact metrics — administrative entry',
    }
  }

  return {
    category:   stored,
    confidence: 'LOW',
    reason:     'No CCIL label, no code, no title match — relying on DLog2 fallback',
  }
}
