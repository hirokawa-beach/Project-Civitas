# Real-world DEM import — Issue #38

## Workflow

New Game → **DEM IMPORT** → enter centre latitude/longitude, width, depth and output sample spacing → **IMPORT & PREVIEW** → **OPEN MAP EDITOR** → review Terrain, Water Bodies and Outside Connections → Validate → Save as Map Asset. The existing Map Library starts an independent city from that asset.

The source can be current GSI PNG elevation tiles (DEM1A/5A/5B/5C/10B), or downloaded **unzipped UTF-8 GSI GML/XML files**. GSI downloads require their own account; the application does not collect credentials. Select adjoining files of the same dataset/datum/resolution together. ZIP extraction is left to the user.

Source survey spacing, fetched raster spacing/zoom and output spacing are separate metadata. Finer output spacing does not improve the source survey. Coverage varies by dataset; there is no silent fallback that would hide which dataset supplied the elevations.

NoData defaults to rejection with an actionable error. Optional partial-cell interpolation renormalizes valid bilinear corners within one source cell. Fully missing cells, including uncovered/ocean areas, still fail. Elevations below zero are preserved and do **not** create water. Water Bodies remain independently authored in the existing editor. No smoothing, vertical exaggeration or shoreline inference is applied.

## API / architecture

`src/dem/index.ts` exports:

- `DemProvider.load(request, signal, progress)` returns a provider-independent `DemRaster` with Float32 metre samples, NaN NoData, source CRS and affine transform of pixel centres.
- `mapAssetFromDem(raster, request)` is a synchronous, network-free entry point for custom GIS preprocessing/future GeoTIFF adapters.
- `gsiTileProvider(dataset)` handles bounded PNG acquisition; `decodeGsiPng`, `decodeGsiText` and `rasterFromGsiTiles` support downloaded tile inputs.
- `gsiGmlProvider(files)` / `decodeGsiGml` decode downloaded files; adjoining grids are mosaicked before interpolation. Mixed datums/resolutions and conflicting overlaps are rejected.
- `importDem(provider, request)` connects acquisition to the shared importer.

`request.dimensions` uses the existing `WorldDimensions` names: `worldWidthMeters`, `worldDepthMeters`, `terrainSampleSpacingMeters`, optional `terrainColumns`, `terrainRows`, `chunkSizeMeters`. Specified columns/rows must agree with the physical dimensions and spacing. The existing world validation/memory limits apply; the UI reuses safe world sizing. Rectangular grids are supported.

The creation Worker performs fetch, decode, projection and resampling. Provider implementations and GIS libraries are excluded from the Simulation Worker and UI main bundle. Simulation remains authoritative once the existing Map Asset load operation installs the terrain. No GIS calls, global world scans or extra heightmap transfers are introduced in simulation ticks/snapshots.

The importer uses a local transverse Mercator projection centred on the selected geographic point, GRS80, scale factor 1 at the centre. X points east, Z points south; the terrain grid runs NW→SE. World coordinates and raw source elevations are metres. Web Mercator source coordinates are reprojected, not copied as world metres. As with any planar metric projection, ground-distance distortion grows away from the centre; no global flat-earth distance guarantee is implied.

GML latitude/longitude follows its declared JGD2000/2011/2024 reference. The local projection is expressed in that source geographic frame. Source datum labels are retained; historical epoch/displacement and vertical datum corrections are not silently performed. Mixed reference frames are rejected. Generic raster adapters can supply a PROJ/EPSG/WKT definition supported by proj4.

## Metadata / compatibility

Optional additive `WorldMetadata.demImport` records provider, dataset, original source CRS, horizontal/vertical datum, nominal source resolution, selected centre/geographic bounds, attribution, terms/license references, bilinear/NoData policy, partial interpolation count, orientation, and tile zoom/raster spacing or local filenames. Existing `georeference` stores the local projection and affine sample-grid→east/north metre transform.

Map schema, Map Asset version and City Save version stay unchanged. Old assets/saves have no DEM provenance field. The existing validated asset/store/serializer preserves the new optional metadata and the embedded terrain. Imported terrain is the source of truth; City Save/Load and asset editing never refetch it. Terrain edit limits are widened around actual source extrema so mountain elevations are not clipped to the procedural range. The initial DEM camera aims at the authoritative ground elevation.

## Official specifications checked 2026-10-01

