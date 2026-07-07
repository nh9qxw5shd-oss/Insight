'use client'

import { useState, useMemo } from 'react'
import { Grid2x2, Download, Info } from 'lucide-react'
import { IncidentRow, IncidentCategory, CATEGORY_CONFIG, Severity } from '@/lib/types'
import { effectiveDelay } from '@/lib/queries'
import { railwayPeriodWeek } from '@/lib/railwayCalendar'

// ─── Dimensions ───────────────────────────────────────────────────────────────

type DimKey =
  | 'category' | 'area' | 'severity' | 'line' | 'type'
  | 'hourBand' | 'dow' | 'period' | 'week'

const HOUR_BANDS = ['00–06', '06–09', '09–12', '12–15', '15–18', '18–21', '21–24'] as const

function hourBandOf(hour: number | null): string {
  if (hour == null || hour < 0 || hour > 23) return 'Unknown'
  if (hour < 6)  return '00–06'
  if (hour < 9)  return '06–09'
  if (hour < 12) return '09–12'
  if (hour < 15) return '12–15'
  if (hour < 18) return '15–18'
  if (hour < 21) return '18–21'
  return '21–24'
}

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const SEV_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']

// "P03 · 26/27"
function periodKeyOf(i: IncidentRow): string {
  const pw = railwayPeriodWeek(i.report_date)
  return `P${String(pw.period).padStart(2, '0')} · ${pw.yearLabel.slice(2)}`
}

// "P03 W2"
function weekKeyOf(i: IncidentRow): string {
  const pw = railwayPeriodWeek(i.report_date)
  return `P${String(pw.period).padStart(2, '0')} W${pw.week}`
}

interface DimDef {
  key:     DimKey
  label:   string
  valueOf: (i: IncidentRow) => string
  // Fixed display order for small closed sets (hour bands, days, severity).
  // When present it wins over ordering by measure; unmatched values sort last.
  order?:  string[]
}

const DIMENSIONS: DimDef[] = [
  {
    key: 'category', label: 'Category',
    valueOf: i => CATEGORY_CONFIG[i.category as IncidentCategory]?.short ?? i.category,
  },
  { key: 'area',     label: 'Area',          valueOf: i => i.area?.trim() || 'Unknown' },
  { key: 'severity', label: 'Severity',      valueOf: i => i.severity, order: [...SEV_ORDER] },
  { key: 'line',     label: 'Line',          valueOf: i => i.line?.trim() || 'Unknown' },
  { key: 'type',     label: 'Incident type', valueOf: i => i.incident_type_label?.trim() || 'Unknown' },
  {
    key: 'hourBand', label: 'Hour band',
    valueOf: i => hourBandOf(i.hour_of_day),
    order: [...HOUR_BANDS, 'Unknown'],
  },
  {
    key: 'dow', label: 'Day of week',
    valueOf: i => i.day_of_week != null ? (DOW_LABELS[i.day_of_week] ?? 'Unknown') : 'Unknown',
    order: [...DOW_LABELS, 'Unknown'],
  },
  { key: 'period', label: 'Railway period', valueOf: periodKeyOf },
  { key: 'week',   label: 'Railway week',   valueOf: weekKeyOf },
]

function dimByKey(key: DimKey): DimDef {
  return DIMENSIONS.find(d => d.key === key)!
}

// ─── Measures ─────────────────────────────────────────────────────────────────

type MeasureKey =
  | 'count' | 'delay' | 'avgDelay' | 'cancellations'
  | 'trains' | 'avgDuration' | 'slaPct'

const SLA_MINS = 45

// Additive accumulator — merging two cells is plain field-wise addition, which
// keeps "Other" bucketing and totals exact even for averages and percentages.
interface Cell {
  count:     number   // non-continuation incidents
  delay:     number   // effective delay mins (all rows)
  cancels:   number   // cancelled + part_cancelled
  trains:    number   // trains_delayed (non-continuation)
  durSum:    number
  durN:      number
  slaBreach: number
  slaN:      number
}

