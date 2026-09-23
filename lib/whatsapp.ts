'use client'

// ─── WhatsApp incident-advice messaging ─────────────────────────────────────
// Everything the WhatsApp tab needs that is not a Supabase round-trip:
//
//   • reading a dropped export (.txt, or the .zip WhatsApp produces)
//   • parsing the iOS / Android chat formats into messages
//   • classifying each message (headline, RAG prefix, kind, headcodes)
//   • grouping messages into chains ("threads") on their repeated headline
//   • matching chains to CCIL incidents by time window + content
//   • scoring each linked incident against the EM Control Messaging Standard
//   • rolling scores up into KPIs, trends and monitoring flags
//
// Design note — the CCIL incident is the anchor, not the WhatsApp chain. One
// incident often carries several chains as its title changes ("OLE down
// Elstree" → "Elstree de-wirement"), so the tab always shows an incident's
// comms as the union of every chain linked to it. Chains are still needed
// for two things: matching (a chain's first posts carry the context its
// updates lack) and the unlinked inbox (so a whole chain can be linked by
// hand in one action).
//
// Time semantics: exports are Europe/London wall-clock; CCIL times are HH:MM
// on a 06:00–06:00 log day. All comparisons here are done in local wall-clock
// milliseconds (sent_local parsed as if UTC) so DST never enters the maths.
// sent_at (true UTC) is stored for anything that needs an absolute instant.

import { IncidentRow, WaGroup, WaKind, WaMessage, WaRag, WaThreadLink } from './types'
import { geocodeLocation } from './geo'
import { effectiveDelay } from './queries'

// ─── Constants ───────────────────────────────────────────────────────────────

export const WA_GROUP_LABELS: Record<WaGroup, string> = {
  north: 'EM North',
  south: 'EM South (London – Bedford / Critical Corridor)',
  other: 'Other group',
}

// Which CCIL areas each group is expected to message. Used as a prior in the
// matcher (a mismatch costs, it never excludes) and to define "notable"
// incidents per group for coverage.
export const WA_GROUP_AREAS: Record<WaGroup, string[]> = {
  north: ['E - EM - Derby', 'E - EM - Leicester', 'E - EM - Lincoln', 'E - EM - Nottingham', 'E - EM - Route Wide'],
  south: ['E - EM - Bedford', 'E - EM - Route Wide', 'SX - Sussex'],
  other: [],
}

// Standard targets (EM Control Messaging Standard, issue 0.8, section 13/16).
export const STANDARD = {
  holdingMins:      10,   // holding / immediate advice within 10 min of Control being advised
  firstDetailMins:  20,   // first detailed message within 20 min of the holding message
  cadenceRedMins:   30,   // BLACK / RED updates every 30 min
  cadenceAmberMins: 45,   // AMBER (and GREEN, 45+) updates every 45 min
  rapidFireMins:    5,    // "avoid several updates in quick succession"
  closeLagMins:     30,   // house target: closure post within 30 min of NWR (not in the standard)
  // Proxy for a BLACK/RED categorisation — neither source records the formal
  // category after March 2025, so cadence targets are chosen on this basis
  // and the UI says so.
  severeDelayMins:  300,
}

// ─── Reading a dropped file ──────────────────────────────────────────────────

export interface ExportFile { text: string; fileName: string; sha256: string | null }

// Reads a .txt export directly or extracts the first .txt from a WhatsApp
// .zip. The zip reader is deliberately minimal (local-file headers, stored or
// deflate, no encryption) — it is exactly what WhatsApp writes — and uses the
// browser's DecompressionStream rather than a dependency.
export async function readExportFile(file: File): Promise<ExportFile> {
  const ab = await file.arrayBuffer()
  const buf = new Uint8Array(ab)
  const sha256 = await sha256Hex(ab)
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
  if (!isZip) return { text: new TextDecoder('utf-8').decode(buf), fileName: file.name, sha256 }
  const entries = await readZipEntries(buf)
  const txt = entries.find(e => /\.txt$/i.test(e.name)) ?? entries.find(e => !/\.(jpg|jpeg|png|gif|mp4|webp|opus|pdf|vcf)$/i.test(e.name))
  if (!txt) throw new Error('No chat text file found inside the zip')
  return { text: new TextDecoder('utf-8').decode(txt.data), fileName: `${file.name} › ${txt.name}`, sha256 }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null
    const d = await crypto.subtle.digest('SHA-256', buf)
    return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('')
  } catch { return null }
}

interface ZipEntry { name: string; data: Uint8Array }

async function readZipEntries(buf: Uint8Array): Promise<ZipEntry[]> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const out: ZipEntry[] = []
  let p = 0
  while (p + 30 <= buf.length && dv.getUint32(p, true) === 0x04034b50) {
    const flags   = dv.getUint16(p + 6, true)
    const method  = dv.getUint16(p + 8, true)
    let   csize   = dv.getUint32(p + 18, true)
    const nameLen = dv.getUint16(p + 26, true)
    const extraLen = dv.getUint16(p + 28, true)
    const name = new TextDecoder('utf-8').decode(buf.subarray(p + 30, p + 30 + nameLen))
    let dataStart = p + 30 + nameLen + extraLen
    // Data-descriptor entries (bit 3) carry sizes after the data — look them
    // up in the central directory instead.
    if (flags & 0x08) {
      const cd = findCentralEntry(buf, dv, name)
      if (!cd) throw new Error('Unsupported zip layout')
      csize = cd.csize
    }
    const raw = buf.subarray(dataStart, dataStart + csize)
    if (method === 0)      out.push({ name, data: raw })
    else if (method === 8) out.push({ name, data: await inflateRaw(raw) })
    else throw new Error(`Unsupported zip compression method ${method}`)
    p = dataStart + csize + ((flags & 0x08) ? 16 : 0)
    // Optional data descriptor may or may not carry the signature; tolerate both.
    if ((flags & 0x08) && p + 4 <= buf.length && dv.getUint32(p - 16, true) !== 0x08074b50) p -= 4
  }
  return out
}

function findCentralEntry(buf: Uint8Array, dv: DataView, name: string): { csize: number } | null {
  // Scan back for the end-of-central-directory record.
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70_000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      let cp = dv.getUint32(i + 16, true)
      while (cp + 46 <= buf.length && dv.getUint32(cp, true) === 0x02014b50) {
        const csize = dv.getUint32(cp + 20, true)
        const nl = dv.getUint16(cp + 28, true), el = dv.getUint16(cp + 30, true), cl = dv.getUint16(cp + 32, true)
        const n = new TextDecoder('utf-8').decode(buf.subarray(cp + 46, cp + 46 + nl))
        if (n === name) return { csize }
        cp += 46 + nl + el + cl
      }
      return null
    }
  }
  return null
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot unzip in-page — drop the _chat.txt instead of the .zip')
  }
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds)
  const ab = await new Response(stream).arrayBuffer()
  return new Uint8Array(ab)
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

export interface RawMessage {
  sentLocal: string   // 'YYYY-MM-DDTHH:MM:SS'
  sender: string
  body: string
}

// iOS: "[27/11/2023, 17:18:42] Sender: body" (optionally prefixed by U+200E)
// Android: "27/11/2023, 17:18 - Sender: body"
const IOS_RE     = /^‎?\[(\d{1,2})\/(\d{1,2})\/(\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s?([AP]M))?\] ([^:]+?): ([\s\S]*)$/
const ANDROID_RE = /^‎?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s?([AP]M|[ap]\.m\.))? - ([^:]+?): ([\s\S]*)$/

