# Railway Core Pass — Issues #8 / #9

Base: `main` / `99217aa`. Railway uses independent TrackNode / TrackSegment IDs and adjacency. The Road Graph, traffic, transit and Map Asset schema stay independent. Pure curve/metric geometry and the common LandOwnership construction footprint API are reused.

## Phase 1 — infrastructure

`RailwayInfrastructure` is owned by SimulationState in the Simulation Worker. `build-track`, `place-station`, `place-depot`, `set-rail-switch` and `remove-railway` are commands, never renderer writes. Endpoints snap to Track segments; intersections split them and produce logical Junctions. Switch pairs constrain connectivity. Standard/narrow track types specify metre gauge, km/h limit, minimum radius, 4% surface grade and electrification placeholder.

All four construction modes are available from the Railway panel. Click start, direction control(s), end; Esc cancels, Backspace steps back. Continuous mode retains the circular-arc construction geometry; each completed arc remains an independent Track segment. Long straight legs are checked/sampled every 4m so tracks follow authoritative ground and reject hidden steep slopes/water. Paths exceeding 16,384 geometry samples must be built in shorter sections; this is a per-construction budget, not a World size limit.

Station placement snaps to a straight existing Track with 80m approaches and 20–400m platform length. Single (1 platform / 1 track), double (2 / 2), island (1 / 2) templates create Track sections, PlatformFace IDs, physical platform outlines and Junctions for the additional track. Each face records associated Track, offset, side and direction. `fitsPlatform(faceId, metres)` is the Formation length API. Depots have connected Track, capacity and a physical footprint. Remove stations/depots before deleting their referenced Track.

Track, Junction and PlatformFace are exclusive logical Block resources. Occupancy/reservation owner and atomic conflict checks are foundations for route requests. This deliberately conservative model is not detailed signaling or interlocking. Occupied/reserved infrastructure cannot be edited or undone. Railway construction shares the existing global Undo/Redo history; failed Undo/Redo keeps its history entry.

Save v13 gains optional additive `railway` version 1; missing means an empty railway. Full graph/station/platform/depot/block state is saved. Load validates detached components before replacing live state; malformed references/geometry/IDs reject the load. Infrastructure is protected from terrain brushes alongside existing road terrain protection. Renderer samples the authoritative Terrain and queries a Track grid index only when the camera crosses a 128m cell or view radius bucket. Only local Track/platform/depot representations are created; snapshots do not add heightmap copies. Network revision is separate from resource/runtime revision.

Phase 1 verification: `npm test` 306 tests / 40 files and Production Build passed, including 12 infrastructure regressions: independent/snap/switch graph, all curve modes, templates/faces/length/depot, atomic reservation conflict, sampled terrain/curve/water/owned land validation, shared Undo/Redo/terrain protection, legacy/corrupt saves.

## Scope

No OuDiaSecond converter, coupling/splitting, full interlocking, ATS/ATC, crew scheduling, detailed depot shunting, rail bridges/tunnels or new GIS imports. Internal stable railway IDs, integer game-second calls and separate services/formations/operations will allow a future #10 adapter.
