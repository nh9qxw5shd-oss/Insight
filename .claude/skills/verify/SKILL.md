---
name: verify
description: Build, launch, and drive the Insight dashboard to verify UI changes end-to-end.
---

# Verifying Insight changes

Next.js 14 app, static-prerendered. No test suite — verify by driving the UI.

## Build & launch

```bash
npm ci                      # node_modules is not checked in
npx next build              # includes the typecheck
npx next start -p 3111 &    # serve the production build
```

Without `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` the app runs
in **demo mode** on deterministic synthetic data (`lib/syntheticData.ts`) — good
enough for verifying most UI flows. Live-only paths (Supabase queries in
`lib/queries.ts`) can't be exercised here; say so in the report.

Gotcha: after a rebuild, restart `next start` — the running server keeps stale
prerendered HTML referencing the old hashed CSS/JS chunks (page renders unstyled).

## Drive

Playwright with the preinstalled Chromium (do not `playwright install`):

```js
const { chromium } = require('playwright-core') // npm i playwright-core in scratchpad
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
```

Useful flows:
- Overview loads when `text=Total Incidents` appears.
- KPI tiles: the whole card is clickable — `page.locator('div.card', { hasText: 'Total Incidents' }).click()` opens the DrillDownModal (`h3:has-text("All Incidents")`).
- Nearly everything is a drill-down into the same modal: hotspots, repeat assets, routes, etc.
- Tabs are the top nav buttons (OVERVIEW, SAFETY, PERFORMANCE, …).
- WhatsApp tab: `page.setInputFiles` on the hidden input does not fire React's
  change handler — use `page.waitForEvent('filechooser')` + `chooser.setFiles`,
  or dispatch a `drop` event with a `DataTransfer` on `.card.border-dashed`.
  Give the fixture an ASCII-only file name; a path with an en dash never
  reaches the input. Modals portal to `<body>` and close on Escape.
