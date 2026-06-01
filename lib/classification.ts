// ─── Incident classification ─────────────────────────────────────────────────
// The CCIL `incident_type_label` is the authoritative classifier. Every
// CCIL label maps deterministically to an Insight category via the
// LABEL_CATEGORY table below. PSBT has exactly two labels: "Person Struck
// by Train" and "Fatality".
//
// Resolution order:
//   1. incident_type_label   — the CCIL gospel
//   2. incident_type_code    — numeric fallback when no label is set
//   3. title pattern         — last-resort match if neither is available
//   4. DLog2's stored category, else GENERAL
//
// The classifier returns a single IncidentCategory. If a row arrives with
// a category the safety team disagrees with, the fix is to correct the
// label / code / map row at source — not to add a review layer here.

import { IncidentCategory, IncidentRow } from './types'

// ─── CCIL incident type label → Insight category ────────────────────────────
// The label is the canonical CCIL value, not the title. Keys are stored
// lower-case + whitespace-normalised by the lookup wrapper below.

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
  'group standard ge/rt3350':               'TRAIN_FAULT',
  'group standard ge/rt8250':               'TRAIN_FAULT',

  // ── Traction / OHL ────────────────────────────────────────────────────
  'traction failure non-passenger':         'TRACTION_FAILURE',
  'traction failure passenger':             'TRACTION_FAILURE',
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
  'temporary speed restriction (tsr)':      'INFRASTRUCTURE',
  'emergency speed restrictions':           'INFRASTRUCTURE',
  'station infrastructure':                 'INFRASTRUCTURE',
  'track circuit failure (leaf fall)':      'INFRASTRUCTURE',
  'isolations':                             'INFRASTRUCTURE',
  'object/plastic on ohl':                  'INFRASTRUCTURE',
  'traction current problem':               'INFRASTRUCTURE',
  'ohl dewirement':                         'INFRASTRUCTURE',

  // ── Level crossing ────────────────────────────────────────────────────
  'level crossing failure':                 'LEVEL_CROSSING',
  'level crossing failure - telephones':    'LEVEL_CROSSING',
  'level crossing deliberate misuse':       'LEVEL_CROSSING',
  'level crossing incident':                'LEVEL_CROSSING',

  // ── Bridge strike ─────────────────────────────────────────────────────
  'bridge strike':                                              'BRIDGE_STRIKE',
  'bridge/structural defects or incidents (ex. bridge strikes)':'BRIDGE_STRIKE',

  // ── Safety event types ────────────────────────────────────────────────
  'signals passed at danger (category a)':                  'SPAD',
  'signals passed at danger (category a) (weather related)':'SPAD',
  'tpws activation':                                        'TPWS',
  'near miss':                                              'NEAR_MISS',
  'wheelchex / wild activation and confirmed hot axle boxes':'HABD_WILD',

  // ── Irregular working ─────────────────────────────────────────────────
  'irregular working : network rail infrastructure':          'IRREGULAR_WORKING',
  'irregular working : network rail infrastructure projects': 'IRREGULAR_WORKING',
  'irregular working : network rail operations':              'IRREGULAR_WORKING',
  'irregular working : toc':                                  'IRREGULAR_WORKING',
  'divided train':                                            'IRREGULAR_WORKING',
  'incorrect door release':                                   'IRREGULAR_WORKING',
  'speeding':                                                 'IRREGULAR_WORKING',
  'missed power changeover':                                  'IRREGULAR_WORKING',
  'passenger on ecs':                                         'IRREGULAR_WORKING',
  'staff on ecs':                                             'IRREGULAR_WORKING',
  'train or vehicle runaway':                                 'IRREGULAR_WORKING',
  'dispatch incidents':                                       'IRREGULAR_WORKING',

  // ── Fire ──────────────────────────────────────────────────────────────
  'fires':                              'FIRE',
  'lineside fire':                      'FIRE',
  'smouldering sleepers/sleeper fires': 'FIRE',

  // ── Derailment ────────────────────────────────────────────────────────
  'derailment': 'DERAILMENT',

  // ── Possession ────────────────────────────────────────────────────────
  'possession overrun':            'POSSESSION',
  'possession monitoring':         'POSSESSION',
  'significant possession problem':'POSSESSION',

  // ── Station / overrun ─────────────────────────────────────────────────
  'station overrun':                  'STATION_OVERRUN',
  'station overrun (weather related)':'STATION_OVERRUN',
  'stopping incidents':               'STATION_OVERRUN',

  // ── Weather ───────────────────────────────────────────────────────────
  'flooding':                                  'WEATHER',
  'heat speeds':                               'WEATHER',
  'convective rainfall alert tool (cat tool)': 'WEATHER',
  'rainfall – landslip risk':                  'WEATHER',
  'rainfall - landslip risk':                  'WEATHER',
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
  'etcs incident':                                         'GENERAL',
  'planning errors':                                       'GENERAL',
  'collision':                                             'GENERAL',
  'road vehicle incursion (non level crossing)':           'GENERAL',
  'rolling stock traction hire':                           'GENERAL',
  'egress activation':                                     'GENERAL',
  'passcomm activation':                                   'GENERAL',
  'freight trains over length':                            'GENERAL',
  'item dropped on track':                                 'GENERAL',
  'management of early running train':                     'GENERAL',
  'station incident':                                      'GENERAL',
  'actions taken to improve performance':                  'GENERAL',
  'alternative transport issues including rta':            'GENERAL',
  'catering issues':                                       'GENERAL',
  'd.o.o. station equipment':                              'GENERAL',
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

function normLabel(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

const LABEL_CATEGORY: Map<string, IncidentCategory> = new Map(
  Object.entries(LABEL_CATEGORY_RAW).map(([k, v]) => [normLabel(k), v]),
)

export const KNOWN_LABELS: ReadonlyMap<string, IncidentCategory> = LABEL_CATEGORY

// ─── CCIL numeric type code → category (fallback when label is empty) ───────

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

// ─── Title-only fallback (last resort, label and code both absent) ──────────

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

// Returns the trusted category for an incident row.
export function classifyTrusted(i: IncidentRow): IncidentCategory {
  const labelCat = lookupLabel(i.incident_type_label)
  if (labelCat) return labelCat

  const codeCat = lookupCode(i.incident_type_code)
  if (codeCat) return codeCat

  const title = (i.title || '').trim()
  if (title) {
    for (const conf of TITLE_CONFIRMATION) {
      if (conf.pattern.test(title)) return conf.category
    }
  }

  if (i.category === 'FATALITY') return 'PERSON_STRUCK'
  return i.category ?? 'GENERAL'
}
