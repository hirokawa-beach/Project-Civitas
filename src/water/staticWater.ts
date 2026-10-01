import { Hydrography } from './geometry';
import type { WaterBody, WorldMetadata } from '../world/metadata';
import type { HeightmapTerrain } from '../terrain/heightmap';

export interface WaterState {
  version: 1;
  seaLevel: number;
}

export const DEFAULT_WATER_STATE: WaterState = { version: 1, seaLevel: -12 };

/** Static height-based water area; terrain remains authoritative for the shoreline. */
export class StaticWater {
  private current: WaterState;
  revision = 0;
  private hydrography?: Hydrography;
  get mode(): 'explicit' | 'legacy-height' { return this.hydrography ? 'explicit' : 'legacy-height'; }
  configure(world: WorldMetadata): void {
    this.hydrography = world.waterMode === 'explicit' ? new Hydrography(structuredClone(world.waterBodies), world) : undefined;
    this.revision++;
  }
  bodyAt(x: number, z: number): WaterBody | undefined { return this.hydrography?.bodyAt(x, z); }
  waterSurfaceAt(x: number, z: number, terrain?: Pick<HeightmapTerrain, 'getHeight'>): number | undefined {
    return this.hydrography ? this.hydrography.waterSurfaceAt(x, z) : terrain && this.isWaterAt(x, z, terrain) ? this.seaLevel : undefined;
  }
  distanceToShoreline(x: number, z: number, radius?: number): number { return this.hydrography?.distanceToShoreline(x, z, radius) ?? Infinity; }
  intersectsSegment(a: { x: number; z: number }, b: { x: number; z: number }): boolean { return this.hydrography?.intersectsSegment(a, b) ?? false; }

  constructor(state: WaterState = DEFAULT_WATER_STATE) {
    this.current = { ...DEFAULT_WATER_STATE };
    this.restore(state);
  }

  get seaLevel(): number { return this.current.seaLevel; }
  snapshot(): WaterState & { revision: number } { return { ...this.current, revision: this.revision }; }
  save(): WaterState { return { ...this.current }; }
  isWaterAt(x: number, z: number, terrain: Pick<HeightmapTerrain, 'getHeight'>): boolean {
    return this.hydrography ? this.hydrography.isWaterAt(x, z) : terrain.getHeight(x, z) < this.current.seaLevel;
  }
  setSeaLevel(level: number): void { if (this.hydrography) throw new Error('Edit the surface elevation of an explicit Water Body in the Map Editor.'); this.restore({ version: 1, seaLevel: level }); }
  restore(state: WaterState): void {
    if (!state || state.version !== 1 || !Number.isFinite(state.seaLevel) || state.seaLevel < -80 || state.seaLevel > 240)
      throw new Error('Water settings are invalid.');
    this.current = { ...state };
    this.revision += 1;
  }
}
