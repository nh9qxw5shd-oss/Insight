// ─── Pure SVG chart builders for the printable report ────────────────────────
// All functions return raw SVG markup as a string. No Recharts dependency at
// print time — keeps fonts vector-clean and avoids hydration-timing issues
// when the report is rendered into an iframe.

import { TrendPointPlain, ChangePointRow, CategoryRow, GeoRow, HeatmapCellPlain, SafetyRadarRow } from './types'

// Visual tokens — must match the print stylesheet in html.ts.
export const REPORT_COLORS = {
  ink:        '#1A1A1A',
  ink2:       '#3A3F4B',
  ink3:       '#6E7480',
  ink4:       '#A0A6B2',
  rule:       'rgba(26, 26, 26, 0.12)',
  ruleHi:     'rgba(26, 26, 26, 0.28)',
  paper:      '#FBF7EE',
  panel:      '#F4EFE2',
  panelLine:  '#E8E1CF',
  orange:     '#E05206',
  orangeSoft: 'rgba(224, 82, 6, 0.16)',
  amber:      '#C7821B',
  red:        '#B23B30',
  green:      '#2F8855',
  steel:      '#476A98',
} as const

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── Trend area chart with rolling-average overlay and change-point markers ──

export function trendAreaSvg(
  points: TrendPointPlain[],
  changePoints: ChangePointRow[],
  metric: 'incidents' | 'delayMins' = 'incidents',
  opts: { width?: number; height?: number; showRolling?: boolean } = {},
): string {
  const W = opts.width ?? 720
  const H = opts.height ?? 200
  const PAD = { top: 18, right: 18, bottom: 28, left: 36 }
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom

  if (points.length < 2) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="report-chart"><text x="${W/2}" y="${H/2}" text-anchor="middle" fill="${REPORT_COLORS.ink4}" font-family="'JetBrains Mono', monospace" font-size="11">Insufficient data</text></svg>`
  }

  const values = points.map(p => p[metric])
  const maxY = Math.max(1, ...values, ...(opts.showRolling ? points.map(p => p.rolling7Avg ?? 0) : []))
  const niceMax = niceTickMax(maxY)

  const xFor = (i: number) => PAD.left + (i / (points.length - 1)) * innerW
  const yFor = (v: number) => PAD.top + innerH - (v / niceMax) * innerH

  // Build the area + line path
  const linePts = points.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p[metric]).toFixed(1)}`).join(' ')
  const areaPath = `M ${xFor(0).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L ${linePts} L ${xFor(points.length - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)} Z`
  const linePath = `M ${linePts.split(' ').join(' L ')}`

  const rollingPath = opts.showRolling
    ? `M ${points.map((p, i) => `${xFor(i).toFixed(1)},${yFor(p.rolling7Avg ?? p[metric]).toFixed(1)}`).join(' L ')}`
    : null

  // Y-axis ticks (0, mid, max)
  const ticks = [0, niceMax / 2, niceMax]
  const tickEls = ticks.map(t => {
    const y = yFor(t)
    return `
      <line x1="${PAD.left}" x2="${W - PAD.right}" y1="${y}" y2="${y}" stroke="${REPORT_COLORS.rule}" stroke-width="0.5" />
      <text x="${PAD.left - 6}" y="${y + 3}" text-anchor="end" fill="${REPORT_COLORS.ink4}" font-family="'JetBrains Mono', monospace" font-size="9">${formatTick(t, metric)}</text>
    `
  }).join('')

  // X-axis: first / mid / last date
  const xLabels = [0, Math.floor(points.length / 2), points.length - 1]
    .map(i => `<text x="${xFor(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}" fill="${REPORT_COLORS.ink4}" font-family="'JetBrains Mono', monospace" font-size="9">${shortDate(points[i].date)}</text>`)
    .join('')

  // Change-point markers
  const cpEls = changePoints
    .filter(cp => cp.metric === metric)
    .map(cp => {
      const idx = points.findIndex(p => p.date === cp.date)
      if (idx < 0) return ''
      const x = xFor(idx)
      return `
        <line x1="${x}" x2="${x}" y1="${PAD.top}" y2="${PAD.top + innerH}" stroke="${REPORT_COLORS.orange}" stroke-width="0.75" stroke-dasharray="3 3" opacity="0.65" />
        <circle cx="${x}" cy="${PAD.top}" r="3" fill="${REPORT_COLORS.orange}" />
        <text x="${x + 5}" y="${PAD.top + 9}" fill="${REPORT_COLORS.orange}" font-family="'JetBrains Mono', monospace" font-size="9" font-weight="500">${cp.direction === 'up' ? '▲' : '▼'} ${shortDate(cp.date)}</text>
      `
    }).join('')

  return `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" class="report-chart">
      <defs>
        <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${REPORT_COLORS.orange}" stop-opacity="0.35" />
          <stop offset="100%" stop-color="${REPORT_COLORS.orange}" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${tickEls}
      <path d="${areaPath}" fill="url(#trendGrad)" />
      <path d="${linePath}" fill="none" stroke="${REPORT_COLORS.orange}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
      ${rollingPath ? `<path d="${rollingPath}" fill="none" stroke="${REPORT_COLORS.ink2}" stroke-width="0.9" stroke-dasharray="4 3" />` : ''}
      ${cpEls}
      ${xLabels}
    </svg>
  `
}

