// ─── Report HTML renderer ────────────────────────────────────────────────────
// Turns a ReportPlan into a complete styled HTML document — the canonical PDF
// pipeline is the browser's print engine, which preserves vector text and CSS
// page layout exactly as designed here. The same HTML drives the live preview.

import {
  AppendixRow, AssetRow, AttributionRow, CategoryRow, GeoRow, HeatmapCellPlain,
  PmcIncidentRow, PmcItsrPlan, PmcLocationRow, PmcRepeatMatch, PmcTopDelayDetail,
  PmcTopicPlan,
  ReportKpi, ReportPlan, ReportSectionId, SafetyRadarRow, SignalRow, TrendPointPlain,
} from './types'
import { donutSvg, hbarSvg, heatmapSvg, safetyRadarSvg, trendAreaSvg, REPORT_COLORS } from './charts'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function fmt(n: number): string {
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

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—'
  if (Math.abs(n) < 0.5) return '~0%'
  return `${n > 0 ? '+' : ''}${n.toFixed(0)}%`
}

function shortDate(iso: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]}`
}

function longDate(iso: string): string {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`
}

// ─── Print stylesheet ────────────────────────────────────────────────────────
// Editorial / control-centre hybrid translated to a printable cream palette.
// Same type stack as the dashboard (Fraunces / Inter Tight / JetBrains Mono)
// but on a paper background so it doesn't waste ink and remains readable.

