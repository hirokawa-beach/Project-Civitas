export interface Vec2 {
  x: number;
  z: number;
}

export interface LegacyTerrainState {
  width: number;
  depth: number;
  baseHeight: number;
  heightmapId?: string;
}

export type TerrainPreset = 'flat' | 'hills';
export type TerrainBrushMode = 'raise' | 'lower' | 'flatten' | 'smooth';

export interface TerrainSettings {
  sampleSpacing: number;
  minHeight: number;
  maxHeight: number;
  preset: TerrainPreset;
}

export interface TerrainMetadata extends LegacyTerrainState {
  chunkSizeMeters?: number;
  terrainVersion: number;
  settings: TerrainSettings;
}

export interface TerrainState extends TerrainMetadata {
  heightmap: number[];
}

export interface TerrainPatch {
  chunkId: ChunkDescriptor['id'];
  startColumn: number;
  startRow: number;
  columns: number;
  rows: number;
  heights: Float32Array;
}

export interface ChunkCoordinate {
  x: number;
  z: number;
}

export interface ChunkDescriptor extends ChunkCoordinate {
  id: `chunk-${number}-${number}`;
  size: number;
  width?: number;
  depth?: number;
}

export const WORLD_SIZE = 1024;
export const HALF_WORLD_SIZE = WORLD_SIZE / 2;
export const CHUNK_SIZE = 256;

export interface ChunkWorld { worldWidthMeters: number; worldDepthMeters: number; chunkSizeMeters: number }
export const LEGACY_CHUNK_WORLD: ChunkWorld = { worldWidthMeters: WORLD_SIZE, worldDepthMeters: WORLD_SIZE, chunkSizeMeters: CHUNK_SIZE };
export const worldToChunk = (position: Vec2, world: ChunkWorld = LEGACY_CHUNK_WORLD): ChunkCoordinate => ({
  x: Math.max(0, Math.min(Math.ceil(world.worldWidthMeters / world.chunkSizeMeters) - 1, Math.floor((position.x + world.worldWidthMeters / 2) / world.chunkSizeMeters))),
  z: Math.max(0, Math.min(Math.ceil(world.worldDepthMeters / world.chunkSizeMeters) - 1, Math.floor((position.z + world.worldDepthMeters / 2) / world.chunkSizeMeters))),
});

export const createChunks = (world: ChunkWorld = LEGACY_CHUNK_WORLD): ChunkDescriptor[] => {
  const columns = Math.ceil(world.worldWidthMeters / world.chunkSizeMeters);
  const rows = Math.ceil(world.worldDepthMeters / world.chunkSizeMeters);
  return Array.from({ length: columns * rows }, (_, index) => {
    const x = index % columns;
    const z = Math.floor(index / columns);
    return { id: `chunk-${x}-${z}`, x, z, size: world.chunkSizeMeters,
      width: Math.min(world.chunkSizeMeters, world.worldWidthMeters - x * world.chunkSizeMeters),
      depth: Math.min(world.chunkSizeMeters, world.worldDepthMeters - z * world.chunkSizeMeters) };
  });
};

/** Partition once; consumers must not filter the full cell/lot list for every chunk. */
export function groupByChunk<T>(items: readonly T[], position: (item: T) => Vec2, world: ChunkWorld): Map<ChunkDescriptor['id'], T[]> {
  const result = new Map<ChunkDescriptor['id'], T[]>();
  for (const item of items) {
    const chunk = worldToChunk(position(item), world); const id: ChunkDescriptor['id'] = `chunk-${chunk.x}-${chunk.z}`;
    const local = result.get(id) ?? []; local.push(item); result.set(id, local);
  }
  return result;
}
