# World / Map foundation

The Worker owns `WorldMetadata` and City state. A metre remains one world unit. Map schema v1 contains independent width/depth, sample spacing, rows/columns, chunk size, explicit water geometry/boundaries/elevation, configured outside candidates, source/generator and optional georeference metadata. Climate/resources are reserved data, not simulated systems.

City Save v13 stores a detached copy under `world.metadata`. Versions 1–12 migrate with their terrain dimensions and sample spacing, default 256m chunks and `legacy-height` water mode. This preserves StaticWater semantics. New explicit maps will use independently authored water bodies. The legacy constants are defaults for compatibility, not new-map limits.

Map Assets own the initial height data plus this same metadata and separate library identity/name/description/author. `MapAsset.assetVersion` is 1; its `world.mapSchemaVersion` is 1. A City copies an asset on start and never reads it again by reference. The Map Library uses the separate IndexedDB database `project-civitas-maps`; City quicksaves retain `project-civitas`. Built-in assets are immutable and must be duplicated for editing. New IDs use `add` and reject duplicates; deliberate edits use `put` after validation.

World dimensions are limited by explicit allocation validation (up to 65,536m, 16,777,216 terrain samples, 65,536 chunks). This is a safety bound for current in-memory storage, not a streaming guarantee. Resolution is selectable independently of physical size. Width and depth may differ, with partial edge chunks. Dimensions must be divisible by sample spacing, and chunk size must contain an integral number of samples. Dirty terrain patches and camera-local meshes avoid whole-world frame work. Complete streaming/terrain LOD are deferred per #41.

## Authority and editing

`SimulationState` owns terrain, world metadata, hydrography, land ownership and all city systems. Editor actions use the Worker `map-operation` protocol (`load`, `water`, `outside`, `ownership`, `export`) and existing terrain operations. Renderer previews are drafts; the Worker validates and publishes accepted changes. Loading a map creates detached city systems and publishes them after validation, without reconciling the previous city against the new world's chunks.

Create Map offers procedural sources and blank/flat terrain, physical dimensions and sample spacing. The editor supports raise/lower/flatten/smooth, terrain undo/redo, water polygons or river paths, surface elevation, removal, and map-edge outside entries. Validation requires supported schemas, finite terrain, consistent dimensions, valid water geometry and at least one dry, gently sloped road entry. Rail/shipping entries are retained as metadata with an explicit future-support notice; implementing those transport systems is outside this pass.

Save as Map Asset persists a validated initial world. Map Library supports built-in/user maps, duplicate, rename/description, delete, edit and selection for New Game. City saves contain roads, zones, citizens, economy, traffic/transit and an independent world copy.

## Terrain storage and rendering

Initial load, explicit export and City save/load transfer height data once. Ordinary Worker snapshots omit the heightmap; terrain edits transfer only dirty patches, which the client applies to its height buffer. Smoothing reads a local halo instead of cloning all heights. The Renderer maintains meshes for chunks near its camera and retains dirty flags for distant chunks until they enter view. Camera chunk/radius changes update the local rectangle, without walking all terrain vertices each frame. Zone and lot geometry are grouped by chunk in one pass rather than rescanned for every chunk.

Current terrain storage remains a single validated typed buffer. Chunk patches and camera-local meshes provide the extension points for future tile storage and streaming. The UI offers 1/4/8/16/32km sizes and limits selectable terrain grids to 1025×1025 samples (including rectangular combinations). Dimension changes automatically select a safe spacing and remove unsafe spacing options. Recommended square-world spacing is 4/4/8/16/32m respectively. Metadata validation supports 64km at 64m spacing, without making 16km an architecture limit. Browser checks cover 1/4/16/32km; 64km is a metadata/validation check, not a browser or populated-world performance claim.

## Physical world and owned area

Physical bounds come from world width/depth. Independent Land Ownership Tiles use a separate `tileSizeMeters`; terrain chunks remain the terrain storage/rendering unit. Tile coordinates start at the world's minimum X/Z and partial edge tiles are clipped to physical bounds.

