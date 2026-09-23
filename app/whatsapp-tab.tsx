'use client'

import { useCallback, useEffect, useMemo, useRef, useState, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  MessageSquare, Upload, Loader2, X, Link2, CheckCircle2, XCircle, AlertTriangle,
  Download, Trash2, Search, Clock, FileText, Inbox, Activity, ListChecks,
} from 'lucide-react'
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { IncidentRow, IncidentEvent, WaGroup, WaImport, WaMessage, WaThreadLink, CATEGORY_CONFIG } from '@/lib/types'
import {
  effectiveDelay, fetchIncidentEvents, fetchIncidentsLeanForRange,
  fetchWaMessages, fetchWaLinks, fetchWaImports, upsertWaMessages, insertWaAutoLinks,
  insertWaImport, updateWaImportCounts, setWaLink, deleteWaLink, deleteWaGroupData,
} from '@/lib/queries'
import { isSupabaseConfigured } from '@/lib/supabase'
import { parseEventSignals } from '@/lib/eventParser'
import {
  readExportFile, parseExport, classifyMessage, buildThreads, threadsFromMessages, operationalPosts,
  indexIncidentsByDay, matchThread, scoreThreadAgainst, assemblePicture, computeKpis, computeTrend, computeFlags,
  mergedTimeline, scoresToCsv, boldSegments, messageText, localMs,
  WA_GROUP_LABELS, STANDARD, CONTENT_FLAG_LABELS, WA_FLAG_LABELS, NOTABLE_RULE_LABELS,
  ClassifiedMessage, WaThread, ThreadMatch, CommsScore, WaFlag, NotableRule, WaPicture, ContentFlags,
} from '@/lib/whatsapp'

// ─── Config ──────────────────────────────────────────────────────────────────

const AUTHOR_STORAGE_KEY = 'insight-author'
type Section = 'scorecard' | 'incidents' | 'inbox' | 'monitoring' | 'imports'
const SECTIONS: { id: Section; label: string; icon: typeof Activity }[] = [
  { id: 'scorecard',  label: 'Scorecard',  icon: Activity },
  { id: 'incidents',  label: 'Incidents',  icon: ListChecks },
  { id: 'inbox',      label: 'Unlinked chains', icon: Inbox },
  { id: 'monitoring', label: 'Monitoring', icon: AlertTriangle },
  { id: 'imports',    label: 'Imports',    icon: Upload },
]

const RAG_COLOR: Record<string, string> = {
  red: 'var(--nr-red)', amber: 'var(--nr-orange)', yellow: 'var(--nr-amber)', green: 'var(--nr-green)',
}
const KIND_LABEL: Record<string, string> = {
  open: 'Open', update: 'Update', holding: 'Holding', recovery: 'Recovery', close: 'Close',
  conference: 'Conference', advisory: 'Advisory', offroute: 'Off route', other: '—',
}
const GRADE_COLOR: Record<string, string> = { A: 'var(--nr-green)', B: 'var(--nr-blue)', C: 'var(--nr-amber)', D: 'var(--nr-red)' }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtMins(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return '—'
  const a = Math.abs(m)
  const s = a >= 120 ? `${(a / 60).toFixed(1)}h` : `${Math.round(a)}m`
  return m < 0 ? `−${s}` : s
}
function fmtPct(p: number | null | undefined): string {
  return p == null ? '—' : `${Math.round(p * 100)}%`
}
function fmtLocal(sentLocal: string): string {
  const d = new Date(sentLocal + 'Z')
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
}
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function loadStoredAuthor(): string {
  if (typeof window === 'undefined') return ''
  try { return localStorage.getItem(AUTHOR_STORAGE_KEY) ?? '' } catch { return '' }
}
function storeAuthor(a: string) {
  try { localStorage.setItem(AUTHOR_STORAGE_KEY, a) } catch { /* private mode */ }
}
function incidentLabel(i: IncidentRow): string {
  return `${i.report_date}${i.incident_start ? ' ' + i.incident_start.slice(0, 5) : ''} · ${i.title ?? '—'}${i.location ? ' @ ' + i.location : ''}`
}
let localSeq = 0
const localId = () => `local-${Date.now().toString(36)}-${(localSeq++).toString(36)}`

// Bring stored rows back to the classifier's shape so a re-import can rebuild
// chains over the union of old and new messages with stable keys.
function toClassified(m: WaMessage): ClassifiedMessage {
  return {
    sentLocal: m.sent_local, sender: m.sender, body: m.body, headline: m.headline, rag: m.rag,
    headcodes: m.headcodes, hasMedia: m.has_media, isDeleted: m.is_deleted, bodyHash: m.body_hash,
  }
}

// ─── WhatsAppTab ─────────────────────────────────────────────────────────────

