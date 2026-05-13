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
  const win = window.open('', '_blank', 'noopener')
  if (!win) {
    // Pop-up blocker. Fall back to a blob URL the user can open manually.
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    return
  }
  win.document.open()
  win.document.write(html)
  win.document.title = title
  win.document.close()

  // Wait for fonts + images to load before firing print so the dialog
  // captures the styled document, not a half-rendered cream rectangle.
  const fire = () => {
    try {
      win.focus()
      win.print()
    } catch {
      // ignore — some Safari versions throw if the window has been navigated away
    }
  }
  if ((win.document as any).fonts && (win.document as any).fonts.ready) {
    ;(win.document as any).fonts.ready.then(() => setTimeout(fire, 80))
  } else {
    setTimeout(fire, 600)
  }
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
