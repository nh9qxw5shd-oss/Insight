# EMR Diagram Exposure Profiling — Phase 1 Results

**Analysis basis:** NWR CIF full daily extract (12 Aug 2026), filtered to EMR (ATOC `EM`), permanent (STP `P`) schedules only. Diagrams inferred by chaining trips at shared locations with ≤90min turnaround. Passenger (OO/XX) trips classify diagrams into service groups by running-time-weighted vote; ECS legs included in exposure totals. Tier boundary: 600 min running. Mileage = chained great-circle distance between coordinate-known calling points (junction timing points excluded) — a consistent ~5–10% underestimate of true route miles, fine for comparison.

## Headline findings

1. **Full-day diagrams converge to similar daily workloads regardless of route.** Weekday/Saturday full-day archetypes all sit within ~800–930 min running, ~80–160 min dwell. Sunday compresses to ~690–725 min. Diagram *structure* is therefore not the main exposure differentiator across the fleet.
2. **The full-day / part-day tier split is what makes group averaging valid.** Raw group variance (SD up to ~300 min) collapses to SD ~60–140 once each group splits into full-day and part-day tiers. Group+tier archetypes are a sound simplification; diagram-level granularity is not needed for the PoC.
3. **Distance is the sharp differentiator.** Intercity full-day diagrams cover ~1,530–1,740 km/day at 62–70 mph effective; regional full-day diagrams cover ~590–1,030 km at 27–43 mph on near-identical hours. Intercity units sweep far more weather geography per day — the weather overlay (Phase 1 Step 3) will therefore discriminate primarily on *where* units run, which is precisely what the heat-exposure theory needs.
4. **Day-type structure:** Saturday ≈ weekday (marginally harder). Sunday is structurally different — shorter spans, and some groups (Corby–STP, Cleethorpes–Barton) run no full-day diagrams at all.

## Caveats

- One-unit-per-diagram assumed (breaks on disrupted days — flagged limitation).
- Small-n archetypes (n≤2) need manual review; e.g. Sunday 'Nottingham–Worksop full-day' (n=2, 1,108km) is clearly misclassified edge diagrams.
- Chained-trip diagram inference is an approximation of the real diagram book; validate a sample against actual EMR diagrams before Phase 2.

## Archetype table

