'use client'

import { AnalyticsFilters, IncidentCategory, Severity } from './types'

// Pure helpers that return a new AnalyticsFilters with one value toggled or
// added. Used by chart click-handlers to drive the cross-filter drill-down
// flow — clicking a category slice / area bar / severity pill pushes that
// value into the corresponding filter list (or removes it if already there).

export function toggleCategoryFilter(f: AnalyticsFilters, c: IncidentCategory): AnalyticsFilters {
  return {
    ...f,
    categories: f.categories.includes(c)
      ? f.categories.filter(x => x !== c)
      : [...f.categories, c],
  }
}

export function toggleAreaFilter(f: AnalyticsFilters, area: string): AnalyticsFilters {
  return {
    ...f,
    areas: f.areas.includes(area)
      ? f.areas.filter(x => x !== area)
      : [...f.areas, area],
  }
}

export function toggleSeverityFilter(f: AnalyticsFilters, s: Severity): AnalyticsFilters {
  return {
    ...f,
    severities: f.severities.includes(s)
      ? f.severities.filter(x => x !== s)
      : [...f.severities, s],
  }
}

export function removeSearchToken(f: AnalyticsFilters, token: string): AnalyticsFilters {
  return { ...f, searches: f.searches.filter(s => s !== token) }
}

export function clearCustomDate(f: AnalyticsFilters): AnalyticsFilters {
  const { startDate: _s, endDate: _e, ...rest } = f
  return { ...rest }
}

export function clearDelayFilter(f: AnalyticsFilters): AnalyticsFilters {
  const { minDelay: _min, maxDelay: _max, ...rest } = f
  return { ...rest }
}

export function toggleIncidentTypeFilter(f: AnalyticsFilters, label: string): AnalyticsFilters {
  return {
    ...f,
    incidentTypes: f.incidentTypes.includes(label)
      ? f.incidentTypes.filter(x => x !== label)
      : [...f.incidentTypes, label],
  }
}

export function toggleStaffFilter(f: AnalyticsFilters, name: string): AnalyticsFilters {
  return {
    ...f,
    staffNames: f.staffNames.includes(name)
      ? f.staffNames.filter(x => x !== name)
      : [...f.staffNames, name],
  }
}

export function clearStaffFilter(f: AnalyticsFilters): AnalyticsFilters {
  return { ...f, staffNames: [] }
}
