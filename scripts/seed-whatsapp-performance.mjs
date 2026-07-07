#!/usr/bin/env node
// Seed historic ma_message_snapshots rows from a WhatsApp chat export of the
// "EM State of the Route" community (Control Mob operational reports).
//
// The messaging assistant only started capturing snapshots on 2026-07-07
// (docs/briefs/MESSAGING_ASSISTANT_SNAPSHOTS.md). This script back-fills the
// same table from the WhatsApp messages the control room posted between
// April 2025 and July 2026, mapping each report onto the builder's slot model:
//
//   - the ~05:30 morning report carries *yesterday's* end-of-day standing
//     ("Yesterday's/Yesterdays Route Performance") -> slot 0530,
//     metrics_for_date = report date - 1
//   - intraday reports -> 0900 (< 12:00), 1500 (< 17:30), 2200 (>= 17:30);
//     where several reports land in one slot the latest wins and
//     build_count records how many were folded in (mirrors the builder's
//     replace-on-rebuild semantics)
//
// Three report formats are handled:
//   era A (Apr-Oct 2025)  "*East Midlands State of the Nation 15:00*",
//                         "On Time: 63.5% (Tgt 62.76%). L2H: 63.7%"
//   era B (Oct 2025-Jun 2026) "Route: ... | Report: 04/10/2025, 05:30:00 | By: ..."
//                         "• 🟠 Route T3 %: 71.4 (Tgt 78.4)"
//   era C (Jun-Jul 2026)  builder-shaped messages sent at slot times
//
// Seed rows are marked tab='whatsapp' with provenance in payload.source so
// they are distinguishable from live builder rows (tab='tactical'). Inserts
// use ON CONFLICT (snapshot_date, slot) DO NOTHING so live rows always win.
//
// Usage:
//   node scripts/seed-whatsapp-performance.mjs <path-to-_chat.txt> --report
//   node scripts/seed-whatsapp-performance.mjs <path-to-_chat.txt> --sql <out-dir> [--batch 40]
//   SUPABASE_URL=... SUPABASE_KEY=... node scripts/seed-whatsapp-performance.mjs <path-to-_chat.txt> --post

import fs from 'node:fs'
import path from 'node:path'

// ─── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const chatPath = argv.find(a => !a.startsWith('--'))
if (!chatPath) {
  console.error('usage: seed-whatsapp-performance.mjs <_chat.txt> [--sql <out-dir>] [--json <file>] [--report] [--batch N]')
  process.exit(1)
}
const flag = name => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : null
}
const sqlDir = flag('sql')
const jsonOut = flag('json')
const wantReport = argv.includes('--report')
const wantPost = argv.includes('--post')
const batchSize = Number(flag('batch')) || 40

// ─── Message splitting ────────────────────────────────────────────────────────

const raw = fs.readFileSync(chatPath, 'utf8').replace(/‎/g, '')
const MSG_RE = /^\[(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})\] ([^:\n]+): /

function splitMessages(text) {
  const messages = []
  let cur = null
  for (const line of text.split('\n')) {
    const m = line.match(MSG_RE)
    if (m) {
      if (cur) messages.push(cur)
      const [, dd, mm, yyyy, h, mi, s] = m
      cur = {
        sentDate: `${yyyy}-${mm}-${dd}`,
        sentTime: `${h}:${mi}:${s}`,
        sender: m[7].trim(),
        lines: [line.slice(m[0].length)],
      }
    } else if (cur) {
      cur.lines.push(line)
    }
  }
  if (cur) messages.push(cur)
  return messages.map(m => ({ ...m, text: m.lines.join('\n').trim() }))
}

// ─── Europe/London wall time -> UTC ISO ──────────────────────────────────────

function londonToUtcIso(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [h, mi, s] = timeStr.split(':').map(Number)
  // Try both possible offsets (GMT/BST) and keep the one that round-trips.
  for (const offMin of [60, 0]) {
    const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, s || 0) - offMin * 60000)
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(utc)
    const get = t => fmt.find(p => p.type === t).value
    if (get('year') == y && get('month') == String(mo).padStart(2, '0') &&
        get('day') == String(d).padStart(2, '0') &&
        Number(get('hour')) % 24 === h && get('minute') == String(mi).padStart(2, '0')) {
      return utc.toISOString()
    }
  }
  // Nonexistent wall time (spring-forward gap): treat as GMT.
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s || 0)).toISOString()
}