const SYSTEM_RE = /^‎?(?:.*\b(added|left|removed|joined|changed the (subject|group|settings)|created (the )?group|turned (on|off)|pinned a message|Messages and calls are end-to-end encrypted|Added You to a Group|security code changed|joined using this group|deleted this group|is a contact)\b)/i
const MEDIA_RE  = /‎?(image|video|audio|sticker|GIF|document|Contact card) omitted|<Media omitted>|\.(pdf|docx?|xlsx?|pptx?) • ‎?\d+ pages? ‎?document omitted/i
const PHONE_RE  = /^‪?\+?\d[\d\s  -]{6,}‬?$/
const DELETED_RE = /^‎?(This message was deleted|You deleted this message)\.?$/i

export interface ParsedExport {
  group: WaGroup
  groupLabel: string | null
  messages: RawMessage[]      // operational messages only (system lines dropped)
  systemLines: number
  format: 'ios' | 'android' | 'unknown'
}

export function detectGroup(label: string | null | undefined, fileName?: string | null): WaGroup {
  const s = `${label ?? ''} ${fileName ?? ''}`.toLowerCase()
  if (/\bnorth\b/.test(s)) return 'north'
  if (/\bsouth\b|london|bedford|critical corridor/.test(s)) return 'south'
  return 'other'
}

export function parseExport(text: string, fileName?: string | null): ParsedExport {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const messages: RawMessage[] = []
  let cur: RawMessage | null = null
  let format: ParsedExport['format'] = 'unknown'
  let systemLines = 0
  let groupLabel: string | null = null

  const flush = () => {
    if (!cur) return
    const body = cur.body.trim()
    if (!body) { cur = null; return }
    if (SYSTEM_RE.test(body) && body.length < 220) { systemLines++; cur = null; return }
    messages.push({ ...cur, body })
    cur = null
  }

  for (const line of lines) {
    let m = IOS_RE.exec(line)
    let fmt: ParsedExport['format'] = 'ios'
    if (!m) { m = ANDROID_RE.exec(line); fmt = 'android' }
    if (m) {
      flush()
      format = fmt
      const [, dd, mm, yyyy, hh, mi, ss, ampm, sender, body] = m
      let hour = parseInt(hh, 10)
      if (ampm) {
        const pm = /p/i.test(ampm)
        if (pm && hour < 12) hour += 12
        if (!pm && hour === 12) hour = 0
      }
      const year = yyyy.length === 2 ? `20${yyyy}` : yyyy
      const sentLocal = `${year}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${mi}:${ss ?? '00'}`
      const rawSender = sender.replace(/^‎/, '').replace(/^~\s? ?/, '').trim()
      // The group's own name appears as the sender of system lines — the
      // first such line tells us which group this export came from.
      if (!groupLabel && /incident advice|state of the route/i.test(rawSender) && SYSTEM_RE.test(body)) groupLabel = rawSender
      cur = { sentLocal, sender: PHONE_RE.test(rawSender) ? 'Unsaved contact' : rawSender, body }
    } else if (cur) {
      cur.body += '\n' + line
    }
  }
  flush()
  return { group: detectGroup(groupLabel, fileName), groupLabel, messages, systemLines, format }
}

// ─── Time helpers ────────────────────────────────────────────────────────────

// Local wall-clock → ms, treating the wall clock as if it were UTC. Used for
// every duration in this module so DST changes never shift a gap.
export function localMs(sentLocal: string): number {
  return Date.parse(sentLocal + 'Z')
}

function lastSunday(year: number, month: number): number {
  const d = new Date(Date.UTC(year, month + 1, 0))
  return d.getUTCDate() - d.getUTCDay()
}

// Europe/London wall clock → true UTC ISO. BST runs from 01:00 UTC on the
// last Sunday of March to 01:00 UTC on the last Sunday of October.
export function londonToUtcIso(sentLocal: string): string {
  const ms = localMs(sentLocal)
  const y = new Date(ms).getUTCFullYear()
  const bstStart = Date.UTC(y, 2, lastSunday(y, 2), 1)
  const bstEnd   = Date.UTC(y, 9, lastSunday(y, 9), 1)
  // Compare the wall clock against the transition instants expressed in wall
  // clock: start is 01:00 GMT (=01:00 wall), end is 02:00 BST wall (=01:00 UTC).
  const isBst = ms >= bstStart && ms < bstEnd + 3_600_000
  return new Date(ms - (isBst ? 3_600_000 : 0)).toISOString()
}

// CCIL incident start as local wall-clock ms. Log days run 06:00–06:00, so a
// time before 06:00 belongs to the calendar day after report_date.
export function incidentStartLocalMs(i: Pick<IncidentRow, 'report_date' | 'incident_start' | 'advised_time'>, field: 'incident_start' | 'advised_time' | 'nwr_time' = 'incident_start', override?: string | null): number | null {
  const hhmm = override ?? (field === 'incident_start' ? i.incident_start : i.advised_time)
  if (!hhmm) return null
  const t = normaliseHHMM(hhmm)
  if (!t) return null
  let ms = localMs(`${i.report_date}T${t}:00`)
  if (t < '06:00') ms += 86_400_000
  return ms
}

export function normaliseHHMM(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = raw.match(/(\d{1,2})[:.]?(\d{2})/)
  if (!m) return null
  const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10)
  if (hh > 23 || mm > 59) return null
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ─── Classification ──────────────────────────────────────────────────────────

const RAG_EMOJI: [string, WaRag][] = [['🔴', 'red'], ['🟠', 'amber'], ['🟡', 'yellow'], ['🟢', 'green']]
const HEADLINE_RE = /\*{1,2}([^*\n]{2,140}?)\*{1,2}/
const GENERIC_HEADLINE_RE = /^(incident (headline|update|alert)|holding message|post[\s-]*incident service recovery|update|correction|current site update|priority plan|milestone plan|command structure|stranded trains?)\b/i
const HEADCODE_RE = /(?:^|[^0-9A-Z])([0-9][A-Z][0-9]{2})(?![0-9A-Z])/g
const NWR_RE = /normal working (has )?(been )?resumed|\bNWR\b|handed back|\bhand ?back\b|lines? (re-?opened|reopened|back open)|back in use|booked in order|\bin order\b(?! to)|rectified|service recovery (complete|commenced)|all lines (now )?open/i
const HOLDING_RE = /holding message|#holding/i
const RECOVERY_RE = /post[\s-]*incident service recovery|service recovery (target|plan|update)|recovery target/i
const CONFERENCE_RE = /conference call (via|on) teams|technical conference|strategic (update|conference)|to join via teams|join the meeting/i
const ADVISORY_RE = /^(⚠️|🟡|🟠)?\s*\*?(forecast|weather|ewat|extreme weather|possession information|working in hot weather|hot weather|heat|cold weather|leaf ?fall|autumn|state of the (nation|route)|route wide (service recovery|update)|route performance|please note|reminder)/i
const OFFROUTE_RE = /off[\s-]*route|sussex (incident|managed|led)|york managed|kent (–|-)|awareness only|(\bgtr\b|\bthameslink\b)[^\n]{0,30}(network|planning)/i

export interface ClassifiedMessage extends RawMessage {
  headline: string | null
  rag: WaRag | null
  headcodes: string[]
  hasMedia: boolean
  isDeleted: boolean
  bodyHash: string
}

