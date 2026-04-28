'use client'

import { AnalyticsFilters, DEFAULT_FILTERS } from './types'

const PARAM = 'v'

export function encodeFilters(f: AnalyticsFilters): string {
  try {
    return btoa(JSON.stringify(f))
  } catch {
    return ''
  }
}

export function decodeFilters(s: string): AnalyticsFilters | null {
  try {
    const parsed = JSON.parse(atob(s))
    // Validate required shape — must have at least the required array fields
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.windowDays === 'number' &&
      Array.isArray(parsed.areas) &&
      Array.isArray(parsed.categories) &&
      Array.isArray(parsed.severities)
    ) {
      return { ...DEFAULT_FILTERS, ...parsed } as AnalyticsFilters
    }
    return null
  } catch {
    return null
  }
}

export function getFiltersFromUrl(): AnalyticsFilters | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const raw = params.get(PARAM)
  return raw ? decodeFilters(raw) : null
}

export function setFiltersInUrl(f: AnalyticsFilters): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  url.searchParams.set(PARAM, encodeFilters(f))
  window.history.replaceState(null, '', url.toString())
}

export function clearFiltersFromUrl(): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  url.searchParams.delete(PARAM)
  window.history.replaceState(null, '', url.toString())
}
