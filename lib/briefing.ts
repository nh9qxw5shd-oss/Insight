'use client'

import { getSupabase } from './supabase'
import { AnalyticsFilters, CATEGORY_CONFIG, IncidentCategory } from './types'
import { WeatherLevel, weatherLevelLabel, LOOKAHEAD_COVERAGE_START } from './weatherLookahead'

// ─── Briefing pins ───────────────────────────────────────────────────────────
// A pin is a finding "plucked" from any Insight view: a self-contained data
// snapshot plus the context it was read in (window, filters, source view).
// The Briefing tab composes pins into a one-page executive brief and exports
// it through the existing print pipeline. Snapshots are stored whole so a
// brief renders identically later, even after the live window moves on.

export type PinKind =
  | 'kpi' | 'timeline' | 'level-impact' | 'risk-impact' | 'duration' | 'incident'
  | 'ranking' | 'heatmap' | 'scatter' | 'profile'

export interface KpiPinPayload {
  value: string                 // formatted headline value, e.g. "74,381 min"
  deltaPct: number | null       // vs previous equivalent window
  deltaInverted: boolean        // true = up is bad
  caption?: string
}

export interface TimelinePinPayload {
  days: { date: string; incidents: number; delayMins: number; level: WeatherLevel | null }[]
}

export interface LevelImpactPinPayload {
  metricLabel: string           // "Incidents", "Delay minutes", "Cancellations"
  unit: 'count' | 'mins'
  rows: { level: WeatherLevel; days: number; rate: number }[]
}

export interface RiskImpactPinPayload {
  risk: string
  daysWith: number
  daysWithout: number
  incRateWith: number
  incRateWithout: number
  delayRateWith: number
  delayRateWithout: number
}

export interface DurationPinPayload {
  positions: string[]           // "Day 1" … "Day 5+"
  nDays: number[]               // sample size per position
  panels: { label: string; values: number[]; unit: 'count' | 'mins' }[]
}

export interface RankingPinPayload {
  valueLabel: string            // "Delay minutes", "Incidents"
  unit: 'count' | 'mins'
  rows: { label: string; value: number; secondary?: string }[]
}

export interface HeatmapPinPayload {
  // rows[dow][hour] — dow 0=Sun … 6=Sat, hour 0–23
  rows: number[][]
  cellLabel: string             // what a cell counts, e.g. "incidents"
}

export interface ScatterPinPayload {
  xLabel: string
  yLabel: string
  points: { x: number; y: number }[]   // capped at capture time (~400)
  note?: string
}

export interface ProfileTier {
  label: string
  n: number
  per30d: number
  medianDelay: number | null
  meanDelay: number | null
  p90Delay: number | null
  medianDuration: number | null
  medianArrival: number | null
  cancelsPerInc: number | null
  note?: string
}

export interface ProfilePinPayload {
  typeLabel: string
  location: string
  radiusMiles: number | null      // null = anchor location not geocodable
  tiers: ProfileTier[]
  narrative: string | null
}

export interface IncidentPinPayload {
  date: string
  title: string
  location: string | null
  typeLabel: string | null
  category: IncidentCategory | null
  delayMins: number
  cancelled: number
}

export interface BriefingPin {
  id: string
  created_at: string
  kind: PinKind
  title: string
  comment: string | null
  source_label: string | null
  window_from: string | null
  window_to: string | null
  filters_summary: string | null
  payload: any
  position: number
}

export type BriefingPinInput = Omit<BriefingPin, 'id' | 'created_at'>

// What a pin site provides; the page-level submitter enriches it with the
// active window, a filter summary, and an ordering position before insert.
export interface PinDraft {
  kind: PinKind
  title: string
  comment?: string | null
  source_label?: string | null
  payload: any
}

const PIN_COLS = 'id, created_at, kind, title, comment, source_label, window_from, window_to, filters_summary, payload, position'

export async function fetchPins(): Promise<BriefingPin[]> {
  const sb = getSupabase()
  if (!sb) return []
  const { data, error } = await sb
    .from('insight_briefing_pins')
    .select(PIN_COLS)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error || !data) return []
  return data as unknown as BriefingPin[]
}