export function classifyMessage(m: RawMessage): ClassifiedMessage {
  const b = m.body
  const head = b.slice(0, 8)
  const rag = RAG_EMOJI.find(([e]) => head.includes(e))?.[1] ?? null
  const hm = HEADLINE_RE.exec(b.slice(0, 260))
  const headline = hm ? hm[1].trim() : null
  const hcs = new Set<string>()
  const upper = b.toUpperCase()
  let mm: RegExpExecArray | null
  HEADCODE_RE.lastIndex = 0
  while ((mm = HEADCODE_RE.exec(upper))) hcs.add(mm[1])
  return {
    ...m,
    headline,
    rag,
    headcodes: [...hcs].slice(0, 12),
    hasMedia: MEDIA_RE.test(b),
    isDeleted: DELETED_RE.test(b),
    bodyHash: fnv1a(b),
  }
}

export function normaliseHeadline(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function isGenericHeadline(h: string | null): boolean {
  return !!h && GENERIC_HEADLINE_RE.test(h)
}

// Strip the body down to the message's operational text only (no media tag).
function bodyText(b: string): string {
  return b.replace(MEDIA_RE, '').replace(/‎/g, '').trim()
}

// ─── Threading ───────────────────────────────────────────────────────────────

export interface WaThread {
  key: string
  group: WaGroup
  title: string
  messages: WaMessage[]
  firstLocalMs: number
  lastLocalMs: number
}

const THREAD_REUSE_MS   = 36 * 3_600_000
const GENERIC_ATTACH_MS = 6 * 3_600_000
const FREETEXT_ATTACH_MS = 2 * 3_600_000

// Groups classified messages into chains and assigns kind + thread_key,
// returning WaMessage-shaped rows (ids are filled in later by Supabase, or
// by a local id in demo mode). Must be run over ALL of a group's messages in
// time order so keys are stable across cumulative re-imports: a message's
// chain depends only on what came before it.
export function buildThreads(group: WaGroup, msgs: ClassifiedMessage[], idFor: (m: ClassifiedMessage) => string): { messages: WaMessage[]; threads: WaThread[] } {
  const sorted = [...msgs].sort((a, b) => a.sentLocal.localeCompare(b.sentLocal))
  const threads: WaThread[] = []
  const active = new Map<string, WaThread>()
  let last: WaThread | null = null
  const out: WaMessage[] = []

  for (const m of sorted) {
    const ms = localMs(m.sentLocal)
    const text = bodyText(m.body)
    const mediaOnly = m.hasMedia && text.length === 0
    const generic = isGenericHeadline(m.headline)
    let t: WaThread | null = null
    let kind: WaKind = 'other'

    if (m.headline && !generic && !mediaOnly) {
      const nk = normaliseHeadline(m.headline)
      t = active.get(nk) ?? null
      if (t && ms - t.lastLocalMs > THREAD_REUSE_MS) t = null
      if (!t) {
        t = { key: `${group}|${m.sentLocal}|${nk.slice(0, 60)}`, group, title: m.headline, messages: [], firstLocalMs: ms, lastLocalMs: ms }
        threads.push(t)
        active.set(nk, t)
        kind = 'open'
      } else kind = 'update'
    } else if (m.headline && generic) {
      if (last && ms - last.lastLocalMs < GENERIC_ATTACH_MS) { t = last; kind = 'update' }
      else {
        t = { key: `${group}|${m.sentLocal}|${normaliseHeadline(m.headline).slice(0, 60)}`, group, title: text.split('\n')[0].replace(/\*/g, '').slice(0, 80) || m.headline, messages: [], firstLocalMs: ms, lastLocalMs: ms }
        threads.push(t)
        kind = 'open'
      }
    } else {
      if (last && ms - last.lastLocalMs < FREETEXT_ATTACH_MS) { t = last; kind = mediaOnly ? 'other' : 'update' }
      else {
        // Orphan free text becomes its own single-message chain so nothing
        // is silently dropped; the inbox shows it as unlinked.
        t = { key: `${group}|${m.sentLocal}|${fnv1a(text || m.body)}`, group, title: (text || '(media)').split('\n')[0].slice(0, 80), messages: [], firstLocalMs: ms, lastLocalMs: ms }
        threads.push(t)
        kind = 'other'
      }
    }

    // Refine kind from content — order matters (a closing post that also
    // mentions a conference is still a close).
    const probe = `${m.headline ?? ''}\n${text.slice(0, 400)}`
    if (m.isDeleted) kind = 'other'
    else if (mediaOnly) kind = 'other'
    else if (HOLDING_RE.test(probe)) kind = 'holding'
    else if (RECOVERY_RE.test(probe)) kind = 'recovery'
    else if (m.rag === 'green' || NWR_RE.test(text.slice(0, 500))) kind = 'close'
    else if (CONFERENCE_RE.test(probe) && !m.headline) kind = 'conference'
    else if (kind === 'open' && OFFROUTE_RE.test(probe)) kind = 'offroute'
    else if (kind === 'open' && ADVISORY_RE.test(probe)) kind = 'advisory'
    else if (kind === 'other' && CONFERENCE_RE.test(probe)) kind = 'conference'

    const row: WaMessage = {
      id: idFor(m),
      import_id: null,
      group_name: group,
      sent_at: londonToUtcIso(m.sentLocal),
      sent_local: m.sentLocal,
      sender: m.sender,
      body: m.body,
      body_hash: m.bodyHash,
      headline: m.headline,
      rag: m.rag,
      kind,
      headcodes: m.headcodes,
      thread_key: t.key,
      has_media: m.hasMedia,
      is_deleted: m.isDeleted,
    }
    t.messages.push(row)
    t.lastLocalMs = ms
    last = t
    out.push(row)
  }
  return { messages: out, threads }
}

// Rebuild chains from stored rows (thread_key is persisted), preserving the
// exact grouping the importer produced.
export function threadsFromMessages(msgs: WaMessage[]): WaThread[] {
  const by = new Map<string, WaThread>()
  for (const m of [...msgs].sort((a, b) => a.sent_local.localeCompare(b.sent_local))) {
    const ms = localMs(m.sent_local)
    let t = by.get(m.thread_key)
    if (!t) {
      t = { key: m.thread_key, group: m.group_name, title: m.headline ?? bodyText(m.body).split('\n')[0].slice(0, 80) ?? '(untitled)', messages: [], firstLocalMs: ms, lastLocalMs: ms }
      by.set(m.thread_key, t)
    }
    t.messages.push(m)
    t.lastLocalMs = ms
  }
  return [...by.values()].sort((a, b) => b.firstLocalMs - a.firstLocalMs)
}

// A chain's operational posts — excludes deleted and media-only rows.
export function operationalPosts(t: { messages: WaMessage[] }): WaMessage[] {
  return t.messages.filter(m => !m.is_deleted && bodyText(m.body).length > 0)
}

// ─── Matching chains to CCIL incidents ───────────────────────────────────────

const STOP = new Set('the a an and of at on in to for with between jn junction station line lines up down fast slow main road via no not is are has have been from by this that ll dn area route em nr'.split(' '))

const KEYWORDS: [RegExp, string][] = [
  [/\btcf\b|track circuit|\btc ?\d+|\bsowc\b|\bscwo\b/i, 'track circuit'],
  [/signal(ling)?/i, 'signal'],
  [/\bpoints?\b|\bpts\b/i, 'points'],
  [/\bole\b|overhead|de-?wire|wirement|pantograph|\bohl(e)?\b/i, 'ole'],
  [/flood/i, 'flood'],
  [/trespass/i, 'trespass'],
  [/fatalit|person (struck|hit)|\bfatal\b/i, 'fatality'],
  [/\bfire\b/i, 'fire'],
  [/bridge (strike|struck)|struck (a |the )?bridge/i, 'bridge strike'],
  [/struck|strike|hit (a |an )?(tree|cow|animal|object)/i, 'strike'],
  [/ill passenger|passenger (ill|collapsed|taken ill)|collapsed|medical/i, 'passenger illness'],
  [/rough ride/i, 'rough ride'],
  [/level crossing|\b[a-z]+ ?(ahbc|mcb|aocl|uwc)\b|barrier/i, 'crossing'],
  [/possession|overrun|hand ?back/i, 'possession'],
  [/train describer|\btd\b/i, 'describer'],
  [/landslip|embankment/i, 'landslip'],
  [/\btree\b/i, 'tree'],
  [/\bcows?\b|animal|sheep|horse/i, 'animal'],
  [/loss of power|traction|engine|failed train|unit (fault|failure|issue)|train fault|loss of air|brake/i, 'traction'],
  [/concern for welfare|\bcfw\b|welfare/i, 'welfare'],
  [/broken rail|rail defect|track defect/i, 'rail defect'],
  [/lineside|\bfire\b/i, 'fire'],
]

function tokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const t of s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) if (!STOP.has(t)) out.add(t)
  return out
}
function keywords(s: string): Set<string> {
  const out = new Set<string>()
  for (const [re, k] of KEYWORDS) if (re.test(s)) out.add(k)
  return out
}
function headcodesIn(s: string): Set<string> {
  const out = new Set<string>()
  const u = s.toUpperCase(); let m: RegExpExecArray | null
  HEADCODE_RE.lastIndex = 0
  while ((m = HEADCODE_RE.exec(u))) out.add(m[1])
  return out
}

