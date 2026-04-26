# Patch 1 — `lib/ccilParser.ts`

Goal: capture the extra fields the parser already sees but currently throws away.

## 1. Replace the `parseIncidentBlock` function

Locate `function parseIncidentBlock(...)` and replace its **declaration block + body**
with the version below. The signature is unchanged. New behaviour:

- Parses `incident_type_code` and `incident_type_label` separately
- Captures `line`, `possessionRef`, full timing row (advised, initial resp, arrived, NWR)
- Parses the `TRAIN` block (`trainId`, company, origin, destination, unit numbers)
- Computes `eventCount`, `hasFiles`
- Derives `minsToAdvised`, `minsToResponse`, `minsToArrival`, `incidentDuration`

```typescript
// ─── HH:MM string helpers ───────────────────────────────────────────────────

/** Convert "1500" or "15:00" → minutes-since-midnight. Returns null on failure. */
function timeToMinutes(t: string | undefined): number | null {
  if (!t) return null
  const m = t.replace(/[^\d:]/g, '')
  if (!m) return null
  const colon = m.indexOf(':')
  let hh: number, mm: number
  if (colon >= 0) {
    hh = parseInt(m.slice(0, colon), 10)
    mm = parseInt(m.slice(colon + 1), 10)
  } else if (m.length === 4) {
    hh = parseInt(m.slice(0, 2), 10)
    mm = parseInt(m.slice(2, 4), 10)
  } else {
    return null
  }
  if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return hh * 60 + mm
}

/** Difference in minutes, with day-rollover handling (max 24h window). */
function diffMinutes(start: string | undefined, end: string | undefined): number | null {
  const s = timeToMinutes(start)
  const e = timeToMinutes(end)
  if (s === null || e === null) return null
  let d = e - s
  if (d < 0) d += 24 * 60
  return d > 24 * 60 ? null : Math.max(0, d)
}

/** "1500" → "15:00". Empty / unparseable → empty string. */
function fmtHHMM(raw: string | undefined): string {
  if (!raw) return ''
  const cleaned = raw.replace(/[^\d:]/g, '')
  if (!cleaned) return ''
  if (cleaned.includes(':')) return cleaned
  if (cleaned.length === 4) return `${cleaned.slice(0, 2)}:${cleaned.slice(2, 4)}`
  return ''
}

function parseIncidentBlock(
  lines: string[],
  title: string,
  ccil: string,
  isoDate: string
): Incident {
  let location = ''
  let line = ''
  let incidentType = ''
  let faultNo = ''
  let possessionRef = ''
  let area = ''
  let action = ''
  let btpRef = ''
  let thirdPartyRef = ''
  let incidentStart = ''
  let advisedTime = ''
  let initialResp = ''
  let arrivedAt = ''
  let nwrTime = ''
  let cancelled = 0
  let partCancelled = 0
  let trainsDelayed = 0
  let minutesDelay = 0
  let ftsDivCount = 0
  let trustRef = ''
  let tdaRef = ''
  let trmcCode = ''
  let hasFiles = false
  // TRAIN block
  let trainId = ''
  let trainCompany = ''
  let trainOrigin = ''
  let trainDestination = ''
  const unitNumbers: string[] = []

  const events: IncidentEvent[] = []
  let inEvents = false
  let eventHeaderSeen = false
  let inTrainBlock = false
  let trainHeaderSeen = false

  // Track which row of the type/line/area block we're processing
  let typeRowSeen = false

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]
    const ln = raw.trim()
    if (!ln) continue
    if (ln === '| --- | --- | --- | --- |') continue

    const cells = ln.startsWith('|') ? cellValues(ln) : []

    // ── Section markers ────────────────────────────────────────────────────
    if (ln === '**EVENTS**') { inEvents = true; inTrainBlock = false; continue }
    if (ln === '**TRAIN**')  { inTrainBlock = true; inEvents = false; trainHeaderSeen = false; continue }

    // ── TRAIN block parsing ────────────────────────────────────────────────
    if (inTrainBlock) {
      if (ln.includes('**T. ID**') && ln.includes('**Date**')) {
        trainHeaderSeen = true
        continue
      }
      if (trainHeaderSeen && ln.startsWith('|') && !ln.includes('**')) {
        // | T.ID | DD/MM/YYYY | HH:MM | Origin | Destination | Co | Driver | Guard |
        if (cells.length >= 6 && /^[0-9A-Z]{4,5}$/i.test(cells[0]) && !trainId) {
          trainId = cells[0]
          trainOrigin = cells[3] || ''
          trainDestination = cells[4] || ''
          trainCompany = cells[5] || ''
        }
        continue
      }
      if (ln.toLowerCase().includes('vehicle (unit)')) {
        // | **Vehicle (Unit):** |  | 66548  66012 |
        const allCells = cellValues(ln)
        const numCell = allCells.find(c => /\d/.test(c) && !/vehicle/i.test(c))
        if (numCell) {
          numCell.split(/\s+/).map(s => s.trim()).filter(Boolean).forEach(u => unitNumbers.push(u))
        }
        continue
      }
    }

    // ── EVENTS block parsing (unchanged) ───────────────────────────────────
    if (inEvents) {
      if (ln.includes('**Date**') && ln.includes('**Description**')) {
        eventHeaderSeen = true
        continue
      }
      if (!eventHeaderSeen) continue
      if (ln.startsWith('|')) {
        const ec = cellValues(ln)
        if (ec.length >= 4 && /^\d{2}\/\d{2}$/.test(ec[0]) && ec[3]) {
          events.push({
            date: ec[0],
            time: ec[1],
            company: ec[2],
            description: ec[3],
          })
        }
      }
      continue
    }

    // ── Header block (everything before EVENTS / TRAIN) ────────────────────

    // Location row: first non-label, non-typecode cell
    if (!location && cells.length > 0) {
      const candidates = cells
        .map(c => c.trim())
        .filter(Boolean)
        .filter(c => !/^(Location|Line|Fault Number|Area|Action|BTP Ref|Incident Start|Updated|Advised|Date|Time|Company|Description|TDA|TRMC|Can|Pt Can|Trains|Mins|FTS|Files|Possession Ref)\s*:?\s*$/i.test(c))
        .filter(c => !/^\d{1,3}[A-Z]?\s/.test(c))
        .filter(c => !/^Incident\s+\d+$/i.test(c))

      if (candidates.length > 0) {
        const topCandidate = candidates[0]
        if (!/:\s*$/.test(topCandidate)) {
          location = topCandidate
            .replace(/\s*-?\s*\[[A-Z]{2,4}\]/g, '')
            .replace(/ - $/, '')
            .trim()
        }
      }
    }

    // Type + fault + possession row
    // | **05C Track Circuit Failure** | **Line: ** | **Fault Number:** | 1139281 |
    if (cells.length > 0 && ln.includes('Fault Number')) {
      incidentType = cells[0] || ''
      faultNo = cells[3] || ''
      typeRowSeen = true
      continue
    }

    // Line + possession row (immediately after the type row)
    // |  | Down Fast | **Possession Ref****:** |  |
    if (typeRowSeen && !line && cells.length >= 2 && ln.toLowerCase().includes('possession ref')) {
      // The line direction is in cell[1]
      const candidate = cells[1]?.trim() || ''
      if (candidate && !/^possession ref/i.test(candidate)) line = candidate
      possessionRef = cells[3] || ''
      continue
    }

    // Area / Action / BTP row
    // | **Area: ** | **Action: ** NJ BK AW LH | **BTP Ref:** | 392 05/12/2025 |
    if (cells.length > 0 && ln.includes('Area:') && ln.includes('Action:')) {
      area = cells[0].replace(/^Area:\s*/i, '').trim()
      action = cells[1].replace(/^Action:\s*/i, '').trim()
      const btpM = cells[3]?.match(/^(\d+)/)
      btpRef = btpM ? btpM[1] : ''
      continue
    }

    // Sometimes a row carries 3rd Party Ref on its own
    if (ln.includes('3') && ln.toLowerCase().includes('party ref')) {
      const tpc = cellValues(ln)
      thirdPartyRef = tpc[3] || ''
      continue
    }

    // Incident Start / Advised / ... / NWR header row → next line has values
    if (ln.includes('Incident Start') && ln.includes('Advised')) {
      const nextLine = lines[i + 1]?.trim() || ''
      if (nextLine.startsWith('|')) {
        const tc = cellValues(nextLine)
        // | Incident Start | Advised | Paged | Initial Resp | Arrived At | Trains Susp | OTM | NWR | Booked In Order |
        incidentStart = tc[0] || ''
        advisedTime   = tc[1] || ''
        initialResp   = tc[3] || ''
        arrivedAt     = tc[4] || ''
        nwrTime       = tc[7] || ''
      }
      continue
    }

    // Stats row → next line has values
    if (ln.includes('**TDA**') && ln.includes('**Can**')) {
      const nextLine = lines[i + 1]?.trim() || ''
      if (nextLine.startsWith('|') && !nextLine.includes('**')) {
        const tc = cellValues(nextLine)
        // | TDA | TRMC | Can | Pt Can | blank | Trains | Mins | FTS/DIV | blank | Files | blank |
        tdaRef        = tc[0] && tc[0] !== 'None' ? tc[0] : ''
        trustRef      = tc[1] || ''  // historical alias kept
        trmcCode      = tc[1] || ''
        cancelled     = parseInt(tc[2]) || 0
        partCancelled = parseInt(tc[3]) || 0
        trainsDelayed = parseInt(tc[5]) || 0
        minutesDelay  = parseInt(tc[6]) || 0
        ftsDivCount   = parseInt(tc[7]) || 0
        hasFiles      = /^yes/i.test(tc[9] || '')
      }
      continue
    }
  }

  // ── Classification (unchanged) ────────────────────────────────────────────
  const searchText = `${title} ${incidentType} ${location} ${events[0]?.description || ''}`
  let category: IncidentCategory = classifyByTypeCode(incidentType) || 'GENERAL'
  if (category === 'GENERAL') {
    for (const [pat, cat] of CATEGORY_PATTERNS) {
      if (pat.test(searchText)) { category = cat; break }
    }
  }
  if (category === 'PERSON_STRUCK' &&
      /verbal assault|assault on staff|staff.*assault|anti.?social|harassment|accident.*train|accident.*platform|slip|trip|fell/i.test(searchText) &&
      !/struck.*train|by.*train/i.test(title)) {
    category = 'PASSENGER_INJURY'
  }
  if (category === 'DERAILMENT' &&
      /door fault|door failure|unit.*fault|unit.*defect|train.*defect|on.?board|mechanical|bogie/i.test(title) &&
      !/derail|divided|runaway/i.test(title)) {
    category = 'TRAIN_FAULT'
  }
  if (category === 'HABD_WILD' && /near.?miss/i.test(title)) {
    category = 'NEAR_MISS'
  }

  let severity: Severity = 'LOW'
  for (const [cats, sev] of SEVERITY_RULES) {
    if (cats.includes(category)) { severity = sev; break }
  }
  if (severity === 'LOW' && minutesDelay > 2000) severity = 'CRITICAL'
  else if (severity === 'LOW' && minutesDelay > 1000) severity = 'HIGH'
  else if (severity === 'LOW' && minutesDelay > 500) severity = 'MEDIUM'

  // ── Type code/label split (e.g. "05C Track Circuit Failure") ─────────────
  const typeMatch = incidentType.match(/^([0-9A-Z]+[a-z]?)\s+(.+)$/)
  const incidentTypeCode  = typeMatch ? typeMatch[1] : (incidentType.split(/\s+/)[0] || '')
  const incidentTypeLabel = typeMatch ? typeMatch[2].trim() : incidentType.replace(incidentTypeCode, '').trim()

  // ── Responder initials ────────────────────────────────────────────────────
  const responderInitials = action
    .split(/\s+/)
    .map(s => s.toUpperCase().trim())
    .filter(s => /^[A-Z]{2,4}$/.test(s))

  // ── Best description (NR voice preferred) ─────────────────────────────────
  const nrEvent = events.find(e => e.company === 'NR' && e.description.length > 50)
  const description = (nrEvent || events[0])?.description?.replace(/\s+/g, ' ').trim() || title

  // ── Time normalisation ────────────────────────────────────────────────────
  const startHHMM = fmtHHMM(incidentStart) || isoDate.slice(11, 16)

  // ── Derived response metrics ─────────────────────────────────────────────
  const minsToAdvised   = diffMinutes(incidentStart, advisedTime)
  const minsToResponse  = diffMinutes(incidentStart, initialResp)
  const minsToArrival   = diffMinutes(incidentStart, arrivedAt)
  const incidentDuration = diffMinutes(incidentStart, nwrTime)

  return {
    id: `ccil-${ccil}`,
    ccil,
    trustRef: trustRef || undefined,
    faultNo: faultNo || undefined,
    category,
    severity,
    title: stripMd(title),
    location: location || 'Unknown',
    area: area || undefined,
    line: line || undefined,
    incidentStart: startHHMM,
    description,
    events,
    cancelled,
    partCancelled,
    trainsDelayed,
    minutesDelay,
    btpRef: btpRef || undefined,
    actionCode: action || undefined,
    isHighlight: false,
    rawText: lines.join('\n').slice(0, 1000),

    // Extended capture for Insight analytics
    incidentTypeCode:  incidentTypeCode  || undefined,
    incidentTypeLabel: incidentTypeLabel || undefined,
    possessionRef:     possessionRef     || undefined,
    thirdPartyRef:     thirdPartyRef     || undefined,
    advisedTime:       fmtHHMM(advisedTime) || undefined,
    initialRespTime:   fmtHHMM(initialResp) || undefined,
    arrivedAtTime:     fmtHHMM(arrivedAt)   || undefined,
    nwrTime:           fmtHHMM(nwrTime)     || undefined,
    minsToAdvised:     minsToAdvised   ?? undefined,
    minsToResponse:    minsToResponse  ?? undefined,
    minsToArrival:     minsToArrival   ?? undefined,
    incidentDuration:  incidentDuration ?? undefined,
    trainId:           trainId || undefined,
    trainCompany:      trainCompany || undefined,
    trainOrigin:       trainOrigin || undefined,
    trainDestination:  trainDestination || undefined,
    unitNumbers:       unitNumbers.length ? unitNumbers : undefined,
    tdaRef:            tdaRef || undefined,
    trmcCode:          trmcCode || undefined,
    ftsDivCount:       ftsDivCount || undefined,
    eventCount:        events.length,
    hasFiles,
    responderInitials: responderInitials.length ? responderInitials : undefined,
  }
}
```

That's the only function that changes in this file. The exported `parseCCILText`
and the other helpers are untouched.
