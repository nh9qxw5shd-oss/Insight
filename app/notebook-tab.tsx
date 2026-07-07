'use client'

import { useState, useMemo, useEffect } from 'react'
import {
  NotebookPen, Eye, X, AlertTriangle, Plus, CalendarDays, MapPin, Wrench, FileText,
} from 'lucide-react'
import {
  IncidentRow, InsightAnnotation, AnnotationKind, WatchlistEntry, WatchlistKind,
} from '@/lib/types'
import {
  effectiveDelay, nonContinuation,
  fetchAnnotations, addAnnotation, deleteAnnotation,
  fetchWatchlist, addWatchlistEntry, deleteWatchlistEntry,
} from '@/lib/queries'
import { isSupabaseConfigured } from '@/lib/supabase'

// ─── Config ──────────────────────────────────────────────────────────────────

const AUTHOR_STORAGE_KEY = 'insight-author'

const ANNOTATION_KINDS: {
  kind: AnnotationKind
  label: string
  icon: typeof CalendarDays
  placeholder: string
}[] = [
  { kind: 'date',     label: 'Date',     icon: CalendarDays, placeholder: '' },
  { kind: 'location', label: 'Location', icon: MapPin,       placeholder: 'e.g. Leicester Station' },
  { kind: 'asset',    label: 'Asset',    icon: Wrench,       placeholder: 'e.g. Points Failure — Derby' },
  { kind: 'incident', label: 'Incident', icon: FileText,     placeholder: 'CCIL ref or incident id' },
]

const WATCHLIST_KINDS: { kind: WatchlistKind; label: string; placeholder: string }[] = [
  { kind: 'location', label: 'Location', placeholder: 'e.g. Leicester Station' },
  { kind: 'asset',    label: 'Asset',    placeholder: 'e.g. Points Failure — Derby' },
  { kind: 'fault',    label: 'Fault №',  placeholder: 'e.g. 123456' },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function loadStoredAuthor(): string {
  if (typeof window === 'undefined') return ''
  try { return localStorage.getItem(AUTHOR_STORAGE_KEY) ?? '' } catch { return '' }
}

function storeAuthor(author: string) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(AUTHOR_STORAGE_KEY, author) } catch { /* private mode etc. */ }
}

interface WatchStat {
  entry: WatchlistEntry
  occurrences: number
  totalDelay: number
  lastSeen: string | null
}

// ─── NotebookTab ─────────────────────────────────────────────────────────────