export interface MatchCandidate {
  incident: IncidentRow
  score: number
  why: string[]
  lagMins: number | null   // first post minus CCIL start (positive = post after start)
}

export interface ThreadMatch {
  thread: WaThread
  best: MatchCandidate | null
  runnerUp: MatchCandidate | null
  confidence: 'confident' | 'ambiguous' | 'none'
}

export const MATCH_CONFIDENT_SCORE = 4
export const MATCH_AMBIGUOUS_SCORE = 2.5
const MATCH_MIN_LAG_MS = -2 * 3_600_000
const MATCH_MAX_LAG_MS = 30 * 3_600_000

// Index incidents by calendar day so a chain only scores the incidents that
// could plausibly be its partner.
export function indexIncidentsByDay(incidents: IncidentRow[]): Map<string, IncidentRow[]> {
  const idx = new Map<string, IncidentRow[]>()
  for (const i of incidents) {
    if (i.is_continuation) continue
    const arr = idx.get(i.report_date) ?? []
    arr.push(i)
    idx.set(i.report_date, arr)
  }
  return idx
}

function dayKey(ms: number): string { return new Date(ms).toISOString().slice(0, 10) }
function shiftDay(key: string, d: number): string { return dayKey(localMs(`${key}T12:00:00`) + d * 86_400_000) }

export function incidentSearchText(i: IncidentRow): string {
  return [i.title, i.location, i.incident_type_label, i.fault_number, i.line].filter(Boolean).join(' ')
}

export function scoreThreadAgainst(thread: WaThread, i: IncidentRow): MatchCandidate | null {
  const posts = operationalPosts(thread)
  if (!posts.length) return null
  const first = posts[0]
  const firstMs = localMs(first.sent_local)
  const startMs = incidentStartLocalMs(i) ?? incidentStartLocalMs(i, 'advised_time')
  if (startMs == null) return null
  const lag = firstMs - startMs
  if (lag < MATCH_MIN_LAG_MS || lag > MATCH_MAX_LAG_MS) return null

  const chainText = posts.slice(0, 3).map(m => m.body).join('\n')
  const incText = incidentSearchText(i)
  let score = 0
  const why: string[] = []

  const hc = [...headcodesIn(`${thread.title} ${chainText}`)].filter(h => headcodesIn(incText).has(h))
  if (hc.length) { score += 5; why.push(`headcode ${hc.join(', ')}`) }

  const tt = tokens(thread.title), it = tokens(incText)
  const shared = [...tt].filter(t => it.has(t))
  if (shared.length) { score += Math.min(3, shared.length); why.push(`words ${shared.slice(0, 4).join(', ')}`) }

  // Gazetteer: the chain's headline and the incident location resolving to
  // the same place is strong evidence even when the wording differs.
  const g1 = geocodeLocation(thread.title) ?? geocodeLocation(chainText.slice(0, 300))
  const g2 = geocodeLocation(i.location) ?? geocodeLocation(i.title)
  if (g1 && g2 && g1.label === g2.label) { score += 2; why.push(`place ${g1.label}`) }

  const kw = [...keywords(`${thread.title}\n${chainText.slice(0, 500)}`)].filter(k => keywords(incText).has(k))
  if (kw.length) { score += 1.5; why.push(`type ${kw[0]}`) }

  const areas = WA_GROUP_AREAS[thread.group]
  if (!i.area || areas.length === 0) { /* unknown area: neutral */ }
  else if (areas.includes(i.area)) score += 0.5
  else score -= 1

  if (lag >= 0 && lag <= 6 * 3_600_000) { score += 1; why.push('same shift') }

  return { incident: i, score, why, lagMins: Math.round(lag / 60_000) }
}

export function matchThread(thread: WaThread, byDay: Map<string, IncidentRow[]>): ThreadMatch {
  const posts = operationalPosts(thread)
  const none: ThreadMatch = { thread, best: null, runnerUp: null, confidence: 'none' }
  if (!posts.length) return none
  // A chain that is plainly not an incident never gets an automatic link.
  const k0 = posts[0].kind
  if (k0 === 'advisory' || k0 === 'conference' || k0 === 'offroute') return none

  const d0 = dayKey(localMs(posts[0].sent_local))
  const cands: MatchCandidate[] = []
  for (const d of [shiftDay(d0, -2), shiftDay(d0, -1), d0, shiftDay(d0, 1)]) {
    for (const i of byDay.get(d) ?? []) {
      const c = scoreThreadAgainst(thread, i)
      if (c && c.score > 0) cands.push(c)
    }
  }
  cands.sort((a, b) => b.score - a.score)
  const best = cands[0] ?? null
  const runnerUp = cands[1] ?? null
  if (!best) return none
  const margin = best.score - (runnerUp?.score ?? 0)
  const confidence = best.score >= MATCH_CONFIDENT_SCORE && margin >= 1.5 ? 'confident'
    : best.score >= MATCH_AMBIGUOUS_SCORE ? 'ambiguous' : 'none'
  return { thread, best, runnerUp, confidence }
}

// ─── Scoring against the standard ────────────────────────────────────────────

export interface ContentFlags {
  location: boolean
  headcode: boolean
  headcodeWithOD: boolean
  impact: boolean
  response: boolean
  command: boolean
  stranded: boolean
  plan: boolean
  passenger: boolean
  recoveryTarget: boolean
  closeTime: boolean
  firstTrain: boolean
}

export const CONTENT_FLAG_LABELS: Record<keyof ContentFlags, string> = {
  location:       'Location',
  headcode:       'Train / asset ID',
  headcodeWithOD: 'Headcode with origin–destination',
  impact:         'Service impact',
  response:       'Response / ETA',
  command:        'Command structure',
  stranded:       'Stranded trains',
  plan:           'Priority / milestone plan',
  passenger:      'Passenger impact',
  recoveryTarget: 'Service recovery target',
  closeTime:      'In-order / NWR time stated',
  firstTrain:     'First train to run',
}