function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d + n))
  return dt.toISOString().slice(0, 10)
}

// ─── Stated report label (metadata only — headers carry stale dates/times, so
// slot assignment always keys off the send timestamp) ─────────────────────────

function statedReportTime(msg) {
  const head = msg.lines.slice(0, 3).join('\n')
  let m = head.match(/Report:\s*\d{2}\/\d{2}\/\d{4},?\s*(\d{1,2}:\d{2})/)
  if (m) return m[1]
  m = head.match(/State of the Nation\s*:?\s*\*?\s*(\d{1,2}[:.]\d{2})/)
  if (m) return m[1].replace('.', ':')
  return null
}

// ─── Performance block extraction ─────────────────────────────────────────────

const EOD_HEAD = /Yesterday'?s Route Performance/i
const INTRA_HEAD = /Route Performance/i

const METRIC_RE = new RegExp(
  '(🟩|🟢|🟨|🟠|🟧|🟥|🔴|🟪|🟣|⚪|⚫)?\\s*•?\\s*\\*?' +
  // NB: early-era "On Time" (to-the-minute punctuality) and "L2H" (last two
  // hours) readings are deliberately not extracted — different measures from
  // T3 that must not join this series.
  '(Route T3 %|Route T3|EMR T3 %|EMR T3|EMR Can %|GTR T3 %|GTR T3|XC T3 %|XC T3|Current Period Variance|Can)' +
  '\\*?\\s*:?\\s*(?:🟩|🟢|🟨|🟠|🟧|🟥|🔴)?\\s*(-?\\d+(?:\\.\\d+)?)\\s*%?' +
  '(?:\\s*\\((?:Tgt|Target|tgt)\\s*:?\\s*(-?\\d+(?:\\.\\d+)?)\\s*%?\\)?,?)?',
  'gu',
)

// Human-typed source: fix "79..4%", "87.9.3%", "3.1.%", "84,8%" style typos.
function cleanNumbers(line) {
  return line
    .replace(/(\d)\.\.(\d)/g, '$1.$2')
    .replace(/(\d+\.\d+)\.\d*\s*%/g, '$1%')
    .replace(/(\d+\.\d+)\.\s*%/g, '$1%')
    .replace(/(\d),(\d)/g, '$1.$2')
}

const NAME_MAP = {
  'Route T3': 'Route T3 %', 'Route T3 %': 'Route T3 %',
  'EMR T3': 'EMR T3 %', 'EMR T3 %': 'EMR T3 %',
  'Can': 'EMR Can %', 'EMR Can %': 'EMR Can %',
  'GTR T3': 'GTR T3 %', 'GTR T3 %': 'GTR T3 %',
  'XC T3': 'XC T3 %', 'XC T3 %': 'XC T3 %',
  'Current Period Variance': 'Current Period Variance',
}
const DIR = {
  'Route T3 %': 'higher', 'EMR T3 %': 'higher',
  'EMR Can %': 'lower', 'GTR T3 %': 'higher', 'XC T3 %': 'higher',
  'Current Period Variance': 'higher',
}
const RAG = { '🟩': 'green', '🟢': 'green', '🟨': 'amber', '🟠': 'amber', '🟧': 'amber', '🟥': 'red', '🔴': 'red' }

function cleanNote(s) {
  const t = s
    .replace(/^[\s.,;:–—\-()\[\]*%]+/, '')
    // Excluded L2H readings often precede real commentary — drop the figure,
    // keep the commentary.
    .replace(/^L2H\s*:?\s*(?:--|[\d.]+)?\s*%?\s*/i, '')
    .replace(/^[\s.,;:–—\-()\[\]*%]+/, '')
    .replace(/[\s.,;:–—\-()\[\]*]+$/, '')
    .trim()
  if (t.length < 3) return null
  // Fragments of half-parsed or excluded metrics are noise, not commentary.
  if (/Tgt|^Can\b|^(?:On [Tt]ime|L2H)\b[\s:]*[\d.]*%?$|^\d[\d.,%\s]*$/.test(t)) return null
  return t
}

