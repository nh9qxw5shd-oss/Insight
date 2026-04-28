'use client'

import { AnalyticsFilters } from './types'

const STORAGE_KEY = 'insight_saved_views'

export interface SavedView {
  id: string
  name: string
  filters: AnalyticsFilters
  savedAt: string   // ISO timestamp
}

export function getSavedViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as SavedView[]) : []
  } catch {
    return []
  }
}

export function saveView(name: string, filters: AnalyticsFilters): SavedView {
  const views = getSavedViews()
  const view: SavedView = {
    id: `view-${Date.now()}`,
    name: name.trim(),
    filters,
    savedAt: new Date().toISOString(),
  }
  views.unshift(view)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(views.slice(0, 20)))
  return view
}

export function deleteView(id: string): void {
  const views = getSavedViews().filter(v => v.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(views))
}