export function WhatsAppTab({ incidents, windowFrom, windowTo, demoMode, canWrite }: {
  incidents: IncidentRow[]
  windowFrom: string
  windowTo: string
  demoMode: boolean
  canWrite: boolean
}) {
  const live = isSupabaseConfigured() && !demoMode

  const [section,   setSection]   = useState<Section>('scorecard')
  const [messages,  setMessages]  = useState<WaMessage[]>([])
  const [links,     setLinks]     = useState<WaThreadLink[]>([])
  const [imports,   setImports]   = useState<WaImport[]>([])
  const [rangeIncidents, setRangeIncidents] = useState<IncidentRow[]>([])
  const [loadedRange, setLoadedRange] = useState<{ from: string; to: string } | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [groups,    setGroups]    = useState<WaGroup[]>(['north', 'south'])
  const [scope,     setScope]     = useState<'window' | 'all'>('all')
  const [rule,      setRule]      = useState<NotableRule>('delay500')
  const [author,    setAuthor]    = useState('')

  const [busy,      setBusy]      = useState<string | null>(null)   // import progress text
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [importErr, setImportErr] = useState<string | null>(null)
  const [dragOver,  setDragOver]  = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [openIncidentId, setOpenIncidentId] = useState<string | null>(null)
  const [openThreadKey,  setOpenThreadKey]  = useState<string | null>(null)

  useEffect(() => { setAuthor(loadStoredAuthor()) }, [])

  // ── Load persisted data once ────────────────────────────────────────────────
  useEffect(() => {
    if (!live) return
    let cancelled = false
    setLoading(true)
    Promise.all([fetchWaMessages(), fetchWaLinks(), fetchWaImports()])
      .then(([m, l, im]) => { if (cancelled) return; setMessages(m); setLinks(l); setImports(im) })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load WhatsApp data') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [live])

  // Incidents spanning every stored message (lean, no events). In demo mode
  // the dashboard's synthetic rows stand in.
  const msgRange = useMemo(() => {
    if (!messages.length) return null
    let lo = messages[0].sent_local, hi = messages[0].sent_local
    for (const m of messages) { if (m.sent_local < lo) lo = m.sent_local; if (m.sent_local > hi) hi = m.sent_local }
    return { from: lo.slice(0, 10), to: hi.slice(0, 10) }
  }, [messages])

  useEffect(() => {
    if (!live) { setRangeIncidents(incidents); return }
    if (!msgRange) return
    if (loadedRange && loadedRange.from <= msgRange.from && loadedRange.to >= msgRange.to) return
    const from = loadedRange ? (loadedRange.from < msgRange.from ? loadedRange.from : msgRange.from) : msgRange.from
    const to   = loadedRange ? (loadedRange.to > msgRange.to ? loadedRange.to : msgRange.to) : msgRange.to
    let cancelled = false
    fetchIncidentsLeanForRange(from, to)
      .then(rows => { if (cancelled) return; setRangeIncidents(rows); setLoadedRange({ from, to }) })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load incidents for linking') })
    return () => { cancelled = true }
  }, [live, msgRange, loadedRange, incidents])

  // ── Derived picture ─────────────────────────────────────────────────────────
  const allThreads = useMemo(() => threadsFromMessages(messages), [messages])
  const byDay = useMemo(() => indexIncidentsByDay(rangeIncidents), [rangeIncidents])
  const matches = useMemo(() => {
    const out = new Map<string, ThreadMatch>()
    for (const t of allThreads) out.set(t.key, matchThread(t, byDay))
    return out
  }, [allThreads, byDay])

  const scopedIncidents = useMemo(() =>
    scope === 'window' ? rangeIncidents.filter(i => i.report_date >= windowFrom && i.report_date <= windowTo) : rangeIncidents,
    [scope, rangeIncidents, windowFrom, windowTo])
  const scopedThreads = useMemo(() => {
    if (scope !== 'window') return allThreads
    const lo = localMs(`${windowFrom}T00:00:00`), hi = localMs(`${windowTo}T23:59:59`) + 6 * 3_600_000
    return allThreads.filter(t => t.firstLocalMs >= lo && t.firstLocalMs <= hi)
  }, [scope, allThreads, windowFrom, windowTo])

  const picture = useMemo(() => assemblePicture(scopedIncidents, scopedThreads, links, groups, rule), [scopedIncidents, scopedThreads, links, groups, rule])
  const kpis  = useMemo(() => computeKpis(picture), [picture])
  const trend = useMemo(() => computeTrend(picture), [picture])
  const flags = useMemo(() => computeFlags(picture, matches), [picture, matches])
  const incidentById = useMemo(() => new Map(rangeIncidents.map(i => [i.id, i])), [rangeIncidents])
  const threadByKey = useMemo(() => new Map(allThreads.map(t => [t.key, t])), [allThreads])

  // ── Import pipeline ─────────────────────────────────────────────────────────
  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setImportErr(null); setImportMsg(null)
    const list = Array.from(files)
    if (!list.length) return
    const summary: string[] = []
    try {
      let currentMessages = messages
      let currentLinks = links
      let currentIncidents = rangeIncidents
      for (const file of list) {
        setBusy(`Reading ${file.name}…`)
        const ex = await readExportFile(file)
        const parsed = parseExport(ex.text, ex.fileName)
        if (!parsed.messages.length) throw new Error(`${file.name}: no messages recognised — is this a WhatsApp chat export?`)
        const group = parsed.group
        setBusy(`Parsing ${parsed.messages.length.toLocaleString()} messages from ${WA_GROUP_LABELS[group]}…`)

        // Union with what is already stored for this group, rebuild chains.
        const existing = currentMessages.filter(m => m.group_name === group)
        const existingByKey = new Map(existing.map(m => [`${m.sent_local}|${m.sender}|${m.body_hash}`, m]))
        const fresh = parsed.messages.map(classifyMessage)
        const union = new Map<string, ClassifiedMessage>()
        for (const m of existing) union.set(`${m.sent_local}|${m.sender}|${m.body_hash}`, toClassified(m))
        let newCount = 0
        for (const m of fresh) { const k = `${m.sentLocal}|${m.sender}|${m.bodyHash}`; if (!union.has(k)) newCount++; union.set(k, m) }
        const built = buildThreads(group, [...union.values()], m => existingByKey.get(`${m.sentLocal}|${m.sender}|${m.bodyHash}`)?.id ?? localId())

        let importId: string | null = null
        let rows = built.messages
        if (live) {
          setBusy(`Saving ${newCount.toLocaleString()} new messages…`)
          const im = await insertWaImport({
            group_name: group, group_label: parsed.groupLabel, file_name: ex.fileName, file_sha256: ex.sha256,
            first_msg_at: built.messages[0]?.sent_at ?? null, last_msg_at: built.messages[built.messages.length - 1]?.sent_at ?? null,
            message_count: parsed.messages.length, new_count: 0, imported_by: author.trim() || null,
          })
          importId = im?.id ?? null
          const { inserted, ids } = await upsertWaMessages(built.messages.map(({ id: _id, ...r }) => r), importId)
          rows = built.messages.map(m => ({ ...m, id: ids.get(`${m.group_name}|${m.sent_local}|${m.sender}|${m.body_hash}`) ?? m.id }))
          if (importId) await updateWaImportCounts(importId, { message_count: parsed.messages.length, new_count: inserted })
          newCount = inserted
          if (im) setImports(prev => [{ ...im, new_count: inserted }, ...prev])
        } else {
          setImports(prev => [{
            id: localId(), group_name: group, group_label: parsed.groupLabel, file_name: ex.fileName, file_sha256: ex.sha256,
            first_msg_at: rows[0]?.sent_at ?? null, last_msg_at: rows[rows.length - 1]?.sent_at ?? null,
            message_count: parsed.messages.length, new_count: newCount, imported_by: author.trim() || null, imported_at: new Date().toISOString(),
          }, ...prev])
        }
        currentMessages = [...currentMessages.filter(m => m.group_name !== group), ...rows]

        // Incidents to link against — widen the loaded range if needed.
        const lo = rows[0]?.sent_local.slice(0, 10), hi = rows[rows.length - 1]?.sent_local.slice(0, 10)
        if (live && lo && hi && (!loadedRange || loadedRange.from > lo || loadedRange.to < hi)) {
          setBusy('Loading CCIL incidents for linking…')
          const from = loadedRange && loadedRange.from < lo ? loadedRange.from : lo
          const to = loadedRange && loadedRange.to > hi ? loadedRange.to : hi
          currentIncidents = await fetchIncidentsLeanForRange(from, to)
          setRangeIncidents(currentIncidents); setLoadedRange({ from, to })
        }

        // Auto-link chains that have no decision yet.
        setBusy('Linking chains to CCIL incidents…')
        const decided = new Set(currentLinks.filter(l => l.group_name === group).map(l => l.thread_key))
        const idx = indexIncidentsByDay(currentIncidents)
        const proposals: Omit<WaThreadLink, 'id' | 'decided_by' | 'decided_at'>[] = []
        let confident = 0, ambiguous = 0
        for (const t of built.threads) {
          if (decided.has(t.key)) continue
          const m = matchThread(t, idx)
          if (m.confidence === 'none' || !m.best) continue
          if (m.confidence === 'confident') confident++; else ambiguous++
          proposals.push({ group_name: group, thread_key: t.key, incident_id: m.best.incident.id, ccil: m.best.incident.ccil, score: Math.round(m.best.score * 10) / 10, method: 'auto', status: 'auto' })
        }
        let saved: WaThreadLink[]
        if (live) saved = await insertWaAutoLinks(proposals)
        else saved = proposals.map(p => ({ ...p, id: localId(), decided_by: null, decided_at: null }))
        currentLinks = [...currentLinks, ...saved]
        summary.push(`${WA_GROUP_LABELS[group]}: ${parsed.messages.length.toLocaleString()} messages read, ${newCount.toLocaleString()} new, ${built.threads.length.toLocaleString()} chains, ${confident} linked confidently + ${ambiguous} for review`)
      }
      setMessages(currentMessages)
      setLinks(currentLinks)
      setImportMsg(summary.join(' · '))
      if (author.trim()) storeAuthor(author.trim())
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      setImportErr(msg.trim() ? `Import failed — ${msg}` : 'Import failed')
    } finally {
      setBusy(null)
    }
  }, [messages, links, rangeIncidents, loadedRange, live, author])

  // ── Link actions ────────────────────────────────────────────────────────────
  const decideLink = useCallback(async (l: WaThreadLink, status: 'confirmed' | 'rejected') => {
    const by = author.trim() || null
    try {
      if (live) {
        const saved = await setWaLink(l.group_name, l.thread_key, l.incident_id, l.ccil, status, by, l.score)
        if (saved) setLinks(prev => prev.map(x => x.id === l.id ? saved : x))
      } else {
        setLinks(prev => prev.map(x => x.id === l.id ? { ...x, status, method: 'manual', decided_by: by, decided_at: new Date().toISOString() } : x))
      }
      if (by) storeAuthor(by)
    } catch (e) { setImportErr(e instanceof Error ? e.message : 'Failed to update link') }
  }, [author, live])

  const linkThread = useCallback(async (t: WaThread, i: IncidentRow) => {
    const by = author.trim() || null
    const c = scoreThreadAgainst(t, i)
    try {
      if (live) {
        const saved = await setWaLink(t.group, t.key, i.id, i.ccil, 'confirmed', by, c ? Math.round(c.score * 10) / 10 : null)
        if (saved) setLinks(prev => [...prev.filter(x => !(x.thread_key === t.key && x.incident_id === i.id)), saved])
      } else {
        setLinks(prev => [...prev.filter(x => !(x.thread_key === t.key && x.incident_id === i.id)), {
          id: localId(), group_name: t.group, thread_key: t.key, incident_id: i.id, ccil: i.ccil, score: c?.score ?? null,
          method: 'manual', status: 'confirmed', decided_by: by, decided_at: new Date().toISOString(),
        }])
      }
      if (by) storeAuthor(by)
    } catch (e) { setImportErr(e instanceof Error ? e.message : 'Failed to link chain') }
  }, [author, live])

  const unlink = useCallback(async (l: WaThreadLink) => {
    try {
      if (live) await deleteWaLink(l.id)
      setLinks(prev => prev.filter(x => x.id !== l.id))
    } catch (e) { setImportErr(e instanceof Error ? e.message : 'Failed to remove link') }
  }, [live])

  const clearGroup = useCallback(async (g: WaGroup) => {
    if (typeof window !== 'undefined' && !window.confirm(`Delete every stored message and link for ${WA_GROUP_LABELS[g]}? Import history is kept.`)) return
    try {
      if (live) await deleteWaGroupData(g)
      setMessages(prev => prev.filter(m => m.group_name !== g))
      setLinks(prev => prev.filter(l => l.group_name !== g))
    } catch (e) { setImportErr(e instanceof Error ? e.message : 'Failed to delete group data') }
  }, [live])

  const exportCsv = useCallback(() => {
    const csv = scoresToCsv(picture.scores)
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `whatsapp-comms-scores-${scope === 'window' ? `${windowFrom}_${windowTo}` : 'all'}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, [picture, scope, windowFrom, windowTo])

  // ── Render ──────────────────────────────────────────────────────────────────
  const openIncident = openIncidentId ? incidentById.get(openIncidentId) ?? null : null
  const openThread = openThreadKey ? threadByKey.get(openThreadKey) ?? null : null

  return (
    <div className="space-y-6 animate-fade-up">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="serif text-2xl font-medium flex items-center gap-2" style={{ color: 'var(--ink-100)' }}>
            <MessageSquare size={20} style={{ color: 'var(--nr-green)' }} /> WhatsApp incident advice
          </h2>
          <p className="text-xs mt-1 max-w-3xl" style={{ color: 'var(--ink-400)' }}>
            Drop the EM North / EM South group exports below. Messages are chained on their headline, linked to CCIL
            incidents by time and content, and each linked incident is scored against the EM Control Messaging Standard
            (holding message within {STANDARD.holdingMins} min, first detail within {STANDARD.firstDetailMins} min,
            updates every {STANDARD.cadenceRedMins}/{STANDARD.cadenceAmberMins} min, mandated content, closure).
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <GroupToggle groups={groups} setGroups={setGroups} counts={countByGroup(messages)} />
          <select className="btn text-[11px]" value={scope} onChange={e => setScope(e.target.value as 'window' | 'all')}>
            <option value="all">All imported dates</option>
            <option value="window">Dashboard window</option>
          </select>
          <select className="btn text-[11px]" value={rule} onChange={e => setRule(e.target.value as NotableRule)} title="Which incidents count as needing WhatsApp comms (proxy for RED/BLACK)">
            {(Object.keys(NOTABLE_RULE_LABELS) as NotableRule[]).map(k => <option key={k} value={k}>Notable: {NOTABLE_RULE_LABELS[k]}</option>)}
          </select>
          <button className="btn text-[11px] flex items-center gap-1" onClick={exportCsv} disabled={!picture.scores.length}><Download size={12} /> CSV</button>
        </div>
      </div>

      {loadError && <Banner tone="red" text={loadError} />}
      {!live && <Banner tone="amber" text={demoMode ? 'Demo mode — imports stay in this browser session and link against synthetic incidents.' : 'Supabase is not configured — imports stay in this browser session.'} />}
      {live && !canWrite && <Banner tone="amber" text="Read-only: imports and link decisions will not be saved." />}

      {/* Drop zone */}
      <div
        className={`card p-6 border-dashed transition-colors ${dragOver ? '!border-[var(--nr-green)]' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); if (!busy) void handleFiles(e.dataTransfer.files) }}
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            {busy ? <Loader2 size={18} className="animate-spin" style={{ color: 'var(--nr-green)' }} /> : <Upload size={18} style={{ color: 'var(--ink-400)' }} />}
            <div>
              <div className="text-sm font-medium" style={{ color: 'var(--ink-200)' }}>{busy ?? 'Drop WhatsApp exports here'}</div>
              <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>
                The .zip WhatsApp produces, or its _chat.txt. Both groups at once is fine. Re-dropping a newer export only adds what is new.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              className="btn text-[11px] w-24" placeholder="Initials" value={author} onChange={e => setAuthor(e.target.value)}
              title="Recorded against imports and link decisions"
            />
            <button className="btn text-[11px]" onClick={() => fileRef.current?.click()} disabled={!!busy}>Choose files</button>
            <input ref={fileRef} type="file" accept=".zip,.txt" multiple className="hidden" onChange={e => { if (e.target.files) void handleFiles(e.target.files); e.target.value = '' }} />
          </div>
        </div>
        {importMsg && <div className="text-[11px] mt-3" style={{ color: 'var(--nr-green)' }}>{importMsg}</div>}
        {importErr && <div className="text-[11px] mt-3" style={{ color: 'var(--nr-red)' }}>{importErr}</div>}
      </div>

      {loading && <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-400)' }}><Loader2 size={12} className="animate-spin" /> Loading stored messages…</div>}

      {messages.length === 0 && !loading ? (
        <div className="card p-10 text-center">
          <MessageSquare size={28} className="mx-auto mb-3" style={{ color: 'var(--ink-500)' }} />
          <div className="text-sm" style={{ color: 'var(--ink-300)' }}>No messages imported yet.</div>
          <div className="text-[11px] mt-1" style={{ color: 'var(--ink-500)' }}>Export a group from WhatsApp (More › Export chat › Without media) and drop the file above.</div>
        </div>
      ) : (
        <>
          {/* Section nav */}
          <div className="flex items-center gap-1 flex-wrap">
            {SECTIONS.map(s => {
              const count = s.id === 'inbox' ? picture.unlinked.filter(t => isInboxWorthy(t)).length
                : s.id === 'monitoring' ? flags.length
                : s.id === 'incidents' ? picture.scores.length
                : s.id === 'imports' ? imports.length : null
              return (
                <button key={s.id} className={`tab flex items-center gap-2 ${section === s.id ? 'tab-active' : ''}`} onClick={() => setSection(s.id)}>
                  <s.icon size={12} /> {s.label}
                  {count != null && <span className="numeric-mono text-[9px]" style={{ color: 'var(--ink-500)' }}>{count}</span>}
                </button>
              )
            })}
          </div>

          {section === 'scorecard'  && <Scorecard kpis={kpis} trend={trend} picture={picture} rule={rule} />}
          {section === 'incidents'  && <IncidentTable picture={picture} onOpen={setOpenIncidentId} />}
          {section === 'inbox'      && <UnlinkedInbox picture={picture} matches={matches} incidents={scopedIncidents} onOpenThread={setOpenThreadKey} onLink={linkThread} canWrite={canWrite || !live} />}
          {section === 'monitoring' && <Monitoring flags={flags} onOpen={setOpenIncidentId} onOpenThread={setOpenThreadKey} />}
          {section === 'imports'    && <Imports imports={imports} messages={messages} onClear={clearGroup} canWrite={canWrite || !live} />}
        </>
      )}

      {openIncident && (
        <IncidentCommsModal
          incident={openIncident}
          score={picture.scoreByIncident.get(openIncident.id) ?? null}
          links={links.filter(l => l.incident_id === openIncident.id)}
          threadByKey={threadByKey}
          live={live}
          canWrite={canWrite || !live}
          onDecide={decideLink}
          onUnlink={unlink}
          onClose={() => setOpenIncidentId(null)}
        />
      )}
      {openThread && !openIncident && (
        <ThreadModal
          thread={openThread}
          match={matches.get(openThread.key) ?? null}
          links={links.filter(l => l.thread_key === openThread.key)}
          incidents={scopedIncidents}
          incidentById={incidentById}
          canWrite={canWrite || !live}
          onLink={linkThread}
          onUnlink={unlink}
          onOpenIncident={id => { setOpenThreadKey(null); setOpenIncidentId(id) }}
          onClose={() => setOpenThreadKey(null)}
        />
      )}
    </div>
  )
}

