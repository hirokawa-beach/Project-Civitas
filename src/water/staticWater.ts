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

  constructor(state: WaterState = DEFAULT_WATER_STATE) {
    this.current = { ...DEFAULT_WATER_STATE };
    this.restore(state);
  }

  get seaLevel(): number { return this.current.seaLevel; }
  snapshot(): WaterState & { revision: number } { return { ...this.current, revision: this.revision }; }
  save(): WaterState { return { ...this.current }; }
  isWaterAt(x: number, z: number, terrain: Pick<HeightmapTerrain, 'getHeight'>): boolean {
    return terrain.getHeight(x, z) < this.current.seaLevel;
  }
  setSeaLevel(level: number): void { this.restore({ version: 1, seaLevel: level }); }
  restore(state: WaterState): void {
    if (!state || state.version !== 1 || !Number.isFinite(state.seaLevel) || state.seaLevel < -80 || state.seaLevel > 240)
      throw new Error('Water settings are invalid.');
    this.current = { ...state };
    this.revision += 1;
  }
}