export function NotebookTab({ incidents, windowFrom, windowTo, canWrite }: {
  incidents: IncidentRow[]
  windowFrom: string
  windowTo: string
  canWrite: boolean
}) {
  const configured = isSupabaseConfigured()

  const [annotations, setAnnotations] = useState<InsightAnnotation[]>([])
  const [watchlist,   setWatchlist]   = useState<WatchlistEntry[]>([])
  const [loadError,   setLoadError]   = useState<string | null>(null)

  // Annotation form
  const [annKind,   setAnnKind]   = useState<AnnotationKind>('date')
  const [annAnchor, setAnnAnchor] = useState('')
  const [annNote,   setAnnNote]   = useState('')
  const [author,    setAuthor]    = useState('')
  const [annBusy,   setAnnBusy]   = useState(false)
  const [annError,  setAnnError]  = useState<string | null>(null)

  // Watchlist form
  const [wlKind,   setWlKind]   = useState<WatchlistKind>('location')
  const [wlAnchor, setWlAnchor] = useState('')
  const [wlNote,   setWlNote]   = useState('')
  const [wlBusy,   setWlBusy]   = useState(false)
  const [wlError,  setWlError]  = useState<string | null>(null)

  // Prefill author initials from localStorage
  useEffect(() => { setAuthor(loadStoredAuthor()) }, [])

  // Load persisted entries once on mount
  useEffect(() => {
    if (!isSupabaseConfigured()) return
    let cancelled = false
    Promise.all([fetchAnnotations(), fetchWatchlist()])
      .then(([anns, watch]) => {
        if (cancelled) return
        setAnnotations(anns)
        setWatchlist(watch)
      })
      .catch(e => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Failed to load notebook entries')
      })
    return () => { cancelled = true }
  }, [])

  // ── Annotation actions ──────────────────────────────────────────────────────

  async function handleAddAnnotation() {
    const anchor = annAnchor.trim()
    const note = annNote.trim()
    const by = author.trim()
    if (!anchor || !note) { setAnnError('Both an anchor and a note are required'); return }
    setAnnBusy(true)
    setAnnError(null)
    try {
      if (configured) {
        const row = await addAnnotation(annKind, anchor, note, by || null)
        if (row) setAnnotations(prev => [row, ...prev])
      } else {
        // Demo mode — keep locally so the panel is explorable; nothing persists
        setAnnotations(prev => [{
          id: `demo-${Date.now()}`,
          kind: annKind,
          anchor,
          note,
          author: by || null,
          created_at: new Date().toISOString(),
        }, ...prev])
      }
      if (by) storeAuthor(by)
      setAnnAnchor('')
      setAnnNote('')
    } catch (e) {
      setAnnError(e instanceof Error ? e.message : 'Failed to save annotation')
    } finally {
      setAnnBusy(false)
    }
  }

  async function handleDeleteAnnotation(id: string) {
    if (!confirm('Delete this annotation?')) return
    try {
      if (configured) await deleteAnnotation(id)
      setAnnotations(prev => prev.filter(a => a.id !== id))
    } catch (e) {
      setAnnError(e instanceof Error ? e.message : 'Failed to delete annotation')
    }
  }

  // ── Watchlist actions ───────────────────────────────────────────────────────

  async function handleAddWatchlistEntry() {
    const anchor = wlAnchor.trim()
    const note = wlNote.trim()
    if (!anchor) { setWlError('An anchor is required'); return }
    setWlBusy(true)
    setWlError(null)
    try {
      if (configured) {
        const row = await addWatchlistEntry(wlKind, anchor, note || null, author.trim() || null)
        if (row) setWatchlist(prev => [row, ...prev.filter(w => w.id !== row.id)])
      } else {
        setWatchlist(prev => [{
          id: `demo-${Date.now()}`,
          kind: wlKind,
          anchor,
          note: note || null,
          author: author.trim() || null,
          created_at: new Date().toISOString(),
        }, ...prev])
      }
      setWlAnchor('')
      setWlNote('')
    } catch (e) {
      setWlError(e instanceof Error ? e.message : 'Failed to save watchlist entry')
    } finally {
      setWlBusy(false)
    }
  }

  async function handleDeleteWatchlistEntry(id: string) {
    if (!confirm('Remove this entry from the watchlist?')) return
    try {
      if (configured) await deleteWatchlistEntry(id)
      setWatchlist(prev => prev.filter(w => w.id !== id))
    } catch (e) {
      setWlError(e instanceof Error ? e.message : 'Failed to delete watchlist entry')
    }
  }

  // ── Derived data ────────────────────────────────────────────────────────────

  const groupedAnnotations = useMemo(() => {
    return ANNOTATION_KINDS
      .map(cfg => ({ cfg, items: annotations.filter(a => a.kind === cfg.kind) }))
      .filter(g => g.items.length > 0)
  }, [annotations])

  // Recurrence stats per watchlist entry, computed from the current window's incidents
  const watchStats = useMemo<WatchStat[]>(() => {
    const stats = watchlist.map(entry => {
      const anchorNorm = entry.anchor.trim().toLowerCase()
      const matches = incidents.filter(i => {
        if (entry.kind === 'location') {
          return (i.location ?? '').trim().toLowerCase() === anchorNorm
        }
        if (entry.kind === 'asset') {
          const key = `${i.incident_type_label ?? ''} — ${i.location ?? ''}`.trim().toLowerCase()
          return key === anchorNorm
        }
        // fault
        return (i.fault_number ?? '').trim().toLowerCase() === anchorNorm
      })
      const occurrences = nonContinuation(matches).length
      const totalDelay = matches.reduce((s, i) => s + effectiveDelay(i), 0)
      const lastSeen = matches.reduce<string | null>(
        (latest, i) => (latest == null || i.report_date > latest) ? i.report_date : latest,
        null,
      )
      return { entry, occurrences, totalDelay, lastSeen }
    })
    // Active first, then by delay
    return stats.sort((a, b) =>
      (b.occurrences > 0 ? 1 : 0) - (a.occurrences > 0 ? 1 : 0) ||
      b.totalDelay - a.totalDelay,
    )
  }, [incidents, watchlist])

  const activeAnnKind = ANNOTATION_KINDS.find(k => k.kind === annKind)!
  const activeWlKind  = WATCHLIST_KINDS.find(k => k.kind === wlKind)!

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Demo banner */}
      {!configured && (
        <div className="card p-4 text-xs flex items-start gap-3" style={{ borderColor: 'var(--nr-amber)' }}>
          <AlertTriangle size={14} style={{ color: 'var(--nr-amber)' }} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium" style={{ color: 'var(--ink-100)' }}>Demo mode — notebook entries can&apos;t be saved</div>
            <div className="mt-1" style={{ color: 'var(--ink-400)' }}>
              The Supabase environment variables are not configured. You can explore the notebook, but entries will be lost on reload.
            </div>
          </div>
        </div>
      )}

      {loadError && (
        <div className="card p-3 text-xs" style={{ borderColor: '#E74C3C', color: '#E74C3C' }}>
          Failed to load notebook entries: {loadError}
        </div>
      )}

      {/* Header strip */}
      <div className="card px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <NotebookPen size={14} style={{ color: 'var(--nr-orange)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--ink-100)' }}>Notebook</span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--ink-400)' }}>
          <span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{annotations.length}</span>
          <span>annotation{annotations.length === 1 ? '' : 's'}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--ink-400)' }}>
          <span className="numeric-mono" style={{ color: 'var(--ink-200)' }}>{watchlist.length}</span>
          <span>watch {watchlist.length === 1 ? 'entry' : 'entries'}</span>
        </div>
        <div className="text-[10px] ml-auto" style={{ color: 'var(--ink-500)' }}>
          Date annotations appear as markers on the Overview trend chart
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">

        {/* ── Annotations panel ─────────────────────────────────────────────── */}
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b flex items-center gap-2" style={{ borderColor: 'var(--line)' }}>
            <NotebookPen size={13} style={{ color: 'var(--nr-orange)' }} />
            <span className="label-micro" style={{ color: 'var(--nr-orange)' }}>Annotations</span>
          </div>

          {/* Create form */}
          <div className="px-4 py-4 border-b space-y-3" style={{ borderColor: 'var(--line)' }}>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="label-micro text-[9px] mb-1.5" style={{ color: 'var(--ink-500)' }}>Kind</div>
                <select
                  className="select w-full"
                  value={annKind}
                  onChange={e => { setAnnKind(e.target.value as AnnotationKind); setAnnAnchor('') }}
                >
                  {ANNOTATION_KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </select>
              </div>
              <div>
                <div className="label-micro text-[9px] mb-1.5" style={{ color: 'var(--ink-500)' }}>
                  {annKind === 'date' ? 'Date' : 'Anchor'}
                </div>
                {annKind === 'date' ? (
                  <input
                    type="date"
                    className="input w-full"
                    value={annAnchor}
                    onChange={e => setAnnAnchor(e.target.value)}
                  />
                ) : (
                  <input
                    type="text"
                    className="input w-full"
                    placeholder={activeAnnKind.placeholder}
                    value={annAnchor}
                    onChange={e => setAnnAnchor(e.target.value)}
                  />
                )}
              </div>
            </div>

            <div>
              <div className="label-micro text-[9px] mb-1.5" style={{ color: 'var(--ink-500)' }}>Note</div>
              <textarea
                className="input w-full resize-y"
                rows={2}
                placeholder="What happened, or what should the team keep in mind?"
                value={annNote}
                onChange={e => setAnnNote(e.target.value)}
              />
            </div>

            <div className="flex items-end gap-3">
              <div className="w-28">
                <div className="label-micro text-[9px] mb-1.5" style={{ color: 'var(--ink-500)' }}>Initials</div>
                <input
                  type="text"
                  className="input w-full"
                  placeholder="e.g. JD"
                  maxLength={8}
                  value={author}
                  onChange={e => setAuthor(e.target.value)}
                />
              </div>
              <button
                onClick={handleAddAnnotation}
                disabled={!canWrite || annBusy}
                className="btn flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                title={canWrite ? 'Add annotation' : 'You do not have write access'}
              >
                <Plus size={11} /> {annBusy ? 'Adding…' : 'Add annotation'}
              </button>
              {annError && <span className="text-[10px] pb-1" style={{ color: '#E74C3C' }}>{annError}</span>}
            </div>
          </div>

          {/* List grouped by kind */}
          {groupedAnnotations.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
              No annotations yet — record context the charts can&apos;t see
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
              {groupedAnnotations.map(({ cfg, items }) => (
                <div key={cfg.kind} className="px-4 py-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <cfg.icon size={11} style={{ color: 'var(--ink-400)' }} />
                    <span className="label-micro text-[9px]" style={{ color: 'var(--ink-400)' }}>
                      {cfg.label} · {items.length}
                    </span>
                  </div>
                  <div className="space-y-2.5">
                    {items.map(a => {
                      const inWindow = a.kind === 'date' && a.anchor >= windowFrom && a.anchor <= windowTo
                      return (
                        <div key={a.id} className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className="pill"
                                style={{ background: 'var(--bg-card-hi)', border: '1px solid var(--line-hi)', color: 'var(--ink-300)' }}
                              >
                                {cfg.label}
                              </span>
                              <span className="text-xs font-bold" style={{ color: 'var(--ink-100)' }}>
                                {a.kind === 'date' ? fmtDate(a.anchor) : a.anchor}
                              </span>
                              {inWindow && (
                                <span
                                  className="pill"
                                  style={{ background: 'rgba(224, 82, 6, 0.12)', border: '1px solid rgba(224, 82, 6, 0.4)', color: 'var(--nr-orange)' }}
                                >
                                  in window
                                </span>
                              )}
                            </div>
                            <div className="text-xs mt-1" style={{ color: 'var(--ink-200)' }}>{a.note}</div>
                            <div className="text-[10px] mt-0.5" style={{ color: 'var(--ink-500)' }}>
                              {a.author || 'Unattributed'} · {fmtDate(a.created_at)}
                            </div>
                          </div>
                          <button
                            onClick={() => handleDeleteAnnotation(a.id)}
                            disabled={!canWrite}
                            className="mt-0.5 shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={canWrite ? 'Delete annotation' : 'You do not have write access'}
                          >
                            <X size={12} style={{ color: 'var(--ink-500)' }} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Watchlist panel ───────────────────────────────────────────────── */}
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b flex items-center gap-2" style={{ borderColor: 'var(--line)' }}>
            <Eye size={13} style={{ color: 'var(--nr-orange)' }} />
            <span className="label-micro" style={{ color: 'var(--nr-orange)' }}>Watchlist</span>
            <span className="text-[10px] ml-auto" style={{ color: 'var(--ink-500)' }}>
              Recurrence checked against the current window
            </span>
          </div>

          {/* Create form */}
          <div className="px-4 py-4 border-b space-y-3" style={{ borderColor: 'var(--line)' }}>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="label-micro text-[9px] mb-1.5" style={{ color: 'var(--ink-500)' }}>Kind</div>
                <select
                  className="select w-full"
                  value={wlKind}
                  onChange={e => { setWlKind(e.target.value as WatchlistKind); setWlAnchor('') }}
                >
                  {WATCHLIST_KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </select>
              </div>
              <div>
                <div className="label-micro text-[9px] mb-1.5" style={{ color: 'var(--ink-500)' }}>Anchor</div>
                <input
                  type="text"
                  className="input w-full"
                  placeholder={activeWlKind.placeholder}
                  value={wlAnchor}
                  onChange={e => setWlAnchor(e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-end gap-3">
              <div className="flex-1">
                <div className="label-micro text-[9px] mb-1.5" style={{ color: 'var(--ink-500)' }}>Note (optional)</div>
                <input
                  type="text"
                  className="input w-full"
                  placeholder="Why is this being watched?"
                  value={wlNote}
                  onChange={e => setWlNote(e.target.value)}
                />
              </div>
              <button
                onClick={handleAddWatchlistEntry}
                disabled={!canWrite || wlBusy}
                className="btn flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                title={canWrite ? 'Add to watchlist' : 'You do not have write access'}
              >
                <Plus size={11} /> {wlBusy ? 'Adding…' : 'Add'}
              </button>
            </div>
            {wlError && <div className="text-[10px]" style={{ color: '#E74C3C' }}>{wlError}</div>}
          </div>

          {/* Entry cards */}
          {watchStats.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
              Nothing on the watchlist — add a location, asset, or fault number to track recurrence
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--line)' }}>
              {watchStats.map(({ entry, occurrences, totalDelay, lastSeen }) => {
                const kindCfg = WATCHLIST_KINDS.find(k => k.kind === entry.kind)
                const active = occurrences > 0
                return (
                  <div key={entry.id} className="px-4 py-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="pill"
                          style={{ background: 'var(--bg-card-hi)', border: '1px solid var(--line-hi)', color: 'var(--ink-300)' }}
                        >
                          {kindCfg?.label ?? entry.kind}
                        </span>
                        <span className="text-xs font-bold truncate" style={{ color: 'var(--ink-100)' }}>{entry.anchor}</span>
                        {active ? (
                          <span
                            className="pill"
                            style={{ background: 'rgba(224, 82, 6, 0.12)', border: '1px solid rgba(224, 82, 6, 0.4)', color: 'var(--nr-orange)' }}
                          >
                            <span
                              className="live-dot animate-pulse-soft"
                              style={{ background: 'var(--nr-orange)', boxShadow: '0 0 8px var(--nr-orange)' }}
                            />
                            Active
                          </span>
                        ) : (
                          <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>quiet</span>
                        )}
                      </div>
                      {entry.note && (
                        <div className="text-xs mt-1" style={{ color: 'var(--ink-300)' }}>{entry.note}</div>
                      )}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-[10px]" style={{ color: 'var(--ink-500)' }}>
                        <span>
                          <span className="numeric-mono" style={{ color: active ? 'var(--ink-200)' : 'var(--ink-500)' }}>{occurrences}</span>
                          {' '}in window
                        </span>
                        <span>
                          <span className="numeric-mono" style={{ color: active ? 'var(--ink-200)' : 'var(--ink-500)' }}>{Math.round(totalDelay).toLocaleString()}m</span>
                          {' '}delay
                        </span>
                        <span>last seen {lastSeen ? fmtDate(lastSeen) : '—'}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteWatchlistEntry(entry.id)}
                      disabled={!canWrite}
                      className="mt-0.5 shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
                      title={canWrite ? 'Remove from watchlist' : 'You do not have write access'}
                    >
                      <X size={12} style={{ color: 'var(--ink-500)' }} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
