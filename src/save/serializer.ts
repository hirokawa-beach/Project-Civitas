import type { RoadGraphSnapshot } from '../roads/types';
import { HeightmapTerrain } from '../terrain/heightmap';
import type { RoadLineageId } from '../shared/ids';
import type { GameClockSnapshot } from '../simulation/gameClock';
import type { LegacyTerrainState, TerrainState } from '../world/types';
import type { ZoneAssignment } from '../zoning/types';
import type { Building, Lot } from '../lots/types';
import { PopulationSystem } from '../population/system';
import type { PopulationSaveState } from '../population/types';
import packageInfo from '../../package.json';

export const SAVE_VERSION = 6;
export const GAME_VERSION = packageInfo.version;

interface SaveFileBase {
  gameVersion: string;
  savedAt: string;
  world: {
    width: number;
    depth: number;
    terrain: LegacyTerrainState | TerrainState;
  };
  roadGraph: RoadGraphSnapshot;
  gameClock: GameClockSnapshot;
}

export interface SaveFileV1 extends SaveFileBase { saveVersion: 1 }
export interface SaveFileV2 extends SaveFileBase { saveVersion: 2 }
export interface SaveFileV3 extends SaveFileBase {
  saveVersion: 3;
  zoningAssignments: ZoneAssignment[];
}

export interface SaveFileV4 extends SaveFileBase {
  saveVersion: 4;
  world: SaveFileBase['world'] & { terrain: TerrainState };
  zoningAssignments: ZoneAssignment[];
}
export interface SaveFileV5 extends SaveFileBase {
  saveVersion: 5;
  world: SaveFileBase['world'] & { terrain: TerrainState };
  zoningAssignments: ZoneAssignment[];
  lots: Lot[];
  buildings: Building[];
}
export interface SaveFileV6 extends SaveFileBase {
  saveVersion: 6;
  world: SaveFileBase['world'] & { terrain: TerrainState };
  zoningAssignments: ZoneAssignment[];
  lots: Lot[];
  buildings: Building[];
  population: PopulationSaveState;
}

export type SaveFile = SaveFileV1 | SaveFileV2 | SaveFileV3 | SaveFileV4 | SaveFileV5 | SaveFileV6;

export interface SerializableWorld {
  terrain: LegacyTerrainState | TerrainState;
  roadGraph: RoadGraphSnapshot;
  gameClock: GameClockSnapshot;
  zoningAssignments: ZoneAssignment[];
  lots?: Lot[];
  buildings?: Building[];
  population?: PopulationSaveState;
}

export const serializeWorld = (world: SerializableWorld): SaveFileV6 => ({
  saveVersion: SAVE_VERSION,
  gameVersion: GAME_VERSION,
  savedAt: new Date().toISOString(),
  world: {
    width: world.terrain.width,
    depth: world.terrain.depth,
    terrain: new HeightmapTerrain(world.terrain).state(),
  },
  roadGraph: structuredClone(world.roadGraph),
  gameClock: { ...world.gameClock },
  zoningAssignments: structuredClone(world.zoningAssignments),
  lots: structuredClone(world.lots ?? []),
  buildings: structuredClone(world.buildings ?? []),
  population: structuredClone(world.population ?? new PopulationSystem().save()),
});

const isSaveFileV1 = (value: unknown): value is SaveFileV1 => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SaveFileV1>;
  return candidate.saveVersion === 1 && !!candidate.world && !!candidate.roadGraph && !!candidate.gameClock;
};

const isSaveFileV2 = (value: unknown): value is SaveFileV2 => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SaveFileV2>;
  return candidate.saveVersion === 2 && !!candidate.world && !!candidate.roadGraph && !!candidate.gameClock;
};

const isSaveFileV3 = (value: unknown): value is SaveFileV3 => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SaveFileV3>;
  return candidate.saveVersion === 3 && !!candidate.world && !!candidate.roadGraph
    && !!candidate.gameClock && Array.isArray(candidate.zoningAssignments);
};

const isSaveFileV4 = (value: unknown): value is SaveFileV4 => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SaveFileV4>;
  return candidate.saveVersion === 4 && !!candidate.world && !!candidate.roadGraph
    && !!candidate.gameClock && Array.isArray(candidate.zoningAssignments);
};