- [GSI tile catalogue](https://maps.gsi.go.jp/development/ichiran.html): current PNG dataset endpoints/zoom ranges. TXT tiles stopped receiving updates in October 2024; TXT decoding is offline legacy support only.
- [GSI PNG/TXT numeric format](https://maps.gsi.go.jp/development/demtile.html): signed 24-bit centimetres, RGB 128/0/0 NoData, 256×256 **source tiles**. Output dimensions are independent.
- [GSI tile production/resolution](https://maps.gsi.go.jp/development/hyokochi.html): source spacing, source coverage and lower-zoom averaging.
- [GSI current download formats](https://service.gsi.go.jp/kiban/app/help/) and [file specification 5.3, July 31 2026](https://service.gsi.go.jp/kiban/contents/screen/basismap/documents/FGD_DLFileSpecV5.3.pdf): UTF-8 JPGIS/GML, schema 5.1, `fguuid:jgd2024.bl`, latitude/longitude, NW row order, omitted start/end NoData. Older JGD-labelled files remain supported.
- [GSI announcements](https://maps.gsi.go.jp/help/): PNG elevation tiles updated to 測地成果2024 on March 31 2026. File imports retain the datum declared in their file.
- [GSI terms, revised November 20 2025](https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html): PDL 1.0, attribution and processing notice. Metadata and preview/editor/library show the provider and transformation credit. [Survey Act guidance](https://www.gsi.go.jp/LAW/2930-index.html) is linked because applicable uses may require a separate procedure. These references do not claim every subsequent use is exempt.

## Validation

`npm run verify:dem` fetches and caches real PNG tiles; `npm run verify:dem -- --offline` repeats without network acquisition. Reports include hashes of source tiles, bounds, terrain range, grid, source/output resolution, allocation/JSON sizes and deterministic asset reconstruction. Cache directories are ignored; one attributed Osaka PNG fixture is committed as base64 for offline regression tests.

| Region | World | Output | Elevation (metres) | Tiles |
| --- | --- | --- | --- | --- |
| Osaka Plain (34.69, 135.50) | 1024×1024m | 257×257, 4m | 0.94–4.10 | 4 |
| Kobe / Rokko foothills (34.74, 135.23) | 4096×4096m | 513×513, 8m | 28.20–829.28 | 9 |
| Kyoto Basin (35.00, 135.75) | 4096×4096m | 257×257, 16m | 19.34–47.52 | 4 |

See `benchmarks/dem-import.json` and `benchmarks/dem-import-offline.json`. These are creation-time CPU/I/O measurements, not simulation FPS benchmarks. Osaka ~460ms, Rokko ~671ms, Kyoto ~222ms including acquisition on this run; offline reconstruction ~174/401/169ms. Rokko output is ~1.05MB of Float32 terrain and ~4.71MB JSON asset. DEM provenance adds a small fixed metadata record; routine snapshots continue to omit complete heightmaps.

Regression coverage includes signed PNG/NoData/CRC validation, the actual Osaka fixture, current and legacy GML/startPoint, source mosaics/seams, metric/orientation/bounds and variable rectangular grids, bilinear/partial/missing/edge cases, invalid input, finite real mountain heights, bounded tile plans, cancellation/HTTP errors, offline creation Worker integration, editor water independence, asset and city persistence/metadata with fetch unavailable.

Local verification: **291 tests in 38 files passed**, Production Build passed. The existing Babylon bundle-size warning remains; no new simulation dependency was introduced. Dependency audit reports the two existing moderate Vitest/mocker development advisories and no advisory in the new production dependencies.

Browser smoke used the Production Build at a separate localhost origin to preserve existing saves. Osaka online Preview → Editor → Validation (4 usable road entries) → Save → Library → New Game succeeded. Rokko 4km / 513×513 preview and high-elevation Editor display succeeded (about 60 FPS / 16.7ms, 81 local chunks at the initial view). GML file selection exercised the creation Worker and explicit NoData rejection/partial interpolation. No captured browser console errors/warnings were reported. One initial online fetch failed transiently; retry succeeded, with an actionable retry/file-input error path.

Screenshots: [Osaka saved asset](screenshots/dem-osaka-library.png), [Rokko preview](screenshots/dem-rokko-preview.png), [Rokko editor](screenshots/dem-rokko-editor.png). Editor FPS here is a smoke observation of an empty imported world, not a populated-city performance comparison.

Deferred by scope: GeoTIFF decoder, generic image UI, bounding-box/map picking UI, ZIP extraction, datum correction grids, terrain streaming, hydrography GIS import, OSM/roads/buildings/railways/imagery. They do not block the elevation import API/required workflow.