function countByGroup(msgs: WaMessage[]): Record<WaGroup, number> {
  const c: Record<WaGroup, number> = { north: 0, south: 0, other: 0 }
  for (const m of msgs) c[m.group_name]++
  return c
}

function isInboxWorthy(t: WaThread): boolean {
  const posts = operationalPosts(t)
  if (!posts.length) return false
  const k = posts[0].kind
  return k !== 'advisory' && k !== 'conference' && k !== 'offroute' && !(k === 'other' && posts.length === 1)
}

// ─── Small pieces ────────────────────────────────────────────────────────────

// Modals portal to <body>: the tab root animates with a transform, which
// would otherwise turn position:fixed into position-relative-to-the-tab.
function Portal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}

function Banner({ tone, text }: { tone: 'red' | 'amber'; text: string }) {
  const c = tone === 'red' ? 'var(--nr-red)' : 'var(--nr-amber)'
  return (
    <div className="text-[11px] px-3 py-2 rounded flex items-center gap-2" style={{ background: `${c}15`, border: `1px solid ${c}50`, color: c }}>
      <AlertTriangle size={12} /> {text}
    </div>
  )
}

function GroupToggle({ groups, setGroups, counts }: { groups: WaGroup[]; setGroups: (g: WaGroup[]) => void; counts: Record<WaGroup, number> }) {
  const toggle = (g: WaGroup) => setGroups(groups.includes(g) ? groups.filter(x => x !== g) : [...groups, g])
  return (
    <div className="flex items-center gap-1">
      {(['north', 'south'] as WaGroup[]).map(g => (
        <button key={g} className={`btn text-[11px] ${groups.includes(g) ? 'btn-active' : ''}`} onClick={() => toggle(g)}>
          {g === 'north' ? 'EM North' : 'EM South'} <span className="numeric-mono text-[9px] ml-1" style={{ color: 'var(--ink-500)' }}>{counts[g]}</span>
        </button>
      ))}
    </div>
  )
}

function Tile({ label, value, sub, tone, target }: { label: string; value: string; sub?: string; tone?: string; target?: string }) {
  return (
    <div className="card p-4">
      <div className="label-micro">{label}</div>
      <div className="numeric text-2xl mt-1" style={{ color: tone ?? 'var(--ink-100)' }}>{value}</div>
      {(sub || target) && (
        <div className="text-[10px] mt-1 flex items-center justify-between gap-2" style={{ color: 'var(--ink-500)' }}>
          <span>{sub}</span>{target && <span className="numeric-mono">target {target}</span>}
        </div>
      )}
    </div>
  )
}

function toneFor(v: number | null, good: number, ok: number, higherIsBetter = true): string {
  if (v == null) return 'var(--ink-300)'
  const g = higherIsBetter ? v >= good : v <= good
  const o = higherIsBetter ? v >= ok : v <= ok
  return g ? 'var(--nr-green)' : o ? 'var(--nr-amber)' : 'var(--nr-red)'
}

function GradePill({ grade, score }: { grade: string; score: number }) {
  const c = GRADE_COLOR[grade]
  return <span className="pill numeric-mono" style={{ background: `${c}20`, color: c, borderColor: `${c}60` }}>{grade} · {score}</span>
}