function emptyCell(): Cell {
  return { count: 0, delay: 0, cancels: 0, trains: 0, durSum: 0, durN: 0, slaBreach: 0, slaN: 0 }
}

function addIncident(c: Cell, i: IncidentRow): void {
  if (!i.is_continuation) {
    c.count  += 1
    c.trains += i.trains_delayed || 0
  }
  c.delay   += effectiveDelay(i)
  c.cancels += (i.cancelled || 0) + (i.part_cancelled || 0)
  if (i.incident_duration != null) { c.durSum += i.incident_duration; c.durN += 1 }
  if (i.mins_to_arrival != null) {
    c.slaN += 1
    if (i.mins_to_arrival > SLA_MINS) c.slaBreach += 1
  }
}

function mergeCell(into: Cell, from: Cell): void {
  into.count += from.count;     into.delay += from.delay
  into.cancels += from.cancels; into.trains += from.trains
  into.durSum += from.durSum;   into.durN += from.durN
  into.slaBreach += from.slaBreach; into.slaN += from.slaN
}

interface MeasureDef {
  key:     MeasureKey
  label:   string
  valueOf: (c: Cell) => number | null
  format:  (v: number) => string
}

const MEASURES: MeasureDef[] = [
  {
    key: 'count', label: 'Incident count',
    valueOf: c => c.count,
    format: v => Math.round(v).toLocaleString(),
  },
  {
    key: 'delay', label: 'Total delay (mins)',
    valueOf: c => c.delay,
    format: v => `${Math.round(v).toLocaleString()}m`,
  },
  {
    key: 'avgDelay', label: 'Avg delay / incident',
    valueOf: c => c.count ? c.delay / c.count : null,
    format: v => `${v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}m`,
  },
  {
    key: 'cancellations', label: 'Cancellations',
    valueOf: c => c.cancels,
    format: v => Math.round(v).toLocaleString(),
  },
  {
    key: 'trains', label: 'Trains delayed',
    valueOf: c => c.trains,
    format: v => Math.round(v).toLocaleString(),
  },
  {
    key: 'avgDuration', label: 'Avg duration (mins)',
    valueOf: c => c.durN ? c.durSum / c.durN : null,
    format: v => `${v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}m`,
  },
  {
    key: 'slaPct', label: 'SLA breach %',
    valueOf: c => c.slaN ? (c.slaBreach / c.slaN) * 100 : null,
    format: v => `${Math.round(v)}%`,
  },
]

function measureByKey(key: MeasureKey): MeasureDef {
  return MEASURES.find(m => m.key === key)!
}

// ─── Grid computation ─────────────────────────────────────────────────────────

const MAX_HEADERS = 15
const OTHER = 'Other'
const NONE_COL = 'All incidents'

interface PivotGrid {
  rowKeys:    string[]
  colKeys:    string[]
  cells:      Map<string, number | null>   // `${row}\u0000${col}` → measure value
  rowTotals:  Map<string, number | null>
  colTotals:  Map<string, number | null>
  grandTotal: number | null
  maxCell:    number
}

function cellId(row: string, col: string): string {
  return `${row}\u0000${col}`
}

// Sort raw keys: cap to the top MAX_HEADERS by measure, remainder → "Other".
// Display order follows the dimension's fixed order when it has one,
// otherwise measure value descending; "Other" always trails.
function selectKeys(agg: Map<string, Cell>, measure: MeasureDef, dim: DimDef): { keys: string[]; topSet: Set<string> } {
  const ranked = Array.from(agg.entries())
    .sort((a, b) => (measure.valueOf(b[1]) ?? -Infinity) - (measure.valueOf(a[1]) ?? -Infinity))
    .map(([k]) => k)
  const top = ranked.slice(0, MAX_HEADERS)
  const hasOther = ranked.length > MAX_HEADERS
  const topSet = new Set(top)
  let keys = top
  if (dim.order) {
    const pos = new Map(dim.order.map((v, i) => [v, i]))
    keys = [...top].sort((a, b) => (pos.get(a) ?? 999) - (pos.get(b) ?? 999))
  }
  return { keys: hasOther ? [...keys, OTHER] : keys, topSet }
}

