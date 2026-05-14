'use client'

// ─── Print / download helpers ────────────────────────────────────────────────
// The PDF pipeline is the browser's print engine — keeps fonts vector-clean,
// preserves CSS page layout, and avoids dragging a 300 kB+ PDF dependency
// into the bundle. Two ways the user gets the file:
//
//   • openPrintWindow(html, filename) — opens a new tab containing the
//     pre-styled HTML document, waits for fonts to settle, then invokes
//     print(). Picking "Save as PDF" in the browser dialog yields a perfect
//     vector PDF named via the document title.
//   • downloadHtml(html, filename) — saves the same document as a .html
//     archive. Some teams prefer this for forwarding or scrap-booking.

export function openPrintWindow(html: string, title: string): void {
  // Load the document via a blob URL rather than window.open('', ...) +
  // document.write. The document.write path leaves a blank tab in iPad
  // Safari (and any browser opened with the `noopener` window feature),
  // because the new window's document is then cross-document-isolated and
  // silently drops the writes. A blob URL is same-origin to the parent so
  // the new tab loads HTML directly and we can call print() once it's ready.
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const win  = window.open(url, '_blank')
  if (!win) {
    // Pop-up blocked entirely: trip the .html download so the user still
    // gets the file and can open / print it themselves.
    downloadHtml(html, reportFilename('report', title))
    URL.revokeObjectURL(url)
    return
  }

  const fire = () => {
    try { win.focus(); win.print() } catch {
      // Safari occasionally throws if the user has already closed the tab.
    }
  }
  // Wait for the new tab to finish loading the blob (and for webfonts to
  // settle, where supported) before invoking print so the dialog captures
  // the fully-styled page rather than a half-rendered cream rectangle.
  const onReady = () => {
    const fonts = (win.document as any)?.fonts
    if (fonts && fonts.ready) fonts.ready.then(() => setTimeout(fire, 200))
    else setTimeout(fire, 600)
  }
  if (win.document && win.document.readyState === 'complete') onReady()
  else win.addEventListener('load', onReady, { once: true })

  // Keep the blob alive long enough for the print dialog to read from it
  // before reclaiming the URL.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  // Hint document title in case the new window inherits the parent's tab name
  try { win.document.title = title } catch { /* cross-origin or not yet loaded */ }
}

export function downloadHtml(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function reportFilename(template: string, scope: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return `emcc-${safe(template)}-${safe(scope)}.html`
}