// ─── Scorecard ───────────────────────────────────────────────────────────────

function Scorecard({ kpis, trend, picture, rule }: { kpis: ReturnType<typeof computeKpis>; trend: ReturnType<typeof computeTrend>; picture: WaPicture; rule: NotableRule }) {
  const gradeDist = useMemo(() => {
    const d: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 }
    for (const s of picture.scores) d[s.grade]++
    return d
  }, [picture])
  const flagCoverage = useMemo(() => {
    const keys = Object.keys(CONTENT_FLAG_LABELS) as (keyof ContentFlags)[]
    return keys.map(k => ({ key: k, label: CONTENT_FLAG_LABELS[k], pct: picture.scores.length ? picture.scores.filter(s => s.flags[k]).length / picture.scores.length : null }))
  }, [picture])
  const bySender = useMemo(() => {
    const c = new Map<string, number>()
    for (const s of picture.scores) for (const p of s.posts) c.set(p.sender, (c.get(p.sender) ?? 0) + 1)
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [picture])

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
        <Tile label="Notable incidents covered" value={fmtPct(kpis.coverage)} sub={`${kpis.linkedIncidents} linked of ${kpis.notable} (${NOTABLE_RULE_LABELS[rule]})`} tone={toneFor(kpis.coverage, 0.8, 0.5)} />
        <Tile label="Median time to first post" value={fmtMins(kpis.medianFirstPostMins)} sub={`${fmtPct(kpis.pctFirstPostWithin10)} within ${STANDARD.holdingMins} min`} tone={toneFor(kpis.medianFirstPostMins, 10, 30, false)} target={`${STANDARD.holdingMins}m`} />
        <Tile label="First detail within 20 min" value={fmtPct(kpis.pctFirstUpdateWithin20)} sub="gap between post 1 and post 2" tone={toneFor(kpis.pctFirstUpdateWithin20, 0.8, 0.5)} target="100%" />
        <Tile label="Updates within cadence" value={fmtPct(kpis.pctGapsWithinTarget)} sub={`${STANDARD.cadenceRedMins} min severe · ${STANDARD.cadenceAmberMins} min otherwise`} tone={toneFor(kpis.pctGapsWithinTarget, 0.8, 0.6)} target="100%" />
        <Tile label="Closed with NWR post" value={fmtPct(kpis.pctWithClose)} sub={`median ${fmtMins(kpis.medianCloseLagMins)} after CCIL NWR`} tone={toneFor(kpis.pctWithClose, 0.8, 0.6)} target="100%" />
        <Tile label="Mean comms score" value={kpis.meanScore == null ? '—' : String(Math.round(kpis.meanScore))} sub={`A ${gradeDist.A} · B ${gradeDist.B} · C ${gradeDist.C} · D ${gradeDist.D}`} tone={toneFor(kpis.meanScore, 80, 60)} target="≥ 85" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="card p-4 xl:col-span-2">
          <div className="flex items-center justify-between mb-2">
            <div className="label-micro">Trend by month</div>
            <div className="text-[10px]" style={{ color: 'var(--ink-500)' }}>bars: linked incidents · lines: median first post (min), mean score</div>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={trend} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }} />
              <YAxis yAxisId="n" axisLine={false} tickLine={false} width={30} tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }} />
              <YAxis yAxisId="v" orientation="right" axisLine={false} tickLine={false} width={34} tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }} />
              <Tooltip content={<TrendTip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
              <Legend wrapperStyle={{ fontSize: 10, color: 'var(--ink-400)' }} />
              <Bar yAxisId="n" dataKey="linked" name="Linked incidents" fill="var(--nr-green)" fillOpacity={0.45} radius={[2, 2, 0, 0]} />
              <Bar yAxisId="n" dataKey="notable" name="Notable incidents" fill="var(--ink-500)" fillOpacity={0.25} radius={[2, 2, 0, 0]} />
              <Line yAxisId="v" type="monotone" dataKey="medianFirstPostMins" name="Median first post (min)" stroke="var(--nr-orange)" strokeWidth={2} dot={{ r: 2 }} connectNulls />
              <Line yAxisId="v" type="monotone" dataKey="meanScore" name="Mean score" stroke="var(--nr-blue)" strokeWidth={2} dot={{ r: 2 }} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="card p-4">
          <div className="label-micro mb-2">Content against the standard</div>
          <div className="text-[10px] mb-3" style={{ color: 'var(--ink-500)' }}>Share of linked incidents whose posts contain each mandated element</div>
          <div className="space-y-1.5">
            {flagCoverage.map(f => (
              <div key={f.key} className="flex items-center gap-2 text-[11px]">
                <span className="w-44 truncate" style={{ color: 'var(--ink-300)' }}>{f.label}</span>
                <div className="flex-1 h-1.5 rounded overflow-hidden" style={{ background: 'var(--bg-elev)' }}>
                  <div className="h-full" style={{ width: `${(f.pct ?? 0) * 100}%`, background: toneFor(f.pct, 0.8, 0.5) }} />
                </div>
                <span className="numeric-mono w-9 text-right" style={{ color: 'var(--ink-400)' }}>{fmtPct(f.pct)}</span>
              </div>
            ))}
          </div>
          <div className="text-[10px] mt-3 pt-3 border-t border-[var(--line)] flex items-center justify-between" style={{ color: 'var(--ink-500)' }}>
            <span>Technical abbreviations in first post</span>
            <span className="numeric-mono" style={{ color: toneFor(kpis.pctAbbreviations, 0.2, 0.5, false) }}>{fmtPct(kpis.pctAbbreviations)}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="label-micro mb-2">Coverage and closure by month</div>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={trend.map(t => ({ ...t, coveragePct: t.coverage == null ? null : Math.round(t.coverage * 100), closePct: t.pctWithClose == null ? null : Math.round(t.pctWithClose * 100), cadencePct: t.pctGapsWithinTarget == null ? null : Math.round(t.pctGapsWithinTarget * 100) }))} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }} />
              <YAxis domain={[0, 100]} axisLine={false} tickLine={false} width={30} tick={{ fontSize: 9, fill: 'var(--ink-500)', fontFamily: 'JetBrains Mono, monospace' }} />
              <Tooltip content={<TrendTip />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
              <Legend wrapperStyle={{ fontSize: 10, color: 'var(--ink-400)' }} />
              <Line type="monotone" dataKey="coveragePct" name="Notable covered %" stroke="var(--nr-green)" strokeWidth={2} dot={{ r: 2 }} connectNulls />
              <Line type="monotone" dataKey="closePct" name="Closed with NWR post %" stroke="var(--nr-blue)" strokeWidth={2} dot={{ r: 2 }} connectNulls />
              <Line type="monotone" dataKey="cadencePct" name="Updates within cadence %" stroke="var(--nr-amber)" strokeWidth={2} dot={{ r: 2 }} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="card p-4">
          <div className="label-micro mb-2">Who posts on linked incidents</div>
          <div className="space-y-1.5">
            {bySender.map(([s, n]) => (
              <div key={s} className="flex items-center gap-2 text-[11px]">
                <span className="w-40 truncate" style={{ color: 'var(--ink-300)' }}>{s}</span>
                <div className="flex-1 h-1.5 rounded overflow-hidden" style={{ background: 'var(--bg-elev)' }}>
                  <div className="h-full" style={{ width: `${(n / (bySender[0]?.[1] ?? 1)) * 100}%`, background: 'var(--nr-green)' }} />
                </div>
                <span className="numeric-mono w-10 text-right" style={{ color: 'var(--ink-400)' }}>{n}</span>
              </div>
            ))}
            {!bySender.length && <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>No linked incidents in scope.</div>}
          </div>
          <div className="text-[10px] mt-3 pt-3 border-t border-[var(--line)]" style={{ color: 'var(--ink-500)' }}>
            {kpis.posts.toLocaleString()} posts across {kpis.linkedIncidents} linked incidents · {picture.unlinked.filter(isInboxWorthy).length} chains still unlinked
          </div>
        </div>
      </div>
    </div>
  )
}

