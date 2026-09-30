# Performance & Crowd Pass comparison

Main base: `9c7e930`. Phase 1 Before commit: `67d1165` (248 tests and production build passed before Phase 2). Final Phase 2: 254 tests / 30 files pass, production build passes.

## Environment and method

Windows, Intel Core Ultra 5 125H (18 logical CPUs), Intel Arc Graphics (driver 32.0.101.6790), 16 GB RAM; Node 22.23.2; Chrome 154. Browser viewport 1920 × 1080, DPR approximately 1, balanced profile, x1, one benchmark tab. Actual backend is recorded in each result. VSync limits these runs to approximately 60 FPS. Each scenario uses 3.5 s warmup + 4 s sampling. CPU uses the same seed/input, 10 warmups + 32 fixed 50 ms ticks, no browser. No tests/build/CPU benchmark ran concurrently with measured GPU windows.

Synthetic layouts use real PopulationSystem households, CitizenSystem identities/routes/events and Traffic/Transit/Economy systems. They are isolated Worker fixtures, not long-running playable 100k cities. Cold fixture construction is separately reported as setupMs. Timing/count variation between browser samples is expected because the real-time clock and arrivals continue.

FPS is Babylon's moving average at collection time; frame mean/p95 cover the retained measured frame samples. They need not be exact reciprocals. Use frame mean/p95 to compare the complete sample window.

## WEBGPU — Before → After

| Scenario | FPS | Frame mean ms | Frame p95 ms | Camera candidates | Actually rendered citizens |
|---|---:|---:|---:|---:|---:|
| empty | 60.02 → 60.11 | 16.67 → 16.67 | 16.80 → 16.80 | 0 → 0 | 0 → 0 |
| roads-100 | 60.18 → 60.00 | 16.67 → 16.67 | 18.20 → 16.80 | 0 → 0 | 0 → 0 |
| roads-1000 | 59.90 → 59.99 | 16.67 → 16.67 | 19.80 → 18.00 | 0 → 0 | 0 → 0 |
| population-10k | 59.96 → 59.94 | 16.67 → 16.67 | 20.90 → 18.60 | 1000 → 1000 | 805 → 695 |
| population-50k | 60.01 → 60.00 | 16.67 → 16.73 | 22.90 → 16.90 | 4063 → 4201 | 1500 → 2569 |
| population-100k | 58.77 → 60.00 | 17.01 → 17.24 | 24.00 → 18.20 | 8619 → 9151 | 1500 → 5617 |
| commercial-crowd | 59.99 → 58.74 | 16.67 → 16.74 | 17.00 → 16.90 | 6000 → 6000 | 1500 → 6000 |
| transit-hotspot | 59.99 → 59.83 | 16.81 → 16.81 | 22.80 → 17.40 | 4500 → 5960 | 1500 → 5960 |
| camera-6000 | 58.13 → 59.99 | 16.74 → 17.09 | 17.80 → 16.90 | 6000 → 6000 | 1500 → 6000 |

CPU work in the browser (mean per recorded call; LOD pose updates skip frames):

| Scenario | Worker citizen query ms | Renderer selection ms | Pose/buffer fill ms | Instance upload ms | After crowd buffer KiB | After draw calls/frame |
|---|---:|---:|---:|---:|---:|---:|
| empty | 0.00 → 0.00 | 0.01 → 0.01 | 0.00 → 0.01 | 0.000 → 0.014 | 512 | 15 |
| roads-100 | 0.00 → 0.00 | 0.00 → 0.02 | 0.00 → 0.01 | 0.000 → 0.033 | 512 | 15 |
| roads-1000 | 0.00 → 0.00 | 0.00 → 0.01 | 0.00 → 0.03 | 0.000 → 0.000 | 512 | 505 |
| population-10k | 18.69 → 0.76 | 1.01 → 1.50 | 1.29 → 0.18 | 0.391 → 0.029 | 512 | 160 |
| population-50k | 34.09 → 3.34 | 1.82 → 4.91 | 2.47 → 0.72 | 0.482 → 0.038 | 512 | 654 |
| population-100k | 44.90 → 7.89 | 1.90 → 8.50 | 3.06 → 1.68 | 0.585 → 0.052 | 512 | 1274 |
| commercial-crowd | 35.88 → 2.44 | 1.74 → 9.14 | 3.08 → 1.61 | 0.685 → 0.040 | 512 | 128 |
| transit-hotspot | 33.07 → 1.91 | 1.88 → 14.68 | 3.10 → 1.45 | 0.669 → 0.059 | 512 | 131 |
| camera-6000 | 32.34 → 2.29 | 1.69 → 11.44 | 3.26 → 1.82 | 0.653 → 0.050 | 512 | 128 |

