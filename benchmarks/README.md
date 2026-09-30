# Performance & Crowd Pass

The Before baseline is Phase 1, before changing crowd selection/rendering. CPU and browser runs are separate. Timing is informational; no GPU/FPS gate is used in unit tests.

## Reproduce

1. `npm test` and `npm run build`.
2. `npm run benchmark -- --output benchmarks/latest-simulation.json` (Node, no renderer).
3. Serve `dist` with `npx vite preview`. Open `/benchmark.html?renderer=webgpu` or `?renderer=webgl2`.
4. Use 1920 × 1080, device scale 1, balanced profile, one active benchmark tab. Run all scenarios. Export JSON. Do not run CPU benchmarks/tests simultaneously.

Browser runs use a 3.5 second warmup and 4 second measured window per scenario. Browser FPS is based on actual frame intervals; render CPU time is reported separately. WebGPU requests may fall back; the report records the backend actually used. The application Debug HUD also exports live performance metrics.

## Fixtures

Seed: `civitas-performance-v1`. Empty, 100/1000 segments, 10k/50k/100k individual citizens, commercial crowd, transit hotspot, 6000 camera-local pedestrians. Population stress cities activate one in ten residents; dense cities activate all 6000. The transit hotspot has real, named waiting passengers on a real bus line. Its pre-crowd renderer cannot display those waiting identities.

These are isolated stress layouts, not generated playable city saves. Building capacities use existing definitions. Household members become real CitizenSystem identities, with actual pedestrian routes or transit passenger records. Fixtures do not read/write IndexedDB or modify the user's city. Renderer receives snapshots from a dedicated simulation Worker. Future railway fixtures can be added to `SCENARIOS` without changing the report schema.

## Interpretation

- CPU runs use ten warmup ticks and 32 fixed 50ms ticks, reporting mean/p95/max. Setup cost is separate.
- Camera query count precedes visibility limits. Rendered/selected counts distinguish worker filtering from renderer cost.
- Pathfinding probes exercise real road routing (including cache hits), not a constant stand-in.
- Payload bytes estimate structured-clone data: UTF-8 strings, numbers, raw typed arrays. They are not exact browser heap or wire bytes. Heap readings are optional and affected by GC; Node heap before/after includes fixture construction and must not be read as retained city memory.
- No terrain vertices or population records are scanned by the renderer's per-frame update. Terrain mesh/chunk updates occur on changed terrain revisions/patches. Terrain chunk edit is measured separately in CPU runs.
- Targets from #14 (50k/60 FPS, 100k/30+ FPS) are goals, not proof across hardware. Reports include the measured environment.

Saved baseline and After reports are the evidence for the PR comparison. Scenario definitions and inputs remain identical between phases; timing variation and visible count changes are reported rather than hidden.