// Technical abbreviations the standard asks authors to spell out. Terms every
// recipient of these groups reads daily (MOM, REC, S&T, ITSR) are not counted.
const ABBR_RE = /\b(SOWC|SCWO|TCF|WSTCF|OOC|TDA|PSBT|CFW|ESR|TSR|ECS|STRA|PIDD|DSF|TCA|VCB|GSMR|OTM|HOBC|TMS|TRUST|IBJ|TDM|FSP|PSP)\b/
const HC_OD_RE = /\b[0-9][A-Z][0-9]{2}\b[^\n]{0,50}\b(to|–|-)\s+[A-Z][a-z]/

export function contentFlags(posts: WaMessage[]): ContentFlags {
  const all = posts.map(m => bodyText(m.body)).join('\n')
  const first = posts[0] ? bodyText(posts[0].body) : ''
  const closing = posts.filter(m => m.kind === 'close' || m.kind === 'recovery').map(m => bodyText(m.body)).join('\n')
  return {
    location:       !!(geocodeLocation(first.slice(0, 400)) || /\b(between|at|near)\b [A-Z][a-z]+/.test(first)),
    headcode:       /\b[0-9][A-Z][0-9]{2}\b|\b\d{2,4}\s?(pts|points|tc|signal)\b|\b[A-Z]{1,3}\d{2,4}\b/i.test(first),
    headcodeWithOD: HC_OD_RE.test(first),
    impact:         /impact|service group|services? (affected|suspended|divert|cancel|terminat)|contingency|unable to run|blocked|caution/i.test(all),
    response:       /\bETA\b|en route|on site|attending|response staff|mobilis|dispatched/i.test(all),
    command:        /command structure|\b(TPIC|RIO|strategic commander|silver|gold|bronze)\b/i.test(all),
    stranded:       /stranded|stood at|at a stand|trapped/i.test(all),
    plan:           /priority plan|milestone/i.test(all),
    passenger:      /passenger|ticket acceptance|rail replacement|\bbus(es)?\b|unable to call|terminat|crowd/i.test(all),
    recoveryTarget: /recovery (target|expected|complete|by)|service recovery|expected to be (completed|complete)|recovery (time|plan)/i.test(all),
    closeTime:      /((in order|rectified|normal working resumed|handed back|reopened|restored)[^\n]{0,40}\d{1,2}[:.]?\d{2})|(\d{1,2}[:.]?\d{2}[^\n]{0,40}(in order|rectified|normal working resumed|handed back|reopened|restored))/i.test(closing || all),
    firstTrain:     /first train|first (service|one) (to run|through)|first (up|down) (train|service)/i.test(all),
  }
}

export interface CommsScore {
  incidentId: string
  incident: IncidentRow
  group: WaGroup
  threadKeys: string[]
  posts: WaMessage[]           // union of all linked chains, time-ordered
  postCount: number
  senders: string[]
  severe: boolean              // proxy for BLACK/RED
  cadenceTargetMins: number
  firstPostLagMins: number | null     // vs advised_time ?? incident_start
  firstUpdateGapMins: number | null   // between post 1 and post 2
  gaps: number[]
  pctGapsWithinTarget: number | null
  maxGapMins: number | null
  rapidFireCount: number
  hasHolding: boolean
  hasClose: boolean
  closeLagVsNwrMins: number | null
  abbreviationsInFirst: boolean
  titleFormatOk: boolean
  flags: ContentFlags
  completeness: number         // 0..1
  score: number                // 0..100
  grade: 'A' | 'B' | 'C' | 'D'
  parts: { timeliness: number; completeness: number; closure: number }
}

export function isSevereIncident(i: IncidentRow): boolean {
  return i.severity === 'CRITICAL' || i.severity === 'HIGH' || effectiveDelay(i) >= STANDARD.severeDelayMins
}

// The incidents Control would be expected to message. The standard says
// RED/BLACK; neither source records that category, so the tab lets the user
// choose the proxy: a delay threshold, or CCIL's own highlight flag.
export type NotableRule = 'delay300' | 'delay500' | 'delay1000' | 'highlight'
export const NOTABLE_RULE_LABELS: Record<NotableRule, string> = {
  delay300:  '≥ 300 min or HIGH/CRITICAL',
  delay500:  '≥ 500 min or HIGH/CRITICAL',
  delay1000: '≥ 1,000 min or CRITICAL',
  highlight: 'CCIL highlight flag',
}
export function isNotableIncident(i: IncidentRow, rule: NotableRule = 'delay500'): boolean {
  if (i.is_continuation || i.is_off_route) return false
  const d = effectiveDelay(i)
  switch (rule) {
    case 'delay300':  return d >= 300  || i.severity === 'HIGH' || i.severity === 'CRITICAL'
    case 'delay500':  return d >= 500  || i.severity === 'HIGH' || i.severity === 'CRITICAL'
    case 'delay1000': return d >= 1000 || i.severity === 'CRITICAL'
    case 'highlight': return !!i.is_highlight
  }
}

export function scoreIncidentComms(incident: IncidentRow, threads: WaThread[]): CommsScore {
  const posts = threads.flatMap(operationalPosts).sort((a, b) => a.sent_local.localeCompare(b.sent_local))
  const group = threads[0]?.group ?? 'other'
  const severe = isSevereIncident(incident)
  const cadenceTargetMins = severe ? STANDARD.cadenceRedMins : STANDARD.cadenceAmberMins
  const startMs = incidentStartLocalMs(incident, 'advised_time') ?? incidentStartLocalMs(incident)
  const firstMs = posts[0] ? localMs(posts[0].sent_local) : null
  const firstPostLagMins = startMs != null && firstMs != null ? Math.round((firstMs - startMs) / 60_000) : null
  const gaps: number[] = []
  for (let k = 1; k < posts.length; k++) gaps.push(Math.round((localMs(posts[k].sent_local) - localMs(posts[k - 1].sent_local)) / 60_000))
  const firstUpdateGapMins = gaps[0] ?? null
  const pctGapsWithinTarget = gaps.length ? gaps.filter(g => g <= cadenceTargetMins).length / gaps.length : null
  const maxGapMins = gaps.length ? Math.max(...gaps) : null
  const rapidFireCount = gaps.filter(g => g < STANDARD.rapidFireMins).length
  const hasHolding = posts.some(m => m.kind === 'holding')
  const closes = posts.filter(m => m.kind === 'close' || m.kind === 'recovery')
  const hasClose = closes.length > 0
  const nwrMs = incidentStartLocalMs(incident, 'nwr_time', incident.nwr_time)
  const closeLagVsNwrMins = hasClose && nwrMs != null ? Math.round((localMs(closes[closes.length - 1].sent_local) - nwrMs) / 60_000) : null
  const firstText = posts[0] ? bodyText(posts[0].body) : ''
  const abbreviationsInFirst = ABBR_RE.test(firstText)
  const titleFormatOk = /east midlands route\s*(green|amber|red|black)\s*incident\s*:/i.test(firstText) || /off[\s-]*route incident advice/i.test(firstText)
  const flags = contentFlags(posts)

  // Completeness — the sections the standard asks for. Stranded-train and
  // first-train detail are only "applicable" when the chain suggests them,
  // so they are excluded from the denominator unless present.
  const core: (keyof ContentFlags)[] = ['location', 'headcode', 'impact', 'response', 'command', 'plan', 'passenger', 'recoveryTarget', 'closeTime']
  const optional: (keyof ContentFlags)[] = ['stranded', 'firstTrain', 'headcodeWithOD']
  const present = core.filter(k => flags[k]).length + optional.filter(k => flags[k]).length
  const denom = core.length + optional.filter(k => flags[k]).length
  const completeness = denom ? present / denom : 0

  // Score: timeliness 40, completeness 40, closure 20.
  let timeliness = 0
  if (firstPostLagMins != null) {
    const l = firstPostLagMins
    timeliness += l <= STANDARD.holdingMins ? 20 : l <= 30 ? 12 : l <= 60 ? 6 : 0
  } else timeliness += 6
  if (firstUpdateGapMins != null) timeliness += firstUpdateGapMins <= STANDARD.firstDetailMins ? 10 : firstUpdateGapMins <= 45 ? 5 : 0
  timeliness += Math.round((pctGapsWithinTarget ?? 0.5) * 10)
  const completenessPts = Math.round(completeness * 40)
  let closure = 0
  if (hasClose) {
    closure += 12
    if (closeLagVsNwrMins == null) closure += 6
    else if (Math.abs(closeLagVsNwrMins) <= STANDARD.closeLagMins) closure += 8
    else if (Math.abs(closeLagVsNwrMins) <= 120) closure += 4
  }
  const score = Math.max(0, Math.min(100, timeliness + completenessPts + closure))
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D'

  return {
    incidentId: incident.id, incident, group, threadKeys: threads.map(t => t.key), posts, postCount: posts.length,
    senders: [...new Set(posts.map(p => p.sender))], severe, cadenceTargetMins,
    firstPostLagMins, firstUpdateGapMins, gaps, pctGapsWithinTarget, maxGapMins, rapidFireCount,
    hasHolding, hasClose, closeLagVsNwrMins, abbreviationsInFirst, titleFormatOk, flags, completeness, score, grade,
    parts: { timeliness, completeness: completenessPts, closure },
  }
}

