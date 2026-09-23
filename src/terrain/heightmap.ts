import {
  CHUNK_SIZE, HALF_WORLD_SIZE, WORLD_SIZE,
  type ChunkDescriptor, type LegacyTerrainState, type TerrainBrushMode,
  type TerrainMetadata, type TerrainPatch, type TerrainPreset, type TerrainSettings,
  type TerrainState, type Vec2,
} from '../world/types';

export const TERRAIN_VERSION = 1;
export const TERRAIN_SAMPLE_SPACING = 4;
export const TERRAIN_COLUMNS = WORLD_SIZE / TERRAIN_SAMPLE_SPACING + 1;
export const DEFAULT_TERRAIN_SETTINGS: TerrainSettings = {
  sampleSpacing: TERRAIN_SAMPLE_SPACING,
  minHeight: -80,
  maxHeight: 240,
  preset: 'flat',
};

export interface Vec3 { x: number; y: number; z: number }
export interface TerrainBrushStamp {
  mode: TerrainBrushMode;
  center: Vec2;
  size: number;
  strength: number;
  seconds: number;
  flattenHeight?: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const chunkId = (x: number, z: number): ChunkDescriptor['id'] => `chunk-${x}-${z}`;
const ALL_CHUNK_IDS: ChunkDescriptor['id'][] = Array.from({ length: 16 }, (_, index) => chunkId(index % 4, Math.floor(index / 4)));
const isFullTerrain = (state: LegacyTerrainState | TerrainState): state is TerrainState => 'heightmap' in state;

export class HeightmapTerrain {
  readonly width: number;
  readonly depth: number;
  readonly baseHeight: number;
  readonly settings: TerrainSettings;
  readonly heights: Float32Array;

  constructor(state: LegacyTerrainState | TerrainState = { width: WORLD_SIZE, depth: WORLD_SIZE, baseHeight: 0 }) {
    if (state.width !== WORLD_SIZE || state.depth !== WORLD_SIZE || !Number.isFinite(state.baseHeight)) {
      throw new Error('Terrain dimensions or base height are invalid.');
    }
    this.width = state.width;
    this.depth = state.depth;
    this.baseHeight = state.baseHeight;
    this.settings = isFullTerrain(state) ? { ...state.settings } : { ...DEFAULT_TERRAIN_SETTINGS };
    if (this.settings.sampleSpacing !== TERRAIN_SAMPLE_SPACING
      || !Number.isFinite(this.settings.minHeight) || !Number.isFinite(this.settings.maxHeight)
      || this.settings.minHeight >= this.settings.maxHeight
      || !(['flat', 'hills'] as TerrainPreset[]).includes(this.settings.preset)) {
      throw new Error('Terrain settings are invalid.');
    }
    if (isFullTerrain(state)) {
      if (!Array.isArray(state.heightmap) || state.terrainVersion !== TERRAIN_VERSION || state.heightmap.length !== TERRAIN_COLUMNS ** 2
        || state.heightmap.some((height) => !Number.isFinite(height) || height < this.settings.minHeight || height > this.settings.maxHeight)) {
        throw new Error('Terrain heightmap is invalid.');
      }
      this.heights = Float32Array.from(state.heightmap);
    } else {
      this.heights = new Float32Array(TERRAIN_COLUMNS ** 2);
      this.heights.fill(state.baseHeight);
    }
  }

  static fromBuffer(metadata: TerrainMetadata, heights: Float32Array): HeightmapTerrain {
    return new HeightmapTerrain({ ...metadata, heightmap: Array.from(heights) });
  }

  metadata(): TerrainMetadata {
    return {
      width: this.width, depth: this.depth, baseHeight: this.baseHeight,
      terrainVersion: TERRAIN_VERSION, settings: { ...this.settings },
    };
  }

  state(): TerrainState { return { ...this.metadata(), heightmap: Array.from(this.heights) }; }
  cloneHeights(): Float32Array { return new Float32Array(this.heights); }
  get byteLength(): number { return this.heights.byteLength; }

  getHeight(x: number, z: number): number {
    const column = clamp((x + HALF_WORLD_SIZE) / TERRAIN_SAMPLE_SPACING, 0, TERRAIN_COLUMNS - 1);
    const row = clamp((z + HALF_WORLD_SIZE) / TERRAIN_SAMPLE_SPACING, 0, TERRAIN_COLUMNS - 1);
    const x0 = Math.floor(column);
    const z0 = Math.floor(row);
    const x1 = Math.min(TERRAIN_COLUMNS - 1, x0 + 1);
    const z1 = Math.min(TERRAIN_COLUMNS - 1, z0 + 1);
    const tx = column - x0;
    const tz = row - z0;
    const top = this.heights[this.index(x0, z0)] * (1 - tx) + this.heights[this.index(x1, z0)] * tx;
    const bottom = this.heights[this.index(x0, z1)] * (1 - tx) + this.heights[this.index(x1, z1)] * tx;
    return top * (1 - tz) + bottom * tz;
  }