function TrendTip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number | null; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="recharts-default-tooltip text-[11px] p-2" style={{ background: 'var(--bg-panel)', border: '1px solid var(--line-hi)' }}>
      <div className="label-micro mb-1">{label}</div>
      {payload.map(p => p.value != null && (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span style={{ color: p.color }}>{p.name}</span><span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{Math.round(p.value * 10) / 10}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Incident table ──────────────────────────────────────────────────────────

type SortKey = 'date' | 'score' | 'lag' | 'posts' | 'delay'

function IncidentTable({ picture, onOpen }: { picture: WaPicture; onOpen: (id: string) => void }) {
  const [sort, setSort] = useState<SortKey>('date')
  const [q, setQ] = useState('')
  const [showSilent, setShowSilent] = useState(true)
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase()
    const s = picture.scores.filter(x => !t || `${x.incident.title} ${x.incident.location} ${x.incident.ccil}`.toLowerCase().includes(t))
    const cmp: Record<SortKey, (a: CommsScore, b: CommsScore) => number> = {
      date:  (a, b) => (b.incident.report_date + (b.incident.incident_start ?? '')).localeCompare(a.incident.report_date + (a.incident.incident_start ?? '')),
      score: (a, b) => a.score - b.score,
      lag:   (a, b) => (b.firstPostLagMins ?? -1) - (a.firstPostLagMins ?? -1),
      posts: (a, b) => b.postCount - a.postCount,
      delay: (a, b) => effectiveDelay(b.incident) - effectiveDelay(a.incident),
    }
    return [...s].sort(cmp[sort])
  }, [picture, sort, q])
  const silent = useMemo(() => {
    const t = q.trim().toLowerCase()
    return picture.notableSilent.filter(i => !t || `${i.title} ${i.location} ${i.ccil}`.toLowerCase().includes(t))
  }, [picture, q])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-2" style={{ color: 'var(--ink-500)' }} />
          <input className="btn text-[11px] pl-7 w-64" placeholder="Filter by title, location, CCIL" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <select className="btn text-[11px]" value={sort} onChange={e => setSort(e.target.value as SortKey)}>
          <option value="date">Newest first</option>
          <option value="score">Lowest score first</option>
          <option value="lag">Slowest first post</option>
          <option value="posts">Most posts</option>
          <option value="delay">Largest delay</option>
        </select>
        <label className="text-[11px] flex items-center gap-1" style={{ color: 'var(--ink-400)' }}>
          <input type="checkbox" checked={showSilent} onChange={e => setShowSilent(e.target.checked)} /> show notable incidents with no posts ({picture.notableSilent.length})
        </label>
      </div>
      <div className="card overflow-hidden">
        <div className="grid grid-cols-12 gap-2 px-3 py-2 label-micro border-b border-[var(--line)]">
          <div className="col-span-4">Incident</div>
          <div className="col-span-1 text-right">Delay</div>
          <div className="col-span-1 text-right">Posts</div>
          <div className="col-span-1 text-right">1st post</div>
          <div className="col-span-1 text-right">1st detail</div>
          <div className="col-span-1 text-right">Cadence</div>
          <div className="col-span-1 text-center">Close</div>
          <div className="col-span-1 text-right">Content</div>
          <div className="col-span-1 text-right">Score</div>
        </div>
        {rows.map(s => (
          <button key={s.incidentId} className="w-full grid grid-cols-12 gap-2 px-3 py-2 text-left text-[11px] items-center border-b border-[var(--line)] hover:bg-[var(--bg-card-hi)] transition-colors" onClick={() => onOpen(s.incidentId)}>
            <div className="col-span-4 min-w-0">
              <div className="flex items-center gap-2">
                <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>{s.incident.report_date}{s.incident.incident_start ? ` ${s.incident.incident_start.slice(0, 5)}` : ''}</span>
                <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{s.group === 'north' ? 'North' : s.group === 'south' ? 'South' : ''}</span>
                {s.severe && <span className="pill text-[9px]" style={{ background: 'var(--nr-red)20', color: 'var(--nr-red)', borderColor: 'var(--nr-red)60' }}>severe</span>}
              </div>
              <div className="truncate" style={{ color: 'var(--ink-200)' }}>{s.incident.title ?? '—'}</div>
              <div className="truncate text-[10px]" style={{ color: 'var(--ink-500)' }}>{s.incident.location}{s.incident.ccil ? ` · CCIL ${s.incident.ccil}` : ''}</div>
            </div>
            <div className="col-span-1 text-right numeric-mono" style={{ color: 'var(--nr-orange)' }}>{effectiveDelay(s.incident)}m</div>
            <div className="col-span-1 text-right numeric-mono" style={{ color: 'var(--ink-300)' }}>{s.postCount}</div>
            <div className="col-span-1 text-right numeric-mono" style={{ color: toneFor(s.firstPostLagMins, STANDARD.holdingMins, 30, false) }}>{fmtMins(s.firstPostLagMins)}</div>
            <div className="col-span-1 text-right numeric-mono" style={{ color: toneFor(s.firstUpdateGapMins, STANDARD.firstDetailMins, 45, false) }}>{fmtMins(s.firstUpdateGapMins)}</div>
            <div className="col-span-1 text-right numeric-mono" style={{ color: toneFor(s.pctGapsWithinTarget, 0.8, 0.5) }}>{fmtPct(s.pctGapsWithinTarget)}</div>
            <div className="col-span-1 text-center">{s.hasClose ? <CheckCircle2 size={13} className="inline" style={{ color: 'var(--nr-green)' }} /> : <XCircle size={13} className="inline" style={{ color: 'var(--nr-red)' }} />}</div>
            <div className="col-span-1 text-right numeric-mono" style={{ color: toneFor(s.completeness, 0.8, 0.5) }}>{fmtPct(s.completeness)}</div>
            <div className="col-span-1 text-right"><GradePill grade={s.grade} score={s.score} /></div>
          </button>
        ))}
        {showSilent && silent.map(i => (
          <button key={i.id} className="w-full grid grid-cols-12 gap-2 px-3 py-2 text-left text-[11px] items-center border-b border-[var(--line)] hover:bg-[var(--bg-card-hi)] transition-colors opacity-70" onClick={() => onOpen(i.id)}>
            <div className="col-span-4 min-w-0">
              <div className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>{i.report_date}{i.incident_start ? ` ${i.incident_start.slice(0, 5)}` : ''} · {i.area ?? ''}</div>
              <div className="truncate" style={{ color: 'var(--ink-300)' }}>{i.title ?? '—'}</div>
              <div className="truncate text-[10px]" style={{ color: 'var(--ink-500)' }}>{i.location}{i.ccil ? ` · CCIL ${i.ccil}` : ''}</div>
            </div>
            <div className="col-span-1 text-right numeric-mono" style={{ color: 'var(--nr-orange)' }}>{effectiveDelay(i)}m</div>
            <div className="col-span-7 text-[10px] flex items-center gap-2" style={{ color: 'var(--nr-red)' }}><AlertTriangle size={11} /> notable incident with no WhatsApp post</div>
          </button>
        ))}
        {!rows.length && !(showSilent && silent.length) && <div className="p-6 text-center text-[11px]" style={{ color: 'var(--ink-500)' }}>No linked incidents in scope.</div>}
      </div>
    </div>
  )
}

// ─── Unlinked inbox ──────────────────────────────────────────────────────────

function UnlinkedInbox({ picture, matches, incidents, onOpenThread, onLink, canWrite }: {
  picture: WaPicture; matches: Map<string, ThreadMatch>; incidents: IncidentRow[]
  onOpenThread: (key: string) => void; onLink: (t: WaThread, i: IncidentRow) => void; canWrite: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const rows = useMemo(() => picture.unlinked.filter(t => showAll || isInboxWorthy(t)).sort((a, b) => b.firstLocalMs - a.firstLocalMs), [picture, showAll])
  const [page, setPage] = useState(0)
  const PAGE = 40
  const shown = rows.slice(page * PAGE, (page + 1) * PAGE)
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-[11px]" style={{ color: 'var(--ink-400)' }}>
          Chains with no CCIL link. A suggestion is shown where the matcher found a plausible but low-confidence partner; open a chain to search for the right incident.
        </div>
        <label className="text-[11px] flex items-center gap-1" style={{ color: 'var(--ink-400)' }}>
          <input type="checkbox" checked={showAll} onChange={e => { setShowAll(e.target.checked); setPage(0) }} /> include advisories, conference calls, off-route and media-only ({picture.unlinked.length - picture.unlinked.filter(isInboxWorthy).length})
        </label>
      </div>
      <div className="card overflow-hidden">
        {shown.map(t => {
          const posts = operationalPosts(t)
          const m = matches.get(t.key)
          const first = posts[0]
          return (
            <div key={t.key} className="flex items-start gap-3 px-3 py-2 text-[11px] border-b border-[var(--line)]">
              <button className="flex-1 min-w-0 text-left" onClick={() => onOpenThread(t.key)}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>{first ? fmtLocal(first.sent_local) : ''}</span>
                  <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{t.group === 'north' ? 'North' : 'South'}</span>
                  {first?.rag && <span className="w-2 h-2 rounded-full inline-block" style={{ background: RAG_COLOR[first.rag] }} />}
                  {first && <span className="pill text-[9px]" style={{ color: 'var(--ink-400)', borderColor: 'var(--line)' }}>{KIND_LABEL[first.kind]}</span>}
                  <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>{posts.length} post{posts.length === 1 ? '' : 's'}</span>
                </div>
                <div className="truncate" style={{ color: 'var(--ink-200)' }}>{t.title}</div>
                <div className="truncate text-[10px]" style={{ color: 'var(--ink-500)' }}>{first ? messageText(first.body).replace(/\n+/g, ' ').slice(0, 160) : ''}</div>
              </button>
              <div className="shrink-0 text-right max-w-[40%] min-w-0">
                {m?.best && m.confidence !== 'none' ? (
                  <>
                    <div className="text-[10px] truncate" style={{ color: 'var(--ink-400)' }} title={incidentLabel(m.best.incident)}>suggest: {m.best.incident.title ?? '—'} <span className="numeric-mono">({m.best.score.toFixed(1)})</span></div>
                    <div className="flex items-center gap-1 justify-end mt-1">
                      <button className="btn text-[10px] flex items-center gap-1" disabled={!canWrite} onClick={() => onLink(t, m.best!.incident)}><Link2 size={10} /> Link</button>
                      <button className="btn text-[10px]" onClick={() => onOpenThread(t.key)}>Choose…</button>
                    </div>
                  </>
                ) : (
                  <button className="btn text-[10px]" onClick={() => onOpenThread(t.key)}>Find incident…</button>
                )}
              </div>
            </div>
          )
        })}
        {!rows.length && <div className="p-6 text-center text-[11px]" style={{ color: 'var(--ink-500)' }}>Every chain in scope is linked.</div>}
      </div>
      {rows.length > PAGE && (
        <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--ink-400)' }}>
          <button className="btn text-[10px]" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span className="numeric-mono">{page * PAGE + 1}–{Math.min(rows.length, (page + 1) * PAGE)} of {rows.length}</span>
          <button className="btn text-[10px]" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}
      <div className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{incidents.length.toLocaleString()} CCIL incidents available for linking in scope.</div>
    </div>
  )
}