// ─── Assembling the picture for a window ─────────────────────────────────────

export interface WaPicture {
  scores: CommsScore[]                       // one per linked incident
  scoreByIncident: Map<string, CommsScore>
  threadsByIncident: Map<string, WaThread[]>
  linkedThreadKeys: Set<string>
  unlinked: WaThread[]                       // chains with no active link
  notable: IncidentRow[]                     // incidents that should have comms
  notableSilent: IncidentRow[]               // notable incidents with no chain
  coverage: number | null                    // notable with comms / notable
}

// Active links = auto or confirmed (rejected are kept only to suppress re-proposal).
export function activeLinks(links: WaThreadLink[]): WaThreadLink[] {
  return links.filter(l => l.status !== 'rejected')
}

export function assemblePicture(incidents: IncidentRow[], threads: WaThread[], links: WaThreadLink[], groups: WaGroup[], rule: NotableRule = 'delay500'): WaPicture {
  const incById = new Map(incidents.map(i => [i.id, i]))
  const threadByKey = new Map(threads.map(t => [t.key, t]))
  const threadsByIncident = new Map<string, WaThread[]>()
  const linkedThreadKeys = new Set<string>()
  for (const l of activeLinks(links)) {
    const t = threadByKey.get(l.thread_key)
    const i = incById.get(l.incident_id)
    if (!t || !i) continue
    if (!groups.includes(t.group)) continue
    linkedThreadKeys.add(t.key)
    const arr = threadsByIncident.get(i.id) ?? []
    if (!arr.includes(t)) arr.push(t)
    threadsByIncident.set(i.id, arr)
  }
  const scores: CommsScore[] = []
  for (const [id, ts] of threadsByIncident) scores.push(scoreIncidentComms(incById.get(id)!, ts))
  scores.sort((a, b) => (b.incident.report_date + (b.incident.incident_start ?? '')).localeCompare(a.incident.report_date + (a.incident.incident_start ?? '')))
  const scoreByIncident = new Map(scores.map(s => [s.incidentId, s]))
  const unlinked = threads.filter(t => groups.includes(t.group) && !linkedThreadKeys.has(t.key))
  const groupAreas = new Set(groups.flatMap(g => WA_GROUP_AREAS[g]))
  const notable = incidents.filter(i => isNotableIncident(i, rule) && (!i.area || groupAreas.size === 0 || groupAreas.has(i.area)))
  const notableSilent = notable.filter(i => !scoreByIncident.has(i.id))
  const coverage = notable.length ? (notable.length - notableSilent.length) / notable.length : null
  return { scores, scoreByIncident, threadsByIncident, linkedThreadKeys, unlinked, notable, notableSilent, coverage }
}

// ─── KPIs and trends ─────────────────────────────────────────────────────────

export interface WaKpis {
  linkedIncidents: number
  notable: number
  coverage: number | null
  medianFirstPostMins: number | null
  pctFirstPostWithin10: number | null
  pctFirstUpdateWithin20: number | null
  pctGapsWithinTarget: number | null
  pctWithClose: number | null
  medianCloseLagMins: number | null
  meanScore: number | null
  meanCompleteness: number | null
  pctAbbreviations: number | null
  posts: number
}

export function median(nums: number[]): number | null {
  const v = nums.filter(n => Number.isFinite(n)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}
function pct(num: number, den: number): number | null { return den ? num / den : null }
function mean(nums: number[]): number | null { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null }

export function computeKpis(p: WaPicture): WaKpis {
  const s = p.scores
  const lags = s.map(x => x.firstPostLagMins).filter((x): x is number => x != null)
  const fu = s.map(x => x.firstUpdateGapMins).filter((x): x is number => x != null)
  const allGaps = s.flatMap(x => x.gaps.map(g => [g, x.cadenceTargetMins] as const))
  const closeLags = s.map(x => x.closeLagVsNwrMins).filter((x): x is number => x != null)
  return {
    linkedIncidents: s.length,
    notable: p.notable.length,
    coverage: p.coverage,
    medianFirstPostMins: median(lags),
    pctFirstPostWithin10: pct(lags.filter(l => l <= STANDARD.holdingMins).length, lags.length),
    pctFirstUpdateWithin20: pct(fu.filter(g => g <= STANDARD.firstDetailMins).length, fu.length),
    pctGapsWithinTarget: pct(allGaps.filter(([g, t]) => g <= t).length, allGaps.length),
    pctWithClose: pct(s.filter(x => x.hasClose).length, s.length),
    medianCloseLagMins: median(closeLags),
    meanScore: mean(s.map(x => x.score)),
    meanCompleteness: mean(s.map(x => x.completeness)),
    pctAbbreviations: pct(s.filter(x => x.abbreviationsInFirst).length, s.length),
    posts: s.reduce((n, x) => n + x.postCount, 0),
  }
}

export interface WaTrendPoint {
  key: string            // 'YYYY-MM'
  label: string
  linked: number
  notable: number
  coverage: number | null
  medianFirstPostMins: number | null
  meanScore: number | null
  pctWithClose: number | null
  pctGapsWithinTarget: number | null
  posts: number
}

export function computeTrend(p: WaPicture): WaTrendPoint[] {
  const buckets = new Map<string, { scores: CommsScore[]; notable: number; covered: number; posts: number }>()
  const get = (k: string) => {
    let b = buckets.get(k)
    if (!b) { b = { scores: [], notable: 0, covered: 0, posts: 0 }; buckets.set(k, b) }
    return b
  }
  for (const s of p.scores) { const b = get(s.incident.report_date.slice(0, 7)); b.scores.push(s); b.posts += s.postCount }
  for (const i of p.notable) { const b = get(i.report_date.slice(0, 7)); b.notable++; if (p.scoreByIncident.has(i.id)) b.covered++ }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, b]) => {
    const lags = b.scores.map(x => x.firstPostLagMins).filter((x): x is number => x != null)
    const gaps = b.scores.flatMap(x => x.gaps.map(g => [g, x.cadenceTargetMins] as const))
    const d = new Date(key + '-01T00:00:00Z')
    return {
      key,
      label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
      linked: b.scores.length,
      notable: b.notable,
      coverage: pct(b.covered, b.notable),
      medianFirstPostMins: median(lags),
      meanScore: mean(b.scores.map(x => x.score)),
      pctWithClose: pct(b.scores.filter(x => x.hasClose).length, b.scores.length),
      pctGapsWithinTarget: pct(gaps.filter(([g, t]) => g <= t).length, gaps.length),
      posts: b.posts,
    }
  })
}

