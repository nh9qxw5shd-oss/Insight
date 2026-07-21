'use client'

import { BriefingPin, BriefingMeta } from './briefing'
import { WeatherLevel } from './weatherLookahead'

// ─── Worked example: the July 2026 heatwave brief ────────────────────────────
// The exact findings used to build the heatwave one-pager, frozen as a
// teaching aid. "Load worked example" in the Briefing tab shows these in the
// composer (locally only — nothing is written to the shared pin board) so
// people can see what gets pinned, how the cards read, and what the export
// produces. Every figure was computed live from the shared database on
// 21 Jul 2026 using the standard conventions (per-day normalisation at each
// weather level; continuations counted once via incremental delay; off-route
// delay excluded; cancellations include part-cancellations).

const L = { G: 'GREEN', A: 'AWARE', D: 'ADVERSE', E: 'EXTREME' } as const

// Daily series 25 May – 20 Jul 2026: [date, incidents, delay-min, level]
const TIMELINE: [string, number, number, keyof typeof L | null][] = [
  ['2026-05-25', 56, 4771, 'E'], ['2026-05-26', 66, 9584, 'E'], ['2026-05-27', 50, 1390, 'D'], ['2026-05-28', 38, 2980, 'E'],
  ['2026-05-29', 48, 1954, 'D'], ['2026-05-30', 33, 488, 'E'], ['2026-05-31', 36, 1538, 'A'], ['2026-06-01', 36, 980, 'A'],
  ['2026-06-02', 53, 5089, 'D'], ['2026-06-03', 43, 1941, 'A'], ['2026-06-04', 74, 4665, 'D'], ['2026-06-05', 34, 1469, 'G'],
  ['2026-06-06', 30, 1618, 'D'], ['2026-06-07', 24, 423, 'A'], ['2026-06-08', 38, 2309, 'A'], ['2026-06-09', 29, 1134, 'D'],
  ['2026-06-10', 46, 1534, 'D'], ['2026-06-11', 38, 1655, 'G'], ['2026-06-12', 35, 2160, 'A'], ['2026-06-13', 24, 1638, 'A'],
  ['2026-06-14', 57, 888, 'A'], ['2026-06-15', 30, 1018, null], ['2026-06-16', 38, 3441, 'A'], ['2026-06-17', 56, 2787, 'A'],
  ['2026-06-18', 43, 1902, 'D'], ['2026-06-19', 42, 435, 'E'], ['2026-06-20', 24, 3692, 'D'], ['2026-06-21', 29, 1382, 'E'],
  ['2026-06-22', 63, 6575, 'E'], ['2026-06-23', 101, 7367, 'E'], ['2026-06-24', 50, 2526, 'E'], ['2026-06-25', 51, 2987, 'E'],
  ['2026-06-26', 46, 3230, 'E'], ['2026-06-27', 53, 1940, 'E'], ['2026-06-28', 31, 449, 'D'], ['2026-06-29', 48, 1160, 'A'],
  ['2026-06-30', 38, 2466, 'D'], ['2026-07-01', 44, 1881, 'G'], ['2026-07-02', 50, 3280, 'D'], ['2026-07-03', 42, 1977, 'D'],
  ['2026-07-04', 34, 2259, 'E'], ['2026-07-05', 31, 1954, 'E'], ['2026-07-06', 27, 607, 'E'], ['2026-07-07', 51, 4415, 'E'],
  ['2026-07-08', 57, 9329, 'E'], ['2026-07-09', 45, 2029, 'E'], ['2026-07-10', 33, 2748, 'E'], ['2026-07-11', 25, 2025, 'E'],
  ['2026-07-12', 18, 170, 'E'], ['2026-07-13', 37, 1847, 'E'], ['2026-07-14', 30, 3283, 'E'], ['2026-07-15', 27, 1309, 'E'],
  ['2026-07-16', 19, 65, 'E'], ['2026-07-17', 34, 1232, 'E'], ['2026-07-18', 25, 1376, 'D'], ['2026-07-19', 31, 1320, 'A'],
  ['2026-07-20', 47, 1193, 'D'],
]

// Per-day rates at each level across the joined coverage (31 Dec – 20 Jul):
// 65 Normal / 70 Aware / 35 Adverse / 31 Extreme days.
const LEVEL_DAYS: Record<WeatherLevel, number> = { GREEN: 65, AWARE: 70, ADVERSE: 35, EXTREME: 31 }
const levelRows = (rates: [number, number, number, number]) =>
  (['GREEN', 'AWARE', 'ADVERSE', 'EXTREME'] as WeatherLevel[]).map((level, i) => ({
    level, days: LEVEL_DAYS[level], rate: rates[i],
  }))

const ex = (n: number, pin: Omit<BriefingPin, 'id' | 'created_at' | 'position'>): BriefingPin => ({
  id: `example-${n}`,
  created_at: '2026-07-21T09:00:00Z',
  position: n,
  ...pin,
})

const SEASON = { window_from: '2025-12-31', window_to: '2026-07-20', filters_summary: 'none' }
const EVENT  = { window_from: '2026-07-04', window_to: '2026-07-17', filters_summary: 'none' }

