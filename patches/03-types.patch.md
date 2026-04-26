# Patch 3 — `lib/types.ts`

Goal: type the new optional fields on the `Incident` interface so the parser
and supabase client compile with `--strict`.

Locate the `export interface Incident` block and **append** the fields below
to the existing interface. The existing fields are unchanged.

```typescript
export interface Incident {
  // ... existing fields unchanged ...

  // Extended capture for Insight analytics platform — all optional, all nullable.
  incidentTypeCode?:  string         // e.g. "05C"
  incidentTypeLabel?: string         // e.g. "Track Circuit Failure"
  possessionRef?:     string
  thirdPartyRef?:     string

  advisedTime?:       string         // HH:MM
  initialRespTime?:   string         // HH:MM
  arrivedAtTime?:     string         // HH:MM
  nwrTime?:           string         // HH:MM

  minsToAdvised?:     number
  minsToResponse?:    number
  minsToArrival?:     number
  incidentDuration?:  number         // mins from incident_start to NWR

  trainId?:           string
  trainCompany?:      string
  trainOrigin?:       string
  trainDestination?:  string
  unitNumbers?:       string[]

  tdaRef?:            string
  trmcCode?:          string
  ftsDivCount?:       number

  eventCount?:        number
  hasFiles?:          boolean
  responderInitials?: string[]
}
```