function reportStylesheet(): string {
  return `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600&family=Inter+Tight:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

      :root {
        --ink:        ${REPORT_COLORS.ink};
        --ink-2:      ${REPORT_COLORS.ink2};
        --ink-3:      ${REPORT_COLORS.ink3};
        --ink-4:      ${REPORT_COLORS.ink4};
        --rule:       ${REPORT_COLORS.rule};
        --rule-hi:    ${REPORT_COLORS.ruleHi};
        --paper:      ${REPORT_COLORS.paper};
        --panel:      ${REPORT_COLORS.panel};
        --panel-line: ${REPORT_COLORS.panelLine};
        --orange:     ${REPORT_COLORS.orange};
        --orange-soft: ${REPORT_COLORS.orangeSoft};
        --amber:      ${REPORT_COLORS.amber};
        --red:        ${REPORT_COLORS.red};
        --green:      ${REPORT_COLORS.green};
        --steel:      ${REPORT_COLORS.steel};
      }

      @page {
        size: A4 portrait;
        margin: 16mm 14mm 16mm 14mm;
      }

      * { box-sizing: border-box; }

      html, body {
        margin: 0; padding: 0;
        background: var(--paper);
        color: var(--ink);
        font-family: 'Inter Tight', system-ui, sans-serif;
        font-size: 10.5pt;
        line-height: 1.42;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      .serif       { font-family: 'Fraunces', Georgia, serif; }
      .mono        { font-family: 'JetBrains Mono', monospace; }
      .label-micro {
        font-family: 'JetBrains Mono', monospace;
        font-size: 7.5pt;
        font-weight: 500;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--ink-3);
      }
      .numeric {
        font-family: 'Fraunces', Georgia, serif;
        font-feature-settings: 'tnum' 1, 'lnum' 1;
        font-variation-settings: 'opsz' 144;
      }

      .page {
        page-break-after: always;
        position: relative;
      }
      .page:last-child { page-break-after: auto; }

      /* Editorial tick-corner brackets */
      .tick-corners { position: relative; }
      .tick-corners::before,
      .tick-corners::after {
        content: '';
        position: absolute;
        width: 10px; height: 10px;
        border: 1.25px solid var(--orange);
        opacity: 0.85;
      }
      .tick-corners::before { top: 0;    left: 0;    border-right: none; border-bottom: none; }
      .tick-corners::after  { bottom: 0; right: 0;   border-left: none;  border-top: none; }

      .rule       { border: 0; border-top: 0.5pt solid var(--rule);     margin: 14pt 0; }
      .rule-hi    { border: 0; border-top: 0.75pt solid var(--rule-hi); margin: 14pt 0; }
      .rule-orange { border: 0; border-top: 1.5pt solid var(--orange);   margin: 14pt 0; }

      /* ── Cover page ────────────────────────────────────────────────────── */
      .cover {
        height: 100%;
        min-height: 245mm;
        display: flex; flex-direction: column;
        padding: 18mm 12mm 14mm 12mm;
        background:
          radial-gradient(circle at 96% 6%, rgba(224, 82, 6, 0.10), transparent 35%),
          radial-gradient(circle at 4% 100%, rgba(74, 111, 165, 0.08), transparent 40%),
          var(--paper);
      }
      .cover-top { display: flex; justify-content: space-between; align-items: flex-start; }
      .cover-mark { display: flex; align-items: center; gap: 10px; }
      .cover-mark-square {
        width: 12px; height: 12px; background: var(--orange);
        box-shadow: 3px 3px 0 var(--ink);
      }
      .cover-mark-text { font-family: 'JetBrains Mono', monospace; font-size: 8pt; letter-spacing: 0.22em; text-transform: uppercase; color: var(--ink-2); }

      .cover-template {
        font-family: 'JetBrains Mono', monospace;
        font-size: 7.5pt; letter-spacing: 0.2em;
        text-transform: uppercase; color: var(--orange);
      }

      .cover-headline {
        margin-top: 28mm;
      }
      .cover-eyebrow {
        font-family: 'JetBrains Mono', monospace;
        font-size: 8pt; letter-spacing: 0.22em; text-transform: uppercase;
        color: var(--ink-3);
        margin-bottom: 14px;
      }
      .cover-title {
        font-family: 'Fraunces', Georgia, serif;
        font-weight: 400;
        font-size: 56pt;
        line-height: 0.96;
        letter-spacing: -0.022em;
        color: var(--ink);
        margin: 0 0 6mm 0;
      }
      .cover-scope {
        font-family: 'Fraunces', Georgia, serif;
        font-weight: 300;
        font-size: 22pt;
        font-style: italic;
        color: var(--orange);
        line-height: 1.05;
        margin: 0;
      }

      .cover-hero {
        margin-top: auto;
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 0;
        border-top: 0.75pt solid var(--rule-hi);
        padding-top: 8mm;
      }
      .cover-hero-tile {
        padding: 0 6mm 0 0;
        border-right: 0.5pt solid var(--rule);
      }
      .cover-hero-tile:last-child { border-right: none; padding-right: 0; }
      .cover-hero-tile + .cover-hero-tile { padding-left: 6mm; }
      .cover-hero-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 7pt; letter-spacing: 0.18em; text-transform: uppercase;
        color: var(--ink-3);
        margin-bottom: 6px;
      }
      .cover-hero-value {
        font-family: 'Fraunces', Georgia, serif;
        font-weight: 400;
        font-size: 30pt;
        line-height: 0.95;
        letter-spacing: -0.015em;
        color: var(--ink);
        font-feature-settings: 'tnum' 1, 'lnum' 1;
      }
      .cover-hero-delta {
        font-family: 'JetBrains Mono', monospace;
        font-size: 9pt; font-weight: 500;
        margin-top: 6px;
      }
      .delta-good { color: var(--green); }
      .delta-bad  { color: var(--red); }
      .delta-flat { color: var(--ink-3); }

      .cover-foot {
        margin-top: 10mm;
        display: flex; justify-content: space-between; align-items: flex-end;
        font-family: 'JetBrains Mono', monospace;
        font-size: 8pt; letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--ink-3);
      }
      .cover-foot .right { text-align: right; }
      .cover-foot strong { color: var(--ink); font-weight: 500; }
      .cover-demo {
        margin-top: 6px;
        display: inline-block;
        font-family: 'JetBrains Mono', monospace;
        font-size: 7pt; letter-spacing: 0.16em; text-transform: uppercase;
        color: var(--amber);
        border: 0.75pt solid var(--amber);
        padding: 2px 6px;
      }

      /* ── Section pages ─────────────────────────────────────────────────── */
      .section {
        padding-top: 4mm;
      }
      .section-head {
        display: flex; align-items: baseline; justify-content: space-between;
        gap: 12px;
        margin-bottom: 6mm;
        padding-bottom: 4mm;
        border-bottom: 0.5pt solid var(--rule-hi);
      }
      .section-eyebrow {
        font-family: 'JetBrains Mono', monospace;
        font-size: 7.5pt; letter-spacing: 0.2em; text-transform: uppercase;
        color: var(--orange);
      }
      .section-title {
        font-family: 'Fraunces', Georgia, serif;
        font-weight: 400;
        font-size: 22pt;
        line-height: 1.05;
        letter-spacing: -0.015em;
        color: var(--ink);
        margin: 4px 0 0 0;
      }
      .section-lede {
        font-family: 'Fraunces', Georgia, serif;
        font-style: italic;
        font-size: 13pt;
        line-height: 1.4;
        color: var(--ink-2);
        max-width: 64ch;
        margin: 0 0 10pt 0;
      }
      .section-body p {
        margin: 0 0 9pt 0;
        max-width: 76ch;
      }

      .pill {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 2px 7px; border-radius: 999px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 7pt; font-weight: 500;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        border: 0.5pt solid;
      }
      .pill-critical { color: var(--red);    border-color: rgba(178, 59, 48, 0.55);  background: rgba(178, 59, 48, 0.08); }
      .pill-high     { color: var(--orange); border-color: rgba(224, 82, 6, 0.55);    background: rgba(224, 82, 6, 0.08); }
      .pill-medium   { color: var(--amber);  border-color: rgba(199, 130, 27, 0.55);  background: rgba(199, 130, 27, 0.08); }
      .pill-low      { color: var(--steel);  border-color: rgba(71, 106, 152, 0.55);  background: rgba(71, 106, 152, 0.08); }
      .pill-info     { color: var(--ink-3);  border-color: var(--rule-hi);            background: var(--panel); }

      /* ── KPI grid ──────────────────────────────────────────────────────── */
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 0;
        border: 0.5pt solid var(--rule-hi);
      }
      .kpi {
        padding: 9mm 7mm;
        border-right: 0.5pt solid var(--rule);
        border-bottom: 0.5pt solid var(--rule);
        background: var(--paper);
        position: relative;
      }
      .kpi:nth-child(4n) { border-right: none; }
      .kpi:nth-last-child(-n+4) { border-bottom: none; }
      .kpi-critical::after {
        content: '';
        position: absolute; top: 0; right: 0;
        width: 22mm; height: 18mm;
        background: radial-gradient(circle at top right, rgba(178, 59, 48, 0.18), transparent 70%);
        pointer-events: none;
      }
      .kpi-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 7pt; letter-spacing: 0.18em; text-transform: uppercase;
        color: var(--ink-3);
      }
      .kpi-value {
        font-family: 'Fraunces', Georgia, serif;
        font-feature-settings: 'tnum' 1, 'lnum' 1;
        font-weight: 400;
        font-size: 32pt;
        line-height: 1;
        letter-spacing: -0.014em;
        color: var(--ink);
        margin: 8px 0 6px 0;
      }
      .kpi-hint {
        font-family: 'JetBrains Mono', monospace;
        font-size: 7.5pt;
        color: var(--ink-3);
        margin-top: 6px;
      }
      .kpi-delta {
        font-family: 'JetBrains Mono', monospace;
        font-size: 8.5pt; font-weight: 500;
        margin-top: 4px;
      }
      .kpi-delta .arrow { font-size: 9pt; margin-right: 3px; }

      /* ── Two-column layout for chart + commentary ──────────────────────── */
      .two-col {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8mm;
        align-items: start;
      }
      .two-col-asym {
        display: grid;
        grid-template-columns: 1.4fr 1fr;
        gap: 8mm;
        align-items: start;
      }

      /* ── Generic panel (light card) ────────────────────────────────────── */
      .panel {
        background: var(--panel);
        border: 0.5pt solid var(--panel-line);
        padding: 6mm;
      }
      .panel-light {
        background: var(--paper);
        border: 0.5pt solid var(--rule-hi);
        padding: 6mm;
      }

      .panel-title {
        font-family: 'JetBrains Mono', monospace;
        font-size: 7.5pt;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--ink-3);
        margin: 0 0 6pt 0;
      }
      .panel-content { color: var(--ink-2); }

      /* ── Data tables ───────────────────────────────────────────────────── */
      table.data {
        width: 100%;
        border-collapse: collapse;
        font-size: 9.5pt;
      }
      table.data th, table.data td {
        text-align: left;
        padding: 6pt 8pt;
        border-bottom: 0.5pt solid var(--rule);
      }
      table.data th {
        font-family: 'JetBrains Mono', monospace;
        font-size: 7pt;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--ink-3);
        background: var(--panel);
        border-bottom: 0.75pt solid var(--rule-hi);
      }
      table.data td.num, table.data th.num { text-align: right; font-family: 'JetBrains Mono', monospace; font-feature-settings: 'tnum' 1; }
      table.data tbody tr:last-child td { border-bottom: 0.75pt solid var(--rule-hi); }
      .cat-chip {
        display: inline-flex; align-items: center; gap: 6px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 7.5pt; font-weight: 500;
        color: var(--ink-2);
      }
      .cat-chip::before {
        content: '';
        width: 7px; height: 7px;
        background: currentColor;
        flex-shrink: 0;
      }

      /* ── Findings bullets ──────────────────────────────────────────────── */
      .findings { list-style: none; padding: 0; margin: 6pt 0 0 0; }
      .findings li {
        position: relative;
        padding: 8pt 10pt 8pt 22pt;
        border-bottom: 0.5pt solid var(--rule);
        font-size: 10pt;
      }
      .findings li:last-child { border-bottom: none; }
      .findings li::before {
        content: '';
        position: absolute;
        left: 8pt; top: 14pt;
        width: 7pt; height: 7pt;
        background: var(--ink-4);
      }
      .findings li.positive::before { background: var(--green); }
      .findings li.warning::before  { background: var(--orange); }
      .findings li.neutral::before  { background: var(--ink-4); }

      /* ── Signal cards ──────────────────────────────────────────────────── */
      .signal {
        border-left: 2pt solid var(--ink-4);
        padding: 6pt 0 6pt 10pt;
        margin-bottom: 8pt;
      }
      .signal-critical { border-left-color: var(--red); }
      .signal-warning  { border-left-color: var(--orange); }
      .signal-info     { border-left-color: var(--steel); }
      .signal-title { font-weight: 600; color: var(--ink); font-size: 10.5pt; }
      .signal-detail { color: var(--ink-2); font-size: 9.5pt; margin-top: 2pt; }
      .signal-date { font-family: 'JetBrains Mono', monospace; font-size: 7.5pt; letter-spacing: 0.1em; color: var(--ink-3); margin-top: 4pt; }

      /* ── Cover hero numeric & section svgs ─────────────────────────────── */
      svg.report-chart { width: 100%; height: auto; display: block; }
      svg.report-spark { width: 100%; height: 24pt; display: block; }

      /* ── Footer (running on each non-cover page) ───────────────────────── */
      .page-footer {
        position: fixed;
        bottom: 6mm; left: 14mm; right: 14mm;
        display: flex; justify-content: space-between;
        font-family: 'JetBrains Mono', monospace;
        font-size: 7pt; letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ink-3);
        pointer-events: none;
      }

      /* Avoid orphan section headers */
      .section-head, .kpi-grid, .panel { break-inside: avoid; }
      table.data, .signal { break-inside: avoid; }

      /* ── Top-delay deep-dive card ──────────────────────────────────────── */
      .td-card {
        border: 0.5pt solid var(--rule-hi);
        background: var(--paper);
        padding: 6mm;
        margin: 4mm 0;
        break-inside: avoid-page;
      }
      .td-card + .td-card { margin-top: 6mm; }
      .td-head {
        display: grid;
        grid-template-columns: auto 1fr 38mm;
        gap: 8mm;
        align-items: start;
        border-bottom: 0.5pt solid var(--rule);
        padding-bottom: 4mm;
        margin-bottom: 4mm;
      }
      .td-rank {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 30pt;
        line-height: 1;
        font-weight: 400;
        color: var(--orange);
        letter-spacing: -0.02em;
        padding-top: 1mm;
      }
      .td-head-main { min-width: 0; }
      .td-eyebrow {
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 4pt;
      }
      .td-title {
        font-family: 'Fraunces', Georgia, serif;
        font-weight: 400;
        font-size: 16pt;
        line-height: 1.15;
        letter-spacing: -0.01em;
        color: var(--ink);
        margin: 0 0 3pt 0;
      }
      .td-sub {
        font-size: 9.5pt;
        color: var(--ink-2);
        display: flex; flex-direction: column; gap: 1pt;
      }
      .td-impact { text-align: right; }
      .td-impact-value {
        font-family: 'Fraunces', Georgia, serif;
        font-weight: 400;
        font-size: 32pt;
        line-height: 1;
        letter-spacing: -0.015em;
        color: var(--ink);
        font-feature-settings: 'tnum' 1, 'lnum' 1;
      }
      .td-impact-unit { font-size: 16pt; color: var(--ink-3); margin-left: 2px; }
      .td-impact-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 7pt; letter-spacing: 0.16em; text-transform: uppercase;
        color: var(--ink-3); margin-top: 3pt;
      }
      .td-bar {
        margin-top: 6pt;
        height: 4pt;
        background: var(--panel);
        border: 0.5pt solid var(--rule);
      }
      .td-bar-fill { height: 100%; }

      .td-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 3mm 4mm;
      }
      .td-cell { min-width: 0; }
      .td-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 7pt;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--ink-3);
        margin-bottom: 2px;
        /* Keep long uppercase labels (CANCELLATIONS, FILES ATTACHED) inside
           their grid column rather than bleeding into the next cell. */
        overflow-wrap: anywhere;
        word-break: break-word;
        white-space: normal;
      }
      .td-value {
        font-size: 9.5pt;
        color: var(--ink);
        word-break: break-word;
        font-feature-settings: 'tnum' 1;
      }

      .td-timeline {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 2mm;
        padding: 3mm 0 1mm 0;
      }
      .td-step {
        position: relative;
        padding-left: 10pt;
      }
      .td-step + .td-step::before {
        content: '';
        position: absolute;
        left: -8pt; top: 5pt;
        width: 8pt; height: 0.75pt;
        background: var(--rule-hi);
      }
      .td-step-dot {
        position: absolute;
        left: 0; top: 3pt;
        width: 6pt; height: 6pt;
        background: var(--orange);
        border: 1pt solid var(--paper);
        box-shadow: 0 0 0 0.5pt var(--orange);
      }
      .td-step-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 7pt; letter-spacing: 0.14em; text-transform: uppercase;
        color: var(--ink-3);
      }
      .td-step-time {
        font-family: 'JetBrains Mono', monospace;
        font-size: 9pt;
        color: var(--ink);
        margin-top: 1pt;
      }
      .td-step-offset {
        font-family: 'JetBrains Mono', monospace;
        font-size: 8pt;
        color: var(--ink-3);
      }

      @media screen {
        /* When rendered into the live preview iframe, paint paper-like pages */
        body {
          padding: 16px 0;
        }
        .page {
          width: 210mm; min-height: 297mm;
          margin: 0 auto 16px auto;
          background: var(--paper);
          padding: 16mm 14mm;
          box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.12);
        }
        .cover { margin: 0 auto 16px auto; }
        .page-footer { display: none; }
      }
    </style>
  `
}

