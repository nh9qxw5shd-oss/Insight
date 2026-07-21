'use client'

import { useEffect, useRef, useState } from 'react'
import { Pin, Printer, Download, Trash2, ChevronUp, ChevronDown, RefreshCw, Info } from 'lucide-react'
import {
  BriefingPin, PinKind, fetchPins, updatePin, deletePin, buildBriefingHtml,
} from '@/lib/briefing'
import { openPrintWindow, downloadHtml, reportFilename } from '@/lib/reports/print'

// ─── Briefing composer ───────────────────────────────────────────────────────
// Findings pinned anywhere in Insight land here as evidence cards. Reorder
// them, tighten the claims, add a headline and a short narrative, then export
// a one-page brief through the shared print pipeline. Pins live in Supabase
// (shared with colleagues, like annotations); the headline/narrative are
// per-browser drafts kept in localStorage until exported.

const META_KEY = 'insight-briefing-meta'

const KIND_META: Record<PinKind, { label: string; color: string }> = {
  'kpi':          { label: 'KPI',       color: 'var(--nr-orange)' },
  'timeline':     { label: 'Timeline',  color: 'var(--nr-blue)' },
  'level-impact': { label: 'By level',  color: '#5B9EA0' },
  'risk-impact':  { label: 'Risk',      color: '#5B9EA0' },
  'duration':     { label: 'Duration',  color: '#9B59B6' },
  'incident':     { label: 'Incident',  color: 'var(--nr-red, #E74C3C)' },
}

function fmtWindow(pin: BriefingPin): string {
  if (!pin.window_from || !pin.window_to) return ''
  return `${pin.window_from} – ${pin.window_to}`
}