  getNormal(x: number, z: number): Vec3 {
    const step = TERRAIN_SAMPLE_SPACING;
    const dx = (this.getHeight(x + step, z) - this.getHeight(x - step, z)) / (2 * step);
    const dz = (this.getHeight(x, z + step) - this.getHeight(x, z - step)) / (2 * step);
    const length = Math.hypot(dx, 1, dz);
    return { x: -dx / length, y: 1 / length, z: -dz / length };
  }

  applyBrush(stamp: TerrainBrushStamp, before: Map<number, number>, editWeights?: Float32Array): ChunkDescriptor['id'][] {
    if (!Number.isFinite(stamp.center.x) || !Number.isFinite(stamp.center.z)
      || !(['raise', 'lower', 'flatten', 'smooth'] as TerrainBrushMode[]).includes(stamp.mode)
      || !Number.isFinite(stamp.size) || stamp.size < 4 || stamp.size > 256
      || !Number.isFinite(stamp.strength) || stamp.strength <= 0 || stamp.strength > 50
      || !Number.isFinite(stamp.seconds) || stamp.seconds <= 0 || stamp.seconds > 1
      || (stamp.mode === 'flatten' && !Number.isFinite(stamp.flattenHeight))) {
      throw new Error('Terrain brush settings are invalid.');
    }
    const radius = stamp.size / 2;
    const left = clamp(Math.floor((stamp.center.x - radius + HALF_WORLD_SIZE) / TERRAIN_SAMPLE_SPACING), 0, TERRAIN_COLUMNS - 1);
    const right = clamp(Math.ceil((stamp.center.x + radius + HALF_WORLD_SIZE) / TERRAIN_SAMPLE_SPACING), 0, TERRAIN_COLUMNS - 1);
    const top = clamp(Math.floor((stamp.center.z - radius + HALF_WORLD_SIZE) / TERRAIN_SAMPLE_SPACING), 0, TERRAIN_COLUMNS - 1);
    const bottom = clamp(Math.ceil((stamp.center.z + radius + HALF_WORLD_SIZE) / TERRAIN_SAMPLE_SPACING), 0, TERRAIN_COLUMNS - 1);
    const source = stamp.mode === 'smooth' ? this.cloneHeights() : this.heights;
    const dirty = new Set<ChunkDescriptor['id']>();
    for (let row = top; row <= bottom; row += 1) {
      for (let column = left; column <= right; column += 1) {
        const x = column * TERRAIN_SAMPLE_SPACING - HALF_WORLD_SIZE;
        const z = row * TERRAIN_SAMPLE_SPACING - HALF_WORLD_SIZE;
        const distance = Math.hypot(x - stamp.center.x, z - stamp.center.z);
        if (distance >= radius) continue;
        const t = 1 - distance / radius;
        const falloff = t * t * (3 - 2 * t);
        const index = this.index(column, row);
        const influence = falloff * (editWeights?.[index] ?? 1);
        if (influence <= 0) continue;
        const height = this.heights[index];
        let next = height;
        if (stamp.mode === 'raise' || stamp.mode === 'lower') {
          next += (stamp.mode === 'raise' ? 1 : -1) * stamp.strength * stamp.seconds * influence;
        } else {
          const target = stamp.mode === 'flatten'
            ? stamp.flattenHeight!
            : (source[this.index(Math.max(0, column - 1), row)]
              + source[this.index(Math.min(TERRAIN_COLUMNS - 1, column + 1), row)]
              + source[this.index(column, Math.max(0, row - 1))]
              + source[this.index(column, Math.min(TERRAIN_COLUMNS - 1, row + 1))]) / 4;
          next += (target - height) * Math.min(1, stamp.strength * stamp.seconds * influence);
        }
        next = clamp(next, this.settings.minHeight, this.settings.maxHeight);
        if (Math.abs(next - height) < 1e-6) continue;
        if (!before.has(index)) before.set(index, height);
        this.heights[index] = next;
        this.markDirtyVertex(column, row, dirty);
      }
    }
    return [...dirty].sort();
  }