Live Worker message estimate and optional JS heap (MiB; heap is GC-dependent, not retained GPU memory):

| Scenario | Message logical MiB | Sampled JS heap MiB |
|---|---:|---:|
| empty | 0.00 → 0.00 | 20.56 → 80.25 |
| roads-100 | 0.07 → 0.07 | 21.77 → 37.93 |
| roads-1000 | 0.70 → 0.70 | 67.46 → 58.98 |
| population-10k | 0.92 → 0.94 | 100.94 → 47.93 |
| population-50k | 1.53 → 3.68 | 51.14 → 105.19 |
| population-100k | 1.84 → 7.77 | 149.00 → 169.38 |
| commercial-crowd | 1.34 → 5.37 | 72.21 → 127.91 |
| transit-hotspot | 1.33 → 4.67 | 67.87 → 89.19 |
| camera-6000 | 1.34 → 5.37 | 99.55 → 37.10 |

## WEBGL2 — Before → After

| Scenario | FPS | Frame mean ms | Frame p95 ms | Camera candidates | Actually rendered citizens |
|---|---:|---:|---:|---:|---:|
| empty | 60.00 → 60.00 | 16.67 → 16.67 | 16.90 → 16.80 | 0 → 0 | 0 → 0 |
| roads-100 | 60.68 → 59.96 | 16.66 → 16.67 | 18.10 → 16.80 | 0 → 0 | 0 → 0 |
| roads-1000 | 60.00 → 59.99 | 16.67 → 16.67 | 16.90 → 16.80 | 0 → 0 | 0 → 0 |
| population-10k | 60.08 → 61.03 | 16.67 → 16.67 | 19.00 → 16.90 | 1000 → 1000 | 805 → 695 |
| population-50k | 60.00 → 58.99 | 16.67 → 16.72 | 16.90 → 16.90 | 4110 → 4113 | 1500 → 2545 |
| population-100k | 60.01 → 59.99 | 16.80 → 17.02 | 18.40 → 16.90 | 8502 → 9476 | 1500 → 5824 |
| commercial-crowd | 60.01 → 57.70 | 16.67 → 16.75 | 22.70 → 19.40 | 6000 → 6000 | 1500 → 6000 |
| transit-hotspot | 60.01 → 60.00 | 16.67 → 16.80 | 17.00 → 17.20 | 4500 → 5960 | 1500 → 5960 |
| camera-6000 | 59.99 → 59.95 | 16.67 → 17.10 | 16.90 → 17.70 | 6000 → 6000 | 1500 → 6000 |

CPU work in the browser (mean per recorded call; LOD pose updates skip frames):