export function BriefingTab({ supabaseConfigured, demoMode }: { supabaseConfigured: boolean; demoMode: boolean }) {
  const [pins, setPins] = useState<BriefingPin[] | null>(null)
  const [title, setTitle] = useState('Operations Briefing')
  const [subtitle, setSubtitle] = useState('')
  const [intro, setIntro] = useState('')
  const metaLoaded = useRef(false)

  // Draft headline/narrative survive tab switches and reloads per browser.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(META_KEY)
      if (raw) {
        const m = JSON.parse(raw)
        if (typeof m.title === 'string' && m.title) setTitle(m.title)
        if (typeof m.subtitle === 'string') setSubtitle(m.subtitle)
        if (typeof m.intro === 'string') setIntro(m.intro)
      }
    } catch { /* corrupt draft — start fresh */ }
    metaLoaded.current = true
  }, [])
  useEffect(() => {
    if (!metaLoaded.current) return
    try { localStorage.setItem(META_KEY, JSON.stringify({ title, subtitle, intro })) } catch { /* storage full */ }
  }, [title, subtitle, intro])

  const load = async () => {
    setPins(await fetchPins())
  }
  useEffect(() => {
    if (supabaseConfigured && !demoMode) load()
    else setPins([])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ordered = pins ?? []

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...ordered]
    const j = idx + dir
    if (j < 0 || j >= next.length) return
    ;[next[idx], next[j]] = [next[j], next[idx]]
    const renumbered = next.map((p, i) => ({ ...p, position: i }))
    setPins(renumbered)
    // Persist the whole order — pin counts are small, and rewriting every
    // index keeps epoch-seeded positions from new pins consistent.
    Promise.all(renumbered.map(p => updatePin(p.id, { position: p.position }))).catch(() => {})
  }

  const remove = async (id: string) => {
    setPins(ps => (ps ?? []).filter(p => p.id !== id))
    await deletePin(id)
  }

  const patchLocal = (id: string, patch: Partial<BriefingPin>) => {
    setPins(ps => (ps ?? []).map(p => (p.id === id ? { ...p, ...patch } : p)))
  }

  const exportMeta = () => ({
    title: title.trim() || 'Operations Briefing',
    subtitle: subtitle.trim() || undefined,
    intro: intro.trim() || undefined,
    generatedOn: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
  })

  const canExport = ordered.length > 0

  if (!supabaseConfigured || demoMode) {
    return (
      <div className="card p-5">
        <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Briefing</h3>
        <div className="py-12 text-center text-xs" style={{ color: 'var(--ink-500)' }}>
          Pinned findings are stored in the shared database — connect a live database to use the Briefing composer.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">

      {/* ── Composer header ──────────────────────────────────────────────── */}
      <div className="card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
          <div>
            <h3 className="serif text-lg" style={{ color: 'var(--ink-100)' }}>Briefing Composer</h3>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-400)' }}>
              Pinned findings become evidence cards on a one-page brief · pins are shared; the headline and narrative below are your draft
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} className="btn flex items-center gap-1.5" title="Reload pins">
              <RefreshCw size={11} /> Refresh
            </button>
            <button
              onClick={() => downloadHtml(buildBriefingHtml(exportMeta(), ordered), reportFilename('briefing', title))}
              disabled={!canExport}
              className="btn flex items-center gap-1.5"
              style={!canExport ? { opacity: 0.4, cursor: 'not-allowed' } : {}}
            >
              <Download size={11} /> HTML
            </button>
            <button
              onClick={() => openPrintWindow(buildBriefingHtml(exportMeta(), ordered), title)}
              disabled={!canExport}
              className="btn btn-active flex items-center gap-1.5"
              style={!canExport ? { opacity: 0.4, cursor: 'not-allowed' } : {}}
            >
              <Printer size={11} /> Print / PDF
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="space-y-3">
            <div>
              <label className="label-micro mb-1 block text-[9px]">Headline</label>
              <input type="text" className="input w-full" value={title}
                     onChange={e => setTitle(e.target.value)}
                     placeholder="e.g. Fourteen days at Extreme: what the July heatwave did to the route" />
            </div>
            <div>
              <label className="label-micro mb-1 block text-[9px]">Scope line (optional)</label>
              <input type="text" className="input w-full" value={subtitle}
                     onChange={e => setSubtitle(e.target.value)}
                     placeholder="e.g. Event 4–17 Jul 2026 · baseline: Normal-rated days" />
            </div>
          </div>
          <div>
            <label className="label-micro mb-1 block text-[9px]">Narrative — “what this means” (optional)</label>
            <textarea className="input w-full" rows={4} value={intro}
                      onChange={e => setIntro(e.target.value)}
                      placeholder="Two or three plain-English sentences an exec can read in thirty seconds. Blank lines split paragraphs." />
          </div>
        </div>
      </div>

      {/* ── Pinned findings ──────────────────────────────────────────────── */}
      {pins == null ? (
        <div className="flex items-center justify-center py-16">
          <RefreshCw size={16} className="animate-spin" style={{ color: 'var(--ink-400)' }} />
        </div>
      ) : ordered.length === 0 ? (
        <div className="card p-5">
          <div className="py-12 flex flex-col items-center gap-3 text-center">
            <Pin size={26} style={{ color: 'var(--ink-500)' }} />
            <div className="text-sm" style={{ color: 'var(--ink-300)' }}>No findings pinned yet</div>
            <div className="text-[11px] max-w-md leading-relaxed" style={{ color: 'var(--ink-500)' }}>
              Browse any view and press <span className="numeric-mono" style={{ color: 'var(--ink-300)' }}>PIN</span> on
              a finding: the KPI cards and Daily Activity chart on <b>Overview</b>, and the level table, risk table and
              Duration Effect panel on <b>Weather</b>. Each pin captures the numbers plus the window and filters it was
              read under, then appears here ready to compose.
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {ordered.map((pin, idx) => {
            const km = KIND_META[pin.kind] ?? { label: pin.kind, color: 'var(--ink-400)' }
            return (
              <div key={pin.id} className="card p-4">
                <div className="flex items-start gap-3">
                  <span className="shrink-0 px-1.5 py-0.5 rounded-sm text-[9px] numeric-mono uppercase tracking-wider mt-1"
                        style={{ border: `1px solid ${km.color}`, color: km.color, background: `${km.color}18` }}>
                    {km.label}
                  </span>
                  <div className="flex-1 min-w-0 space-y-2">
                    <input
                      type="text"
                      className="input w-full !text-sm"
                      value={pin.title}
                      onChange={e => patchLocal(pin.id, { title: e.target.value })}
                      onBlur={e => updatePin(pin.id, { title: e.target.value })}
                      title="The claim as it will appear on the brief — edit freely"
                    />
                    <input
                      type="text"
                      className="input w-full !text-xs"
                      value={pin.comment ?? ''}
                      placeholder="Optional supporting sentence shown under the claim…"
                      onChange={e => patchLocal(pin.id, { comment: e.target.value })}
                      onBlur={e => updatePin(pin.id, { comment: e.target.value || null } as any)}
                    />
                    <div className="text-[10px] numeric-mono" style={{ color: 'var(--ink-500)' }}>
                      ⚲ {pin.source_label || 'Insight'} · {fmtWindow(pin)} · filters: {pin.filters_summary || 'none'}
                    </div>
                  </div>
                  <div className="shrink-0 flex flex-col items-center gap-1">
                    <button onClick={() => move(idx, -1)} disabled={idx === 0} className="btn !p-1" style={idx === 0 ? { opacity: 0.3 } : {}} title="Move up"><ChevronUp size={12} /></button>
                    <button onClick={() => move(idx, 1)} disabled={idx === ordered.length - 1} className="btn !p-1" style={idx === ordered.length - 1 ? { opacity: 0.3 } : {}} title="Move down"><ChevronDown size={12} /></button>
                    <button onClick={() => remove(pin.id)} className="btn !p-1 hover:!border-[var(--nr-red)]" title="Remove pin"><Trash2 size={12} style={{ color: 'var(--ink-400)' }} /></button>
                  </div>
                </div>
              </div>
            )
          })}
          <div className="flex items-start gap-2 px-1">
            <Info size={11} style={{ color: 'var(--ink-500)', flexShrink: 0, marginTop: 1 }} />
            <span className="text-[10px]" style={{ color: 'var(--ink-500)' }}>
              Consecutive KPI pins merge into one headline strip on the export; level / risk / incident cards flow into a
              two-column grid, in the order above. The export carries a fixed method footnote (per-day normalisation,
              delay conventions, correlation caveat) so the brief is always honest about how the numbers were made.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