function niceTickMax(v: number): number {
  if (v <= 5) return Math.max(5, Math.ceil(v))
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const norm = v / mag
  let step = 1
  if (norm > 5) step = 10
  else if (norm > 2) step = 5
  else if (norm > 1) step = 2
  return step * mag
}

function formatTick(v: number, metric: 'incidents' | 'delayMins'): string {
  if (metric === 'delayMins') {
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
    return String(Math.round(v))
  }
  return String(Math.round(v))
}

function shortDate(iso: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]}`
}

// ─── Donut chart for the category mix ────────────────────────────────────────

export function donutSvg(
  rows: CategoryRow[],
  centreLabel: { headline: string; sub: string },
  opts: { size?: number } = {},
): string {
  const S = opts.size ?? 220
  const cx = S / 2
  const cy = S / 2
  const rOuter = S * 0.46
  const rInner = S * 0.32

  const total = rows.reduce((s, r) => s + r.count, 0)
  if (total === 0) {
    return `<svg viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg" class="report-chart"><text x="${cx}" y="${cy}" text-anchor="middle" fill="${REPORT_COLORS.ink4}" font-family="'JetBrains Mono', monospace" font-size="11">No data</text></svg>`
  }

  let angleAcc = -Math.PI / 2
  const segs = rows.slice(0, 10).map(r => {
    const angle = (r.count / total) * 2 * Math.PI
    const a0 = angleAcc
    const a1 = angleAcc + angle
    angleAcc = a1
    const large = angle > Math.PI ? 1 : 0
    const x0o = cx + rOuter * Math.cos(a0), y0o = cy + rOuter * Math.sin(a0)
    const x1o = cx + rOuter * Math.cos(a1), y1o = cy + rOuter * Math.sin(a1)
    const x0i = cx + rInner * Math.cos(a1), y0i = cy + rInner * Math.sin(a1)
    const x1i = cx + rInner * Math.cos(a0), y1i = cy + rInner * Math.sin(a0)
    const path = `M ${x0o},${y0o} A ${rOuter},${rOuter} 0 ${large} 1 ${x1o},${y1o} L ${x0i},${y0i} A ${rInner},${rInner} 0 ${large} 0 ${x1i},${y1i} Z`
    return `<path d="${path}" fill="${r.color}" />`
  }).join('')

  return `
    <svg viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg" class="report-chart">
      ${segs}
      <circle cx="${cx}" cy="${cy}" r="${rInner - 1}" fill="${REPORT_COLORS.paper}" />
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="${REPORT_COLORS.ink}" font-family="Fraunces, Georgia, serif" font-size="${S * 0.16}" font-weight="500">${esc(centreLabel.headline)}</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="${REPORT_COLORS.ink4}" font-family="'JetBrains Mono', monospace" font-size="9" letter-spacing="1.5">${esc(centreLabel.sub.toUpperCase())}</text>
    </svg>
  `
}