function computeGrid(
  incidents: IncidentRow[],
  rowDim: DimDef,
  colDim: DimDef | null,
  measure: MeasureDef,
): PivotGrid {
  // Pass 1 — accumulate per raw value pair, plus per-axis aggregates.
  const raw = new Map<string, Cell>()          // rowVal ␀ colVal
  const rowAgg = new Map<string, Cell>()
  const colAgg = new Map<string, Cell>()
  for (const i of incidents) {
    const rv = rowDim.valueOf(i)
    const cv = colDim ? colDim.valueOf(i) : NONE_COL
    const id = cellId(rv, cv)
    let c = raw.get(id);    if (!c) { c = emptyCell(); raw.set(id, c) }
    let r = rowAgg.get(rv); if (!r) { r = emptyCell(); rowAgg.set(rv, r) }
    let k = colAgg.get(cv); if (!k) { k = emptyCell(); colAgg.set(cv, k) }
    addIncident(c, i); addIncident(r, i); addIncident(k, i)
  }

  const rowSel = selectKeys(rowAgg, measure, rowDim)
  const colSel = colDim
    ? selectKeys(colAgg, measure, colDim)
    : { keys: [NONE_COL], topSet: new Set([NONE_COL]) }

  // Pass 2 — rebucket raw cells into the capped grid (accumulators are
  // additive, so merging into "Other" stays exact for every measure).
  const bucketed  = new Map<string, Cell>()
  const rowTotalC = new Map<string, Cell>()
  const colTotalC = new Map<string, Cell>()
  const grandC = emptyCell()
  for (const [id, cell] of raw.entries()) {
    const [rv, cv] = id.split('\u0000')
    const br = rowSel.topSet.has(rv) ? rv : OTHER
    const bc = colSel.topSet.has(cv) ? cv : OTHER
    const bid = cellId(br, bc)
    let b = bucketed.get(bid);   if (!b) { b = emptyCell(); bucketed.set(bid, b) }
    let rt = rowTotalC.get(br);  if (!rt) { rt = emptyCell(); rowTotalC.set(br, rt) }
    let ct = colTotalC.get(bc);  if (!ct) { ct = emptyCell(); colTotalC.set(bc, ct) }
    mergeCell(b, cell); mergeCell(rt, cell); mergeCell(ct, cell); mergeCell(grandC, cell)
  }

  const cells = new Map<string, number | null>()
  let maxCell = 0
  for (const [id, cell] of bucketed.entries()) {
    const v = measure.valueOf(cell)
    cells.set(id, v)
    if (v != null && v > maxCell) maxCell = v
  }
  const rowTotals = new Map<string, number | null>()
  for (const [k, c] of rowTotalC.entries()) rowTotals.set(k, measure.valueOf(c))
  const colTotals = new Map<string, number | null>()
  for (const [k, c] of colTotalC.entries()) colTotals.set(k, measure.valueOf(c))

  return {
    rowKeys: rowSel.keys,
    colKeys: colSel.keys,
    cells, rowTotals, colTotals,
    grandTotal: measure.valueOf(grandC),
    maxCell,
  }
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function gridToCSV(grid: PivotGrid, rowDim: DimDef, colDim: DimDef | null, measure: MeasureDef): string {
  const fmt = (v: number | null | undefined) => v == null ? '—' : measure.format(v)
  const header = [
    `${rowDim.label}${colDim ? ` \\ ${colDim.label}` : ''}`,
    ...grid.colKeys,
    'Total',
  ]
  const lines = [header.map(csvEscape).join(',')]
  for (const rk of grid.rowKeys) {
    const cells = grid.colKeys.map(ck => fmt(grid.cells.get(cellId(rk, ck))))
    lines.push([rk, ...cells, fmt(grid.rowTotals.get(rk))].map(csvEscape).join(','))
  }
  const totalRow = ['Total', ...grid.colKeys.map(ck => fmt(grid.colTotals.get(ck))), fmt(grid.grandTotal)]
  lines.push(totalRow.map(csvEscape).join(','))
  return lines.join('\n')
}

function downloadCSV(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ─── Cell styling ─────────────────────────────────────────────────────────────

function heatStyle(v: number | null | undefined, max: number): React.CSSProperties {
  if (v == null || max <= 0 || v <= 0) return {}
  const t = Math.min(1, v / max)
  return { background: `rgba(224, 82, 6, ${(0.04 + t * 0.30).toFixed(3)})` }
}

// ─── PivotTab ─────────────────────────────────────────────────────────────────

export function PivotTab({ incidents }: { incidents: IncidentRow[] }) {
  const [rowKey,     setRowKey]     = useState<DimKey>('category')
  const [colKey,     setColKey]     = useState<DimKey | 'none'>('area')
  const [measureKey, setMeasureKey] = useState<MeasureKey>('count')

  const rowDim  = dimByKey(rowKey)
  const colDim  = colKey === 'none' ? null : dimByKey(colKey)
  const measure = measureByKey(measureKey)
  const sameDims = colDim != null && colDim.key === rowDim.key

  const grid = useMemo(
    () => computeGrid(incidents, rowDim, colDim, measure),
    [incidents, rowDim, colDim, measure],
  )

  const fmt = (v: number | null | undefined) => v == null ? '—' : measure.format(v)

  function handleDownload() {
    const csv = gridToCSV(grid, rowDim, colDim, measure)
    const stamp = new Date().toISOString().slice(0, 10)
    downloadCSV(csv, `insight-pivot-${rowDim.key}${colDim ? `-by-${colDim.key}` : ''}-${measure.key}-${stamp}.csv`)
  }

  return (
    <div className="space-y-6">

      {/* Heading */}
      <div className="flex items-center gap-3">
        <Grid2x2 size={15} style={{ color: 'var(--nr-orange)', flexShrink: 0 }} />
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--ink-100)' }}>Pivot</div>
          <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>
            Cross-tabulate the current window by any two dimensions and measure
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="card p-4 flex flex-wrap items-end gap-4">
        <div>
          <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>Rows</div>
          <select className="select text-xs" value={rowKey} onChange={e => setRowKey(e.target.value as DimKey)}>
            {DIMENSIONS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </div>
        <div>
          <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>Columns</div>
          <select className="select text-xs" value={colKey} onChange={e => setColKey(e.target.value as DimKey | 'none')}>
            <option value="none">— none —</option>
            {DIMENSIONS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </div>
        <div>
          <div className="label-micro text-[9px] mb-1" style={{ color: 'var(--ink-500)' }}>Measure</div>
          <select className="select text-xs" value={measureKey} onChange={e => setMeasureKey(e.target.value as MeasureKey)}>
            {MEASURES.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
        <button onClick={handleDownload} className="btn flex items-center gap-1.5 !py-1.5 ml-auto" disabled={grid.rowKeys.length === 0}>
          <Download size={11} /> Download CSV
        </button>
      </div>

      {/* Same-dimension hint */}
      {sameDims && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded border text-xs"
          style={{ borderColor: 'var(--nr-amber)', background: 'var(--bg-card)', color: 'var(--nr-amber)' }}>
          <Info size={12} style={{ flexShrink: 0 }} />
          Rows and columns are the same dimension — pick two different dimensions for a useful cross-tab.
        </div>
      )}

      {/* Grid */}
      {grid.rowKeys.length === 0 ? (
        <div className="rounded border py-16 flex flex-col items-center gap-2" style={{ borderColor: 'var(--line)', borderStyle: 'dashed' }}>
          <Grid2x2 size={26} style={{ color: 'var(--ink-500)' }} />
          <div className="text-sm" style={{ color: 'var(--ink-400)' }}>No incidents in the current window</div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b flex items-center justify-between" style={{ borderColor: 'var(--line)' }}>
            <span className="label-micro" style={{ color: 'var(--nr-orange)' }}>
              {measure.label} — {rowDim.label}{colDim ? ` × ${colDim.label}` : ''}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>
              {grid.rowKeys.length} rows × {grid.colKeys.length} cols
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs" style={{ borderCollapse: 'separate', borderSpacing: 0, minWidth: '100%' }}>
              <thead>
                <tr>
                  <th
                    className="text-left px-3 py-2 label-micro text-[9px] font-medium border-b border-r"
                    style={{
                      color: 'var(--ink-500)', borderColor: 'var(--line)',
                      position: 'sticky', left: 0, zIndex: 2, background: 'var(--bg-card)',
                    }}
                  >
                    {rowDim.label}{colDim ? ` \\ ${colDim.label}` : ''}
                  </th>
                  {grid.colKeys.map(ck => (
                    <th key={ck} className="text-right px-3 py-2 label-micro text-[9px] font-medium border-b whitespace-nowrap"
                      style={{ color: 'var(--ink-500)', borderColor: 'var(--line)', background: 'var(--bg-card)' }}>
                      {ck}
                    </th>
                  ))}
                  <th className="text-right px-3 py-2 label-micro text-[9px] font-medium border-b border-l whitespace-nowrap"
                    style={{ color: 'var(--ink-300)', borderColor: 'var(--line-hi)', background: 'var(--bg-card-hi)' }}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {grid.rowKeys.map(rk => (
                  <tr key={rk}>
                    <td
                      className="px-3 py-1.5 border-b border-r whitespace-nowrap"
                      style={{
                        color: 'var(--ink-400)', borderColor: 'var(--line)',
                        position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-card)',
                        maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis',
                      }}
                      title={rk}
                    >
                      {rk}
                    </td>
                    {grid.colKeys.map(ck => {
                      const v = grid.cells.get(cellId(rk, ck))
                      return (
                        <td key={ck} className="px-3 py-1.5 text-right numeric-mono border-b whitespace-nowrap"
                          style={{ color: v == null ? 'var(--ink-500)' : 'var(--ink-200)', borderColor: 'var(--line)', ...heatStyle(v, grid.maxCell) }}>
                          {fmt(v)}
                        </td>
                      )
                    })}
                    <td className="px-3 py-1.5 text-right numeric-mono border-b border-l whitespace-nowrap"
                      style={{ color: 'var(--ink-100)', borderColor: 'var(--line-hi)', background: 'var(--bg-card-hi)' }}>
                      {fmt(grid.rowTotals.get(rk))}
                    </td>
                  </tr>
                ))}
                {/* Column totals */}
                <tr>
                  <td
                    className="px-3 py-2 label-micro text-[9px] border-r whitespace-nowrap"
                    style={{
                      color: 'var(--ink-300)', borderColor: 'var(--line-hi)',
                      position: 'sticky', left: 0, zIndex: 1, background: 'var(--bg-card-hi)',
                    }}
                  >
                    Total
                  </td>
                  {grid.colKeys.map(ck => (
                    <td key={ck} className="px-3 py-2 text-right numeric-mono whitespace-nowrap"
                      style={{ color: 'var(--ink-100)', background: 'var(--bg-card-hi)' }}>
                      {fmt(grid.colTotals.get(ck))}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right numeric-mono font-medium border-l whitespace-nowrap"
                    style={{ color: 'var(--nr-orange)', borderColor: 'var(--line-hi)', background: 'var(--bg-card-hi)' }}>
                    {fmt(grid.grandTotal)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 border-t flex items-center gap-4 text-[9px]" style={{ borderColor: 'var(--line)', color: 'var(--ink-500)' }}>
            <span>Axes capped at top {MAX_HEADERS} values by {measure.label.toLowerCase()} — remainder grouped as “{OTHER}”</span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="w-8 h-2 rounded-sm inline-block" style={{ background: 'linear-gradient(90deg, rgba(224,82,6,0.04), rgba(224,82,6,0.34))' }} />
              cell heat ∝ value
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