// ─── Monitoring flags ────────────────────────────────────────────────────────

export type WaFlagKind = 'silent' | 'late-first' | 'no-close' | 'stale-gap' | 'rapid-fire' | 'ambiguous'

export interface WaFlag {
  kind: WaFlagKind
  severity: 'red' | 'amber'
  incident: IncidentRow | null
  thread: WaThread | null
  detail: string
}

export const WA_FLAG_LABELS: Record<WaFlagKind, string> = {
  'silent':     'Notable incident with no WhatsApp post',
  'late-first': 'First post outside 30 min',
  'no-close':   'No closure post',
  'stale-gap':  'Update gap over twice the cadence target',
  'rapid-fire': 'Updates in quick succession',
  'ambiguous':  'Chain linked with low confidence',
}

export function computeFlags(p: WaPicture, matches: Map<string, ThreadMatch>): WaFlag[] {
  const out: WaFlag[] = []
  for (const i of p.notableSilent) out.push({ kind: 'silent', severity: 'red', incident: i, thread: null, detail: `${effectiveDelay(i)}m delay, ${i.severity}` })
  for (const s of p.scores) {
    if (s.firstPostLagMins != null && s.firstPostLagMins > 30) out.push({ kind: 'late-first', severity: s.firstPostLagMins > 60 ? 'red' : 'amber', incident: s.incident, thread: null, detail: `first post ${s.firstPostLagMins} min after Control was advised` })
    if (!s.hasClose && s.postCount >= 2) out.push({ kind: 'no-close', severity: 'amber', incident: s.incident, thread: null, detail: `${s.postCount} posts, none confirms normal working` })
    if (s.maxGapMins != null && s.maxGapMins > s.cadenceTargetMins * 2) out.push({ kind: 'stale-gap', severity: 'amber', incident: s.incident, thread: null, detail: `longest gap ${s.maxGapMins} min against a ${s.cadenceTargetMins} min target` })
    if (s.rapidFireCount >= 2) out.push({ kind: 'rapid-fire', severity: 'amber', incident: s.incident, thread: null, detail: `${s.rapidFireCount} updates under ${STANDARD.rapidFireMins} min apart` })
  }
  for (const [, m] of matches) {
    if (m.confidence === 'ambiguous' && m.best && p.linkedThreadKeys.has(m.thread.key)) {
      out.push({ kind: 'ambiguous', severity: 'amber', incident: m.best.incident, thread: m.thread, detail: `score ${m.best.score.toFixed(1)}${m.runnerUp ? ` vs ${m.runnerUp.score.toFixed(1)}` : ''}` })
    }
  }
  const rank = { red: 0, amber: 1 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.incident?.report_date ?? '').localeCompare(a.incident?.report_date ?? ''))
}

// ─── Merged timeline (CCIL events + WhatsApp posts) ──────────────────────────

export interface TimelineItem {
  ms: number
  time: string          // HH:MM
  date: string          // YYYY-MM-DD
  source: 'ccil' | 'whatsapp'
  text: string
  meta: string | null   // company / sender
  rag: WaRag | null
  kind: WaKind | null
}

export function mergedTimeline(incident: IncidentRow, posts: WaMessage[]): TimelineItem[] {
  const items: TimelineItem[] = []
  for (const e of incident.events ?? []) {
    const t = normaliseHHMM(e.time)
    // Event dates are 'DD/MM'; fall back to the report date, applying the
    // 06:00 log-day rule when only a time is known.
    let date = incident.report_date
    const dm = e.date?.match(/(\d{1,2})\/(\d{1,2})/)
    if (dm) date = `${incident.report_date.slice(0, 4)}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`
    else if (t && t < '06:00') date = dayKey(localMs(`${date}T12:00:00`) + 86_400_000)
    const ms = t ? localMs(`${date}T${t}:00`) : localMs(`${date}T00:00:00`)
    items.push({ ms, time: t ?? '—', date, source: 'ccil', text: e.description ?? '', meta: e.company ?? null, rag: null, kind: null })
  }
  for (const m of posts) {
    const ms = localMs(m.sent_local)
    items.push({ ms, time: m.sent_local.slice(11, 16), date: m.sent_local.slice(0, 10), source: 'whatsapp', text: bodyText(m.body), meta: m.sender, rag: m.rag, kind: m.kind })
  }
  return items.sort((a, b) => a.ms - b.ms)
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function scoresToCsv(scores: CommsScore[]): string {
  const cols = ['report_date', 'incident_start', 'ccil', 'title', 'location', 'area', 'severity', 'delay_mins', 'group', 'posts', 'first_post_lag_mins', 'first_update_gap_mins', 'pct_gaps_within_target', 'max_gap_mins', 'has_holding', 'has_close', 'close_lag_vs_nwr_mins', 'completeness', 'abbreviations_in_first', 'score', 'grade']
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const rows = scores.map(s => [
    s.incident.report_date, s.incident.incident_start, s.incident.ccil, s.incident.title, s.incident.location, s.incident.area, s.incident.severity, effectiveDelay(s.incident),
    s.group, s.postCount, s.firstPostLagMins, s.firstUpdateGapMins, s.pctGapsWithinTarget == null ? '' : Math.round(s.pctGapsWithinTarget * 100), s.maxGapMins,
    s.hasHolding, s.hasClose, s.closeLagVsNwrMins, Math.round(s.completeness * 100), s.abbreviationsInFirst, s.score, s.grade,
  ].map(esc).join(','))
  return [cols.join(','), ...rows].join('\n')
}

// Render *bold* WhatsApp markup as segments for the UI.
export function boldSegments(text: string): { bold: boolean; text: string }[] {
  const out: { bold: boolean; text: string }[] = []
  const re = /\*([^*\n]+)\*/g
  let last = 0; let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ bold: false, text: text.slice(last, m.index) })
    out.push({ bold: true, text: m[1] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ bold: false, text: text.slice(last) })
  return out
}

export { bodyText as messageText }

// ─── Attribution to the SNDM on shift ────────────────────────────────────────
// The standard makes the SNDM accountable for WhatsApp incident messaging.
// Since March 2025 posts come from the shared "SNDM Derby" account, so the
// sender cannot identify the person; instead the incident is attributed to
// the SNDM DLog2 recorded on duty for that log day and shift. The shift is
// chosen from the time of the first WhatsApp post (day 06:00–18:00, night
// otherwise, the EMCC 12-hour pattern). Before the role account existed the
// poster's own name is used when no roster row exists.

export const DAY_SHIFT_START = 6   // 06:00 inclusive
export const DAY_SHIFT_END   = 18  // 18:00 exclusive

export const SNDM_ROLE_ACCOUNT = /^sndm derby$/i
const SNDM_ROLE_RE = /\bsndm\b/i
const PLACEHOLDER_NAME_RE = /^(uncovered|vacancy|u\/c|tbc|n\/a|none|-+|=+|\?+)$/i
export const UNATTRIBUTED = 'Unattributed'