// ─── Monitoring ──────────────────────────────────────────────────────────────

function Monitoring({ flags, onOpen, onOpenThread }: { flags: WaFlag[]; onOpen: (id: string) => void; onOpenThread: (k: string) => void }) {
  const [kind, setKind] = useState<string>('all')
  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const f of flags) c.set(f.kind, (c.get(f.kind) ?? 0) + 1)
    return c
  }, [flags])
  const rows = flags.filter(f => kind === 'all' || f.kind === kind).slice(0, 300)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 flex-wrap">
        <button className={`btn text-[10px] ${kind === 'all' ? 'btn-active' : ''}`} onClick={() => setKind('all')}>All <span className="numeric-mono ml-1">{flags.length}</span></button>
        {(Object.keys(WA_FLAG_LABELS) as (keyof typeof WA_FLAG_LABELS)[]).map(k => (
          <button key={k} className={`btn text-[10px] ${kind === k ? 'btn-active' : ''}`} onClick={() => setKind(k)}>{WA_FLAG_LABELS[k]} <span className="numeric-mono ml-1">{counts.get(k) ?? 0}</span></button>
        ))}
      </div>
      <div className="card overflow-hidden">
        {rows.map((f, idx) => {
          const inc = f.incident
          const when = inc ? `${inc.report_date}${inc.incident_start ? ' ' + inc.incident_start.slice(0, 5) : ''}${inc.ccil ? ' · CCIL ' + inc.ccil : ''}` : null
          const detail = f.detail + (inc?.location ? ' · ' + inc.location : '')
          const open = () => { if (inc) onOpen(inc.id); else if (f.thread) onOpenThread(f.thread.key) }
          return (
            <button key={idx} className="w-full flex items-start gap-3 px-3 py-2 text-left text-[11px] border-b border-[var(--line)] hover:bg-[var(--bg-card-hi)] transition-colors" onClick={open}>
              <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: f.severity === 'red' ? 'var(--nr-red)' : 'var(--nr-amber)' }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="pill text-[9px]" style={{ color: 'var(--ink-300)', borderColor: 'var(--line-hi)' }}>{WA_FLAG_LABELS[f.kind]}</span>
                  {when && <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>{when}</span>}
                </div>
                <div className="truncate" style={{ color: 'var(--ink-200)' }}>{inc?.title ?? f.thread?.title ?? '—'}</div>
                <div className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{detail}</div>
              </div>
            </button>
          )
        })}
        {!rows.length && <div className="p-6 text-center text-[11px]" style={{ color: 'var(--ink-500)' }}>Nothing flagged in scope.</div>}
      </div>
    </div>
  )
}

// ─── Imports ─────────────────────────────────────────────────────────────────

function Imports({ imports, messages, onClear, canWrite }: { imports: WaImport[]; messages: WaMessage[]; onClear: (g: WaGroup) => void; canWrite: boolean }) {
  const byGroup = useMemo(() => {
    const out: { group: WaGroup; count: number; first: string | null; last: string | null }[] = []
    for (const g of ['north', 'south', 'other'] as WaGroup[]) {
      const ms = messages.filter(m => m.group_name === g)
      if (!ms.length) continue
      out.push({ group: g, count: ms.length, first: ms[0].sent_local, last: ms[ms.length - 1].sent_local })
    }
    return out
  }, [messages])
  const stale = (last: string | null) => last ? Math.floor((Date.now() - localMs(last)) / 86_400_000) : null
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {byGroup.map(g => {
          const d = stale(g.last)
          return (
            <div key={g.group} className="card p-4">
              <div className="flex items-center justify-between">
                <div className="label-micro">{WA_GROUP_LABELS[g.group]}</div>
                <button className="btn text-[10px] flex items-center gap-1" disabled={!canWrite} onClick={() => onClear(g.group)} title="Delete stored messages and links for this group"><Trash2 size={10} /> Clear</button>
              </div>
              <div className="numeric text-2xl mt-1" style={{ color: 'var(--ink-100)' }}>{g.count.toLocaleString()}</div>
              <div className="text-[10px] mt-1" style={{ color: 'var(--ink-500)' }}>{g.first ? fmtLocal(g.first) : ''} → {g.last ? fmtLocal(g.last) : ''}</div>
              {d != null && <div className="text-[10px] mt-1 flex items-center gap-1" style={{ color: d > 7 ? 'var(--nr-amber)' : 'var(--ink-500)' }}><Clock size={10} /> last message {d} day{d === 1 ? '' : 's'} ago{d > 7 ? ' — drop a fresh export' : ''}</div>}
            </div>
          )
        })}
      </div>
      <div className="card overflow-hidden">
        <div className="grid grid-cols-12 gap-2 px-3 py-2 label-micro border-b border-[var(--line)]">
          <div className="col-span-3">Imported</div><div className="col-span-2">Group</div><div className="col-span-4">File</div><div className="col-span-1 text-right">Read</div><div className="col-span-1 text-right">New</div><div className="col-span-1 text-right">By</div>
        </div>
        {imports.map(im => (
          <div key={im.id} className="grid grid-cols-12 gap-2 px-3 py-2 text-[11px] border-b border-[var(--line)]">
            <div className="col-span-3 numeric-mono" style={{ color: 'var(--ink-400)' }}>{fmtDateTime(im.imported_at)}</div>
            <div className="col-span-2" style={{ color: 'var(--ink-300)' }}>{im.group_name}</div>
            <div className="col-span-4 truncate" style={{ color: 'var(--ink-300)' }} title={im.file_name ?? ''}>{im.file_name ?? '—'}</div>
            <div className="col-span-1 text-right numeric-mono" style={{ color: 'var(--ink-400)' }}>{im.message_count.toLocaleString()}</div>
            <div className="col-span-1 text-right numeric-mono" style={{ color: 'var(--nr-green)' }}>{im.new_count.toLocaleString()}</div>
            <div className="col-span-1 text-right" style={{ color: 'var(--ink-500)' }}>{im.imported_by ?? '—'}</div>
          </div>
        ))}
        {!imports.length && <div className="p-6 text-center text-[11px]" style={{ color: 'var(--ink-500)' }}>No imports recorded.</div>}
      </div>
    </div>
  )
}

// ─── Chain rendering ─────────────────────────────────────────────────────────

function PostBody({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed" style={{ color: 'var(--ink-200)' }}>
      {boldSegments(text).map((s, i) => s.bold ? <strong key={i} style={{ color: 'var(--ink-100)' }}>{s.text}</strong> : <span key={i}>{s.text}</span>)}
    </div>
  )
}

function PostCard({ m, gapMins, target }: { m: WaMessage; gapMins: number | null; target: number }) {
  const text = messageText(m.body)
  const over = gapMins != null && gapMins > target
  return (
    <div className="rounded border border-[var(--line)] p-3" style={{ background: 'var(--bg-card)', borderLeft: m.rag ? `3px solid ${RAG_COLOR[m.rag]}` : undefined }}>
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <span className="numeric-mono text-[11px]" style={{ color: 'var(--ink-300)' }}>{m.sent_local.slice(11, 16)}</span>
        <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>{m.sent_local.slice(0, 10)}</span>
        <span className="text-[10px]" style={{ color: 'var(--ink-400)' }}>{m.sender}</span>
        <span className="pill text-[9px]" style={{ color: 'var(--ink-400)', borderColor: 'var(--line)' }}>{KIND_LABEL[m.kind]}</span>
        {m.has_media && <span className="text-[9px]" style={{ color: 'var(--ink-500)' }}>📎 media</span>}
        {gapMins != null && <span className="numeric-mono text-[9px] ml-auto" style={{ color: over ? 'var(--nr-amber)' : 'var(--ink-500)' }}>+{fmtMins(gapMins)}{over ? ` › ${target}m target` : ''}</span>}
      </div>
      {m.is_deleted ? <div className="text-[11px] italic" style={{ color: 'var(--ink-500)' }}>message deleted</div> : <PostBody text={text || '(media only)'} />}
    </div>
  )
}

function ChainPosts({ posts, target }: { posts: WaMessage[]; target: number }) {
  return (
    <div className="space-y-2">
      {posts.map((m, i) => (
        <PostCard key={m.id} m={m} gapMins={i === 0 ? null : Math.round((localMs(m.sent_local) - localMs(posts[i - 1].sent_local)) / 60_000)} target={target} />
      ))}
    </div>
  )
}

