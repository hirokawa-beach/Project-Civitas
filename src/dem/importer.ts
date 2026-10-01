import proj4 from 'proj4';
import { GEOGRAPHIC_GRS80, importRegion } from './region';
export { GEOGRAPHIC_GRS80, importRegion } from './region';
import { HeightmapTerrain, DEFAULT_TERRAIN_SETTINGS, TERRAIN_VERSION } from '../terrain/heightmap';
import { mapAssetFromTerrain, suggestOutsideConnections } from '../maps/mapAsset';
import type { DemProvider, DemRaster, DemRequest } from './types';

export function validateRaster(raster: DemRaster): void {
  const { columns: c, rows: r, samples, affine: a } = raster;
  if (!Number.isInteger(c) || !Number.isInteger(r) || c < 2 || r < 2 || c * r > 16777216
    || !(samples instanceof Float32Array) || samples.length !== c * r || samples.some(v => !Number.isFinite(v) && !Number.isNaN(v))
    || !Array.isArray(a) || a.length !== 6 || !a.every(Number.isFinite) || Math.abs(a[1] * a[5] - a[2] * a[4]) < 1e-20)
    throw new Error('Invalid DEM raster dimensions, values or affine transform.');
  proj4(raster.crs, GEOGRAPHIC_GRS80); // Reject unknown CRS rather than silently treating it as geographic.
  const s = raster.source;
  if (!s || ![s.provider, s.dataset, s.sourceCrs, s.horizontalDatum, s.verticalDatum, s.attribution, s.termsUrl, s.license, s.sourceUrl].every(v => typeof v === 'string' && !!v.trim())
    || !Number.isFinite(s.nominalResolutionMeters) || s.nominalResolutionMeters <= 0) throw new Error('DEM source/attribution metadata is required.');
}

/** No extrapolation: only the half-pixel footprint at an outer edge is clamped. */
export function bilinear(raster: DemRaster, column: number, row: number, policy: 'reject' | 'renormalize' = 'reject'): { height: number; filled: boolean } {
  if (!Number.isFinite(column) || !Number.isFinite(row) || column < -.5 - 1e-7 || row < -.5 - 1e-7 || column > raster.columns - .5 + 1e-7 || row > raster.rows - .5 + 1e-7)
    throw new Error('Selected region extends outside the DEM coverage. Supply adjoining files or choose a smaller region.');
  const x = Math.max(0, Math.min(raster.columns - 1, column)), y = Math.max(0, Math.min(raster.rows - 1, row));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, raster.columns - 1), y1 = Math.min(y0 + 1, raster.rows - 1);
  let height = 0, weight = 0, filled = false;
  for (const [index, w] of [[y0 * raster.columns + x0, (1 - x + x0) * (1 - y + y0)], [y0 * raster.columns + x1, (x - x0) * (1 - y + y0)],
    [y1 * raster.columns + x0, (1 - x + x0) * (y - y0)], [y1 * raster.columns + x1, (x - x0) * (y - y0)]]) {
    if (w <= 1e-12) continue;
    const value = raster.samples[index];
    if (!Number.isFinite(value)) {
      if (policy === 'reject') throw new Error('DEM contains NoData in the selected region. Choose another region/dataset, or enable partial-cell interpolation. Water must be configured separately.');
      filled = true; continue;
    }
    height += value * w; weight += w;
  }
  if (weight <= 1e-12) throw new Error('DEM contains an entirely missing cell. Partial-cell interpolation cannot fill large gaps or ocean areas.');
  return { height: height / weight, filled };
}

/** Offline entry point: no network, no renderer/Simulation authority, no water inference. */
export function mapAssetFromDem(raster: DemRaster, request: DemRequest) {
  validateRaster(raster);
  const { world, crs, bounds } = importRegion(request), transform = proj4(crs, raster.crs);
  const a = raster.affine, determinant = a[1] * a[5] - a[2] * a[4];
  const heights = new Float32Array(world.terrainColumns * world.terrainRows);
  const policy = request.noDataPolicy ?? 'reject'; let min = Infinity, max = -Infinity, filled = 0;
  for (let row = 0; row < world.terrainRows; row++) for (let col = 0; col < world.terrainColumns; col++) {
    const [x, y] = transform.forward([col * world.terrainSampleSpacingMeters - world.worldWidthMeters / 2, world.worldDepthMeters / 2 - row * world.terrainSampleSpacingMeters]);
    const pixelX = ((x - a[0]) * a[5] - (y - a[3]) * a[2]) / determinant;
    const pixelY = ((y - a[3]) * a[1] - (x - a[0]) * a[4]) / determinant;
    const sample = bilinear(raster, pixelX, pixelY, policy);
    const index = row * world.terrainColumns + col; heights[index] = sample.height;
    min = Math.min(min, heights[index]); max = Math.max(max, heights[index]); if (sample.filled) filled++;
  }
  const terrain = HeightmapTerrain.fromBuffer({ width: world.worldWidthMeters, depth: world.worldDepthMeters, baseHeight: 0,
    terrainVersion: TERRAIN_VERSION, chunkSizeMeters: world.chunkSizeMeters,
    settings: { ...DEFAULT_TERRAIN_SETTINGS, sampleSpacing: world.terrainSampleSpacingMeters,
      minHeight: Math.min(DEFAULT_TERRAIN_SETTINGS.minHeight, Math.floor(min) - 100), maxHeight: Math.max(DEFAULT_TERRAIN_SETTINGS.maxHeight, Math.ceil(max) + 100) } }, heights);
  world.waterMode = 'explicit'; world.source = { kind: 'dem', name: raster.source.dataset, author: raster.source.provider, uri: raster.source.sourceUrl };
  world.georeference = { crs, affineTransform: [-world.worldWidthMeters / 2, world.terrainSampleSpacingMeters, 0, world.worldDepthMeters / 2, 0, -world.terrainSampleSpacingMeters], verticalDatum: raster.source.verticalDatum };
  world.demImport = { ...structuredClone(raster.source), center: { latitude: request.latitude, longitude: request.longitude }, geographicBounds: bounds,
    orientation: 'x-east-z-south', resampling: 'bilinear', noDataPolicy: policy, interpolatedNoDataSamples: filled };
  world.outsideConnections = suggestOutsideConnections(world, terrain);
  return mapAssetFromTerrain(request.identity, terrain.state(), world);
}
export async function importDem(provider: DemProvider, request: DemRequest, signal?: AbortSignal, progress?: (message: string) => void) {
  importRegion(request); const raster = await provider.load(request, signal, progress);
  signal?.throwIfAborted(); progress?.('Resampling terrain into local metres…');
  return mapAssetFromDem(raster, request);
}
