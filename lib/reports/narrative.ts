// ─── Narrative generator ─────────────────────────────────────────────────────
// Turns the structured deltas, signals and hotspots into plain-English copy.
// Three layers: a one-line headline, two-to-four supporting paragraphs, and a
// bullet list of findings tagged positive / warning / neutral.

import { KPISummary } from '../types'
import { CategoryRow, GeoRow, AssetRow, SignalRow, ChangePointRow } from './types'

function fmtPct(n: number | null | undefined, withSign = true): string {
  if (n == null) return '—'
  if (Math.abs(n) < 0.5) return '~0%'
  const sign = withSign && n > 0 ? '+' : ''
  return `${sign}${n.toFixed(0)}%`
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-GB', { maximumFractionDigits: 0 })
}

function fmtMins(n: number): string {
  if (n >= 60) {
    const h = Math.floor(n / 60)
    const m = Math.round(n % 60)
    return m === 0 ? `${h}h` : `${h}h ${m}m`
  }
  return `${Math.round(n)} min`
}

function directionWord(deltaPct: number | null, deltaInverted: boolean): string {
  if (deltaPct == null) return 'unchanged'
  if (Math.abs(deltaPct) < 1) return 'broadly flat'
  const up = deltaPct > 0
  if (deltaInverted) return up ? 'up'   : 'down'
  return up ? 'up' : 'down'
}

// Used for "this is a good/bad direction" framing.
function directionGood(deltaPct: number | null, deltaInverted: boolean): 'positive' | 'warning' | 'neutral' {
  if (deltaPct == null || Math.abs(deltaPct) < 1) return 'neutral'
  const up = deltaPct > 0
  // If inverted: up is bad. Non-inverted: up is good.
  const isBad = (up && deltaInverted) || (!up && !deltaInverted)
  return isBad ? 'warning' : 'positive'
}

export interface NarrativeInputs {
  scopeLabel: string
  kpis: KPISummary
  categories: CategoryRow[]
  geography: GeoRow[]
  assets: AssetRow[]
  signals: SignalRow[]
  changePoints: ChangePointRow[]
}

