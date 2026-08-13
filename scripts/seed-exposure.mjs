#!/usr/bin/env node
// Seed / regenerate the Temperature Exposure archetype data.
//
// Source of truth is supabase/seed/*.json — the outputs of the EMR diagram
// profiling analysis (NWR CIF full daily extract, 12 Aug 2026). Prefix→group
// mappings and archetypes drift at timetable changes (Dec/May): re-run the
// analysis derivation, replace the JSON files, then run this script with
// --ts to regenerate lib/exposureData.ts and --post/--sql to refresh the
// Supabase tables from migration 016.
//
// Usage:
//   node scripts/seed-exposure.mjs --ts                 # regenerate lib/exposureData.ts
//   node scripts/seed-exposure.mjs --sql <out-dir>      # emit seed SQL files
//   SUPABASE_URL=... SUPABASE_KEY=... node scripts/seed-exposure.mjs --post

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const seedDir = path.join(root, 'supabase', 'seed')

const archetypes = JSON.parse(fs.readFileSync(path.join(seedDir, 'exposure_archetypes.json'), 'utf8'))
const traces = JSON.parse(fs.readFileSync(path.join(seedDir, 'archetype_route_traces.json'), 'utf8'))
const overlay = JSON.parse(fs.readFileSync(path.join(seedDir, 'exposure_overlay_july2026.json'), 'utf8'))

const argv = process.argv.slice(2)
const wantTs = argv.includes('--ts')
const wantPost = argv.includes('--post')
const sqlIdx = argv.indexOf('--sql')
const sqlDir = sqlIdx >= 0 ? argv[sqlIdx + 1] : null

if (!wantTs && !wantPost && !sqlDir) {
  console.error('usage: seed-exposure.mjs [--ts] [--sql <out-dir>] [--post]')
  process.exit(1)
}

// ─── lib/exposureData.ts generation ──────────────────────────────────────────

function generateTs() {
  const out = []
  out.push('// ─── Temperature-exposure seed data (GENERATED — do not hand-edit) ──────────')
  out.push('// Source: EMR diagram profiling analysis (NWR CIF full extract, 12 Aug 2026;')
  out.push('// ATOC EM, permanent STP `P` schedules). Regenerate from the analysis JSON via')
  out.push('// scripts/seed-exposure.mjs whenever the timetable changes (Dec/May).')
  out.push('')
  out.push("export type ExposureDayType = 'weekday' | 'saturday' | 'sunday'")
  out.push("export type ExposureTier = 'full-day' | 'part-day'")
  out.push('')
  out.push('export interface ExposureArchetype {')
  out.push("  id: string                 // 'weekday|Sheffield - St Pancras|full-day'")
  out.push('  day: ExposureDayType')
  out.push('  group: string')
  out.push('  tier: ExposureTier')
  out.push('  n_diagrams: number')
  out.push('  avg_running_min: number')
  out.push('  avg_dwell_min: number')
  out.push('  avg_span_min: number')
  out.push('  avg_route_km: number')
  out.push('  avg_speed_mph: number')
  out.push('}')
  out.push('')
  out.push('// One representative route trace per archetype: 15-min timestamped positions,')
  out.push('// each flagged running (1) or dwell (0). Tuple form keeps the bundle compact:')
  out.push('// [minuteOfDay, lat, lon, running]')
  out.push('export type TracePoint = [number, number, number, 0 | 1]')
  out.push('')
  out.push('export const EXPOSURE_ARCHETYPES: ExposureArchetype[] = [')
  for (const [k, a] of Object.entries(archetypes)) {
    out.push(
      `  { id: ${JSON.stringify(k)}, day: ${JSON.stringify(a.day)}, group: ${JSON.stringify(a.group)}, ` +
      `tier: ${JSON.stringify(a.tier)}, n_diagrams: ${a.n_diagrams}, avg_running_min: ${a.avg_running_min}, ` +
      `avg_dwell_min: ${a.avg_dwell_min}, avg_span_min: ${a.avg_span_min}, avg_route_km: ${a.avg_route_km}, ` +
      `avg_speed_mph: ${a.avg_speed_mph.toFixed(1)} },`)
  }
  out.push(']')
  out.push('')
  out.push('export const ARCHETYPE_TRACES: Record<string, TracePoint[]> = {')
  for (const [k, t] of Object.entries(traces)) {
    const pts = t.trace
      .map(p => `[${p.minute},${p.lat},${p.lon},${p.state === 'running' ? 1 : 0}]`)
      .join(',')
    out.push(`  ${JSON.stringify(k)}: [${pts}],`)
  }
  out.push('}')
  out.push('')
  out.push('// Worked reference output from the analysis session: banded exposure for the')
  out.push('// 4–17 July 2026 heat window. Used to validate the in-app compute (results')
  out.push('// should match to rounding) and as a demo dataset when offline.')
  out.push('export interface ExposureOverlayRef {')
  out.push('  run_gt25_h: number; run_gt30_h: number')
  out.push('  dwell_gt25_h: number; dwell_gt30_h: number')
  out.push('  total_gt25_h: number; total_gt30_h: number')
  out.push('  peak_route_temp_c: number; days_sampled: number')
  out.push('}')
  out.push('')
  out.push(`export const JULY_2026_REFERENCE_WINDOW: [string, string] = [${overlay.window.map(w => JSON.stringify(w)).join(', ')}]`)
  out.push('')
  out.push('export const JULY_2026_REFERENCE: Record<string, ExposureOverlayRef> = {')
  for (const [k, r] of Object.entries(overlay.results)) {
    out.push(
      `  ${JSON.stringify(k)}: { run_gt25_h: ${r.run_gt25_h}, run_gt30_h: ${r.run_gt30_h}, ` +
      `dwell_gt25_h: ${r.dwell_gt25_h}, dwell_gt30_h: ${r.dwell_gt30_h}, total_gt25_h: ${r.total_gt25_h}, ` +
      `total_gt30_h: ${r.total_gt30_h}, peak_route_temp_c: ${r.peak_route_temp_c}, days_sampled: ${r.days_sampled} },`)
  }
  out.push('}')
  out.push('')
  const file = path.join(root, 'lib', 'exposureData.ts')
  fs.writeFileSync(file, out.join('\n'))
  console.log(`wrote ${file} (${fs.statSync(file).size} bytes)`)
}