export async function addPin(input: BriefingPinInput): Promise<BriefingPin | null> {
  const sb = getSupabase()
  if (!sb) return null
  const { data, error } = await sb
    .from('insight_briefing_pins')
    .insert(input)
    .select(PIN_COLS)
    .single()
  if (error || !data) return null
  return data as unknown as BriefingPin
}

export async function updatePin(
  id: string,
  patch: Partial<Pick<BriefingPin, 'title' | 'comment' | 'position'>>,
): Promise<void> {
  const sb = getSupabase()
  if (!sb) return
  await sb.from('insight_briefing_pins').update(patch).eq('id', id)
}

export async function deletePin(id: string): Promise<void> {
  const sb = getSupabase()
  if (!sb) return
  await sb.from('insight_briefing_pins').delete().eq('id', id)
}

// ─── Context capture ─────────────────────────────────────────────────────────

// Compact human summary of the active filter set, stored with each pin so the
// brief can honestly state the scope a finding was read under.
export function describeFilters(f: AnalyticsFilters): string {
  const parts: string[] = []
  if (f.areas.length)         parts.push(`areas: ${f.areas.join(', ')}`)
  if (f.categories.length)    parts.push(`categories: ${f.categories.map(c => CATEGORY_CONFIG[c]?.short ?? c).join(', ')}`)
  if (f.severities.length)    parts.push(`severity: ${f.severities.join(', ')}`)
  if (f.incidentTypes.length) parts.push(`types: ${f.incidentTypes.join(', ')}`)
  if (f.staffNames.length)    parts.push(`staff: ${f.staffNames.join(', ')}`)
  if (f.searches.length)      parts.push(`search: ${f.searches.map(s => `"${s}"`).join(` ${f.searchMode.toUpperCase()} `)}`)
  if (f.minDelay != null || f.maxDelay != null) parts.push(`delay ${f.minDelay ?? 0}–${f.maxDelay ?? '∞'} min`)
  if (f.weatherLevels?.length) parts.push(`weather level: ${f.weatherLevels.map(weatherLevelLabel).join(', ')}`)
  if (f.weatherRisks?.length)  parts.push(`weather risk: ${f.weatherRisks.join(', ')}`)
  if (f.weatherConditions?.length) parts.push(`conditions: ${f.weatherConditions.join(', ')}`)
  if ((f.offRouteFilter ?? 'include') !== 'include') parts.push(`off-route: ${f.offRouteFilter}`)
  return parts.length ? parts.join(' · ') : 'none'
}

// ─── Brief HTML export ───────────────────────────────────────────────────────
// A self-contained, print-first document in Insight's identity. Fixed light
// palette — the brief is a handout, not a dashboard.

const C = {
  bg: '#FCFBF7', panel: '#FFFFFF', line: '#E3E0D6', lineHi: '#CFCBBD',
  ink1: '#1C2230', ink2: '#4A5266', ink3: '#7C8296',
  accent: '#C24A05', accentSoft: '#C24A0518', bad: '#B03A2E', good: '#1E8449',
}

const LEVEL_C: Record<WeatherLevel, string> = {
  GREEN: '#1E8449', AWARE: '#A08508', ADVERSE: '#C24A05', EXTREME: '#B03A2E',
}

const SANS  = `"Inter Tight", -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif`
const SERIF = `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`
const MONO  = `ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace`

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtNum(n: number, unit: 'count' | 'mins'): string {
  if (unit === 'mins') return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`
  return n >= 100 ? `${Math.round(n)}` : n >= 10 ? n.toFixed(1) : n.toFixed(2)
}

// Full minutes with unit — "3,667m", never a compact "3.7k" that could read
// as kilometres next to the m suffix.
function fmtMinsFull(n: number): string {
  return `${Math.round(n).toLocaleString()}m`
}

function fmtShortDate(iso: string): string {
  const [, m, d] = iso.split('-')
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${parseInt(d, 10)} ${months[parseInt(m, 10)]}`
}

function provenance(pin: BriefingPin): string {
  const bits = [
    pin.source_label,
    pin.window_from && pin.window_to ? `${fmtShortDate(pin.window_from)} – ${fmtShortDate(pin.window_to)}` : null,
    `filters: ${pin.filters_summary || 'none'}`,
  ].filter(Boolean)
  return `<div class="prov">⚲ ${bits.map(b => esc(b as string)).join(' · ')}</div>`
}