function parseMetricLines(lines) {
  const metrics = []
  for (let line of lines) {
    line = cleanNumbers(line)
    const matches = [...line.matchAll(METRIC_RE)]
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]
      const name = NAME_MAP[m[2]]
      if (!name) continue
      const value = Number(m[3])
      // % readings outside 0-100 are transcription noise, keep them out
      if (name !== 'Current Period Variance' && (value < 0 || value > 100)) continue
      const noteEnd = i + 1 < matches.length ? matches[i + 1].index : line.length
      const note = cleanNote(line.slice(m.index + m[0].length, noteEnd))
      if (metrics.some(x => x.name === name)) continue
      metrics.push({
        name,
        value,
        target: m[4] != null ? Number(m[4]) : null,
        amber: null,
        dir: DIR[name],
        rag: RAG[m[1]] ?? null,
        notes: note,
      })
    }
  }
  return metrics
}

// Collect metric lines following a heading. Metric lines carry a RAG emoji
// and a "label: value" shape; interleaved free-text note lines (sometimes
// several — TOC delay commentary) are tolerated. The block ends at the next
// section heading (bold line or section emoji) or after 10 straight misses.
const SECTION_RE = /^\*[^*]+\*?\s*$|^[🚅🛤ℹ⏱👥🦺🌤📞✅⚠]/u
function blockAfter(lines, headIdx) {
  const collected = []
  let misses = 0
  for (let i = headIdx + 1; i < Math.min(lines.length, headIdx + 28); i++) {
    const line = cleanNumbers(lines[i].trim())
    if (!line) continue
    if (SECTION_RE.test(line)) break
    const hasMetric = [...line.matchAll(METRIC_RE)].some(m => NAME_MAP[m[2]])
    if (hasMetric) { collected.push(line); misses = 0 }
    else if (++misses >= 10) break
  }
  return collected
}

function extractBlocks(msg) {
  const lines = msg.text.split('\n')
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    if (EOD_HEAD.test(lines[i])) blocks.push({ kind: 'eod', metrics: parseMetricLines(blockAfter(lines, i)) })
    else if (INTRA_HEAD.test(lines[i])) blocks.push({ kind: 'intraday', metrics: parseMetricLines(blockAfter(lines, i)) })
  }
  return blocks.filter(b => b.metrics.length > 0)
}

// ─── Slot assignment & row building ──────────────────────────────────────────

// Slot from the send timestamp. An "evening" report posted shortly after
// midnight still belongs to the previous day's 2200 slot.
function slotAndDate(kind, msg) {
  if (kind === 'eod') return { slot: '0530', date: msg.sentDate }
  const t = +msg.sentTime.slice(0, 2) * 60 + +msg.sentTime.slice(3, 5)
  if (t < 180) return { slot: '2200', date: addDays(msg.sentDate, -1) }
  if (t < 720) return { slot: '0900', date: msg.sentDate }
  if (t < 1050) return { slot: '1500', date: msg.sentDate }
  return { slot: '2200', date: msg.sentDate }
}

const messages = splitMessages(raw)
const candidates = []
for (const msg of messages) {
  if (msg.sender !== 'Control Mob') continue
  const blocks = extractBlocks(msg)
  if (!blocks.length) continue
  const stated = statedReportTime(msg)
  for (const block of blocks) {
    const { slot, date: snapshotDate } = slotAndDate(block.kind, msg)
    candidates.push({
      snapshot_date: snapshotDate,
      slot,
      metrics_for_date: block.kind === 'eod' ? addDays(snapshotDate, -1) : snapshotDate,
      built_at: londonToUtcIso(msg.sentDate, msg.sentTime),
      report_time: stated,
      block: block.kind,
      metrics: block.metrics,
      message: msg.text,
      sent_at_local: `${msg.sentDate} ${msg.sentTime}`,
    })
  }
}

