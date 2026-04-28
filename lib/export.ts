'use client'

import { IncidentRow } from './types'

const COLS: { key: keyof IncidentRow; label: string }[] = [
  { key: 'report_date',         label: 'Date' },
  { key: 'ccil',                label: 'CCIL' },
  { key: 'category',            label: 'Category' },
  { key: 'severity',            label: 'Severity' },
  { key: 'incident_type_label', label: 'Type' },
  { key: 'title',               label: 'Title' },
  { key: 'location',            label: 'Location' },
  { key: 'area',                label: 'Area' },
  { key: 'line',                label: 'Line' },
  { key: 'incident_start',      label: 'Start Time' },
  { key: 'minutes_delay',       label: 'Delay (mins)' },
  { key: 'trains_delayed',      label: 'Trains Delayed' },
  { key: 'cancelled',           label: 'Cancelled' },
  { key: 'incident_duration',   label: 'Duration (mins)' },
  { key: 'mins_to_arrival',     label: 'Mins to Arrival' },
  { key: 'train_company',       label: 'Train Company' },
  { key: 'fault_number',        label: 'Fault Number' },
  { key: 'trmc_code',           label: 'Attribution Code' },
  { key: 'btp_ref',             label: 'BTP Ref' },
]

function escapeCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s
}

export function exportCSV(incidents: IncidentRow[], from: string, to: string): void {
  const header = COLS.map(c => c.label).join(',')
  const rows   = incidents.map(i =>
    COLS.map(c => escapeCell(i[c.key])).join(',')
  )
  const csv  = [header, ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `insight-export-${from}-${to}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
