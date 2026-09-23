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
}

export const WORLD_SIZE = 1024;
export const HALF_WORLD_SIZE = WORLD_SIZE / 2;
export const CHUNK_SIZE = 256;

export const worldToChunk = (position: Vec2): ChunkCoordinate => ({
  x: Math.max(0, Math.min(3, Math.floor((position.x + HALF_WORLD_SIZE) / CHUNK_SIZE))),
  z: Math.max(0, Math.min(3, Math.floor((position.z + HALF_WORLD_SIZE) / CHUNK_SIZE))),
});

export const createChunks = (): ChunkDescriptor[] =>
  Array.from({ length: 16 }, (_, index) => {
    const x = index % 4;
    const z = Math.floor(index / 4);
    return { id: `chunk-${x}-${z}`, x, z, size: CHUNK_SIZE };
  });