const isSaveFileV5 = (value: unknown): value is SaveFileV5 => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SaveFileV5>;
  return candidate.saveVersion === 5 && !!candidate.world && !!candidate.roadGraph
    && !!candidate.gameClock && Array.isArray(candidate.zoningAssignments)
    && Array.isArray(candidate.lots) && Array.isArray(candidate.buildings);
};

const isSaveFileV6 = (value: unknown): value is SaveFileV6 => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SaveFileV6>;
  return candidate.saveVersion === 6 && !!candidate.world && !!candidate.roadGraph
    && !!candidate.gameClock && Array.isArray(candidate.zoningAssignments)
    && Array.isArray(candidate.lots) && Array.isArray(candidate.buildings)
    && !!candidate.population && Array.isArray(candidate.population.households)
    && Array.isArray(candidate.population.occupancies);
};

export const migrateSave = (value: unknown): SaveFileV6 => {
  if (isSaveFileV6(value)) return structuredClone(value);
  if (isSaveFileV5(value)) return { ...structuredClone(value), saveVersion: 6, gameVersion: GAME_VERSION,
    population: new PopulationSystem().save() };
  if (isSaveFileV4(value)) return { ...structuredClone(value), saveVersion: 6, gameVersion: GAME_VERSION,
    lots: [], buildings: [], population: new PopulationSystem().save() };
  if (isSaveFileV3(value)) {
    const migrated = structuredClone(value);
    return { ...migrated, saveVersion: 6, gameVersion: GAME_VERSION, lots: [], buildings: [],
      population: new PopulationSystem().save(),
      world: { ...migrated.world, terrain: new HeightmapTerrain(migrated.world.terrain).state() } };
  }
  if (isSaveFileV2(value)) {
    const migrated = structuredClone(value);
    return { ...migrated, saveVersion: 6, gameVersion: GAME_VERSION, zoningAssignments: [], lots: [], buildings: [],
      population: new PopulationSystem().save(),
      world: { ...migrated.world, terrain: new HeightmapTerrain(migrated.world.terrain).state() } };
  }
  if (!isSaveFileV1(value)) throw new Error('No migration is available for this save version.');

  const migrated = structuredClone(value) as SaveFileV1;
  const usedLineages = new Set(
    migrated.roadGraph.segments
      .map((segment) => segment.zoningLineageId)
      .filter((lineageId): lineageId is RoadLineageId => lineageId !== undefined),
  );
  let nextLineage = 1;
  for (const segment of migrated.roadGraph.segments) {
    while (usedLineages.has(`roadline-${nextLineage}`)) nextLineage += 1;
    if (!segment.zoningLineageId) {
      segment.zoningLineageId = `roadline-${nextLineage}`;
      usedLineages.add(segment.zoningLineageId);
      nextLineage += 1;
    }
    segment.zoningStartOffset ??= 0;
  }
  return { ...migrated, saveVersion: 6, gameVersion: GAME_VERSION, zoningAssignments: [], lots: [], buildings: [],
    population: new PopulationSystem().save(),
    world: { ...migrated.world, terrain: new HeightmapTerrain(migrated.world.terrain).state() } };
};

export const deserializeWorld = (value: unknown): SerializableWorld & { terrain: TerrainState; lots: Lot[]; buildings: Building[]; population: PopulationSaveState; hasLotData: boolean; hasPopulationData: boolean } => {
  const hasLotData = isSaveFileV5(value) || isSaveFileV6(value);
  const hasPopulationData = isSaveFileV6(value);
  let save: SaveFileV6;
  try {
    save = migrateSave(value);
  } catch {
    throw new Error('Unsupported or corrupt save file.');
  }
  return {
    terrain: structuredClone(save.world.terrain),
    roadGraph: structuredClone(save.roadGraph),
    gameClock: { ...save.gameClock },
    zoningAssignments: structuredClone(save.zoningAssignments),
    lots: structuredClone(save.lots),
    buildings: structuredClone(save.buildings),
    population: structuredClone(save.population),
    hasLotData,
    hasPopulationData,
  };
};