  applyValues(values: ReadonlyMap<number, number>): ChunkDescriptor['id'][] {
    const dirty = new Set<ChunkDescriptor['id']>();
    for (const [index, height] of values) {
      if (index < 0 || index >= this.heights.length || !Number.isFinite(height)) throw new Error('Terrain edit is invalid.');
      if (this.heights[index] === height) continue;
      this.heights[index] = height;
      this.markDirtyVertex(index % TERRAIN_COLUMNS, Math.floor(index / TERRAIN_COLUMNS), dirty);
    }
    return [...dirty].sort();
  }

  setPreset(preset: TerrainPreset, editWeights?: Float32Array): ChunkDescriptor['id'][] {
    if (preset !== 'flat' && preset !== 'hills') throw new Error('Unknown terrain preset.');
    for (let row = 0; row < TERRAIN_COLUMNS; row += 1) {
      for (let column = 0; column < TERRAIN_COLUMNS; column += 1) {
        const x = column * TERRAIN_SAMPLE_SPACING - HALF_WORLD_SIZE;
        const z = row * TERRAIN_SAMPLE_SPACING - HALF_WORLD_SIZE;
        const index = this.index(column, row);
        const target = preset === 'flat' ? this.baseHeight : this.hillHeight(x, z);
        const weight = editWeights?.[index] ?? 1;
        this.heights[index] += (target - this.heights[index]) * weight;
      }
    }
    this.settings.preset = preset;
    return [...ALL_CHUNK_IDS];
  }

  replaceHeights(heights: Float32Array, preset: TerrainPreset): ChunkDescriptor['id'][] {
    if (heights.length !== this.heights.length || heights.some((height) => !Number.isFinite(height))) {
      throw new Error('Terrain heightmap is invalid.');
    }
    this.heights.set(heights);
    this.settings.preset = preset;
    return [...ALL_CHUNK_IDS];
  }

  applyPatch(patch: TerrainPatch): void {
    if (!Number.isInteger(patch.startColumn) || !Number.isInteger(patch.startRow)
      || !Number.isInteger(patch.columns) || !Number.isInteger(patch.rows)
      || patch.startColumn < 0 || patch.startRow < 0 || patch.columns < 1 || patch.rows < 1
      || patch.startColumn + patch.columns > TERRAIN_COLUMNS || patch.startRow + patch.rows > TERRAIN_COLUMNS
      || patch.heights.length !== patch.columns * patch.rows
      || patch.heights.some((height) => !Number.isFinite(height))) throw new Error('Terrain patch dimensions are invalid.');
    for (let row = 0; row < patch.rows; row += 1) {
      const destination = this.index(patch.startColumn, patch.startRow + row);
      this.heights.set(patch.heights.subarray(row * patch.columns, (row + 1) * patch.columns), destination);
    }
  }

  patchForChunk(id: ChunkDescriptor['id']): TerrainPatch {
    const match = /^chunk-(\d+)-(\d+)$/.exec(id);
    if (!match) throw new Error('Unknown terrain chunk.');
    const x = Number(match[1]);
    const z = Number(match[2]);
    if (x < 0 || x > 3 || z < 0 || z > 3) throw new Error('Unknown terrain chunk.');
    const steps = CHUNK_SIZE / TERRAIN_SAMPLE_SPACING;
    const startColumn = x * steps;
    const startRow = z * steps;
    const columns = steps + 1;
    const rows = steps + 1;
    const heights = new Float32Array(columns * rows);
    for (let row = 0; row < rows; row += 1) {
      heights.set(this.heights.subarray(this.index(startColumn, startRow + row), this.index(startColumn, startRow + row) + columns), row * columns);
    }
    return { chunkId: id, startColumn, startRow, columns, rows, heights };
  }

  private hillHeight(x: number, z: number): number {
    const gaussian = (cx: number, cz: number, radius: number, height: number): number =>
      height * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / (2 * radius ** 2));
    return this.baseHeight + gaussian(-160, -120, 110, 26) + gaussian(190, 140, 145, 34) + gaussian(40, -260, 75, 12);
  }

  private index(column: number, row: number): number { return row * TERRAIN_COLUMNS + column; }

  private markDirtyVertex(column: number, row: number, dirty: Set<ChunkDescriptor['id']>): void {
    const steps = CHUNK_SIZE / TERRAIN_SAMPLE_SPACING;
    for (const offsetZ of [-1, 0, 1]) {
      for (const offsetX of [-1, 0, 1]) {
        const x = clamp(Math.floor((column + offsetX) / steps), 0, 3);
        const z = clamp(Math.floor((row + offsetZ) / steps), 0, 3);
        dirty.add(chunkId(x, z));
      }
    }
  }
}