// Merge collisions on (snapshot_date, slot): latest report wins, count builds.
const bySlot = new Map()
for (const c of candidates) {
  const key = `${c.snapshot_date}|${c.slot}`
  const prev = bySlot.get(key)
  if (!prev) bySlot.set(key, { ...c, build_count: 1, first_built_at: c.built_at, last_built_at: c.built_at })
  else {
    const later = c.built_at >= prev.last_built_at
    bySlot.set(key, {
      ...(later ? c : prev),
      build_count: prev.build_count + 1,
      first_built_at: prev.first_built_at <= c.built_at ? prev.first_built_at : c.built_at,
      last_built_at: later ? c.built_at : prev.last_built_at,
    })
  }
}
const rows = [...bySlot.values()].sort((a, b) =>
  a.snapshot_date === b.snapshot_date ? a.slot.localeCompare(b.slot) : a.snapshot_date.localeCompare(b.snapshot_date))

// ─── Outputs ──────────────────────────────────────────────────────────────────

if (wantReport) {
  const bySlotCount = {}, byMetric = {}, byMonth = {}
  for (const r of rows) {
    bySlotCount[r.slot] = (bySlotCount[r.slot] || 0) + 1
    byMonth[r.snapshot_date.slice(0, 7)] = (byMonth[r.snapshot_date.slice(0, 7)] || 0) + 1
    for (const m of r.metrics) byMetric[m.name] = (byMetric[m.name] || 0) + 1
  }
  console.log(`rows: ${rows.length} (from ${candidates.length} report blocks)`)
  console.log(`dates: ${rows[0]?.snapshot_date} .. ${rows[rows.length - 1]?.snapshot_date}`)
  console.log('by slot:', bySlotCount)
  console.log('by metric:', byMetric)
  console.log('by month:', byMonth)
}

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1))

if (sqlDir) {
  fs.mkdirSync(sqlDir, { recursive: true })
  const lit = s => `'${String(s).replace(/'/g, "''")}'`
  const toSql = r => {
    const payload = {
      source: 'whatsapp_export',
      chat: 'EM State of the Route',
      sender: 'Control Mob',
      block: r.block,
      report_time: r.report_time,
      sent_at_local: r.sent_at_local,
    }
    return `(${lit(r.snapshot_date)}, ${lit(r.slot)}, 'whatsapp', ${lit(r.message)}, ` +
      `${lit(JSON.stringify(payload))}::jsonb, ${lit(JSON.stringify(r.metrics))}::jsonb, ` +
      `${lit(r.metrics_for_date)}, ${r.build_count}, ${lit(r.first_built_at)}, ${lit(r.last_built_at)})`
  }
  let n = 0
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const sql =
      'INSERT INTO ma_message_snapshots\n' +
      '  (snapshot_date, slot, tab, message, payload, metrics, metrics_for_date, build_count, first_built_at, last_built_at)\n' +
      'VALUES\n' + batch.map(toSql).join(',\n') +
      '\nON CONFLICT (snapshot_date, slot) DO NOTHING;\n'
    fs.writeFileSync(path.join(sqlDir, `seed_${String(++n).padStart(3, '0')}.sql`), sql)
  }
  console.log(`wrote ${n} SQL batch files to ${sqlDir}`)
}

if (wantPost) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_KEY
  if (!url || !key) { console.error('--post needs SUPABASE_URL and SUPABASE_KEY'); process.exit(1) }
  const toRecord = r => ({
    snapshot_date: r.snapshot_date,
    slot: r.slot,
    tab: 'whatsapp',
    message: r.message,
    payload: {
      source: 'whatsapp_export', chat: 'EM State of the Route', sender: 'Control Mob',
      block: r.block, report_time: r.report_time, sent_at_local: r.sent_at_local,
    },
    metrics: r.metrics,
    metrics_for_date: r.metrics_for_date,
    build_count: r.build_count,
    first_built_at: r.first_built_at,
    last_built_at: r.last_built_at,
  })
  let inserted = 0
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize).map(toRecord)
    const res = await fetch(`${url}/rest/v1/ma_message_snapshots?on_conflict=snapshot_date,slot`, {
      method: 'POST',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(batch),
    })
    if (!res.ok) {
      console.error(`batch at row ${i} failed: ${res.status} ${await res.text()}`)
      process.exit(1)
    }
    inserted += batch.length
    process.stdout.write(`\rposted ${inserted}/${rows.length}`)
  }
  console.log('\ndone (duplicates of existing (snapshot_date, slot) rows were skipped by the server)')
}