// ─── Cover page ──────────────────────────────────────────────────────────────

function renderCover(plan: ReportPlan): string {
  const hero = plan.heroKpis ?? []
  const generated = new Date(plan.meta.generatedAt)
  const dateStr = generated.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const timeStr = generated.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

  const heroTiles = hero.map(k => `
    <div class="cover-hero-tile">
      <div class="cover-hero-label">${esc(k.label)}</div>
      <div class="cover-hero-value">${esc(k.value)}</div>
      ${k.delta ? deltaTag(k.delta.signedPct, k.delta.deltaInverted, k.delta.label, 'cover-hero-delta') : ''}
    </div>
  `).join('')

  return `
    <section class="page cover tick-corners">
      <div class="cover-top">
        <div class="cover-mark">
          <div class="cover-mark-square"></div>
          <div class="cover-mark-text">EMCC Insight · Strategic Analytics</div>
        </div>
        <div class="cover-template">${esc(plan.meta.templateName)}</div>
      </div>

      <div class="cover-headline">
        <div class="cover-eyebrow">East Midlands Control Centre · Network Rail</div>
        <h1 class="cover-title">${esc(plan.meta.templateName)}.</h1>
        <p class="cover-scope">${esc(plan.meta.scopeLabel)}</p>
      </div>

      ${hero.length ? `<div class="cover-hero">${heroTiles}</div>` : ''}

      <div class="cover-foot">
        <div>
          <div><strong>${esc(dateStr)}</strong> · ${esc(timeStr)}</div>
          <div>${esc(plan.meta.filtersDescriptor)}</div>
          ${plan.meta.demoMode ? `<div class="cover-demo">Demo data · synthetic dataset</div>` : ''}
        </div>
        <div class="right">
          <div>Window</div>
          <div><strong>${esc(shortDate(plan.meta.windowFrom))} → ${esc(shortDate(plan.meta.windowTo))}</strong></div>
          <div>${plan.meta.windowDays} day${plan.meta.windowDays === 1 ? '' : 's'}</div>
        </div>
      </div>
    </section>
  `
}

function deltaTag(signedPct: number | null, inverted: boolean, label: string, className = 'kpi-delta'): string {
  if (signedPct == null) return `<div class="${className} delta-flat">— ${esc(label)}</div>`
  if (Math.abs(signedPct) < 0.5) return `<div class="${className} delta-flat">~0% ${esc(label)}</div>`
  const up = signedPct > 0
  const isBad = (up && inverted) || (!up && !inverted)
  const cls = isBad ? 'delta-bad' : 'delta-good'
  const arrow = up ? '▲' : '▼'
  return `<div class="${className} ${cls}"><span class="arrow">${arrow}</span>${fmtPct(signedPct)} ${esc(label)}</div>`
}

// ─── Section renderers ───────────────────────────────────────────────────────

function renderExecutive(plan: ReportPlan): string {
  if (!plan.executive) return ''
  return `
    <section class="page section">
      ${sectionHead('01', 'Executive Summary', plan.meta.scopeLabel)}
      <p class="section-lede">${esc(plan.executive)}</p>
      <hr class="rule-orange" />
      <div class="two-col">
        <div class="panel">
          <div class="panel-title">What this report covers</div>
          <p>This briefing distils ${plan.meta.windowDays} day${plan.meta.windowDays === 1 ? '' : 's'} of CCIL-captured incidents into the headline numbers, geographic concentration, asset-failure patterns and any anomalies worth a closer look. Every metric uses the same methodology as the live EMCC Insight dashboard.</p>
          <p>Numbers in this report are continuation-aware — a CCIL that re-appears day-by-day is treated as one event, and only its incremental delay is summed into the totals.</p>
        </div>
        <div class="panel-light">
          <div class="panel-title">How to read the deltas</div>
          <p>Each KPI shows the percentage change against the previous equivalent window. A 30-day report compares against the 30 days before; a railway period compares against the period before. Up arrows are red where rising is bad (incidents, delay, breaches) and green where rising is good (SLA compliance).</p>
        </div>
      </div>
      ${footer(plan, 1)}
    </section>
  `
}