export function buildNarrative(n: NarrativeInputs): {
  executive: string
  headline:  string
  paragraphs: string[]
  bullets:   { kind: 'positive' | 'warning' | 'neutral'; text: string }[]
} {
  const { kpis, categories, geography, assets, signals, changePoints, scopeLabel } = n

  // ── Headline ──────────────────────────────────────────────────────────────
  const incDir = directionWord(kpis.incidentsDeltaPct, true)
  const delayDir = directionWord(kpis.delayDeltaPct, true)
  const sameDir  = (kpis.incidentsDeltaPct ?? 0) > 0 === (kpis.delayDeltaPct ?? 0) > 0
  const headline = sameDir
    ? `Incidents ${incDir} ${fmtPct(kpis.incidentsDeltaPct)}, delay-minutes ${delayDir} ${fmtPct(kpis.delayDeltaPct)} vs the previous equivalent window.`
    : `Incidents ${incDir} ${fmtPct(kpis.incidentsDeltaPct)} but delay-minutes ${delayDir} ${fmtPct(kpis.delayDeltaPct)} — the volume/duration relationship is diverging.`

  // ── Executive summary ─────────────────────────────────────────────────────
  const topCat = categories[0]
  const topArea = geography[0]
  const execBits: string[] = []
  execBits.push(`Over ${scopeLabel.toLowerCase()}, ${fmtInt(kpis.totalIncidents)} incidents drove ${fmtMins(kpis.totalDelayMins)} of delay across the route.`)
  if (topCat) execBits.push(`${topCat.label} led the mix at ${fmtInt(topCat.count)} incidents (${(topCat.share * 100).toFixed(0)}%).`)
  if (kpis.safetyCriticalCount > 0) {
    execBits.push(`${fmtInt(kpis.safetyCriticalCount)} safety-critical event${kpis.safetyCriticalCount === 1 ? '' : 's'} ${kpis.safetyDeltaPct != null ? `(${fmtPct(kpis.safetyDeltaPct)} vs prior)` : ''} demand particular attention.`)
  }
  if (kpis.slaCompliancePct != null) {
    const slaMissed = (100 - kpis.slaCompliancePct).toFixed(0)
    execBits.push(`Arrival-SLA compliance held at ${kpis.slaCompliancePct.toFixed(0)}% (${slaMissed}% of arrivals exceeded 45 minutes).`)
  }
  const executive = execBits.join(' ')

  // ── Body paragraphs ───────────────────────────────────────────────────────
  const paragraphs: string[] = []

  // Volume & delay framing
  const para1: string[] = []
  para1.push(`Window total: ${fmtInt(kpis.totalIncidents)} unique incidents (${incDir} ${fmtPct(kpis.incidentsDeltaPct)} vs prior).`)
  para1.push(`These accumulated ${fmtMins(kpis.totalDelayMins)} of delay (${delayDir} ${fmtPct(kpis.delayDeltaPct)}) and contributed to ${fmtInt(kpis.totalCancelled)} cancellations and ${fmtInt(kpis.totalPartCancelled)} part-cancellations.`)
  if (kpis.avgIncidentDuration != null) {
    para1.push(`Average incident duration sat at ${fmtMins(kpis.avgIncidentDuration)} ${kpis.durationDeltaPct != null ? `(${fmtPct(kpis.durationDeltaPct)} vs prior)` : ''}.`)
  }
  paragraphs.push(para1.join(' '))

  // Category & geography framing
  const para2: string[] = []
  if (topCat) {
    para2.push(`${topCat.label} was the most common category, accounting for ${(topCat.share * 100).toFixed(0)}% of incidents and ${fmtMins(topCat.delayMins)} of delay.`)
    const next = categories[1]
    if (next) para2.push(`${next.label} followed at ${fmtInt(next.count)} (${(next.share * 100).toFixed(0)}%).`)
  }
  if (topArea) {
    const top3 = geography.slice(0, 3).map(g => g.location).join(', ')
    para2.push(`Hotspots concentrated around ${top3} — ${topArea.location} alone took ${fmtMins(topArea.delayMins)} across ${fmtInt(topArea.count)} incidents.`)
  }
  if (para2.length) paragraphs.push(para2.join(' '))

  // Asset & repeat patterns
  if (assets.length > 0) {
    const top = assets[0]
    const repeatCount = assets.length
    paragraphs.push(`Repeat-asset signal: ${fmtInt(repeatCount)} asset–location pair${repeatCount === 1 ? '' : 's'} failed more than once. ${top.assetType} at ${top.location} re-appeared ${fmtInt(top.occurrences)} times for ${fmtMins(top.totalDelay)} of cumulative delay — a candidate for engineering follow-up.`)
  }

  // Anomalies & change-points
  if (changePoints.length > 0 || signals.length > 0) {
    const cpBits = changePoints.slice(0, 2).map(cp => `${cp.direction === 'up' ? 'rise' : 'drop'} on ${shortDate(cp.date)} (${cp.beforeMean.toFixed(1)} → ${cp.afterMean.toFixed(1)})`).join('; ')
    const sigBits = signals.slice(0, 2).map(s => s.title).join('; ')
    const sentence: string[] = []
    if (cpBits) sentence.push(`Detected level shifts in the daily series: ${cpBits}.`)
    if (sigBits) sentence.push(`${signals.length} active signal${signals.length === 1 ? '' : 's'} — including ${sigBits}.`)
    if (sentence.length) paragraphs.push(sentence.join(' '))
  }

  // ── Bullet list ───────────────────────────────────────────────────────────
  const bullets: { kind: 'positive' | 'warning' | 'neutral'; text: string }[] = []

  bullets.push({
    kind: directionGood(kpis.incidentsDeltaPct, true),
    text: `Incident volume ${incDir} ${fmtPct(kpis.incidentsDeltaPct)} vs prior — ${fmtInt(kpis.totalIncidents)} this window.`,
  })
  bullets.push({
    kind: directionGood(kpis.delayDeltaPct, true),
    text: `Total delay ${delayDir} ${fmtPct(kpis.delayDeltaPct)} — ${fmtMins(kpis.totalDelayMins)}.`,
  })
  if (kpis.safetyDeltaPct != null) {
    bullets.push({
      kind: directionGood(kpis.safetyDeltaPct, true),
      text: `Safety-critical count ${directionWord(kpis.safetyDeltaPct, true)} ${fmtPct(kpis.safetyDeltaPct)} — ${fmtInt(kpis.safetyCriticalCount)} event${kpis.safetyCriticalCount === 1 ? '' : 's'}.`,
    })
  }
  if (kpis.slaCompliancePct != null) {
    const breached = (100 - kpis.slaCompliancePct).toFixed(0)
    bullets.push({
      kind: kpis.slaCompliancePct >= 80 ? 'positive' : kpis.slaCompliancePct >= 60 ? 'neutral' : 'warning',
      text: `Arrival-SLA compliance ${kpis.slaCompliancePct.toFixed(0)}% — ${breached}% breached the 45-min target.`,
    })
  }
  if (assets.length > 0) {
    bullets.push({
      kind: 'warning',
      text: `${assets.length} repeat-fault asset${assets.length === 1 ? '' : 's'} flagged — top: ${assets[0].assetType} at ${assets[0].location} (${assets[0].occurrences}×).`,
    })
  }
  if (signals.some(s => s.severity === 'critical')) {
    const crit = signals.filter(s => s.severity === 'critical').length
    bullets.push({
      kind: 'warning',
      text: `${crit} critical signal${crit === 1 ? '' : 's'} active — review the anomalies section.`,
    })
  }
  if (changePoints.length > 0) {
    bullets.push({
      kind: 'neutral',
      text: `${changePoints.length} statistical change-point${changePoints.length === 1 ? '' : 's'} detected on the daily series — see trend overlay.`,
    })
  }

  return { executive, headline, paragraphs, bullets }
}

function shortDate(iso: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]}`
}
