import { validateWaterPolygon, waterPolygons } from '../water/geometry';
import type { Vec2, TerrainMetadata } from './types';
import type { GenerationMetadata } from '../terrain/generator';
import { entireMapOwnership, validateLandSettings, type LandOwnershipSettings } from './landOwnership';
import type { DemProvenance } from '../dem/types';

export const MAP_SCHEMA_VERSION = 1;
export interface WorldDimensions {
  worldWidthMeters: number;
  worldDepthMeters: number;
  terrainSampleSpacingMeters: number;
  terrainColumns: number;
  terrainRows: number;
  chunkSizeMeters: number;
}
export interface WaterPolygon { vertices: Vec2[]; holes?: Vec2[][] }
export type WaterGeometry = ({ kind: 'polygon' } & WaterPolygon)
  | { kind: 'multipolygon'; polygons: WaterPolygon[] }
  | { kind: 'river'; path: Vec2[]; widths: number[] };
export interface WaterBody {
  id: string;
  type: 'ocean' | 'sea' | 'river' | 'lake' | 'reservoir';
  geometry: WaterGeometry;
  surfaceElevation: number;
  boundary: Vec2[][];
  source?: { name?: string; uri?: string };
  flow?: { direction?: 'forward' | 'backward'; depthMeters?: number };
}
export interface MapOutsideConnection {
  id: string;
  type: 'road' | 'rail' | 'shipping';
  position: Vec2;
  name?: string;
}
export interface WorldMetadata extends WorldDimensions {
  /** Optional only for old schema-v1 assets/saves: missing means Entire Map. */
  landOwnership?: LandOwnershipSettings;
  mapSchemaVersion: typeof MAP_SCHEMA_VERSION;
  waterMode: 'legacy-height' | 'explicit';
  waterBodies: WaterBody[];
  outsideConnections: MapOutsideConnection[];
  generatorMetadata: GenerationMetadata | null;
  source: { kind: 'legacy' | 'procedural' | 'flat' | 'heightmap' | 'dem'; author?: string; name?: string; uri?: string };
  /** Projected sample-grid coordinates in metres; independent from terrain edits. */
  georeference?: { crs: string; affineTransform: [number, number, number, number, number, number]; verticalDatum?: string };
  demImport?: DemProvenance;
  climate?: Record<string, unknown>;
  resources?: Record<string, unknown>;
}
export const LEGACY_WORLD_DIMENSIONS: WorldDimensions = {
  worldWidthMeters: 1024, worldDepthMeters: 1024, terrainSampleSpacingMeters: 4,
  terrainColumns: 257, terrainRows: 257, chunkSizeMeters: 256,
};
export function createWorldMetadata(input: Partial<WorldDimensions> = {}): WorldMetadata {
  const dimensions = { ...LEGACY_WORLD_DIMENSIONS, ...input };
  dimensions.terrainColumns = dimensions.worldWidthMeters / dimensions.terrainSampleSpacingMeters + 1;
  dimensions.terrainRows = dimensions.worldDepthMeters / dimensions.terrainSampleSpacingMeters + 1;
  const world: WorldMetadata = { ...dimensions, mapSchemaVersion: MAP_SCHEMA_VERSION, waterMode: 'legacy-height',
    waterBodies: [], outsideConnections: [], generatorMetadata: null, source: { kind: 'legacy' }, landOwnership: entireMapOwnership() };
  validateWorldMetadata(world); return world;
}
export function worldBounds(world: WorldDimensions) {
  return { minX: -world.worldWidthMeters / 2, maxX: world.worldWidthMeters / 2,
    minZ: -world.worldDepthMeters / 2, maxZ: world.worldDepthMeters / 2 };
}
export function withinWorld(point: Vec2, world: WorldDimensions): boolean {
  const b = worldBounds(world);
  return Number.isFinite(point.x) && Number.isFinite(point.z) && point.x >= b.minX && point.x <= b.maxX && point.z >= b.minZ && point.z <= b.maxZ;
}
export function validateWorldMetadata(world: WorldMetadata, terrain?: TerrainMetadata): void {
  if (!world || world.mapSchemaVersion !== MAP_SCHEMA_VERSION) throw new Error('Unsupported map schema.');
  const { worldWidthMeters: w, worldDepthMeters: d, terrainSampleSpacingMeters: s, terrainColumns: c, terrainRows: r, chunkSizeMeters: chunk } = world;
  if (![w, d, s, chunk].every(Number.isFinite) || w < 64 || d < 64 || w > 65536 || d > 65536
    || s < .5 || s > 256 || chunk < 16 || chunk > 4096 || !Number.isInteger(chunk / s)
    || !Number.isInteger(c) || !Number.isInteger(r) || c !== w / s + 1 || r !== d / s + 1
    || c * r > 16777216 || Math.ceil(w / chunk) * Math.ceil(d / chunk) > 65536) throw new Error('Invalid world dimensions or terrain grid.');
  if (terrain && (terrain.width !== w || terrain.depth !== d || terrain.settings.sampleSpacing !== s || (terrain.chunkSizeMeters ?? 256) !== chunk))
    throw new Error('World and terrain metadata disagree.');
  validateLandSettings(world.landOwnership ?? entireMapOwnership(), world);
  if (!['legacy-height', 'explicit'].includes(world.waterMode) || !Array.isArray(world.waterBodies)
    || !Array.isArray(world.outsideConnections) || !world.source || !['legacy', 'procedural', 'flat', 'heightmap', 'dem'].includes(world.source.kind))
    throw new Error('Invalid world metadata.');
  const waterIds = new Set<string>();
  for (const body of world.waterBodies) {
    if (!body || typeof body.id !== 'string' || !body.id.trim() || waterIds.has(body.id)
      || !['ocean', 'sea', 'river', 'lake', 'reservoir'].includes(body.type) || !Number.isFinite(body.surfaceElevation)
      || !body.geometry || !Array.isArray(body.boundary) || !body.boundary.length) throw new Error('Invalid or duplicate Water Body.');
    waterIds.add(body.id);
    const path = (points: Vec2[], minimum: number) => {
      if (!Array.isArray(points) || points.length < minimum || points.length > 100000
        || points.some((point) => !point || !withinWorld(point, world))) throw new Error('Invalid Water Body geometry.');
    };
    const polygon = (p: WaterPolygon) => { path(p.vertices, 3); for (const hole of p.holes ?? []) path(hole, 3); validateWaterPolygon(p); };
    if (body.geometry.kind === 'polygon') polygon(body.geometry);
    else if (body.geometry.kind === 'multipolygon') {
      if (!Array.isArray(body.geometry.polygons) || !body.geometry.polygons.length) throw new Error('Invalid Water Body polygons.');
      for (const p of body.geometry.polygons) polygon(p);
    } else if (body.geometry.kind === 'river') {
      path(body.geometry.path, 2);
      if (!Array.isArray(body.geometry.widths) || body.geometry.widths.length !== body.geometry.path.length
        || body.geometry.widths.some((width) => !Number.isFinite(width) || width <= 0 || width > 4096)) throw new Error('Invalid river width profile.');
    } else throw new Error('Invalid Water Body geometry type.');
    if (body.geometry.kind === 'river') for (const p of waterPolygons(body.geometry, world)) polygon(p);
    for (const boundary of body.boundary) path(boundary, 2);
  }
  const outsideIds = new Set<string>();
  for (const connection of world.outsideConnections) {
    if (!connection || typeof connection.id !== 'string' || !connection.id.trim() || outsideIds.has(connection.id)
      || !['road', 'rail', 'shipping'].includes(connection.type) || !withinWorld(connection.position, world)) throw new Error('Invalid Outside Connection.');
    const b = worldBounds(world); const p = connection.position;
    if (Math.min(Math.abs(p.x - b.minX), Math.abs(p.x - b.maxX), Math.abs(p.z - b.minZ), Math.abs(p.z - b.maxZ)) > 2)
      throw new Error('Outside Connection must touch a world edge.');
    outsideIds.add(connection.id);
  }
  if (world.georeference && (typeof world.georeference.crs !== 'string' || !world.georeference.crs.trim()
    || !Array.isArray(world.georeference.affineTransform) || world.georeference.affineTransform.length !== 6
    || !world.georeference.affineTransform.every(Number.isFinite))) throw new Error('Invalid georeference metadata.');
  const dem = world.demImport;
  if (dem) {
    const bounds = dem.geographicBounds;
    if (!world.georeference || ![dem.provider, dem.dataset, dem.sourceCrs, dem.horizontalDatum, dem.verticalDatum,
      dem.attribution, dem.termsUrl, dem.license, dem.sourceUrl].every(v => typeof v === 'string' && !!v.trim())
      || !Number.isFinite(dem.nominalResolutionMeters) || dem.nominalResolutionMeters <= 0
      || !dem.center || ![dem.center.latitude, dem.center.longitude].every(Number.isFinite)
      || Math.abs(dem.center.latitude) > 80 || Math.abs(dem.center.longitude) > 180
      || !bounds || ![bounds.west, bounds.east, bounds.south, bounds.north].every(Number.isFinite)
      || bounds.west >= bounds.east || bounds.south >= bounds.north || bounds.west < -180 || bounds.east > 180 || bounds.south < -90 || bounds.north > 90
      || dem.resampling !== 'bilinear' || dem.orientation !== 'x-east-z-south' || !['reject', 'renormalize'].includes(dem.noDataPolicy)
      || !Number.isInteger(dem.interpolatedNoDataSamples) || dem.interpolatedNoDataSamples < 0 || dem.interpolatedNoDataSamples > c * r
      || (dem.tileZoom !== undefined && (!Number.isInteger(dem.tileZoom) || dem.tileZoom < 1 || dem.tileZoom > 17))
      || (dem.rasterSpacingMetersAtCenter !== undefined && (!Number.isFinite(dem.rasterSpacingMetersAtCenter) || dem.rasterSpacingMetersAtCenter <= 0))
      || (dem.files !== undefined && (!Array.isArray(dem.files) || dem.files.length > 256 || dem.files.some(f => typeof f !== 'string'))))
      throw new Error('Invalid DEM provenance metadata.');
    for (const url of [dem.termsUrl, dem.sourceUrl]) {
      try { if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error(); }
      catch { throw new Error('Invalid DEM attribution URL.'); }
    }
  }
}