function sectionHead(num: string, title: string, sub: string): string {
  return `
    <header class="section-head">
      <div>
        <div class="section-eyebrow">§${num} · ${esc(sub)}</div>
        <h2 class="section-title">${esc(title)}</h2>
      </div>
      <div class="label-micro">EMCC Insight</div>
    </header>
  `
}

function renderKpis(plan: ReportPlan, num: number): string {
  if (!plan.kpis || plan.kpis.length === 0) return ''
  const tiles = plan.kpis.map(k => `
    <div class="kpi ${k.critical ? 'kpi-critical' : ''}">
      <div class="kpi-label">${esc(k.label)}</div>
      <div class="kpi-value">${esc(k.value)}</div>
      ${k.delta ? deltaTag(k.delta.signedPct, k.delta.deltaInverted, k.delta.label) : ''}
      ${k.hint ? `<div class="kpi-hint">${esc(k.hint)}</div>` : ''}
    </div>
  `).join('')
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Headline KPIs', plan.meta.scopeLabel)}
      <p class="section-lede">Eight numbers that frame the window. Each delta compares like-for-like against the previous equivalent window — every metric continuation-aware so a multi-day incident isn't double-counted.</p>
      <div class="kpi-grid">${tiles}</div>
      ${footer(plan, num)}
    </section>
  `
}

function renderTrend(plan: ReportPlan, num: number): string {
  if (!plan.trend || plan.trend.points.length === 0) return ''
  const incChart = trendAreaSvg(plan.trend.points, plan.trend.changePoints, 'incidents', { showRolling: true })
  const delayChart = trendAreaSvg(plan.trend.points, plan.trend.changePoints, 'delayMins', { showRolling: true })
  const cps = plan.trend.changePoints

  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Trend & Change-Points', plan.meta.scopeLabel)}
      <p class="section-lede">Daily incident counts and delay-minutes across the window with a 7-day rolling average. Dashed verticals mark statistical level shifts — sustained breaks where the underlying mean has moved.</p>

      <div class="panel-light">
        <div class="panel-title">Incidents per day</div>
        ${incChart}
      </div>
      <div style="height: 6mm;"></div>
      <div class="panel-light">
        <div class="panel-title">Delay-minutes per day</div>
        ${delayChart}
      </div>

      ${cps.length ? `
        <hr class="rule" />
        <div class="panel-title">Detected change-points</div>
        <table class="data">
          <thead>
            <tr><th>Date</th><th>Series</th><th>Direction</th><th class="num">Before</th><th class="num">After</th><th class="num">Magnitude</th></tr>
          </thead>
          <tbody>
            ${cps.map(c => `
              <tr>
                <td>${esc(shortDate(c.date))}</td>
                <td>${c.metric === 'delayMins' ? 'Delay-mins' : 'Incidents'}</td>
                <td>${c.direction === 'up' ? '▲ Step up' : '▼ Step down'}</td>
                <td class="num">${c.beforeMean.toFixed(1)}</td>
                <td class="num">${c.afterMean.toFixed(1)}</td>
                <td class="num">${Math.abs(c.afterMean - c.beforeMean).toFixed(1)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<p style="color: var(--ink-3); font-size: 9.5pt; margin-top: 10pt;">No statistical change-points detected in this window — the daily series is consistent with its own short-term variance.</p>'}
      ${footer(plan, num)}
    </section>
  `
}

function renderCategoryMix(plan: ReportPlan, num: number): string {
  if (!plan.categories || plan.categories.length === 0) return ''
  const top = plan.categories[0]
  const donut = donutSvg(plan.categories, {
    headline: String(top.count),
    sub:      top.short,
  })
  const rows = plan.categories.slice(0, 10).map((c, i) => `
    <tr>
      <td><span class="cat-chip" style="color: ${c.color}">${esc(c.label)}</span></td>
      <td class="num">${fmt(c.count)}</td>
      <td class="num">${(c.share * 100).toFixed(0)}%</td>
      <td class="num">${fmtMins(c.delayMins)}</td>
      <td class="num">${c.count > 0 ? Math.round(c.delayMins / c.count) : 0}m</td>
    </tr>
  `).join('')
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Category Mix', plan.meta.scopeLabel)}
      <p class="section-lede">Where the window's incidents concentrated by category — both count share (how often) and delay impact (how disruptive).</p>
      <div class="two-col-asym">
        <div>
          <table class="data">
            <thead>
              <tr><th>Category</th><th class="num">Count</th><th class="num">Share</th><th class="num">Total delay</th><th class="num">Avg / inc.</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="panel" style="text-align: center;">
          <div class="panel-title" style="text-align: left;">Distribution by count</div>
          <div style="max-width: 60mm; margin: 4mm auto 0 auto;">${donut}</div>
          <div style="font-family: 'JetBrains Mono', monospace; font-size: 8pt; color: var(--ink-3); margin-top: 5mm; letter-spacing: 0.1em; text-transform: uppercase;">Most common · ${esc(top.label)}</div>
        </div>
      </div>
      ${footer(plan, num)}
    </section>
  `
}

function renderGeography(plan: ReportPlan, num: number): string {
  if (!plan.geography || plan.geography.length === 0) return ''
  const rows: GeoRow[] = plan.geography
  const bars = hbarSvg(
    rows.slice(0, 10).map(r => ({
      label: r.location,
      sub:   r.area ?? undefined,
      value: r.delayMins,
      color: r.topCategory?.color ?? REPORT_COLORS.orange,
    })),
    { valueLabel: v => fmtMins(v) },
  )
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Geography & Hotspots', plan.meta.scopeLabel)}
      <p class="section-lede">Locations ranked by total delay-minutes accumulated in the window. The bar colour indicates each location's dominant category.</p>

      <div class="panel-light">${bars}</div>

      <hr class="rule" />

      <table class="data">
        <thead>
          <tr><th>Location</th><th>Area</th><th>Dominant category</th><th class="num">Incidents</th><th class="num">Total delay</th></tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${esc(r.location)}</td>
              <td>${esc(r.area ?? '—')}</td>
              <td>${r.topCategory ? `<span class="cat-chip" style="color: ${r.topCategory.color}">${esc(r.topCategory.label)}</span>` : '—'}</td>
              <td class="num">${fmt(r.count)}</td>
              <td class="num">${fmtMins(r.delayMins)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${footer(plan, num)}
    </section>
  `
}

function renderPatterns(plan: ReportPlan, num: number): string {
  if (!plan.heatmap || plan.heatmap.length === 0) return ''
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Day × Hour Patterns', plan.meta.scopeLabel)}
      <p class="section-lede">When in the week incidents cluster. Each cell is a day-of-week × hour-of-day bucket — darker shading means higher count.</p>
      <div class="panel-light">${heatmapSvg(plan.heatmap)}</div>
      <hr class="rule" />
      <div class="two-col">
        <div class="panel">
          <div class="panel-title">How to read this</div>
          <p>Patterns emerge over weeks rather than days. The most common time-of-day bands (AM peak, PM peak, overnight engineering hours) should appear as horizontal bands across the days, while concentration on a single column suggests a recurring incident at a fixed time.</p>
        </div>
        <div class="panel-light">
          <div class="panel-title">Use cases</div>
          <p>Roster-planning, control-room shift handover prep, anticipating SLA pressure points. Verbatim use of the dashboard's Patterns tab heatmap — share with route teams to highlight where attention is most needed at what time.</p>
        </div>
      </div>
      ${footer(plan, num)}
    </section>
  `
}

function renderAssets(plan: ReportPlan, num: number): string {
  if (!plan.assets || plan.assets.length === 0) {
    return `
      <section class="page section">
        ${sectionHead(String(num).padStart(2, '0'), 'Repeat Assets', plan.meta.scopeLabel)}
        <p class="section-lede">No asset–location pair failed more than once during this window.</p>
        ${footer(plan, num)}
      </section>
    `
  }
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Repeat Assets', plan.meta.scopeLabel)}
      <p class="section-lede">Engineering priority list. Each row is a (location, asset-type) pair that has failed more than once in this window — sorted by frequency of recurrence and then total accumulated delay.</p>
      <table class="data">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Location</th>
            <th class="num">Occurrences</th>
            <th class="num">Total delay</th>
            <th>First seen</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          ${plan.assets.map((a: AssetRow) => `
            <tr>
              <td>${esc(a.assetType)}</td>
              <td>${esc(a.location)}</td>
              <td class="num">${fmt(a.occurrences)}×</td>
              <td class="num">${fmtMins(a.totalDelay)}</td>
              <td>${esc(shortDate(a.firstSeen))}</td>
              <td>${esc(shortDate(a.lastSeen))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${footer(plan, num)}
    </section>
  `
}

function renderSafetyRadar(plan: ReportPlan, num: number): string {
  if (!plan.safetyRadar || plan.safetyRadar.length === 0) return ''
  const rows = plan.safetyRadar
  const totalCur = rows.reduce((s, r) => s + r.current, 0)
  const totalPrev = rows.reduce((s, r) => s + r.previous, 0)
  const delta = totalPrev === 0 ? null : ((totalCur - totalPrev) / totalPrev) * 100
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Safety Profile', plan.meta.scopeLabel)}
      <p class="section-lede">Per-category safety-critical event counts plotted against the previous equivalent window. The filled polygon is current; the dashed outline is prior.</p>
      <div class="two-col-asym">
        <div class="panel-light" style="display: flex; justify-content: center;">${safetyRadarSvg(rows, { size: 320 })}</div>
        <div>
          <table class="data">
            <thead>
              <tr><th>Category</th><th class="num">Current</th><th class="num">Previous</th><th class="num">Δ</th></tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const d = r.previous === 0 ? (r.current === 0 ? null : Infinity) : ((r.current - r.previous) / r.previous) * 100
                const dTxt = d == null ? '—' : !isFinite(d) ? '+∞' : fmtPct(d)
                const cls = d == null ? '' : d > 0 ? 'delta-bad' : d < 0 ? 'delta-good' : ''
                return `
                  <tr>
                    <td><span class="cat-chip" style="color: ${r.color}">${esc(r.label)}</span></td>
                    <td class="num">${fmt(r.current)}</td>
                    <td class="num">${fmt(r.previous)}</td>
                    <td class="num ${cls}">${dTxt}</td>
                  </tr>
                `
              }).join('')}
              <tr>
                <td><strong>All safety-critical</strong></td>
                <td class="num"><strong>${fmt(totalCur)}</strong></td>
                <td class="num"><strong>${fmt(totalPrev)}</strong></td>
                <td class="num"><strong>${delta == null ? '—' : fmtPct(delta)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      ${footer(plan, num)}
    </section>
  `
}

function renderAttribution(plan: ReportPlan, num: number): string {
  if (!plan.attribution || plan.attribution.length === 0) return ''
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Delay Attribution', plan.meta.scopeLabel)}
      <p class="section-lede">How delay-minutes break down by attribution code — who carried the share of the disruption in this window.</p>
      <table class="data">
        <thead>
          <tr>
            <th>Attribution</th>
            <th>Code</th>
            <th class="num">Incidents</th>
            <th class="num">Delay-minutes</th>
            <th class="num">% of total</th>
          </tr>
        </thead>
        <tbody>
          ${plan.attribution.map((a: AttributionRow) => `
            <tr>
              <td>${esc(a.label)}</td>
              <td><span class="pill pill-info">${esc(a.code)}</span></td>
              <td class="num">${fmt(a.incidentCount)}</td>
              <td class="num">${fmtMins(a.totalDelay)}</td>
              <td class="num">${a.pct.toFixed(1)}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${footer(plan, num)}
    </section>
  `
}

function renderSignals(plan: ReportPlan, num: number): string {
  if (!plan.signals || plan.signals.length === 0) {
    return `
      <section class="page section">
        ${sectionHead(String(num).padStart(2, '0'), 'Anomalies & Signals', plan.meta.scopeLabel)}
        <p class="section-lede">No active signals — the window's daily series is consistent with its own short-term baseline.</p>
        ${footer(plan, num)}
      </section>
    `
  }
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Anomalies & Signals', plan.meta.scopeLabel)}
      <p class="section-lede">Automated checks against statistical baselines: incident surges, delay spikes, recurring faults, response degradation and SLA-breach rate.</p>
      ${plan.signals.map((s: SignalRow) => `
        <div class="signal signal-${s.severity}">
          <div class="signal-title">${esc(s.title)} <span class="pill pill-${s.severity === 'critical' ? 'critical' : s.severity === 'warning' ? 'high' : 'info'}" style="margin-left: 6px;">${s.severity}</span></div>
          <div class="signal-detail">${esc(s.detail)}</div>
          ${s.date ? `<div class="signal-date">Date: ${esc(shortDate(s.date))}</div>` : ''}
        </div>
      `).join('')}
      ${footer(plan, num)}
    </section>
  `
}

function renderNarrative(plan: ReportPlan, num: number): string {
  if (!plan.narrative) return ''
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Findings & Guidance', plan.meta.scopeLabel)}
      <p class="section-lede">${esc(plan.narrative.headline)}</p>
      <div class="section-body">
        ${plan.narrative.paragraphs.map(p => `<p>${esc(p)}</p>`).join('')}
      </div>
      <hr class="rule" />
      <div class="panel-title">Key findings</div>
      <ul class="findings">
        ${plan.narrative.bullets.map(b => `<li class="${b.kind}">${esc(b.text)}</li>`).join('')}
      </ul>
      ${footer(plan, num)}
    </section>
  `
}

function renderAppendix(plan: ReportPlan, num: number): string {
  if (!plan.appendix || plan.appendix.length === 0) return ''
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Incident Appendix', plan.meta.scopeLabel)}
      <p class="section-lede">Top ${plan.appendix.length} incidents from this window ranked by effective delay-minutes. Continuation events are excluded — only the originating incident appears.</p>
      <table class="data">
        <thead>
          <tr>
            <th>Date</th>
            <th>CCIL</th>
            <th>Cat.</th>
            <th>Severity</th>
            <th>Title</th>
            <th>Location</th>
            <th class="num">Delay</th>
            <th class="num">Duration</th>
            <th class="num">Arrival</th>
          </tr>
        </thead>
        <tbody>
          ${plan.appendix.map((a: AppendixRow) => `
            <tr>
              <td>${esc(shortDate(a.date))}</td>
              <td><span class="mono" style="font-size: 8.5pt;">${esc(a.ccil ?? '—')}</span></td>
              <td><span class="cat-chip" style="color: ${a.categoryColor}">${esc(a.categoryShort)}</span></td>
              <td><span class="pill pill-${severityPillClass(a.severity)}">${esc(a.severity)}</span></td>
              <td>${esc(truncate(a.title, 38))}</td>
              <td>${esc(a.location ?? '—')}</td>
              <td class="num">${fmt(a.delayMins)}m</td>
              <td class="num">${a.duration != null ? `${fmt(a.duration)}m` : '—'}</td>
              <td class="num">${a.arrival != null ? `${fmt(a.arrival)}m` : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${footer(plan, num)}
    </section>
  `
}

// ─── Control PMC renderers ───────────────────────────────────────────────────
// Each topic gets its own page with the same shape: header card + delta row,
// top-locations bar chart (when data exists), then the per-incident table.

function pmcDeltaSpan(signedPct: number | null, inverted = true): string {
  if (signedPct == null) return `<span class="delta-flat mono">—</span>`
  if (Math.abs(signedPct) < 0.5) return `<span class="delta-flat mono">~0%</span>`
  const up = signedPct > 0
  const isBad = (up && inverted) || (!up && !inverted)
  const cls = isBad ? 'delta-bad' : 'delta-good'
  const arrow = up ? '▲' : '▼'
  return `<span class="${cls} mono">${arrow}&nbsp;${fmtPct(signedPct)}</span>`
}

function pmcIncidentTable(rows: PmcIncidentRow[], opts: { showNote?: boolean; showFlag?: boolean } = {}): string {
  if (rows.length === 0) {
    return `<p style="color: var(--ink-3); font-size: 9.5pt; margin: 6pt 0;">No incidents in this band for the selected week.</p>`
  }
  return `
    <table class="data">
      <thead>
        <tr>
          <th>Date</th>
          <th>CCIL</th>
          <th>TDA</th>
          <th>Category</th>
          <th>Title</th>
          <th>Location</th>
          <th class="num">Delay</th>
          <th class="num">Trains</th>
          <th class="num">Cancel</th>
          ${opts.showFlag ? '<th>Reason held back</th>' : (opts.showNote ? '<th>Notes</th>' : '')}
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${esc(shortDate(r.date))}</td>
            <td><span class="mono" style="font-size: 8.5pt;">${esc(r.ccil ?? '—')}</span></td>
            <td><span class="mono" style="font-size: 8.5pt;">${esc(r.tda ?? '—')}</span></td>
            <td><span class="cat-chip" style="color: ${r.categoryColor}">${esc(r.categoryShort)}</span></td>
            <td>${esc(truncate(r.title ?? '—', 36))}</td>
            <td>${esc(r.location ?? '—')}${r.area ? ` <span class="mono" style="font-size: 7pt; color: var(--ink-3);">· ${esc(r.area)}</span>` : ''}</td>
            <td class="num">${fmt(r.delayMins)}m</td>
            <td class="num">${fmt(r.trainsDelayed)}</td>
            <td class="num">${fmt(r.cancelled)}${r.partCancelled ? `+${fmt(r.partCancelled)}p` : ''}</td>
            ${opts.showFlag
              ? `<td><span style="font-size: 8.5pt; color: var(--ink-3);">${esc(r.flagReason ?? '')}</span></td>`
              : (opts.showNote ? `<td><span class="mono" style="font-size: 8.5pt; color: var(--ink-3);">${esc(r.note ?? '')}</span></td>` : '')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `
}

// "Needs review" subsection — rows the trusted classifier held back from the
// headline counts, plus rows it moved out of the category (for audit). The
// subsection only renders when there is at least one row to surface.
function pmcFlaggedSection(rows: PmcIncidentRow[] | undefined): string {
  if (!rows || rows.length === 0) return ''
  return `
    <hr class="rule" />
    <div class="panel-title">Needs review · classification flagged ${rows.length} row${rows.length === 1 ? '' : 's'}</div>
    <p style="color: var(--ink-3); font-size: 9pt; margin: 4pt 0 6pt;">
      These rows were either re-classified out of this section by the CCIL-code-first
      classifier, or are missing a CCIL type code and were matched on title only.
      None are counted in the headline figures above — surfaced here for reviewer audit.
    </p>
    ${pmcIncidentTable(rows, { showFlag: true })}
  `
}

function pmcLocationTable(locs: PmcLocationRow[]): string {
  if (locs.length === 0) return ''
  return `
    <div class="panel-light" style="margin-top: 6pt;">
      <div class="panel-title">Top locations by delay</div>
      <table class="data" style="margin-top: 4pt;">
        <thead><tr><th>Location</th><th>Area</th><th class="num">Incidents</th><th class="num">Delay</th></tr></thead>
        <tbody>
          ${locs.map(l => `
            <tr>
              <td>${esc(l.location)}</td>
              <td>${esc(l.area ?? '—')}</td>
              <td class="num">${fmt(l.count)}</td>
              <td class="num">${fmtMins(l.delayMins)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `
}

function pmcInsights(insights: string[]): string {
  if (insights.length === 0) return ''
  return `
    <ul class="findings" style="margin-top: 6pt;">
      ${insights.map(b => `<li class="neutral">${esc(b)}</li>`).join('')}
    </ul>
  `
}

function pmcSummaryCard(plan: PmcTopicPlan): string {
  const s = plan.summary
  // CCIL refs intentionally omitted — every incident carries one CCIL so the
  // figure was always equal to "Incidents" and offered no extra information.
  return `
    <div class="kpi-grid" style="grid-template-columns: repeat(4, 1fr);">
      <div class="kpi">
        <div class="kpi-label">Incidents</div>
        <div class="kpi-value">${fmt(s.count)}</div>
        <div class="kpi-delta">${pmcDeltaSpan(s.countDeltaPct)} vs prev wk</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Total delay</div>
        <div class="kpi-value">${fmtMins(s.delayMins)}</div>
        <div class="kpi-delta">${pmcDeltaSpan(s.delayDeltaPct)} vs prev wk</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Locations</div>
        <div class="kpi-value">${fmt(s.uniqueLocations)}</div>
        <div class="kpi-hint">Distinct sites affected</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">TDA refs</div>
        <div class="kpi-value">${fmt(s.uniqueTda)}</div>
        <div class="kpi-hint">Unique TDA references</div>
      </div>
    </div>
  `
}

function renderPmcTopic(
  plan: ReportPlan, num: number,
  title: string, subtitle: string, topic: PmcTopicPlan | undefined,
  opts: { showNote?: boolean } = {},
): string {
  if (!topic) return ''
  const status = topic.status
    ? `<div class="signal signal-info"><div class="signal-detail">${esc(topic.status)}</div></div>`
    : ''
  const secondary = topic.secondary
    ? `
      <hr class="rule" />
      <div class="panel-title">${esc(topic.secondary.title)}</div>
      ${pmcIncidentTable(topic.secondary.incidents, { showNote: opts.showNote })}
    `
    : ''
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), title, plan.meta.scopeLabel)}
      <p class="section-lede">${esc(subtitle)}</p>
      ${status}
      ${pmcSummaryCard(topic)}
      ${pmcLocationTable(topic.locations)}
      ${pmcInsights(topic.insights)}
      <hr class="rule" />
      <div class="panel-title">Incidents in scope</div>
      ${pmcIncidentTable(topic.incidents, { showNote: opts.showNote })}
      ${secondary}
      ${pmcFlaggedSection(topic.flagged)}
      ${footer(plan, num)}
    </section>
  `
}

function renderPmcSummary(plan: ReportPlan, num: number): string {
  if (!plan.controlPmc) return ''
  const k = plan.controlPmc.headline
  const tiles = k.map(kpi => `
    <div class="kpi ${kpi.critical ? 'kpi-critical' : ''}">
      <div class="kpi-label">${esc(kpi.label)}</div>
      <div class="kpi-value">${esc(kpi.value)}</div>
      ${kpi.delta ? deltaTag(kpi.delta.signedPct, kpi.delta.deltaInverted, kpi.delta.label) : ''}
      ${kpi.hint ? `<div class="kpi-hint">${esc(kpi.hint)}</div>` : ''}
    </div>
  `).join('')
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Control PMC · Week summary', plan.meta.scopeLabel)}
      <p class="section-lede">Six headline numbers for the Control PMC week. Each topic is broken down in detail in the sections that follow.</p>
      <div class="kpi-grid" style="grid-template-columns: repeat(3, 1fr);">${tiles}</div>
      <hr class="rule" />
      <div class="two-col">
        <div class="panel">
          <div class="panel-title">How this report is built</div>
          <p>Incidents are grouped by topic from the same CCIL feed used by the live dashboard. Stranded-train and ITSR adherence figures are driven by reviewed incidents — events without an SNDM review on file count against ITSR adherence and don't appear in the stranded-train list until reviewed.</p>
        </div>
        <div class="panel-light">
          <div class="panel-title">Period vector</div>
          <p>Each topic shows a percentage change against the same week one cycle earlier. Up-arrows are red where rising is bad (incidents, delay) and green where rising is good (ITSR adherence).</p>
        </div>
      </div>
      ${footer(plan, num)}
    </section>
  `
}

function renderPmcFatalities(plan: ReportPlan, num: number): string {
  return renderPmcTopic(plan, num,
    'Fatalities · Person Struck',
    'All person-struck and fatality incidents recorded in the week. Zero is the target — any non-zero number triggers a deep-dive in the Control room.',
    plan.controlPmc?.fatalities)
}

function renderPmcStranded(plan: ReportPlan, num: number): string {
  return renderPmcTopic(plan, num,
    'Stranded train incidents',
    'Incidents flagged by an SNDM review as having stranded a train. Detail rows show the affected headcodes, locations and times pulled from the review record.',
    plan.controlPmc?.stranded, { showNote: true })
}

function renderPmcIrregular(plan: ReportPlan, num: number): string {
  return renderPmcTopic(plan, num,
    'Irregular working',
    'Irregular-working incidents from the CCIL feed. Used to monitor procedural drift and refresh briefings where volume rises week-on-week.',
    plan.controlPmc?.irregular)
}

function renderPmcPax(plan: ReportPlan, num: number): string {
  const pax = plan.controlPmc?.pax
  if (!pax) return ''
  const subtitle = pax.summary.count > 10
    ? `Passenger / public injury events ranked by delay impact — only the top 10 of ${pax.summary.count} appear in the table.`
    : 'Passenger / public injury events captured this week, ranked by delay impact.'
  return renderPmcTopic(plan, num, 'PAX incidents', subtitle, pax)
}

function renderPmcTrainFaults(plan: ReportPlan, num: number): string {
  return renderPmcTopic(plan, num,
    'Train fault incidents',
    'All train faults above 200 minutes delay are reported individually. The top 5 below the 200-minute threshold are appended in the secondary table for awareness.',
    plan.controlPmc?.trainFaults, { showNote: true })
}

function renderPmcItsr(plan: ReportPlan, num: number): string {
  const itsr = plan.controlPmc?.itsr as PmcItsrPlan | undefined
  if (!itsr) return ''
  const adherenceTile = `
    <div class="panel" style="margin-bottom: 6pt;">
      <div class="panel-title">ITSR adherence — incidents over 300 minutes</div>
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin-top: 6pt; border: 0.5pt solid var(--rule-hi);">
        <div class="kpi" style="padding: 6mm 5mm;">
          <div class="kpi-label">Adherence</div>
          <div class="kpi-value">${itsr.itsrPct.toFixed(0)}%</div>
          <div class="kpi-hint">${fmt(itsr.itsrCompleted)} of ${fmt(itsr.itsrCount)} reviewed with ITSR</div>
        </div>
        <div class="kpi" style="padding: 6mm 5mm;">
          <div class="kpi-label">ITSR completed</div>
          <div class="kpi-value">${fmt(itsr.itsrCompleted)}</div>
          <div class="kpi-hint">Reviewed · ITSR required = Yes</div>
        </div>
        <div class="kpi" style="padding: 6mm 5mm;">
          <div class="kpi-label">No ITSR (reviewed)</div>
          <div class="kpi-value">${fmt(itsr.itsrMissing)}</div>
          <div class="kpi-hint">Reviewed · ITSR not required</div>
        </div>
        <div class="kpi ${itsr.itsrUnreviewed > 0 ? 'kpi-critical' : ''}" style="padding: 6mm 5mm; border-right: none;">
          <div class="kpi-label">Unreviewed</div>
          <div class="kpi-value">${fmt(itsr.itsrUnreviewed)}</div>
          <div class="kpi-hint">No SNDM review on file</div>
        </div>
      </div>
    </div>
  `
  const status = itsr.status
    ? `<div class="signal signal-info"><div class="signal-detail">${esc(itsr.status)}</div></div>`
    : ''
  const secondary = itsr.secondary
    ? `
      <hr class="rule" />
      <div class="panel-title">${esc(itsr.secondary.title)}</div>
      ${pmcIncidentTable(itsr.secondary.incidents, { showNote: true })}
    `
    : ''
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'ITSR adherence', plan.meta.scopeLabel)}
      <p class="section-lede">Every incident with delay above 300 minutes should have a completed ITSR. The adherence figure measures the share of those incidents whose review confirms an ITSR was completed.</p>
      ${status}
      ${adherenceTile}
      ${pmcLocationTable(itsr.locations)}
      ${pmcInsights(itsr.insights)}
      <hr class="rule" />
      <div class="panel-title">Incidents above 300m with ITSR completed</div>
      ${pmcIncidentTable(itsr.incidents, { showNote: true })}
      ${secondary}
      ${footer(plan, num)}
    </section>
  `
}

// ─── Top 5 delay incidents deep-dive ─────────────────────────────────────────

function detailCell(label: string, value: string | null | undefined): string {
  return `
    <div class="td-cell">
      <div class="td-label">${esc(label)}</div>
      <div class="td-value">${value && value.length ? esc(value) : '<span style="color: var(--ink-4);">—</span>'}</div>
    </div>
  `
}

function tdTimeline(d: PmcTopDelayDetail): string {
  // Compact ASCII-ish timeline of the key timestamps
  const items: { label: string; time: string | null; offset: number | null }[] = [
    { label: 'Incident',     time: d.incidentStart,    offset: 0 },
    { label: 'Advised',      time: d.advisedTime,      offset: d.minsToAdvised  },
    { label: 'Initial resp', time: d.initialRespTime,  offset: d.minsToResponse },
    { label: 'Arrived',      time: d.arrivedAtTime,    offset: d.minsToArrival  },
    { label: 'NWR (closed)', time: d.nwrTime,          offset: d.incidentDuration },
  ]
  return `
    <div class="td-timeline">
      ${items.map(t => `
        <div class="td-step">
          <div class="td-step-dot"></div>
          <div class="td-step-label">${esc(t.label)}</div>
          <div class="td-step-time">${t.time ? esc(t.time) : '—'}</div>
          <div class="td-step-offset">${t.offset != null ? `+${fmt(t.offset)}m` : '—'}</div>
        </div>
      `).join('')}
    </div>
  `
}

function tdMatchTable(matches: PmcRepeatMatch[]): string {
  if (matches.length === 0) {
    return `<p style="color: var(--ink-3); font-size: 9.5pt; margin: 4pt 0 0 0;">No matching incidents found in the trailing 6 months.</p>`
  }
  return `
    <table class="data" style="margin-top: 4pt;">
      <thead>
        <tr>
          <th>Date</th>
          <th>CCIL</th>
          <th>Title</th>
          <th>Location</th>
          <th class="num">Delay</th>
          <th>Matched on</th>
        </tr>
      </thead>
      <tbody>
        ${matches.map(m => `
          <tr>
            <td>${esc(shortDate(m.date))}</td>
            <td><span class="mono" style="font-size: 8.5pt;">${esc(m.ccil ?? '—')}</span></td>
            <td>${esc(truncate(m.title ?? '—', 42))}</td>
            <td>${esc(m.location ?? '—')}${m.area ? ` <span class="mono" style="font-size: 7pt; color: var(--ink-3);">· ${esc(m.area)}</span>` : ''}</td>
            <td class="num">${fmt(m.delayMins)}m</td>
            <td><span class="pill pill-info">${esc(m.matchedOn === 'fault' ? 'fault number' : 'location · type')}</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `
}

function renderPmcTopDelayCard(d: PmcTopDelayDetail, rank: number, maxDelay: number): string {
  const barPct = maxDelay > 0 ? Math.max(2, Math.round((d.delayMins / maxDelay) * 100)) : 0
  const responder = (d.responderInitials ?? []).join(' · ') || '—'
  const units = (d.unitNumbers ?? []).join(', ') || '—'
  const dowName = d.dayOfWeek != null ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.dayOfWeek] : null
  const ts = [dowName, d.incidentStart, d.hourOfDay != null ? `hour ${d.hourOfDay}` : null].filter(Boolean).join(' · ')
  return `
    <div class="td-card">
      <div class="td-head">
        <div class="td-rank">#${rank}</div>
        <div class="td-head-main">
          <div class="td-eyebrow">
            <span class="cat-chip" style="color: ${d.categoryColor}">${esc(d.categoryShort)}</span>
            <span class="mono" style="font-size: 8pt; color: var(--ink-3);">${esc(d.categoryLabel)}</span>
            <span class="pill pill-${severityPillClass(d.severity)}" style="margin-left: 6px;">${esc(d.severity)}</span>
          </div>
          <h3 class="td-title">${esc(d.title ?? 'Untitled incident')}</h3>
          <div class="td-sub">
            <span><strong>${esc(d.location ?? '—')}</strong>${d.area ? ` · ${esc(d.area)}` : ''}${d.line ? ` · ${esc(d.line)}` : ''}</span>
            <span class="mono" style="font-size: 8.5pt; color: var(--ink-3);">${esc(longDate(d.date))}${ts ? ` · ${esc(ts)}` : ''}</span>
          </div>
        </div>
        <div class="td-impact">
          <div class="td-impact-value">${fmt(d.delayMins)}<span class="td-impact-unit">m</span></div>
          <div class="td-impact-label">delay minutes</div>
          <div class="td-bar"><div class="td-bar-fill" style="width: ${barPct}%; background: ${d.categoryColor};"></div></div>
        </div>
      </div>

      <div class="td-grid">
        ${detailCell('CCIL',           d.ccil)}
        ${detailCell('TDA',            d.tda)}
        ${detailCell('TRUST',          d.trustRef)}
        ${detailCell('TRMC',           d.trmcCode)}
        ${detailCell('Fault number',   d.faultNumber)}
        ${detailCell('Possession',     d.possessionRef)}
        ${detailCell('BTP ref',        d.btpRef)}
        ${detailCell('3rd-party ref',  d.thirdPartyRef)}
        ${detailCell('Type code',      d.incidentTypeCode)}
        ${detailCell('Type label',     d.incidentTypeLabel)}
        ${detailCell('Action code',    d.actionCode)}
        ${detailCell('Responders',     responder)}
      </div>

      <hr class="rule" style="margin: 6pt 0;" />

      <div class="two-col">
        <div>
          <div class="panel-title">Impact</div>
          <div class="td-grid">
            ${detailCell('Trains',     fmt(d.trainsDelayed))}
            ${detailCell('Cancelled',  fmt(d.cancelled))}
            ${detailCell('Part-canc.', fmt(d.partCancelled))}
            ${detailCell('Events',     d.eventCount != null ? fmt(d.eventCount) : null)}
            ${detailCell('FTS div',    d.ftsDivCount != null ? fmt(d.ftsDivCount) : null)}
            ${detailCell('Files',      d.hasFiles == null ? null : d.hasFiles ? 'Yes' : 'No')}
          </div>
        </div>
        <div>
          <div class="panel-title">Train</div>
          <div class="td-grid">
            ${detailCell('Headcode',     d.trainId)}
            ${detailCell('Operator',     d.trainCompany)}
            ${detailCell('Origin',       d.trainOrigin)}
            ${detailCell('Destination',  d.trainDestination)}
            ${detailCell('Units',        units)}
          </div>
        </div>
      </div>

      <hr class="rule" style="margin: 6pt 0;" />

      <div class="panel-title">Response timeline</div>
      ${tdTimeline(d)}

      <hr class="rule" style="margin: 6pt 0;" />

      <div class="panel-title">Repeat-issue lookup · last 6 months</div>
      <p style="color: var(--ink-3); font-size: 9pt; margin: 0 0 4pt 0;">${esc(d.matchNote)}</p>
      ${tdMatchTable(d.matches)}
    </div>
  `
}

function renderPmcTopDelay(plan: ReportPlan, num: number): string {
  const td = plan.controlPmc?.topDelay
  if (!td) return ''
  const maxDelay = td.incidents.length ? td.incidents[0].delayMins : 0
  const cards = td.incidents.map((d, i) => renderPmcTopDelayCard(d, i + 1, maxDelay)).join('')
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Top 5 delay incidents · deep-dive', plan.meta.scopeLabel)}
      <p class="section-lede">Filter-blind ranking of the week's five highest delay-incurring incidents. Each card surfaces the full operational record plus any matching incidents from ${esc(shortDate(td.windowFrom))} → ${esc(shortDate(td.windowTo))} (same fault number, or same location and asset type) to flag potential repeat issues.</p>
      ${pmcInsights(td.insights)}
      ${td.incidents.length === 0 ? '' : cards}
      ${footer(plan, num)}
    </section>
  `
}

function renderPmcSatisfaction(plan: ReportPlan, num: number): string {
  const sat = plan.controlPmc?.satisfaction
  if (!sat) return ''
  return `
    <section class="page section">
      ${sectionHead(String(num).padStart(2, '0'), 'Passenger satisfaction', plan.meta.scopeLabel)}
      <p class="section-lede">${esc(sat.status ?? 'Reserved for passenger satisfaction reporting.')}</p>
      <div class="panel">
        <div class="panel-title">Reserved section</div>
        ${pmcInsights(sat.insights)}
        <p style="color: var(--ink-3); font-size: 9.5pt; margin-top: 6pt;">When the satisfaction data feed is wired up, this section will display weekly survey results, top complaint themes, and movement against the prior week — using the same period-vs-period framing as the rest of this pack.</p>
      </div>
      ${footer(plan, num)}
    </section>
  `
}

function severityPillClass(s: string): string {
  if (s === 'CRITICAL') return 'critical'
  if (s === 'HIGH')     return 'high'
  if (s === 'MEDIUM')   return 'medium'
  if (s === 'LOW')      return 'low'
  return 'info'
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function footer(plan: ReportPlan, _pageNum: number): string {
  // The footer is a fixed-position block that prints once per page via the
  // browser's running-element model. Avoid hard-coding page numbers — the
  // print engine handles ordering, and a CSS counter would over-specify here.
  return `
    <div class="page-footer">
      <span>${esc(plan.meta.templateName)} · ${esc(plan.meta.scopeLabel)}</span>
      <span>Generated ${esc(new Date(plan.meta.generatedAt).toLocaleDateString('en-GB'))} · EMCC Insight</span>
    </div>
  `
}

// ─── Top-level document assembly ─────────────────────────────────────────────

const SECTION_RENDERERS: Record<Exclude<ReportSectionId, 'cover'>, (plan: ReportPlan, num: number) => string> = {
  executive:    renderExecutive,
  kpis:         renderKpis,
  trend:        renderTrend,
  categoryMix:  renderCategoryMix,
  safetyRadar:  renderSafetyRadar,
  geography:    renderGeography,
  patterns:     renderPatterns,
  assets:       renderAssets,
  attribution:  renderAttribution,
  signals:      renderSignals,
  narrative:    renderNarrative,
  appendix:     renderAppendix,
  pmcSummary:      renderPmcSummary,
  pmcFatalities:   renderPmcFatalities,
  pmcStranded:     renderPmcStranded,
  pmcIrregular:    renderPmcIrregular,
  pmcPax:          renderPmcPax,
  pmcTrainFaults:  renderPmcTrainFaults,
  pmcItsr:         renderPmcItsr,
  pmcSatisfaction: renderPmcSatisfaction,
  pmcTopDelay:     renderPmcTopDelay,
}

export function renderReportDocument(plan: ReportPlan): string {
  const sections = plan.sections
  const cover = sections.includes('cover') ? renderCover(plan) : ''
  let n = 1
  const body = sections
    .filter(s => s !== 'cover')
    .map(s => {
      const fn = SECTION_RENDERERS[s as Exclude<ReportSectionId, 'cover'>]
      if (!fn) return ''
      const html = fn(plan, n)
      if (html) n += 1
      return html
    })
    .join('\n')

  return `<!doctype html>
    <html lang="en-GB">
      <head>
        <meta charset="utf-8" />
        <title>${esc(plan.meta.templateName)} · ${esc(plan.meta.scopeLabel)}</title>
        ${reportStylesheet()}
      </head>
      <body>
        ${cover}
        ${body}
      </body>
    </html>
  `
}