// ─── Horizontal bar chart used for hotspots and category breakdowns ──────────

export function hbarSvg(
  rows: { label: string; value: number; sub?: string; color?: string }[],
  opts: { width?: number; rowHeight?: number; pad?: number; valueLabel?: (v: number) => string } = {},
): string {
  const W = opts.width ?? 720
  const rowH = opts.rowHeight ?? 26
  const pad = opts.pad ?? 6
  const labelW = 180
  const valueW = 60
  const barW = W - labelW - valueW - pad * 2
  const H = Math.max(rowH, rows.length * rowH + 4)
  const max = Math.max(1, ...rows.map(r => r.value))
  const valueLabel = opts.valueLabel ?? ((v: number) => String(Math.round(v)))

  const els = rows.map((r, i) => {
    const y = i * rowH
    const w = (r.value / max) * barW
    const color = r.color ?? REPORT_COLORS.orange
    return `
      <g transform="translate(0,${y})">
        <text x="0" y="${rowH / 2 + 4}" fill="${REPORT_COLORS.ink}" font-family="'Inter Tight', sans-serif" font-size="11" font-weight="500">${esc(truncate(r.label, 28))}</text>
        ${r.sub ? `<text x="0" y="${rowH / 2 + 16}" fill="${REPORT_COLORS.ink4}" font-family="'JetBrains Mono', monospace" font-size="8.5">${esc(r.sub)}</text>` : ''}
        <rect x="${labelW + pad}" y="${rowH / 2 - 7}" width="${barW}" height="6" fill="${REPORT_COLORS.panel}" />
        <rect x="${labelW + pad}" y="${rowH / 2 - 7}" width="${w.toFixed(1)}" height="6" fill="${color}" />
        <text x="${W}" y="${rowH / 2 + 4}" text-anchor="end" fill="${REPORT_COLORS.ink}" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="500">${esc(valueLabel(r.value))}</text>
      </g>
    `
  }).join('')

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="report-chart">${els}</svg>`
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// ─── Heatmap (DOW × hour) ────────────────────────────────────────────────────

export function heatmapSvg(cells: HeatmapCellPlain[], opts: { width?: number; height?: number } = {}): string {
  const W = opts.width ?? 720
  const H = opts.height ?? 220
  const PAD = { top: 16, right: 12, bottom: 28, left: 32 }
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const cellW = innerW / 24
  const cellH = innerH / 7
  const max = Math.max(1, ...cells.map(c => c.count))
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  const cellEls = cells.map(c => {
    const x = PAD.left + c.hour * cellW
    const y = PAD.top  + c.dow  * cellH
    const intensity = c.count === 0 ? 0 : 0.12 + (c.count / max) * 0.78
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cellW - 1).toFixed(1)}" height="${(cellH - 1).toFixed(1)}" fill="${REPORT_COLORS.orange}" fill-opacity="${intensity.toFixed(2)}" />`
  }).join('')

  const dayLabels = days.map((d, i) =>
    `<text x="${PAD.left - 6}" y="${PAD.top + i * cellH + cellH / 2 + 3}" text-anchor="end" fill="${REPORT_COLORS.ink4}" font-family="'JetBrains Mono', monospace" font-size="9">${d}</text>`,
  ).join('')

  const hourLabels = [0, 4, 8, 12, 16, 20].map(h =>
    `<text x="${PAD.left + h * cellW + cellW / 2}" y="${H - 10}" text-anchor="middle" fill="${REPORT_COLORS.ink4}" font-family="'JetBrains Mono', monospace" font-size="9">${String(h).padStart(2, '0')}:00</text>`,
  ).join('')

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="report-chart">${cellEls}${dayLabels}${hourLabels}</svg>`
}

// ─── Safety radar (current vs previous window) ───────────────────────────────

export function safetyRadarSvg(rows: SafetyRadarRow[], opts: { size?: number } = {}): string {
  const S = opts.size ?? 280
  const cx = S / 2
  const cy = S / 2
  const radius = S * 0.36
  const n = rows.length
  if (n < 3) {
    return `<svg viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg" class="report-chart"><text x="${cx}" y="${cy}" text-anchor="middle" fill="${REPORT_COLORS.ink4}" font-family="'JetBrains Mono', monospace" font-size="11">Insufficient safety data</text></svg>`
  }
  const max = Math.max(1, ...rows.flatMap(r => [r.current, r.previous]))
  const niceMax = niceTickMax(max)

  const pointFor = (i: number, value: number) => {
    const angle = -Math.PI / 2 + (i / n) * 2 * Math.PI
    const r = (value / niceMax) * radius
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
  }

  // Concentric grid rings
  const gridRings = [0.33, 0.66, 1].map(f => {
    const pts = rows.map((_, i) => {
      const a = -Math.PI / 2 + (i / n) * 2 * Math.PI
      return `${(cx + radius * f * Math.cos(a)).toFixed(1)},${(cy + radius * f * Math.sin(a)).toFixed(1)}`
    }).join(' ')
    return `<polygon points="${pts}" fill="none" stroke="${REPORT_COLORS.rule}" stroke-width="0.5" />`
  }).join('')

  // Axis spokes
  const spokes = rows.map((_, i) => {
    const a = -Math.PI / 2 + (i / n) * 2 * Math.PI
    return `<line x1="${cx}" y1="${cy}" x2="${(cx + radius * Math.cos(a)).toFixed(1)}" y2="${(cy + radius * Math.sin(a)).toFixed(1)}" stroke="${REPORT_COLORS.rule}" stroke-width="0.5" />`
  }).join('')

  // Previous (faint outline)
  const prevPts = rows.map((r, i) => {
    const p = pointFor(i, r.previous)
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
  }).join(' ')
  // Current (filled)
  const curPts = rows.map((r, i) => {
    const p = pointFor(i, r.current)
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
  }).join(' ')

  // Spoke labels
  const labels = rows.map((r, i) => {
    const a = -Math.PI / 2 + (i / n) * 2 * Math.PI
    const x = cx + (radius + 14) * Math.cos(a)
    const y = cy + (radius + 14) * Math.sin(a)
    const anchor = Math.abs(Math.cos(a)) < 0.2 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end'
    return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${anchor}" fill="${REPORT_COLORS.ink2}" font-family="'JetBrains Mono', monospace" font-size="9" font-weight="500">${esc(r.short)}</text>`
  }).join('')

  return `
    <svg viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg" class="report-chart">
      ${gridRings}
      ${spokes}
      <polygon points="${prevPts}" fill="none" stroke="${REPORT_COLORS.ink3}" stroke-width="0.9" stroke-dasharray="3 3" />
      <polygon points="${curPts}" fill="${REPORT_COLORS.orange}" fill-opacity="0.18" stroke="${REPORT_COLORS.orange}" stroke-width="1.4" />
      ${labels}
    </svg>
  `
}

// ─── Sparkline used inside the KPI strip ─────────────────────────────────────

export function sparklineSvg(values: number[], opts: { width?: number; height?: number; color?: string } = {}): string {
  const W = opts.width ?? 120
  const H = opts.height ?? 30
  const color = opts.color ?? REPORT_COLORS.orange
  if (values.length < 2) return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="report-spark"></svg>`
  const max = Math.max(1, ...values)
  const min = Math.min(0, ...values)
  const range = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (W - 2) + 1
    const y = H - 1 - ((v - min) / range) * (H - 4)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' L ')
  return `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="report-spark">
      <path d="M ${pts}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  `
}