// CCIL side: field grid + commentary, with the events log fetched on demand
// when the row came from the lean fetch.
function CcilPanel({ incident, live }: { incident: IncidentRow; live: boolean }) {
  const [events, setEvents] = useState<IncidentEvent[] | null>(incident.events ?? null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    setEvents(incident.events ?? null)
    if (incident.events != null || !live) return
    let cancelled = false
    setLoading(true)
    fetchIncidentEvents([incident.id]).then(m => { if (!cancelled) setEvents(m.get(incident.id) ?? []) }).catch(() => { if (!cancelled) setEvents([]) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [incident, live])
  const signals = useMemo(() => parseEventSignals(events), [events])
  const cat = CATEGORY_CONFIG[incident.category]
  const fields: [string, string | number | null | undefined][] = [
    ['CCIL', incident.ccil], ['Log date', incident.report_date], ['Start', incident.incident_start?.slice(0, 5)], ['Advised', incident.advised_time?.slice(0, 5)],
    ['Responded', incident.initial_resp_time?.slice(0, 5)], ['Arrived', incident.arrived_at_time?.slice(0, 5)], ['NWR', incident.nwr_time?.slice(0, 5)], ['Duration', incident.incident_duration != null ? `${incident.incident_duration}m` : null],
    ['Delay', `${effectiveDelay(incident)}m`], ['Trains', incident.trains_delayed], ['Cancelled', incident.cancelled], ['Part', incident.part_cancelled],
    ['Area', incident.area], ['Line', incident.line], ['Fault №', incident.fault_number], ['Responders', incident.responder_initials?.join(', ')],
  ]
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className={`pill pill-${incident.severity.toLowerCase()}`}>{incident.severity}</span>
          {incident.incident_type_label && <span className="pill" style={{ background: `${cat.color}20`, color: cat.color, borderColor: `${cat.color}50` }}>{incident.incident_type_label}</span>}
        </div>
        <div className="text-sm font-medium" style={{ color: 'var(--ink-100)' }}>{incident.title ?? '—'}</div>
        <div className="text-[11px]" style={{ color: 'var(--ink-400)' }}>{incident.location}</div>
      </div>
      <div className="grid grid-cols-4 gap-x-3 gap-y-1.5">
        {fields.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <div className="label-micro text-[9px]">{k}</div>
            <div className="numeric-mono text-[11px] truncate" style={{ color: v == null || v === '' ? 'var(--ink-500)' : 'var(--ink-200)' }}>{v == null || v === '' ? '—' : v}</div>
          </div>
        ))}
      </div>
      <div>
        <div className="label-micro mb-1 flex items-center gap-2"><FileText size={10} /> CCIL commentary {events && <span className="numeric-mono text-[9px]" style={{ color: 'var(--ink-500)' }}>{events.length}</span>}</div>
        {loading && <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>Loading events…</div>}
        {!loading && (!events || !events.length) && <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>No events log recorded for this incident.</div>}
        <div className="space-y-0.5 max-h-[50vh] overflow-y-auto pr-1">
          {(events ?? []).map((e, i) => {
            const tag = signals.itsr?.eventIndex === i ? 'ITSR' : signals.momArrival?.eventIndex === i ? 'MOM on site' : signals.momDispatch?.eventIndex === i ? 'MOM dispatch' : null
            return (
              <div key={i} className="flex items-start gap-2 text-[11px] px-1 py-0.5 rounded-sm" style={tag ? { background: 'var(--bg-card)', border: '1px solid var(--line)' } : undefined}>
                <span className="numeric-mono shrink-0" style={{ color: 'var(--ink-400)', minWidth: '4ch' }}>{e.time || '—'}</span>
                {e.company && <span className="label-micro text-[9px] shrink-0 pt-0.5" style={{ color: 'var(--ink-500)' }}>{e.company}</span>}
                <span className="flex-1 break-words" style={{ color: 'var(--ink-200)' }}>{e.description || '—'}</span>
                {tag && <span className="pill text-[9px] shrink-0" style={{ color: 'var(--nr-orange)', borderColor: 'var(--nr-orange)60' }}>{tag}</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ScoreBreakdown({ s }: { s: CommsScore }) {
  const flagKeys = Object.keys(CONTENT_FLAG_LABELS) as (keyof ContentFlags)[]
  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <GradePill grade={s.grade} score={s.score} />
        <span className="numeric-mono text-[10px]" style={{ color: 'var(--ink-500)' }}>timeliness {s.parts.timeliness}/40 · content {s.parts.completeness}/40 · closure {s.parts.closure}/20</span>
        {s.severe && <span className="pill text-[9px]" style={{ color: 'var(--nr-red)', borderColor: 'var(--nr-red)60' }}>severe · {s.cadenceTargetMins} min cadence</span>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-[11px]">
        <Stat label="First post" value={fmtMins(s.firstPostLagMins)} tone={toneFor(s.firstPostLagMins, STANDARD.holdingMins, 30, false)} sub={`≤ ${STANDARD.holdingMins}m`} />
        <Stat label="First detail" value={fmtMins(s.firstUpdateGapMins)} tone={toneFor(s.firstUpdateGapMins, STANDARD.firstDetailMins, 45, false)} sub={`≤ ${STANDARD.firstDetailMins}m`} />
        <Stat label="Within cadence" value={fmtPct(s.pctGapsWithinTarget)} tone={toneFor(s.pctGapsWithinTarget, 0.8, 0.5)} sub={`max gap ${fmtMins(s.maxGapMins)}`} />
        <Stat label="Holding msg" value={s.hasHolding ? 'yes' : 'no'} tone={s.hasHolding ? 'var(--nr-green)' : 'var(--ink-400)'} />
        <Stat label="Closure post" value={s.hasClose ? 'yes' : 'no'} tone={s.hasClose ? 'var(--nr-green)' : 'var(--nr-red)'} sub={s.closeLagVsNwrMins != null ? `${fmtMins(s.closeLagVsNwrMins)} vs NWR` : undefined} />
        <Stat label="Abbreviations" value={s.abbreviationsInFirst ? 'in 1st post' : 'none'} tone={s.abbreviationsInFirst ? 'var(--nr-amber)' : 'var(--nr-green)'} />
      </div>
      <div className="flex flex-wrap gap-1">
        {flagKeys.map(k => (
          <span key={k} className="pill text-[9px]" style={s.flags[k] ? { color: 'var(--nr-green)', borderColor: 'var(--nr-green)60', background: 'var(--nr-green)15' } : { color: 'var(--ink-500)', borderColor: 'var(--line)' }}>
            {s.flags[k] ? '✓' : '·'} {CONTENT_FLAG_LABELS[k]}
          </span>
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div>
      <div className="label-micro text-[9px]">{label}</div>
      <div className="numeric-mono" style={{ color: tone ?? 'var(--ink-200)' }}>{value}</div>
      {sub && <div className="text-[9px]" style={{ color: 'var(--ink-500)' }}>{sub}</div>}
    </div>
  )
}

// ─── Incident modal: CCIL beside WhatsApp ────────────────────────────────────

function IncidentCommsModal({ incident, score, links, threadByKey, live, canWrite, onDecide, onUnlink, onClose }: {
  incident: IncidentRow; score: CommsScore | null; links: WaThreadLink[]; threadByKey: Map<string, WaThread>
  live: boolean; canWrite: boolean
  onDecide: (l: WaThreadLink, s: 'confirmed' | 'rejected') => void; onUnlink: (l: WaThreadLink) => void; onClose: () => void
}) {
  const [view, setView] = useState<'side' | 'merged'>('side')
  const posts = score?.posts ?? []
  const target = score?.cadenceTargetMins ?? STANDARD.cadenceAmberMins
  const timeline = useMemo(() => mergedTimeline(incident, posts), [incident, posts])
  return (
    <Portal onClose={onClose}>
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-6xl max-h-[92vh] bg-[var(--bg-panel)] border border-[var(--line-hi)] rounded overflow-hidden flex flex-col animate-fade-up">
        <div className="flex items-start justify-between p-4 border-b border-[var(--line)] shrink-0 gap-4">
          <div className="min-w-0">
            <h3 className="serif text-xl font-medium truncate" style={{ color: 'var(--ink-100)' }}>{incident.title ?? 'Incident'}</h3>
            <p className="label-micro mt-0.5">{incident.report_date}{incident.incident_start ? ` · ${incident.incident_start.slice(0, 5)}` : ''}{incident.ccil ? ` · CCIL ${incident.ccil}` : ''} · {posts.length} WhatsApp post{posts.length === 1 ? '' : 's'}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button className={`btn text-[10px] ${view === 'side' ? 'btn-active' : ''}`} onClick={() => setView('side')}>Side by side</button>
            <button className={`btn text-[10px] ${view === 'merged' ? 'btn-active' : ''}`} onClick={() => setView('merged')}>Merged timeline</button>
            <button onClick={onClose} className="btn !p-2"><X size={14} /></button>
          </div>
        </div>
        <div className="overflow-y-auto p-4 space-y-4 flex-1">
          {score ? <ScoreBreakdown s={score} /> : <Banner tone="amber" text="No WhatsApp chain is linked to this incident. Link one from the Unlinked chains section." />}

          {links.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {links.map(l => {
                const t = threadByKey.get(l.thread_key)
                const c = l.status === 'confirmed' ? 'var(--nr-green)' : l.status === 'rejected' ? 'var(--nr-red)' : 'var(--nr-amber)'
                return (
                  <div key={l.id} className="flex items-center gap-2 text-[10px] rounded px-2 py-1" style={{ border: `1px solid ${c}50`, background: `${c}10` }}>
                    <Link2 size={10} style={{ color: c }} />
                    <span className="truncate max-w-[26ch]" style={{ color: 'var(--ink-300)' }} title={t?.title}>{t?.title ?? l.thread_key}</span>
                    <span className="numeric-mono" style={{ color: 'var(--ink-500)' }}>{l.method}{l.score != null ? ` ${l.score}` : ''} · {l.status}</span>
                    {canWrite && l.status !== 'confirmed' && <button className="btn !px-1.5 !py-0.5 text-[9px]" title="Confirm this link" onClick={() => onDecide(l, 'confirmed')}><CheckCircle2 size={10} /></button>}
                    {canWrite && l.status !== 'rejected' && <button className="btn !px-1.5 !py-0.5 text-[9px]" title="Reject: this chain is not about this incident" onClick={() => onDecide(l, 'rejected')}><XCircle size={10} /></button>}
                    {canWrite && <button className="btn !px-1.5 !py-0.5 text-[9px]" title="Remove link" onClick={() => onUnlink(l)}><Trash2 size={10} /></button>}
                  </div>
                )
              })}
            </div>
          )}

          {view === 'side' ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="card p-3">
                <div className="label-micro mb-2">CCIL</div>
                <CcilPanel incident={incident} live={live} />
              </div>
              <div className="card p-3">
                <div className="label-micro mb-2 flex items-center gap-2"><MessageSquare size={10} /> WhatsApp chain</div>
                {posts.length ? <ChainPosts posts={posts} target={target} /> : <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>No posts linked.</div>}
              </div>
            </div>
          ) : (
            <div className="card p-3">
              <div className="label-micro mb-2">Merged timeline · CCIL commentary and WhatsApp posts in time order</div>
              <div className="space-y-1">
                {timeline.map((it, i) => (
                  <div key={i} className="flex items-start gap-2 text-[11px] rounded px-2 py-1" style={it.source === 'whatsapp' ? { background: 'var(--nr-green)10', border: '1px solid var(--nr-green)30' } : undefined}>
                    <span className="numeric-mono shrink-0" style={{ color: 'var(--ink-400)', minWidth: '4ch' }}>{it.time}</span>
                    <span className="label-micro text-[9px] shrink-0 pt-0.5 w-16" style={{ color: it.source === 'whatsapp' ? 'var(--nr-green)' : 'var(--ink-500)' }}>{it.source === 'whatsapp' ? 'WhatsApp' : 'CCIL'}</span>
                    {it.rag && <span className="w-2 h-2 rounded-full mt-1 shrink-0" style={{ background: RAG_COLOR[it.rag] }} />}
                    <span className="flex-1 break-words whitespace-pre-wrap" style={{ color: 'var(--ink-200)' }}>{it.source === 'whatsapp' ? <PostBody text={it.text} /> : it.text}</span>
                    {it.meta && <span className="text-[9px] shrink-0" style={{ color: 'var(--ink-500)' }}>{it.meta}</span>}
                  </div>
                ))}
                {!timeline.length && <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>Nothing to show.</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    </Portal>
  )
}

// ─── Thread modal: an unlinked (or any) chain with incident search ───────────

function ThreadModal({ thread, match, links, incidents, incidentById, canWrite, onLink, onUnlink, onOpenIncident, onClose }: {
  thread: WaThread; match: ThreadMatch | null; links: WaThreadLink[]; incidents: IncidentRow[]; incidentById: Map<string, IncidentRow>
  canWrite: boolean; onLink: (t: WaThread, i: IncidentRow) => void; onUnlink: (l: WaThreadLink) => void; onOpenIncident: (id: string) => void; onClose: () => void
}) {
  const posts = operationalPosts(thread)
  const [q, setQ] = useState('')
  const [wide, setWide] = useState(false)
  const candidates = useMemo(() => {
    const first = posts[0]
    if (!first) return []
    const d0 = localMs(first.sent_local.slice(0, 10) + 'T12:00:00')
    const span = wide ? 7 : 2
    const t = q.trim().toLowerCase()
    return incidents
      .filter(i => !i.is_continuation)
      .filter(i => Math.abs(localMs(i.report_date + 'T12:00:00') - d0) <= span * 86_400_000)
      .filter(i => !t || `${i.title} ${i.location} ${i.ccil} ${i.incident_type_label}`.toLowerCase().includes(t))
      .map(i => ({ i, c: scoreThreadAgainst(thread, i) }))
      .sort((a, b) => (b.c?.score ?? -1) - (a.c?.score ?? -1) || effectiveDelay(b.i) - effectiveDelay(a.i))
      .slice(0, 40)
  }, [incidents, posts, q, wide, thread])
  const active = links.filter(l => l.status !== 'rejected')
  return (
    <Portal onClose={onClose}>
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-5xl max-h-[92vh] bg-[var(--bg-panel)] border border-[var(--line-hi)] rounded overflow-hidden flex flex-col animate-fade-up">
        <div className="flex items-start justify-between p-4 border-b border-[var(--line)] shrink-0 gap-4">
          <div className="min-w-0">
            <h3 className="serif text-xl font-medium truncate" style={{ color: 'var(--ink-100)' }}>{thread.title}</h3>
            <p className="label-micro mt-0.5">{WA_GROUP_LABELS[thread.group]} · {posts[0] ? fmtLocal(posts[0].sent_local) : ''} · {posts.length} post{posts.length === 1 ? '' : 's'}</p>
          </div>
          <button onClick={onClose} className="btn !p-2 shrink-0"><X size={14} /></button>
        </div>
        <div className="overflow-y-auto p-4 flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card p-3">
            <div className="label-micro mb-2 flex items-center gap-2"><MessageSquare size={10} /> Chain</div>
            <ChainPosts posts={posts} target={STANDARD.cadenceAmberMins} />
          </div>
          <div className="card p-3 space-y-3">
            <div className="label-micro flex items-center gap-2"><Link2 size={10} /> CCIL incident</div>
            {active.length > 0 && (
              <div className="space-y-1">
                {active.map(l => {
                  const i = incidentById.get(l.incident_id)
                  return (
                    <div key={l.id} className="flex items-center gap-2 text-[11px] rounded px-2 py-1" style={{ border: '1px solid var(--nr-green)50', background: 'var(--nr-green)10' }}>
                      <button className="flex-1 min-w-0 text-left truncate" style={{ color: 'var(--ink-200)' }} onClick={() => onOpenIncident(l.incident_id)}>{i ? incidentLabel(i) : l.incident_id}</button>
                      <span className="numeric-mono text-[9px]" style={{ color: 'var(--ink-500)' }}>{l.status}</span>
                      {canWrite && <button className="btn !px-1.5 !py-0.5 text-[9px]" onClick={() => onUnlink(l)}><Trash2 size={10} /></button>}
                    </div>
                  )
                })}
              </div>
            )}
            {match?.best && !active.some(l => l.incident_id === match.best!.incident.id) && (
              <div className="text-[10px]" style={{ color: 'var(--ink-500)' }}>Matcher suggestion: <span style={{ color: 'var(--ink-300)' }}>{incidentLabel(match.best.incident)}</span> · score {match.best.score.toFixed(1)} · {match.best.why.join(', ')}</div>
            )}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search size={12} className="absolute left-2 top-2" style={{ color: 'var(--ink-500)' }} />
                <input className="btn text-[11px] pl-7 w-full" placeholder="Search incidents near this date" value={q} onChange={e => setQ(e.target.value)} />
              </div>
              <label className="text-[10px] flex items-center gap-1 shrink-0" style={{ color: 'var(--ink-400)' }}><input type="checkbox" checked={wide} onChange={e => setWide(e.target.checked)} /> ±7 days</label>
            </div>
            <div className="space-y-1 max-h-[55vh] overflow-y-auto pr-1">
              {candidates.map(({ i, c }) => (
                <div key={i.id} className="flex items-center gap-2 text-[11px] px-2 py-1 rounded border border-[var(--line)] hover:bg-[var(--bg-card-hi)]">
                  <div className="flex-1 min-w-0">
                    <div className="truncate" style={{ color: 'var(--ink-200)' }}>{i.title ?? '—'}</div>
                    <div className="truncate text-[10px]" style={{ color: 'var(--ink-500)' }}>{i.report_date}{i.incident_start ? ` ${i.incident_start.slice(0, 5)}` : ''} · {i.location} · {effectiveDelay(i)}m{i.ccil ? ` · CCIL ${i.ccil}` : ''}</div>
                  </div>
                  {c && <span className="numeric-mono text-[9px] shrink-0" style={{ color: 'var(--ink-500)' }} title={c.why.join(', ')}>{c.score.toFixed(1)}</span>}
                  <button className="btn !px-2 !py-0.5 text-[10px] shrink-0" disabled={!canWrite || active.some(l => l.incident_id === i.id)} onClick={() => onLink(thread, i)}>Link</button>
                </div>
              ))}
              {!candidates.length && <div className="text-[11px]" style={{ color: 'var(--ink-500)' }}>No incidents near this date match.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
    </Portal>
  )
}