| Day | Service group | Tier | n | Avg running (min) | Avg dwell (min) | Avg span (min) | Avg route (km) | Avg speed (mph) |
|---|---|---|---|---|---|---|---|---|
| saturday | Cleethorpes - Barton | full-day | 2 | 898 | 146 | 1044 | 893 | 37.1 |
| saturday | Corby - St Pancras | part-day | 4 | 431 | 41 | 472 | 764 | 66.1 |
| saturday | Crewe - Lincoln | full-day | 15 | 881 | 158 | 1040 | 788 | 33.3 |
| saturday | Crewe - Lincoln | part-day | 2 | 337 | 50 | 386 | 317 | 35.0 |
| saturday | Liverpool - Norwich | full-day | 24 | 912 | 82 | 994 | 1029 | 42.1 |
| saturday | Matlock - Nottingham/Cleethorpes | full-day | 18 | 839 | 133 | 972 | 813 | 36.1 |
| saturday | Nottingham - Leicester | full-day | 4 | 765 | 123 | 888 | 633 | 30.9 |
| saturday | Nottingham - Leicester | part-day | 2 | 104 | 2 | 105 | 96 | 34.4 |
| saturday | Nottingham - Skegness | full-day | 11 | 848 | 132 | 980 | 725 | 31.9 |
| saturday | Nottingham - Skegness | part-day | 5 | 503 | 53 | 555 | 399 | 29.6 |
| saturday | Nottingham - St Pancras | full-day | 12 | 928 | 105 | 1033 | 1744 | 70.0 |
| saturday | Nottingham - St Pancras | part-day | 4 | 436 | 44 | 480 | 821 | 70.2 |
| saturday | Nottingham - Worksop | full-day | 4 | 910 | 116 | 1026 | 678 | 27.8 |
| saturday | Nottingham - Worksop | part-day | 3 | 215 | 14 | 229 | 164 | 28.5 |
| saturday | Sheffield - St Pancras | full-day | 28 | 915 | 113 | 1028 | 1725 | 70.3 |
| saturday | Sheffield - St Pancras | part-day | 8 | 303 | 41 | 344 | 509 | 62.6 |
| saturday | UNCLASSIFIED | part-day | 5 | 97 | 40 | 137 | 101 | 39.0 |
| sunday | Cleethorpes - Barton | part-day | 2 | 206 | 23 | 230 | 193 | 34.8 |
| sunday | Corby - St Pancras | part-day | 13 | 375 | 72 | 447 | 654 | 65.0 |
| sunday | Liverpool - Norwich | full-day | 13 | 690 | 90 | 780 | 784 | 42.4 |
| sunday | Liverpool - Norwich | part-day | 5 | 502 | 63 | 566 | 561 | 41.6 |
| sunday | Matlock - Nottingham/Cleethorpes | full-day | 8 | 697 | 125 | 821 | 590 | 31.6 |
| sunday | Matlock - Nottingham/Cleethorpes | part-day | 9 | 438 | 75 | 513 | 367 | 31.2 |
| sunday | Nottingham - Skegness | full-day | 6 | 694 | 110 | 805 | 768 | 41.2 |
| sunday | Nottingham - Skegness | part-day | 11 | 429 | 97 | 526 | 443 | 38.5 |
| sunday | Nottingham - St Pancras | full-day | 4 | 713 | 162 | 875 | 1023 | 53.5 |
| sunday | Nottingham - St Pancras | part-day | 4 | 428 | 81 | 509 | 777 | 67.7 |
| sunday | Nottingham - Worksop | full-day | 2 | 844 | 156 | 1001 | 1108 | 48.9 |
| sunday | Nottingham - Worksop | part-day | 5 | 177 | 55 | 232 | 132 | 27.8 |
| sunday | Sheffield - St Pancras | full-day | 14 | 724 | 112 | 836 | 1204 | 62.0 |
| sunday | Sheffield - St Pancras | part-day | 19 | 376 | 57 | 433 | 648 | 64.3 |
| sunday | UNCLASSIFIED | full-day | 4 | 742 | 107 | 849 | 859 | 43.2 |
| sunday | UNCLASSIFIED | part-day | 9 | 240 | 75 | 315 | 250 | 38.9 |
| weekday | Cleethorpes - Barton | full-day | 2 | 892 | 140 | 1032 | 892 | 37.3 |
| weekday | Corby - St Pancras | full-day | 2 | 858 | 131 | 989 | 1532 | 66.6 |
| weekday | Corby - St Pancras | part-day | 4 | 290 | 40 | 329 | 427 | 55.0 |
| weekday | Crewe - Lincoln | full-day | 15 | 841 | 147 | 987 | 760 | 33.7 |
| weekday | Crewe - Lincoln | part-day | 2 | 382 | 52 | 434 | 428 | 41.8 |
| weekday | Lincoln - Peterborough | full-day | 2 | 902 | 160 | 1063 | 927 | 38.3 |
| weekday | Liverpool - Norwich | full-day | 17 | 850 | 80 | 929 | 966 | 42.4 |
| weekday | Liverpool - Norwich | part-day | 5 | 557 | 65 | 622 | 650 | 43.5 |
| weekday | Matlock - Nottingham/Cleethorpes | full-day | 16 | 840 | 131 | 971 | 819 | 36.3 |
| weekday | Nottingham - Leicester | full-day | 4 | 794 | 146 | 939 | 656 | 30.8 |
| weekday | Nottingham - Skegness | full-day | 8 | 842 | 122 | 964 | 771 | 34.1 |
| weekday | Nottingham - Skegness | part-day | 7 | 461 | 35 | 497 | 389 | 31.5 |
| weekday | Nottingham - St Pancras | full-day | 11 | 861 | 102 | 963 | 1537 | 66.5 |
| weekday | Nottingham - St Pancras | part-day | 4 | 418 | 62 | 479 | 725 | 64.7 |
| weekday | Nottingham - Worksop | full-day | 6 | 800 | 88 | 888 | 639 | 29.8 |
| weekday | Nottingham - Worksop | part-day | 8 | 281 | 43 | 324 | 198 | 26.3 |
| weekday | Sheffield - St Pancras | full-day | 27 | 915 | 122 | 1037 | 1637 | 66.7 |
| weekday | Sheffield - St Pancras | part-day | 15 | 370 | 44 | 414 | 650 | 65.5 |
| weekday | UNCLASSIFIED | full-day | 2 | 726 | 112 | 838 | 932 | 47.9 |
| weekday | UNCLASSIFIED | part-day | 6 | 164 | 43 | 207 | 143 | 32.6 |

## Next steps (agreed plan)

1. **Weather overlay (Step 3):** map each archetype's route geography to Open-Meteo historical grid points for chosen heatwave dates; split running/dwell hours into temperature bands (>25°C, >30°C).
2. **Incident cross-reference (Step 4):** CCIL extract filtered to unit-failure fault types; test whether faulting diagrams sit in heavier exposure bands.
3. **Then:** Insight build session — new 'Temperature Exposure' section using these preset archetypes.