function commentHtml(pin: BriefingPin): string {
  return pin.comment ? `<p class="ctx">${esc(pin.comment)}</p>` : ''
}

// ── Per-kind renderers ──

function renderKpiStrip(pins: BriefingPin[]): string {
  const tiles = pins.map(pin => {
    const p = pin.payload as KpiPinPayload
    const deltaColor = p.deltaPct == null ? C.ink3 : (p.deltaPct > 0) === !!p.deltaInverted ? C.bad : C.good
    const delta = p.deltaPct != null
      ? `<b style="color:${deltaColor}">${p.deltaPct > 0 ? '+' : ''}${p.deltaPct.toFixed(1)}%</b> vs previous window`
      : ''
    return `<div class="stat">
      <div class="micro">${esc(pin.title)}</div>
      <div class="v mono">${esc(p.value)}</div>
      <div class="d">${delta}${p.caption ? `${delta ? ' — ' : ''}${esc(p.caption)}` : ''}</div>
    </div>`
  }).join('')
  return `<div class="stats">${tiles}</div>`
}

function renderTimeline(pin: BriefingPin): string {
  const days = (pin.payload as TimelinePinPayload).days ?? []
  if (!days.length) return ''
  const W = 860, top = 14, plotH = 120, stripY = top + plotH + 8, stripH = 9, axisY = stripY + stripH + 14
  const H = axisY + 8, padL = 30, padR = 6
  const n = days.length, maxV = Math.max(...days.map(d => d.incidents), 1)
  const bw = (W - padL - padR) / n
  const x = (i: number) => padL + i * bw
  const y = (v: number) => top + plotH - (v / maxV) * plotH
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`
  const step = maxV > 60 ? 25 : 10
  for (let g = step; g < maxV; g += step) {
    s += `<line x1="${padL}" x2="${W - padR}" y1="${y(g)}" y2="${y(g)}" stroke="${C.line}" stroke-width="1"/>`
       + `<text x="${padL - 6}" y="${y(g) + 3}" text-anchor="end" font-size="9" fill="${C.ink3}" font-family='${MONO}'>${g}</text>`
  }
  days.forEach((d, i) => {
    const bh = (d.incidents / maxV) * plotH
    s += `<rect x="${x(i) + 1}" y="${y(d.incidents)}" width="${Math.max(1, bw - 2)}" height="${bh}" rx="1.5" fill="${C.accent}" opacity="${d.level === 'EXTREME' ? 0.95 : 0.55}"><title>${fmtShortDate(d.date)} · ${d.incidents} incidents · ${Math.round(d.delayMins).toLocaleString()} delay min · ${d.level ? weatherLevelLabel(d.level) : 'no statement'}</title></rect>`
  })
  const peak = days.reduce((a, d, i) => (d.incidents > days[a].incidents ? i : a), 0)
  s += `<text x="${Math.min(W - 40, Math.max(padL + 20, x(peak) + bw / 2))}" y="${Math.max(10, y(days[peak].incidents) - 5)}" text-anchor="middle" font-size="9.5" fill="${C.ink2}" font-family='${MONO}'>${days[peak].incidents} · ${fmtShortDate(days[peak].date)}</text>`
  days.forEach((d, i) => {
    s += `<rect x="${x(i) + 0.5}" y="${stripY}" width="${Math.max(1, bw - 1)}" height="${stripH}" fill="${d.level ? LEVEL_C[d.level] : C.line}"/>`
  })
  const tickEvery = Math.max(1, Math.floor(n / 8))
  for (let i = 0; i < n; i += tickEvery) {
    s += `<text x="${x(i) + bw / 2}" y="${axisY}" text-anchor="middle" font-size="9" fill="${C.ink3}" font-family='${MONO}'>${fmtShortDate(days[i].date)}</text>`
  }
  s += `</svg>`
  const legend = (['GREEN', 'AWARE', 'ADVERSE', 'EXTREME'] as WeatherLevel[])
    .map(l => `<span><span class="sw" style="background:${LEVEL_C[l]}"></span>${weatherLevelLabel(l)}</span>`)
    .join('')
  return `<div class="card">
    <h3>${esc(pin.title)}</h3>
    ${commentHtml(pin)}
    <div style="margin-top:10px">${s}</div>
    <div class="legend mono">${legend}</div>
    ${provenance(pin)}
  </div>`
}

function levelBars(rows: LevelImpactPinPayload['rows'], unit: 'count' | 'mins'): string {
  const max = Math.max(...rows.map(r => r.rate), 0.0001)
  return `<div class="lvbars mono">` + rows.map(r =>
    `<div class="lvrow"><span class="lbl">${weatherLevelLabel(r.level)}</span>` +
    `<span class="bar"><i style="width:${(r.rate / max) * 100}%;background:${LEVEL_C[r.level]}"></i></span>` +
    `<span class="val">${fmtNum(r.rate, unit)}</span></div>`,
  ).join('') + `</div>`
}

function renderLevelImpact(pin: BriefingPin): string {
  const p = pin.payload as LevelImpactPinPayload
  const green = p.rows.find(r => r.level === 'GREEN')
  const worst = p.rows[p.rows.length - 1]
  const lift = green && green.rate > 0 && worst ? worst.rate / green.rate : null
  const fmtRate = (v: number) => (p.unit === 'mins' ? fmtMinsFull(v) : fmtNum(v, 'count'))
  const liftColor = lift == null ? C.ink2 : lift > 1 ? C.bad : C.good
  const headline = worst
    ? `<div class="num mono"><b>${fmtRate(worst.rate)}</b> / day
       <span class="ctx-inline">on ${weatherLevelLabel(worst.level)} days${green ? ` vs ${fmtRate(green.rate)} on Normal${lift != null ? ` (<b style="color:${liftColor}">${lift >= 2 ? lift.toFixed(1) + '×' : (lift - 1 >= 0 ? '+' : '') + Math.round((lift - 1) * 100) + '%'}</b>)` : ''}` : ''}</span></div>`
    : ''
  return `<div class="card finding">
    <h3>${esc(pin.title)}</h3>
    ${headline}
    ${commentHtml(pin)}
    ${levelBars(p.rows, p.unit)}
    ${provenance(pin)}
  </div>`
}

function renderRiskImpact(pin: BriefingPin): string {
  const p = pin.payload as RiskImpactPinPayload
  const incLift = p.incRateWithout > 0 ? p.incRateWith / p.incRateWithout : null
  const delayLift = p.delayRateWithout > 0 ? p.delayRateWith / p.delayRateWithout : null
  const row = (label: string, w: number, wo: number, lift: number | null, unit: 'count' | 'mins') => {
    const fv = (v: number) => (unit === 'mins' ? fmtMinsFull(v) : fmtNum(v, 'count'))
    return `<div class="lvrow"><span class="lbl">${label}</span>
     <span class="riskvals mono">${fv(w)} <em>vs</em> ${fv(wo)}</span>
     <span class="val" style="color:${lift != null && lift > 1.25 ? C.bad : C.ink2}">${lift != null ? lift.toFixed(2) + '×' : '—'}</span></div>`
  }
  return `<div class="card finding">
    <h3>${esc(pin.title)}</h3>
    <div class="num mono"><b>${p.daysWith}</b> days <span class="ctx-inline">carried ${esc(p.risk)} · vs ${p.daysWithout} statement days without it</span></div>
    ${commentHtml(pin)}
    <div class="lvbars mono" style="margin-top:10px">
      ${row('Inc / day', p.incRateWith, p.incRateWithout, incLift, 'count')}
      ${row('Delay / day', p.delayRateWith, p.delayRateWithout, delayLift, 'mins')}
    </div>
    ${provenance(pin)}
  </div>`
}

function renderDuration(pin: BriefingPin): string {
  const p = pin.payload as DurationPinPayload
  const W = 260, top = 16, plotH = 92, axisY = top + plotH + 14, subY = axisY + 12, H = subY + 6
  const panels = p.panels.map(panel => {
    const max = Math.max(...panel.values, 0.0001)
    const peak = panel.values.indexOf(Math.max(...panel.values))
    const n = panel.values.length, bw = W / n
    let s = `<div><div class="cap mono">${esc(panel.label)}</div><svg viewBox="0 0 ${W} ${H}" role="img">`
    panel.values.forEach((v, i) => {
      const bh = (v / max) * plotH
      const bx = i * bw + 10, w = bw - 20
      s += `<rect x="${bx}" y="${top + plotH - bh}" width="${w}" height="${bh}" rx="2.5" fill="${C.accent}" opacity="${i === peak ? 1 : 0.5}"/>`
         + `<text x="${bx + w / 2}" y="${top + plotH - bh - 5}" text-anchor="middle" font-size="10.5" font-weight="${i === peak ? 700 : 400}" fill="${i === peak ? C.ink1 : C.ink2}" font-family='${MONO}'>${fmtNum(v, panel.unit)}</text>`
         + `<text x="${bx + w / 2}" y="${axisY}" text-anchor="middle" font-size="9.5" fill="${C.ink2}" font-family='${MONO}'>${esc(p.positions[i] ?? '')}</text>`
         + `<text x="${bx + w / 2}" y="${subY}" text-anchor="middle" font-size="8.5" fill="${C.ink3}" font-family='${MONO}'>${p.nDays[i] ?? ''}d</text>`
    })
    s += `<line x1="4" x2="${W - 4}" y1="${top + plotH}" y2="${top + plotH}" stroke="${C.lineHi}" stroke-width="1"/></svg></div>`
    return s
  }).join('')
  return `<div class="card">
    <h3>${esc(pin.title)}</h3>
    ${commentHtml(pin)}
    <div class="streaks">${panels}</div>
    ${provenance(pin)}
  </div>`
}

function renderIncident(pin: BriefingPin): string {
  const p = pin.payload as IncidentPinPayload
  return `<div class="card finding">
    <h3>${esc(pin.title)}</h3>
    <div class="num mono"><b>${Math.round(p.delayMins).toLocaleString()}</b> min <span class="ctx-inline">· ${p.cancelled} cancellations · ${fmtShortDate(p.date)}</span></div>
    <p class="ctx">${esc(p.title !== pin.title ? p.title : '')}${p.title !== pin.title && (p.location || p.typeLabel) ? ' — ' : ''}${p.location ? `<b>${esc(p.location)}</b>` : ''}${p.typeLabel ? ` (${esc(p.typeLabel)})` : ''}</p>
    ${commentHtml(pin)}
    ${provenance(pin)}
  </div>`
}

function renderRanking(pin: BriefingPin): string {
  const p = pin.payload as RankingPinPayload
  const rows = (p.rows ?? []).slice(0, 10)
  if (!rows.length) return ''
  const max = Math.max(...rows.map(r => r.value), 0.0001)
  const fv = (v: number) => (p.unit === 'mins' ? fmtMinsFull(v) : Math.round(v).toLocaleString())
  const bars = rows.map(r =>
    `<div class="lvrow rank"><span class="lbl" title="${esc(r.label)}">${esc(r.label)}</span>` +
    `<span class="bar"><i style="width:${(r.value / max) * 100}%;background:${C.accent}"></i></span>` +
    `<span class="val">${fv(r.value)}${r.secondary ? `<em class="sec">${esc(r.secondary)}</em>` : ''}</span></div>`,
  ).join('')
  return `<div class="card finding">
    <h3>${esc(pin.title)}</h3>
    ${commentHtml(pin)}
    <div class="lvbars mono" style="margin-top:11px">${bars}</div>
    <div class="ctx" style="margin-top:8px">${esc(p.valueLabel)} per location, largest first.</div>
    ${provenance(pin)}
  </div>`
}

function renderHeatmap(pin: BriefingPin): string {
  const p = pin.payload as HeatmapPinPayload
  const rows = p.rows ?? []
  if (rows.length !== 7) return ''
  const max = Math.max(...rows.flat(), 1)
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const cell = 30, gap = 3, padL = 40, padT = 6
  const W = padL + 24 * (cell + gap), H = padT + 7 * (cell + gap) + 22
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`
  rows.forEach((row, dow) => {
    s += `<text x="${padL - 8}" y="${padT + dow * (cell + gap) + cell / 2 + 3}" text-anchor="end" font-size="10" fill="${C.ink2}" font-family='${MONO}'>${DOW[dow]}</text>`
    row.forEach((v, h) => {
      const alpha = v > 0 ? 0.12 + 0.88 * (v / max) : 0
      s += `<rect x="${padL + h * (cell + gap)}" y="${padT + dow * (cell + gap)}" width="${cell}" height="${cell}" rx="3" `
         + `fill="${v > 0 ? C.accent : C.line}" opacity="${v > 0 ? alpha.toFixed(2) : 0.5}">`
         + `<title>${DOW[dow]} ${String(h).padStart(2, '0')}:00 · ${v} ${esc(p.cellLabel)}</title></rect>`
    })
  })
  for (let h = 0; h < 24; h += 3) {
    s += `<text x="${padL + h * (cell + gap) + cell / 2}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${C.ink3}" font-family='${MONO}'>${String(h).padStart(2, '0')}</text>`
  }
  s += `</svg>`
  return `<div class="card">
    <h3>${esc(pin.title)}</h3>
    ${commentHtml(pin)}
    <div style="margin-top:10px">${s}</div>
    <div class="ctx" style="margin-top:6px">Darker cells carry more ${esc(p.cellLabel)} · peak cell: ${max}.</div>
    ${provenance(pin)}
  </div>`
}