export interface RosterRow { incident_id: string; report_date: string; name: string; role: string; shift: 'day' | 'night' }

export function normaliseStaffName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim()
  if (!n || PLACEHOLDER_NAME_RE.test(n)) return 'Uncovered'
  return n
}

export function shiftForLocal(sentLocal: string): 'day' | 'night' {
  const h = parseInt(sentLocal.slice(11, 13), 10)
  return h >= DAY_SHIFT_START && h < DAY_SHIFT_END ? 'day' : 'night'
}

export interface SndmAttribution {
  name: string
  source: 'roster' | 'sender' | 'none'
  shift: 'day' | 'night' | null
}

// Roster index: incident id → SNDM rows.
export function indexRoster(rows: RosterRow[]): Map<string, RosterRow[]> {
  const m = new Map<string, RosterRow[]>()
  for (const r of rows) {
    if (!SNDM_ROLE_RE.test(r.role)) continue
    const arr = m.get(r.incident_id) ?? []
    arr.push(r)
    m.set(r.incident_id, arr)
  }
  return m
}

export function attributeSndm(s: CommsScore, roster: Map<string, RosterRow[]>): SndmAttribution {
  const first = s.posts[0]
  const shift = first ? shiftForLocal(first.sent_local) : null
  const rows = roster.get(s.incidentId) ?? []
  if (rows.length) {
    const onShift = rows.filter(r => shift == null || r.shift === shift)
    const pick = (onShift.length ? onShift : rows)[0]
    return { name: normaliseStaffName(pick.name), source: 'roster', shift }
  }
  if (first && !SNDM_ROLE_ACCOUNT.test(first.sender) && first.sender !== 'Unsaved contact' && first.sender !== 'Control Mob') {
    return { name: normaliseStaffName(first.sender), source: 'sender', shift }
  }
  return { name: UNATTRIBUTED, source: 'none', shift }
}

export interface SndmStats {
  name: string
  incidents: number
  dayIncidents: number
  nightIncidents: number
  fromRoster: number
  meanScore: number | null
  grades: Record<'A' | 'B' | 'C' | 'D', number>
  medianFirstPostMins: number | null
  pctFirstPostWithin10: number | null
  pctFirstUpdateWithin20: number | null
  pctGapsWithinTarget: number | null
  pctWithClose: number | null
  meanCompleteness: number | null
  posts: number
  scores: CommsScore[]
}

// Roster spellings drift ("Brad Garner" / "Bradley Garner"). Names sharing a
// surname whose forenames are prefixes of each other are merged under the
// longest spelling. Two different people with the same surname and a shared
// forename prefix would merge too; that is accepted and visible in the table.
export function canonicaliseNames(names: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const parts = (n: string) => { const t = n.toLowerCase().split(' '); return { first: t[0] ?? '', last: t[t.length - 1] ?? '' } }
  for (const n of names) {
    let best = n
    for (const m of names) {
      if (m === n) continue
      const a = parts(n), b = parts(m)
      if (a.last === b.last && a.first && b.first && (b.first.startsWith(a.first) || a.first.startsWith(b.first)) && m.length > best.length) best = m
    }
    out.set(n, best)
  }
  return out
}

export function computeSndmStats(scores: CommsScore[], roster: Map<string, RosterRow[]>): { stats: SndmStats[]; byIncident: Map<string, SndmAttribution> } {
  const byIncident = new Map<string, SndmAttribution>()
  const groups = new Map<string, CommsScore[]>()
  const meta = new Map<string, { day: number; night: number; roster: number }>()
  const raw = scores.map(s => attributeSndm(s, roster))
  const canon = canonicaliseNames([...new Set(raw.map(a => a.name))])
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]
    const a = { ...raw[i], name: canon.get(raw[i].name) ?? raw[i].name }
    byIncident.set(s.incidentId, a)
    const arr = groups.get(a.name) ?? []
    arr.push(s); groups.set(a.name, arr)
    const m = meta.get(a.name) ?? { day: 0, night: 0, roster: 0 }
    if (a.shift === 'day') m.day++; else if (a.shift === 'night') m.night++
    if (a.source === 'roster') m.roster++
    meta.set(a.name, m)
  }
  const stats: SndmStats[] = []
  for (const [name, ss] of groups) {
    const lags = ss.map(x => x.firstPostLagMins).filter((x): x is number => x != null)
    const fu = ss.map(x => x.firstUpdateGapMins).filter((x): x is number => x != null)
    const gaps = ss.flatMap(x => x.gaps.map(g => [g, x.cadenceTargetMins] as const))
    const grades = { A: 0, B: 0, C: 0, D: 0 }
    for (const x of ss) grades[x.grade]++
    const m = meta.get(name)!
    stats.push({
      name, incidents: ss.length, dayIncidents: m.day, nightIncidents: m.night, fromRoster: m.roster,
      meanScore: mean(ss.map(x => x.score)), grades,
      medianFirstPostMins: median(lags),
      pctFirstPostWithin10: pct(lags.filter(l => l <= STANDARD.holdingMins).length, lags.length),
      pctFirstUpdateWithin20: pct(fu.filter(g => g <= STANDARD.firstDetailMins).length, fu.length),
      pctGapsWithinTarget: pct(gaps.filter(([g, t]) => g <= t).length, gaps.length),
      pctWithClose: pct(ss.filter(x => x.hasClose).length, ss.length),
      meanCompleteness: mean(ss.map(x => x.completeness)),
      posts: ss.reduce((n, x) => n + x.postCount, 0),
      scores: ss,
    })
  }
  stats.sort((a, b) => b.incidents - a.incidents)
  return { stats, byIncident }
}

export type SndmTrendMetric = 'meanScore' | 'medianFirstPostMins' | 'pctWithClose' | 'pctGapsWithinTarget'
export const SNDM_TREND_METRIC_LABELS: Record<SndmTrendMetric, string> = {
  meanScore: 'Mean score',
  medianFirstPostMins: 'Median first post (min)',
  pctWithClose: 'Closed with NWR post %',
  pctGapsWithinTarget: 'Updates within cadence %',
}

// Monthly series per SNDM: [{ key, label, <name>: value, ... }]
export function computeSndmTrend(stats: SndmStats[], metric: SndmTrendMetric, names: string[]): Record<string, string | number | null>[] {
  const months = new Map<string, Record<string, string | number | null>>()
  for (const st of stats) {
    if (!names.includes(st.name)) continue
    const byMonth = new Map<string, CommsScore[]>()
    for (const s of st.scores) { const k = s.incident.report_date.slice(0, 7); const arr = byMonth.get(k) ?? []; arr.push(s); byMonth.set(k, arr) }
    for (const [k, ss] of byMonth) {
      let row = months.get(k)
      if (!row) { row = { key: k, label: new Date(k + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }) }; months.set(k, row) }
      let v: number | null = null
      if (metric === 'meanScore') v = mean(ss.map(x => x.score))
      else if (metric === 'medianFirstPostMins') v = median(ss.map(x => x.firstPostLagMins).filter((x): x is number => x != null))
      else if (metric === 'pctWithClose') { const p = pct(ss.filter(x => x.hasClose).length, ss.length); v = p == null ? null : p * 100 }
      else { const gaps = ss.flatMap(x => x.gaps.map(g => [g, x.cadenceTargetMins] as const)); const p = pct(gaps.filter(([g, t]) => g <= t).length, gaps.length); v = p == null ? null : p * 100 }
      row[st.name] = v == null ? null : Math.round(v * 10) / 10
      row[`${st.name}__n`] = ss.length
    }
  }
  return [...months.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)))
}