| Scenario | Worker citizen query ms | Renderer selection ms | Pose/buffer fill ms | Instance upload ms | After crowd buffer KiB | After draw calls/frame |
|---|---:|---:|---:|---:|---:|---:|
| empty | 0.00 → 0.00 | 0.02 → 0.06 | 0.00 → 0.00 | 0.020 → 0.000 | 512 | 15 |
| roads-100 | 0.00 → 0.00 | 0.00 → 0.02 | 0.01 → 0.00 | 0.014 → 0.020 | 512 | 15 |
| roads-1000 | 0.00 → 0.00 | 0.00 → 0.01 | 0.01 → 0.00 | 0.000 → 0.011 | 512 | 505 |
| population-10k | 14.88 → 1.57 | 0.96 → 1.82 | 1.37 → 0.22 | 0.451 → 0.029 | 512 | 160 |
| population-50k | 31.84 → 3.75 | 1.52 → 3.57 | 2.43 → 0.71 | 0.531 → 0.023 | 512 | 654 |
| population-100k | 47.28 → 7.87 | 1.71 → 8.48 | 3.01 → 1.36 | 0.545 → 0.036 | 512 | 1274 |
| commercial-crowd | 34.31 → 3.38 | 1.86 → 10.13 | 3.27 → 1.66 | 0.637 → 0.036 | 512 | 128 |
| transit-hotspot | 30.25 → 2.17 | 1.61 → 10.09 | 3.11 → 1.63 | 0.626 → 0.046 | 512 | 131 |
| camera-6000 | 31.34 → 2.64 | 1.47 → 13.51 | 3.34 → 1.81 | 0.622 → 0.038 | 512 | 128 |

Live Worker message estimate and optional JS heap (MiB; heap is GC-dependent, not retained GPU memory):

| Scenario | Message logical MiB | Sampled JS heap MiB |
|---|---:|---:|
| empty | 0.00 → 0.00 | 29.14 → 20.57 |
| roads-100 | 0.07 → 0.07 | 30.03 → 24.59 |
| roads-1000 | 0.70 → 0.70 | 48.50 → 52.73 |
| population-10k | 0.92 → 0.94 | 139.67 → 39.30 |
| population-50k | 1.53 → 3.62 | 123.64 → 113.46 |
| population-100k | 1.84 → 7.96 | 189.57 → 84.25 |
| commercial-crowd | 1.34 → 5.37 | 100.44 → 42.38 |
| transit-hotspot | 1.33 → 4.67 | 95.78 → 38.55 |
| camera-6000 | 1.34 → 5.37 | 88.24 → 76.14 |

## Deterministic CPU — Before → After

| Scenario | Tick mean ms | Tick p95 ms | Query mean ms | Query p95 ms | Camera candidates | Selected citizens |
|---|---:|---:|---:|---:|---:|---:|
| empty | 0.033 → 0.027 | 0.041 → 0.036 | 0.032 → 0.025 | 0.036 → 0.036 | 0 → 0 | 0 → 0 |
| roads-100 | 0.469 → 0.477 | 0.675 → 0.882 | 0.020 → 0.020 | 0.061 → 0.036 | 0 → 0 | 0 → 0 |
| roads-1000 | 4.507 → 4.219 | 6.102 → 5.761 | 0.014 → 0.013 | 0.022 → 0.017 | 0 → 0 | 0 → 0 |
| population-10k | 0.270 → 0.100 | 0.461 → 0.160 | 27.074 → 0.561 | 37.394 → 1.032 | 986 → 986 | 762 → 762 |
| population-50k | 0.265 → 0.240 | 0.956 → 0.651 | 100.671 → 4.022 | 147.379 → 5.047 | 4883 → 4893 | 1500 → 3690 |
| population-100k | 0.327 → 0.284 | 0.631 → 0.935 | 178.143 → 9.750 | 318.994 → 11.499 | 9775 → 9792 | 1500 → 7426 |
| commercial-crowd | 0.230 → 0.176 | 0.303 → 0.229 | 165.726 → 3.309 | 247.828 → 5.035 | 6000 → 6000 | 1500 → 6000 |
| transit-hotspot | 0.411 → 0.261 | 2.071 → 1.291 | 141.532 → 2.043 | 181.256 → 2.506 | 4500 → 5960 | 1500 → 5960 |
| camera-6000 | 0.261 → 0.189 | 0.533 → 0.273 | 172.109 → 3.367 | 250.798 → 4.916 | 6000 → 6000 | 1500 → 6000 |

Payload/memory indicators:

