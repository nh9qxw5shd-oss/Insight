# Patch 2 — `lib/supabaseClient.ts`

Goal: persist the extra fields parsed in patch 1.

In `upsertReportData`, locate the `rows = annotated.map(...)` block and replace
it with the version below. All other logic in the function is unchanged.

```typescript
  const rows = annotated.map(inc => {
    // Pre-compute hour/dow for cheap analytics queries
    let hourOfDay: number | null = null
    let dayOfWeek: number | null = null
    if (inc.incidentStart && /^\d{2}:\d{2}$/.test(inc.incidentStart)) {
      hourOfDay = parseInt(inc.incidentStart.slice(0, 2), 10)
    }
    if (log.date) {
      const [y, m, d] = log.date.split('-').map(Number)
      const dt = new Date(Date.UTC(y, m - 1, d))
      dayOfWeek = dt.getUTCDay()
    }

    return {
      report_id:       reportId,
      report_date:     log.date,
      ccil:            inc.ccil          || null,
      category:        inc.category,
      severity:        inc.severity,
      title:           inc.title,
      location:        inc.location      || null,
      area:            inc.area          || null,
      incident_start:  inc.incidentStart || null,
      minutes_delay:   inc.minutesDelay  ?? 0,
      trains_delayed:  inc.trainsDelayed ?? 0,
      cancelled:       inc.cancelled     ?? 0,
      part_cancelled:  inc.partCancelled ?? 0,
      is_highlight:    inc.isHighlight,
      is_continuation: inc.isContinuation ?? false,
      delay_delta:     inc.delayDelta    ?? null,

      // Extended capture
      incident_type_code:  inc.incidentTypeCode  ?? null,
      incident_type_label: inc.incidentTypeLabel ?? null,
      line:                inc.line              ?? null,
      fault_number:        inc.faultNo           ?? null,
      possession_ref:      inc.possessionRef     ?? null,
      btp_ref:             inc.btpRef            ?? null,
      third_party_ref:     inc.thirdPartyRef     ?? null,
      action_code:         inc.actionCode        ?? null,
      responder_initials:  inc.responderInitials ?? null,
      advised_time:        inc.advisedTime       ?? null,
      initial_resp_time:   inc.initialRespTime   ?? null,
      arrived_at_time:     inc.arrivedAtTime     ?? null,
      nwr_time:            inc.nwrTime           ?? null,
      mins_to_advised:     inc.minsToAdvised     ?? null,
      mins_to_response:    inc.minsToResponse    ?? null,
      mins_to_arrival:     inc.minsToArrival     ?? null,
      incident_duration:   inc.incidentDuration  ?? null,
      train_id:            inc.trainId           ?? null,
      train_company:       inc.trainCompany      ?? null,
      train_origin:        inc.trainOrigin       ?? null,
      train_destination:   inc.trainDestination  ?? null,
      unit_numbers:        inc.unitNumbers       ?? null,
      trust_ref:           inc.trustRef          ?? null,
      tda_ref:             inc.tdaRef            ?? null,
      trmc_code:           inc.trmcCode          ?? null,
      fts_div_count:       inc.ftsDivCount       ?? null,
      event_count:         inc.eventCount        ?? null,
      has_files:           inc.hasFiles          ?? false,
      hour_of_day:         hourOfDay,
      day_of_week:         dayOfWeek,
    }
  })
```