function renderScatter(pin: BriefingPin): string {
  const p = pin.payload as ScatterPinPayload
  const pts = (p.points ?? []).filter(q => isFinite(q.x) && isFinite(q.y))
  if (!pts.length) return ''
  const W = 860, H = 300, padL = 56, padR = 14, padT = 12, padB = 40
  const maxX = Math.max(...pts.map(q => q.x)) * 1.04
  const maxY = Math.max(...pts.map(q => q.y)) * 1.06
  const x = (v: number) => padL + (v / maxX) * (W - padL - padR)
  const y = (v: number) => padT + (1 - v / maxY) * (H - padT - padB)
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`
  for (let i = 1; i <= 4; i++) {
    const gy = padT + (i / 4) * (H - padT - padB)
    const val = Math.round(maxY * (1 - i / 4))
    s += `<line x1="${padL}" x2="${W - padR}" y1="${gy}" y2="${gy}" stroke="${C.line}" stroke-width="1"/>`
       + `<text x="${padL - 8}" y="${gy + 3}" text-anchor="end" font-size="9" fill="${C.ink3}" font-family='${MONO}'>${val.toLocaleString()}</text>`
  }
  for (let i = 0; i <= 4; i++) {
    const vx = maxX * (i / 4)
    s += `<text x="${x(vx)}" y="${H - padB + 16}" text-anchor="middle" font-size="9" fill="${C.ink3}" font-family='${MONO}'>${Math.round(vx).toLocaleString()}</text>`
  }
  pts.forEach(q => {
    s += `<circle cx="${x(q.x).toFixed(1)}" cy="${y(q.y).toFixed(1)}" r="3.5" fill="${C.accent}" opacity="0.45"/>`
  })
  s += `<text x="${(padL + W - padR) / 2}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${C.ink2}" font-family='${MONO}'>${esc(p.xLabel)}</text>`
     + `<text x="12" y="${(padT + H - padB) / 2}" text-anchor="middle" font-size="10" fill="${C.ink2}" font-family='${MONO}' transform="rotate(-90 12 ${(padT + H - padB) / 2})">${esc(p.yLabel)}</text>`
  s += `</svg>`
  return `<div class="card">
    <h3>${esc(pin.title)}</h3>
    ${commentHtml(pin)}
    <div style="margin-top:10px">${s}</div>
    ${p.note ? `<div class="ctx" style="margin-top:6px">${esc(p.note)}</div>` : ''}
    ${provenance(pin)}
  </div>`
}

function renderProfile(pin: BriefingPin): string {
  const p = pin.payload as ProfilePinPayload
  const tiers = p.tiers ?? []
  if (!tiers.length) return ''
  const num = (v: number | null, f: (x: number) => string) => (v == null ? '—' : f(v))
  const rows = tiers.map(t => `<tr>
    <td class="tierlbl">${esc(t.label)}${t.note ? `<div class="tiernote">${esc(t.note)}</div>` : ''}</td>
    <td>${t.n.toLocaleString()}</td>
    <td>${t.per30d.toFixed(1)}</td>
    <td>${num(t.medianDelay, x => fmtMinsFull(x))}</td>
    <td>${num(t.meanDelay, x => fmtMinsFull(x))}</td>
    <td>${num(t.p90Delay, x => fmtMinsFull(x))}</td>
    <td>${num(t.medianDuration, x => fmtMinsFull(x))}</td>
    <td>${num(t.medianArrival, x => fmtMinsFull(x))}</td>
    <td>${num(t.cancelsPerInc, x => x.toFixed(1))}</td>
  </tr>`).join('')
  return `<div class="card">
    <h3>${esc(pin.title)}</h3>
    ${p.narrative ? `<p class="ctx" style="font-size:12.5px;max-width:78ch">${esc(p.narrative)}</p>` : ''}
    ${commentHtml(pin)}
    <div style="overflow-x:auto;margin-top:11px"><table class="proftable mono">
      <thead><tr><th>Scope</th><th>n</th><th>/30d</th><th>Median delay</th><th>Mean</th><th>P90</th><th>Duration</th><th>Arrival</th><th>Cancels/inc</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${provenance(pin)}
  </div>`
}

export interface BriefingMeta {
  title: string
  subtitle?: string
  intro?: string
  generatedOn: string    // display string, e.g. "21 Jul 2026"
}

export function buildBriefingHtml(meta: BriefingMeta, pins: BriefingPin[]): string {
  const ordered = [...pins].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))

  // Consecutive KPI pins merge into one stat strip; everything else renders
  // in pin order. Finding-style cards flow into a two-column grid.
  const blocks: string[] = []
  let i = 0
  while (i < ordered.length) {
    const pin = ordered[i]
    if (pin.kind === 'kpi') {
      const group: BriefingPin[] = []
      while (i < ordered.length && ordered[i].kind === 'kpi') group.push(ordered[i++])
      blocks.push(renderKpiStrip(group))
      continue
    }
    if (['level-impact', 'risk-impact', 'incident', 'ranking'].includes(pin.kind)) {
      const group: string[] = []
      while (i < ordered.length && ['level-impact', 'risk-impact', 'incident', 'ranking'].includes(ordered[i].kind)) {
        const p2 = ordered[i++]
        group.push(
          p2.kind === 'level-impact' ? renderLevelImpact(p2) :
          p2.kind === 'risk-impact'  ? renderRiskImpact(p2) :
          p2.kind === 'ranking'      ? renderRanking(p2) :
          renderIncident(p2),
        )
      }
      blocks.push(`<div class="grid2">${group.join('')}</div>`)
      continue
    }
    blocks.push(
      pin.kind === 'timeline' ? renderTimeline(pin) :
      pin.kind === 'heatmap'  ? renderHeatmap(pin) :
      pin.kind === 'scatter'  ? renderScatter(pin) :
      pin.kind === 'profile'  ? renderProfile(pin) :
      renderDuration(pin),
    )
    i++
  }

  const windows = ordered.filter(p => p.window_from && p.window_to)
  const minFrom = windows.length ? windows.map(p => p.window_from!).sort()[0] : null
  const maxTo   = windows.length ? windows.map(p => p.window_to!).sort().slice(-1)[0] : null

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
<style>
  * { box-sizing: border-box; }
  body { background: ${C.bg}; color: ${C.ink1}; margin: 0; font: 14.5px/1.55 ${SANS}; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 36px 26px 56px; display: flex; flex-direction: column; gap: 22px; }
  .serif { font-family: ${SERIF}; }
  .mono { font-family: ${MONO}; font-variant-numeric: tabular-nums; }
  .micro { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: ${C.ink3}; }
  h1 { margin: 8px 0 6px; font-size: 34px; line-height: 1.12; font-weight: 500; letter-spacing: -0.01em; font-family: ${SERIF}; text-wrap: balance; }
  .scope { font-size: 11.5px; color: ${C.ink2}; font-family: ${MONO}; }
  .intro { font-size: 15px; line-height: 1.6; max-width: 70ch; color: ${C.ink1}; }
  .eyebrow { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 1px; background: ${C.line}; border: 1px solid ${C.line}; border-radius: 6px; overflow: hidden; }
  .stat { background: ${C.panel}; padding: 13px 15px 11px; }
  .stat .v { font-size: 27px; font-weight: 300; line-height: 1.1; margin: 5px 0 2px; }
  .stat .d { font-size: 11px; color: ${C.ink2}; }
  .card { background: ${C.panel}; border: 1px solid ${C.line}; border-radius: 6px; padding: 17px 19px 14px; break-inside: avoid; }
  .card h3 { margin: 0; font-size: 15.5px; font-weight: 600; line-height: 1.3; text-wrap: balance; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 13px; }
  .num { font-size: 24px; font-weight: 300; margin: 8px 0 1px; }
  .num b { font-weight: 600; }
  .ctx { font-size: 12px; color: ${C.ink2}; margin: 6px 0 0; }
  .ctx-inline { font-size: 12px; color: ${C.ink2}; }
  .prov { margin-top: 11px; padding-top: 8px; border-top: 1px solid ${C.line}; font-size: 9.5px; color: ${C.ink3}; letter-spacing: .04em; font-family: ${MONO}; }
  .lvbars { display: flex; flex-direction: column; gap: 5px; margin-top: 11px; }
  .lvrow { display: grid; grid-template-columns: 70px 1fr 48px; align-items: center; gap: 8px; font-size: 10.5px; }
  .lvrow.rank { grid-template-columns: minmax(90px, 38%) 1fr auto; }
  .lvrow.rank .lbl { text-transform: none; letter-spacing: 0; font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lvrow .sec { color: ${C.ink3}; font-style: normal; margin-left: 6px; font-size: 9px; }
  .lvrow .lbl { color: ${C.ink2}; letter-spacing: .06em; text-transform: uppercase; font-size: 9.5px; }
  .lvrow .bar { height: 8px; border-radius: 2px 3px 3px 2px; background: ${C.line}; position: relative; overflow: hidden; }
  .lvrow .bar i { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 2px 3px 3px 2px; }
  .lvrow .val { text-align: right; }
  .riskvals { font-size: 11.5px; } .riskvals em { color: ${C.ink3}; font-style: normal; }
  .proftable { width: 100%; border-collapse: collapse; font-size: 10.5px; min-width: 640px; }
  .proftable th { text-align: right; font-weight: 400; font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: ${C.ink3}; padding: 0 8px 6px; }
  .proftable th:first-child { text-align: left; padding-left: 0; }
  .proftable td { text-align: right; padding: 6px 8px; border-top: 1px solid ${C.line}; }
  .proftable td.tierlbl { text-align: left; padding-left: 0; color: ${C.ink1}; font-family: ${SANS}; font-size: 11.5px; }
  .proftable .tiernote { font-size: 9px; color: ${C.ink3}; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 6px; font-size: 10px; color: ${C.ink2}; }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .sw { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
  .streaks { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 16px; margin-top: 12px; }
  .streaks .cap { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: ${C.ink2}; margin-bottom: 5px; }
  svg { display: block; width: 100%; height: auto; }
  .method { font-size: 10.5px; color: ${C.ink3}; line-height: 1.55; border-top: 1px solid ${C.line}; padding-top: 12px; font-family: ${MONO}; }
  footer { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: baseline; }
  footer .wordmark { font-size: 17px; font-family: ${SERIF}; }
  footer .wordmark b { color: ${C.accent}; }
  @media print { .wrap { padding: 4px 0; gap: 16px; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>
<div class="wrap">
  <header>
    <div class="eyebrow">
      <span class="micro">EMCC Insight · Operations Briefing</span>
      <span class="micro mono">Generated ${esc(meta.generatedOn)}</span>
    </div>
    <h1>${esc(meta.title)}</h1>
    ${meta.subtitle ? `<div class="scope">${esc(meta.subtitle)}</div>` : ''}
  </header>
  ${meta.intro ? `<div class="intro">${esc(meta.intro).replace(/\n+/g, '</p><p class="intro" style="margin:8px 0 0">')}</div>` : ''}
  ${blocks.join('\n')}
  <div class="method">
    METHOD — Days are classified by the operational weather statement (DLog2 5-Day Look Ahead / EM morning messages);
    weather comparisons are normalised per day at each level. Incident counts exclude continuation rows; delay counts each
    continuing incident once (incremental delay) and excludes off-route incidents; cancellations include part-cancellations.
    Weather statements cover ${LOOKAHEAD_COVERAGE_START} onwards. Figures are correlations, not proof of cause.
    ${minFrom && maxTo ? `Evidence windows span ${fmtShortDate(minFrom)} – ${fmtShortDate(maxTo)}.` : ''}
  </div>
  <footer>
    <div class="wordmark">Insight<b>.</b></div>
    <div class="micro">East Midlands Control Centre · Strategic Operations</div>
  </footer>
</div>
</body></html>`
}