| Scenario | Full snapshot logical MiB | Traffic logical MiB | Citizen save logical MiB |
|---|---:|---:|---:|
| empty | 0.26 → 0.26 | 0.00 → 0.00 | 0.00 → 0.00 |
| roads-100 | 0.33 → 0.33 | 0.03 → 0.03 | 0.00 → 0.00 |
| roads-1000 | 0.95 → 0.95 | 0.31 → 0.31 | 0.00 → 0.00 |
| population-10k | 1.16 → 1.18 | 0.83 → 0.84 | 3.97 → 3.97 |
| population-50k | 2.85 → 4.34 | 2.27 → 3.76 | 19.58 → 19.58 |
| population-100k | 3.18 → 8.40 | 2.28 → 7.50 | 39.28 → 39.28 |
| commercial-crowd | 2.89 → 5.62 | 2.58 → 5.31 | 6.73 → 6.73 |
| transit-hotspot | 2.88 → 4.92 | 2.57 → 4.61 | 6.77 → 6.77 |
| camera-6000 | 2.89 → 5.62 | 2.58 → 5.31 | 6.73 → 6.73 |

## Interpretation and limits

- Dense commercial/camera fixtures render all 6000 actual nearby people; transit renders 5960 after 40 actual passengers board. Outdoor visiting uses actual stroll dwell state; inside-building occupants are not invented outside. Existing bus stops provide the station-like hotspot; no rail/station system was added.
- 50k remains near 60 FPS; 100k stays above the 30 FPS target while drawing more people. The 100k scene has approximately 1274 total draw calls/frame, including its many existing building meshes; the crowd uses at most eight batch meshes. These fixtures do not establish a hardware-independent guarantee or include sustained city growth/zoning recalculation.
- Query improvement comes from cached detached candidates, shared routes, cumulative-distance binary search, and avoiding sort/truncation when all local identities are requested. Renderer selection can cost more because it now handles more candidates and frustum/LOD decisions; pose rates and reusable thin-instance buffers bound frame work.
- More real camera-local people increase expanded payload estimates. Shared route references survive structured clone within a message but this estimator counts them repeatedly; exact transport allocation is not measured. Citizen save state retains individual authority and unchanged identity data. New transit ready/alighted fields are optional; legacy saves still load.
- Node heap readings include fixture creation/GC, and browser heap samples depend on GC and previous scenarios. Do not claim retained-memory savings from these values. Thin-instance buffers reuse power-of-two capacity; retained capacity from earlier scenes is visible even in Empty.
- Before drawCalls was cumulative. Final instrumentation resets it per frame; that field cannot be compared as a per-frame Before metric. Other metrics retain their definitions.
- Build passes with the existing large-chunk advisory; it is not a console/runtime error. Complete timing distributions, setup cost, pathfinding, population, economy, traffic, citizen events, terrain/chunk timings and counts are in the six JSON reports.

## Regression and browser verification

254 tests pass, including deterministic fixtures, 6000 real identities, no density drop under detail pressure, camera leave/return with continued Worker journey, Near/Mid/Far hysteresis and frustum filtering, shared-route/GPU-buffer reuse and picking, transit access/wait/alight, two-dimensional waiting positions, and optional transit save compatibility. Existing New Game, procedural map, startup load, migrations, traffic and transit tests pass. Full-save equality has a 30 s test timeout to avoid a hardware-dependent correctness gate.

Browser functional observations are recorded in `browser-verification.json`; screenshot evidence is saved locally and shown with the PR delivery.

Final WebGL2 checks: paused transit hotspot, 6000 camera candidates; zoom/pan near the stop, then rotate and return to wide view. Near/Mid/Far changed with distance/frustum; wide view restored all 6000. Game time stayed at 28800 and the sampled actual citizen position stayed unchanged throughout Pause. No crowd-wide flicker or arbitrary density drop was observed in the manual sequence. Commercial x1/x2/x4/x8 readings show advancing simulation time and actual citizen positions; those checks preceded the final stop-position hash correction, which does not change commercial movement code. Final benchmark and near/return checks use the final build. Console errors/warnings: none observed.

Normal application: Coastal preview generated (38% buildable, 46% water), then existing city loaded with 108 population, 36 households, actual citizen/vehicle rendering and no console errors/warnings. Existing save was not overwritten. New Game generation and legacy migration also pass the real Worker regression tests.