// ─── SQL generation ──────────────────────────────────────────────────────────

const sq = s => `'${String(s).replace(/'/g, "''")}'`

function archetypeRows() {
  return Object.entries(archetypes).map(([k, a]) =>
    `(${sq(k)}, ${sq(a.day)}, ${sq(a.group)}, ${sq(a.tier)}, ${a.n_diagrams}, ` +
    `${a.avg_running_min}, ${a.avg_dwell_min}, ${a.avg_span_min}, ${a.avg_route_km}, ${a.avg_speed_mph})`)
}

function traceRows() {
  const rows = []
  for (const [k, t] of Object.entries(traces)) {
    for (const p of t.trace) {
      rows.push(`(${sq(k)}, ${p.minute}, ${p.lat}, ${p.lon}, ${p.state === 'running'})`)
    }
  }
  return rows
}

function generateSql(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const a = path.join(dir, 'seed_exposure_archetypes.sql')
  fs.writeFileSync(a,
    'INSERT INTO exposure_archetypes (id, day, service_group, tier, n_diagrams, avg_running_min, avg_dwell_min, avg_span_min, avg_route_km, avg_speed_mph) VALUES\n' +
    archetypeRows().join(',\n') +
    '\nON CONFLICT (id) DO UPDATE SET n_diagrams = EXCLUDED.n_diagrams, avg_running_min = EXCLUDED.avg_running_min, avg_dwell_min = EXCLUDED.avg_dwell_min, avg_span_min = EXCLUDED.avg_span_min, avg_route_km = EXCLUDED.avg_route_km, avg_speed_mph = EXCLUDED.avg_speed_mph;\n')
  const t = path.join(dir, 'seed_archetype_traces.sql')
  const rows = traceRows()
  const chunks = []
  for (let i = 0; i < rows.length; i += 500) {
    chunks.push(
      'INSERT INTO archetype_traces (archetype_id, minute, lat, lon, running) VALUES\n' +
      rows.slice(i, i + 500).join(',\n') +
      '\nON CONFLICT (archetype_id, minute) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, running = EXCLUDED.running;\n')
  }
  fs.writeFileSync(t, chunks.join('\n'))
  console.log(`wrote ${a}\nwrote ${t} (${rows.length} trace rows)`)
}

// ─── Direct post via Supabase REST ───────────────────────────────────────────

async function post() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_KEY
  if (!url || !key) {
    console.error('--post requires SUPABASE_URL and SUPABASE_KEY env vars')
    process.exit(1)
  }
  const headers = {
    apikey: key, Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
  }
  const archRows = Object.entries(archetypes).map(([k, a]) => ({
    id: k, day: a.day, service_group: a.group, tier: a.tier, n_diagrams: a.n_diagrams,
    avg_running_min: a.avg_running_min, avg_dwell_min: a.avg_dwell_min,
    avg_span_min: a.avg_span_min, avg_route_km: a.avg_route_km, avg_speed_mph: a.avg_speed_mph,
  }))
  let res = await fetch(`${url}/rest/v1/exposure_archetypes`, { method: 'POST', headers, body: JSON.stringify(archRows) })
  if (!res.ok) throw new Error(`exposure_archetypes upsert failed: ${res.status} ${await res.text()}`)
  console.log(`upserted ${archRows.length} archetypes`)

  const traceRowsAll = []
  for (const [k, t] of Object.entries(traces)) {
    for (const p of t.trace) {
      traceRowsAll.push({ archetype_id: k, minute: p.minute, lat: p.lat, lon: p.lon, running: p.state === 'running' })
    }
  }
  for (let i = 0; i < traceRowsAll.length; i += 1000) {
    res = await fetch(`${url}/rest/v1/archetype_traces`, { method: 'POST', headers, body: JSON.stringify(traceRowsAll.slice(i, i + 1000)) })
    if (!res.ok) throw new Error(`archetype_traces upsert failed: ${res.status} ${await res.text()}`)
  }
  console.log(`upserted ${traceRowsAll.length} trace points`)
}

if (wantTs) generateTs()
if (sqlDir) generateSql(sqlDir)
if (wantPost) await post()