export const HEATWAVE_EXAMPLE_META: BriefingMeta = {
  title: 'Fourteen days at Extreme: what the July heatwave did to the route',
  subtitle: 'Event 4 – 17 Jul 2026 · 14 consecutive Extreme days (Max Temp / Temp Range) · baseline: Normal-rated days, 31 Dec – 20 Jul · filters: none',
  intro:
    'The route ran fourteen straight days at Extreme — and the cost was not evenly spread. Total workload rose by ' +
    'two-thirds per day, but the growth was concentrated in heat-sensitive assets: train defects doubled and ' +
    'track-circuit failures ran at two-and-a-half times their normal daily rate, while people-related incident types barely moved.\n' +
    'Pressure also built with duration — day three of a spell is the break point, with rates falling back from day five ' +
    'as mitigations bed in. Resilience work aimed at rolling-stock heat tolerance and track-circuit hardening would ' +
    'target the two clearest growth areas this event exposed.',
  generatedOn: '21 Jul 2026',
}

export const HEATWAVE_EXAMPLE_PINS: BriefingPin[] = [
  ex(0, {
    kind: 'kpi', title: 'Extreme spell', comment: null,
    source_label: 'Worked example · Weather tab timeline', ...EVENT,
    payload: { value: '14 days', deltaPct: null, deltaInverted: true, caption: 'Longest unbroken Extreme run on record for the route' },
  }),
  ex(1, {
    kind: 'kpi', title: 'Incidents / day', comment: null,
    source_label: 'Worked example · Impact by Weather Level', ...SEASON,
    payload: { value: '40.2', deltaPct: null, deltaInverted: true, caption: '+67% on Extreme days vs the Normal-day baseline of 24.1' },
  }),
  ex(2, {
    kind: 'kpi', title: 'Delay / day', comment: null,
    source_label: 'Worked example · Impact by Weather Level', ...SEASON,
    payload: { value: '2,801 min', deltaPct: null, deltaInverted: true, caption: '+39% vs the Normal-day baseline of 2,020 min' },
  }),
  ex(3, {
    kind: 'kpi', title: 'Cancellations / day', comment: null,
    source_label: 'Worked example · Impact by Weather Level', ...SEASON,
    payload: { value: '67.4', deltaPct: null, deltaInverted: true, caption: '+53% vs 44.0 on Normal days — full + part cancellations' },
  }),
  ex(4, {
    kind: 'timeline',
    title: 'Eight weeks in one look — daily incidents, banded by operational weather level',
    comment: 'The 14-day Extreme run (4–17 Jul) sits at the right; the late-June Extreme cluster carried the biggest single-day spike (101 incidents, 23 Jun).',
    source_label: 'Worked example · Overview · Daily Activity',
    window_from: '2026-05-25', window_to: '2026-07-20', filters_summary: 'none',
    payload: { days: TIMELINE.map(([date, incidents, delayMins, l]) => ({ date, incidents, delayMins, level: l ? L[l] : null })) },
  }),
  ex(5, {
    kind: 'duration',
    title: 'Pressure builds with consecutive Extreme days — day three is the break point',
    comment: 'One Extreme day the route absorbs. By day three incidents nearly double and train defects treble; delay peaks on day four. From day five the rates fall back — consistent with the route adapting once a spell beds in, not the weather easing.',
    source_label: 'Worked example · Weather tab · Duration effect', ...SEASON,
    payload: {
      positions: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5+'],
      nDays: [9, 3, 3, 3, 13],
      panels: [
        { label: 'Incidents / day',     values: [33.4, 40.0, 61.3, 55.7, 36.5], unit: 'count' },
        { label: 'Delay minutes / day', values: [1835, 2947, 4248, 5508, 2476], unit: 'mins' },
        { label: 'Train defects / day', values: [7.1, 6.7, 22.0, 16.7, 7.5],    unit: 'count' },
      ],
    },
  }),
  ex(6, {
    kind: 'level-impact',
    title: 'Train defects nearly double on Extreme days',
    comment: 'On-train defects rise step-for-step with the weather level — the cleanest heat signature in the data.',
    source_label: 'Worked example · Weather tab · Impact by Weather Level', ...SEASON,
    payload: { metricLabel: 'Train defects', unit: 'count', rows: levelRows([4.94, 6.34, 8.34, 9.58]) },
  }),
  ex(7, {
    kind: 'level-impact',
    title: 'Track-circuit failures 2.6× more frequent on Extreme days',
    comment: 'Small absolute numbers, but the steepest relative climb of any asset type as the level rises.',
    source_label: 'Worked example · Weather tab · Impact by Risk Type (Max Temp)', ...SEASON,
    payload: { metricLabel: 'Track-circuit failures', unit: 'count', rows: levelRows([0.57, 0.86, 0.97, 1.48]) },
  }),
  ex(8, {
    kind: 'incident',
    title: "The spell's worst single incident",
    comment: "9S00 loss of power — one incident carrying 17% of the fortnight's entire delay, on the spell's hottest-impact day (9,329 delay minutes route-wide).",
    source_label: 'Worked example · Overview · Daily Activity drill-down', ...EVENT,
    payload: {
      date: '2026-07-08', title: '9S00 - Loss of power', location: 'Farringdon Station',
      typeLabel: 'On Train Defect - RB TW5', category: 'TRAIN_FAULT', delayMins: 5584, cancelled: 55,
    },
  }),
]