Additive schema-v1 `world.landOwnership` stores `mode`, `tileSizeMeters` and `startingTiles`. New Game and Map Library can choose `entire-map` or `progressive`. The Map Editor's LAND / START tab configures the Progressive Starting Area by clicking terrain or entering tile pairs, and displays nearby owned/locked outlines. Apply publishes validated settings through the Worker; saving the asset preserves them. A founded city owns a detached copy. Starting settings cannot be changed in the city.

Additive City Save v13 `landOwnership` stores `mode`, `tileSizeMeters` and sparse `ownedTiles`. Entire Map ownership is implicit: zero stored owned tiles, regardless of world size. Missing ownership in older v13 and v1–12 Saves migrates to Entire Map. Missing ownership in old Map Assets means Entire Map. Progressive saves validate starting-tile inclusion and all existing construction against owned land before publishing any live state.

`LandOwnership.canConstruct` is the common physical-bounds/ownership API used by Worker roads, zoning, automatic building lots and services, and by their Renderer-side previews. Polygon clipping checks the whole footprint rather than only vertices. Roads check their full width and the same sampled bend ribbon used for drawing; outside connection endpoints retain their previous physical-edge semantics. Entire Map permits existing construction within physical bounds. Progressive refuses construction crossing locked tiles. Zoning erasure and removal remain available.

City LAND controls focus a tile or unlock an edge-adjacent tile using an authoritative `unlock-land` command. Unlocks are currently free and permanent; purchase prices/economy rules were not specified. Undoing roads/zoning does not remove land ownership. Saving/reloading preserves unlocked tiles. This adds no terrain-tile entities or detailed simulation for empty/distant land. Ownership outlines and terrain meshes follow a camera-local rectangle; Citizen/Traffic/Transit scheduling and #14 instrumentation remain intact.

Large→Small world replacement also disposes cached zoning/debug meshes outside the incoming world, and rebuilds populated or previously cached chunks without creating empty zoning meshes for every physical chunk.

## Explicit water

New Map Assets use `waterMode: explicit`. Water bodies carry stable IDs, type, polygon/multipolygon (including holes) or river path/width profile, surface elevation, canonical boundary and optional source/flow metadata. `Hydrography` builds a chunk index and exposes `bodyAt`, `isWaterAt`, `waterSurfaceAt`, `distanceToShoreline` and exact `intersectsSegment` queries independent of terrain height. Overlapping bodies choose the highest surface, with a stable ID tie break.

Babylon surfaces triangulate the same Worker geometry. Per-body signatures preserve unaffected meshes when one body changes. Terrain edits neither reclassify explicit water nor recreate its meshes. Coastal/Islands generation captures wet-region boundaries once; River Valley outputs explicit river paths. Old procedural outputs can be converted once when creating an asset. This generator conversion is distinct from reading an imported elevation map: import adapters must supply explicit hydrography separately.

## Save and import contracts

Versions 1–12 follow the existing migration chain and acquire v13 metadata from their terrain dimensions. The legacy global sea level and StaticWater behavior remain in `legacy-height` mode, including replacement revision synchronization. Version 13 validates its outer world dimensions against metadata and terrain. Terrain spacing and chunk size are restored rather than reset to legacy defaults.

`mapAssetFromTerrain(identity, terrain, world)` is the reusable output API for procedural/heightmap and future DEM adapters. Importers provide heights, projected world metres, `source`, optional CRS/affine transform/vertical datum and independently sourced water bodies. The adapter validates and clones the data; it does not infer water from height. `assertMapAsset` is the publication/start-city gate; an editor may open a working map before its outside entries are playable.

DEM parsing (#38), GIS hydrography import, full scenario editing, climate simulation, Workshop/scripts, fluid simulation/flooding/tides, complete terrain LOD/streaming and origin rebasing are deferred according to the issues' scopes. No issue/current-implementation specification conflict was found; legacy water mode is the migration option explicitly allowed by #42.

See [verification and measurements](validation/world-foundation.md). Run `npm run benchmark:world` to regenerate the deterministic CPU measurement artifact.

The additional ownership/large-world pass is documented in [ownership verification](validation/land-ownership.md). Run `npm run benchmark:land` to regenerate its 1/4/16/32km CPU measurements.
