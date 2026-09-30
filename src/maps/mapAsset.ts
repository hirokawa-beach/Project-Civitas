import { HeightmapTerrain, DEFAULT_TERRAIN_SETTINGS } from '../terrain/heightmap';
import { generateMap, presetParameters, validateGenerationMetadata, type GeneratedMap } from '../terrain/generator';
import { Hydrography } from '../water/geometry';
import { captureGeneratedWater } from '../water/generatedWater';
import { type WaterState } from '../water/staticWater';
import { createWorldMetadata, validateWorldMetadata, type WorldMetadata, type WorldDimensions } from '../world/metadata';
import type { TerrainState } from '../world/types';

export const MAP_ASSET_VERSION = 1;
export interface MapIdentity { id: string; name: string; description: string; author: string }
export interface MapAsset extends MapIdentity {
  assetVersion: typeof MAP_ASSET_VERSION;
  world: WorldMetadata;
  terrain: TerrainState;
  /** Retained only for importing an old procedural source before conversion. */
  legacyWater?: WaterState;
}
export interface MapAssetValidation { valid: boolean; errors: string[]; warnings: string[]; usableOutsideConnections: number }
export function validateMapAsset(asset: MapAsset): MapAssetValidation {
  const errors: string[] = []; const warnings: string[] = []; let usableOutsideConnections = 0;
  try {
    if (!asset || asset.assetVersion !== MAP_ASSET_VERSION || typeof asset.id !== 'string' || !asset.id.trim() || asset.id.length > 128
      || typeof asset.name !== 'string' || !asset.name.trim() || asset.name.length > 120 || typeof asset.description !== 'string' || asset.description.length > 4000
      || typeof asset.author !== 'string' || asset.author.length > 120) throw new Error('Invalid Map Asset identity or version.');
    validateWorldMetadata(asset.world, asset.terrain);
    const terrain = new HeightmapTerrain(asset.terrain);
    if (asset.world.waterMode !== 'explicit') throw new Error('New Map Assets must use explicit Water Bodies. Convert the legacy shoreline first.');
    if (asset.world.generatorMetadata) validateGenerationMetadata(asset.world.generatorMetadata);
    const water = new Hydrography(asset.world.waterBodies, asset.world);
    for (const connection of asset.world.outsideConnections) {
      if (connection.type === 'road' && !water.isWaterAt(connection.position.x, connection.position.z)
        && terrain.getNormal(connection.position.x, connection.position.z).y >= .98) usableOutsideConnections++;
      if (connection.type !== 'road') warnings.push(`${connection.type} connection ${connection.id} is metadata for future transport support.`);
    }
    if (!usableOutsideConnections) errors.push('Configure at least one road Outside Connection on gently sloped dry land at a map edge.');
  } catch (cause) { errors.push(cause instanceof Error ? cause.message : String(cause)); }
  return { valid: !errors.length, errors, warnings, usableOutsideConnections };
}
export function assertMapAsset(asset: MapAsset): void {
  const result = validateMapAsset(asset); if (!result.valid) throw new Error(result.errors.join(' '));
}
/** One reusable output contract for Procedural, heightmap and future DEM adapters. No DEM parsing. */
export function mapAssetFromTerrain(identity: MapIdentity, terrain: TerrainState, world: WorldMetadata): MapAsset {
  validateWorldMetadata(world, terrain); new HeightmapTerrain(terrain);
  return { ...identity, assetVersion: MAP_ASSET_VERSION, terrain: structuredClone(terrain), world: structuredClone(world) };
}
export function suggestOutsideConnections(world: WorldMetadata, terrain: HeightmapTerrain): WorldMetadata['outsideConnections'] {
  const water = new Hydrography(world.waterBodies, world); const w = world.worldWidthMeters / 2; const d = world.worldDepthMeters / 2;
  const candidates = [];
  for (let i = 1; i < 16; i++) for (const position of [{ x: -w, z: -d + 2 * d * i / 16 }, { x: w, z: -d + 2 * d * i / 16 },
    { x: -w + 2 * w * i / 16, z: -d }, { x: -w + 2 * w * i / 16, z: d }]) {
    if (!water.isWaterAt(position.x, position.z) && terrain.getNormal(position.x, position.z).y >= .98) candidates.push(position);
  }
  return candidates.slice(0, 4).map((position, i) => ({ id: `road-entry-${i + 1}`, type: 'road', position }));
}
export function mapAssetFromGenerated(map: GeneratedMap, identity: MapIdentity): MapAsset {
  const world = structuredClone(map.world ?? createWorldMetadata());
  world.source.kind = 'procedural'; world.generatorMetadata = structuredClone(map.metadata);
  if (world.waterMode === 'legacy-height') { world.waterMode = 'explicit'; world.waterBodies = captureGeneratedWater(map.heights, map.metadata.parameters.seaLevel, world, 'sea'); }
  const terrain = HeightmapTerrain.fromBuffer({ width: world.worldWidthMeters, depth: world.worldDepthMeters, baseHeight: 0, terrainVersion: 1,
    chunkSizeMeters: world.chunkSizeMeters, settings: { ...DEFAULT_TERRAIN_SETTINGS, sampleSpacing: world.terrainSampleSpacingMeters } }, map.heights);
  world.outsideConnections = suggestOutsideConnections(world, terrain);
  return mapAssetFromTerrain(identity, terrain.state(), world);
}
export function blankMapAsset(identity: MapIdentity, dimensions: Partial<WorldDimensions> = {}): MapAsset {
  const world = createWorldMetadata(dimensions); world.waterMode = 'explicit'; world.source.kind = 'flat';
  const terrain = HeightmapTerrain.fromBuffer({ width: world.worldWidthMeters, depth: world.worldDepthMeters, baseHeight: 0,
    terrainVersion: 1, chunkSizeMeters: world.chunkSizeMeters, settings: { ...DEFAULT_TERRAIN_SETTINGS, sampleSpacing: world.terrainSampleSpacingMeters } },
  new Float32Array(world.terrainColumns * world.terrainRows));
  world.outsideConnections = suggestOutsideConnections(world, terrain); return mapAssetFromTerrain(identity, terrain.state(), world);
}
export function duplicateMapAsset(asset: MapAsset, id = crypto.randomUUID()): MapAsset {
  return { ...structuredClone(asset), id, name: `${asset.name} copy`.slice(0, 120) };
}
let builtins: MapAsset[] | undefined;
export function builtInMaps(): MapAsset[] {
  builtins ??= ['flat-plains', 'coastal', 'river-valley'].map(preset => mapAssetFromGenerated(generateMap({ generatorVersion: 1,
    seed: 'civitas-library-1', preset: preset as 'flat-plains' | 'coastal' | 'river-valley', parameters: presetParameters(preset as 'flat-plains' | 'coastal' | 'river-valley') }),
  { id: `builtin-${preset}`, name: preset === 'flat-plains' ? 'Civitas Plains' : preset === 'coastal' ? 'Civitas Coast' : 'Civitas River Valley', description: 'Built-in starting world. Duplicate to customize.', author: 'Project Civitas' }));
  return structuredClone(builtins);
}
