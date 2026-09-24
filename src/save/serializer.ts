import type { RoadGraphSnapshot } from '../roads/types';
import { HeightmapTerrain } from '../terrain/heightmap';
import type { RoadLineageId } from '../shared/ids';
import type { GameClockSnapshot } from '../simulation/gameClock';
import type { LegacyTerrainState, TerrainState } from '../world/types';
import type { ZoneAssignment } from '../zoning/types';
import type { Building, Lot } from '../lots/types';
import { PopulationSystem } from '../population/system';
import type { PopulationSaveState } from '../population/types';
import { EconomySystem } from '../economy/system';
import type { EconomyState } from '../economy/types';
import { TrafficSystem } from '../traffic/system';
import type { TrafficSaveState } from '../traffic/types';
import { ServiceSystem } from '../services/system';
import type { ServiceSaveState } from '../services/types';
import { TransitSystem } from '../transit/system';
import type { TransitSaveState } from '../transit/types';
import { DEFAULT_WATER_STATE, type WaterState } from '../water/staticWater';
import { profileRoadElevation } from '../roads/elevation';
import { getRoadType } from '../roads/roadTypes';
import packageInfo from '../../package.json';

export const SAVE_VERSION = 11;
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
export interface SaveFileV7 extends SaveFileBase {
  saveVersion: 7;
  world: SaveFileBase['world'] & { terrain: TerrainState };
  zoningAssignments: ZoneAssignment[];
  lots: Lot[];
  buildings: Building[];
  population: PopulationSaveState;
  economy: EconomyState;
}
export interface SaveFileV8 extends SaveFileBase {
  saveVersion: 8;
  world: SaveFileBase['world'] & { terrain: TerrainState };
  zoningAssignments: ZoneAssignment[];
  lots: Lot[];
  buildings: Building[];
  population: PopulationSaveState;
  economy: EconomyState;
  traffic: TrafficSaveState;
}
export interface SaveFileV9 extends SaveFileBase {
  saveVersion: 9;
  world: SaveFileBase['world'] & { terrain: TerrainState };
  zoningAssignments: ZoneAssignment[];
  lots: Lot[];
  buildings: Building[];
  population: PopulationSaveState;
  economy: EconomyState;
  traffic: TrafficSaveState;
  services: ServiceSaveState;
}
export interface SaveFileV10 extends Omit<SaveFileV9, 'saveVersion'> {
  saveVersion: 10;
  transit: TransitSaveState;
}
export interface SaveFileV11 extends Omit<SaveFileV10, 'saveVersion'> {
  saveVersion: 11;
  water: WaterState;
}

export type SaveFile = SaveFileV1 | SaveFileV2 | SaveFileV3 | SaveFileV4 | SaveFileV5 | SaveFileV6 | SaveFileV7 | SaveFileV8 | SaveFileV9 | SaveFileV10 | SaveFileV11;

export interface SerializableWorld {
  terrain: LegacyTerrainState | TerrainState;
  roadGraph: RoadGraphSnapshot;
  gameClock: GameClockSnapshot;
  zoningAssignments: ZoneAssignment[];
  lots?: Lot[];
  buildings?: Building[];
  population?: PopulationSaveState;
  economy?: EconomyState;
  traffic?: TrafficSaveState;
  services?: ServiceSaveState;
  transit?: TransitSaveState;
  water?: WaterState;
}

export const serializeWorld = (world: SerializableWorld): SaveFileV11 => ({
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
  economy: structuredClone(world.economy ?? new EconomySystem(undefined, world.gameClock.gameSeconds).save()),
  traffic: structuredClone(world.traffic ?? new TrafficSystem(world.roadGraph, undefined, world.gameClock.gameSeconds).save()),
  services: structuredClone(world.services ?? new ServiceSystem().save()),
  transit: structuredClone(world.transit ?? new TransitSystem(world.roadGraph, undefined, world.gameClock.gameSeconds).save()),
  water: structuredClone(world.water ?? DEFAULT_WATER_STATE),
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

const isSaveFileV7 = (value: unknown): value is SaveFileV7 => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SaveFileV7>;
  return candidate.saveVersion === 7 && !!candidate.world && !!candidate.roadGraph
    && !!candidate.gameClock && Array.isArray(candidate.zoningAssignments)
    && Array.isArray(candidate.lots) && Array.isArray(candidate.buildings)
    && !!candidate.population && Array.isArray(candidate.population.households)
    && Array.isArray(candidate.population.occupancies) && !!candidate.economy;
};

const isSaveFileV8 = (value: unknown): value is SaveFileV8 => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SaveFileV8>;
  return candidate.saveVersion === 8 && !!candidate.world && !!candidate.roadGraph
    && !!candidate.gameClock && Array.isArray(candidate.zoningAssignments)
    && Array.isArray(candidate.lots) && Array.isArray(candidate.buildings)
    && !!candidate.population && Array.isArray(candidate.population.households)
    && Array.isArray(candidate.population.occupancies) && !!candidate.economy
    && !!candidate.traffic && Array.isArray(candidate.traffic.trips)
    && Array.isArray(candidate.traffic.outsideConnections);
};

const isSaveFileV9 = (value: unknown): value is SaveFileV9 => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SaveFileV9>;
  return candidate.saveVersion === 9 && !!candidate.world && !!candidate.roadGraph
    && !!candidate.gameClock && Array.isArray(candidate.zoningAssignments)
    && Array.isArray(candidate.lots) && Array.isArray(candidate.buildings)
    && !!candidate.population && !!candidate.economy && !!candidate.traffic
    && !!candidate.services && Array.isArray(candidate.services.facilities);
};

const migrateToV6 = (value: unknown): SaveFileV6 => {
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

const migrateToV7 = (value: unknown): SaveFileV7 => {
  if (isSaveFileV7(value)) return structuredClone(value);
  const old = migrateToV6(value);
  return { ...old, saveVersion: 7, gameVersion: GAME_VERSION,
    economy: new EconomySystem(undefined, old.gameClock.gameSeconds).save() };
};

const migrateToV8 = (value: unknown): SaveFileV8 => {
  if (isSaveFileV8(value)) return structuredClone(value);
  const old = migrateToV7(value);
  return { ...old, saveVersion: 8, gameVersion: GAME_VERSION,
    traffic: new TrafficSystem(old.roadGraph, undefined, old.gameClock.gameSeconds).save() };
};

const migrateToV9 = (value: unknown): SaveFileV9 => {
  if (isSaveFileV9(value)) return structuredClone(value);
  const old = migrateToV8(value);
  return { ...old, saveVersion: 9, gameVersion: GAME_VERSION,
    economy: { ...old.economy, lastCycleServiceMaintenance: 0 },
    services: new ServiceSystem().save() };
};

const isSaveFileV10 = (value: unknown): value is SaveFileV10 => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SaveFileV10>;
  return candidate.saveVersion === 10 && !!candidate.world && !!candidate.roadGraph
    && !!candidate.gameClock && Array.isArray(candidate.zoningAssignments)
    && Array.isArray(candidate.lots) && Array.isArray(candidate.buildings)
    && !!candidate.population && !!candidate.economy && !!candidate.traffic
    && !!candidate.services && !!candidate.transit && Array.isArray(candidate.transit.stops)
    && Array.isArray(candidate.transit.lines);
};

const isSaveFileV11 = (value: unknown): value is SaveFileV11 => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SaveFileV11>;
  return candidate.saveVersion === 11 && !!candidate.world && !!candidate.roadGraph
    && !!candidate.gameClock && Array.isArray(candidate.zoningAssignments)
    && Array.isArray(candidate.lots) && Array.isArray(candidate.buildings)
    && !!candidate.population && !!candidate.economy && !!candidate.traffic
    && !!candidate.services && !!candidate.transit && !!candidate.water;
};

export const migrateSave = (value: unknown): SaveFileV11 => {
  if (isSaveFileV11(value)) return structuredClone(value);
  const old: SaveFileV10 = isSaveFileV10(value) ? structuredClone(value) : (() => {
    const previous = migrateToV9(value);
    return { ...previous, saveVersion: 10 as const, gameVersion: GAME_VERSION,
      transit: new TransitSystem(previous.roadGraph, undefined, previous.gameClock.gameSeconds).save() };
  })();
  const terrain = new HeightmapTerrain(old.world.terrain);
  const roadGraph = structuredClone(old.roadGraph);
  for (const segment of roadGraph.segments) {
    segment.structureType ??= 'ground';
    segment.targetElevation ??= 0;
    segment.geometry.centerline ??= profileRoadElevation(segment.geometry.points, 'ground', 0,
      (x, z) => terrain.getHeight(x, z), getRoadType(segment.roadTypeId)).centerline;
  }
  return { ...old, roadGraph, saveVersion: 11, gameVersion: GAME_VERSION,
    water: { ...DEFAULT_WATER_STATE } };
};

export const deserializeWorld = (value: unknown): SerializableWorld & { terrain: TerrainState; lots: Lot[]; buildings: Building[]; population: PopulationSaveState; economy: EconomyState; traffic: TrafficSaveState; services: ServiceSaveState; transit: TransitSaveState; water: WaterState; hasLotData: boolean; hasPopulationData: boolean; hasEconomyData: boolean; hasTrafficData: boolean; hasServiceData: boolean; hasTransitData: boolean } => {
  const hasLotData = isSaveFileV5(value) || isSaveFileV6(value) || isSaveFileV7(value) || isSaveFileV8(value) || isSaveFileV9(value) || isSaveFileV10(value) || isSaveFileV11(value);
  const hasPopulationData = isSaveFileV6(value) || isSaveFileV7(value) || isSaveFileV8(value) || isSaveFileV9(value) || isSaveFileV10(value) || isSaveFileV11(value);
  const hasEconomyData = isSaveFileV7(value) || isSaveFileV8(value) || isSaveFileV9(value) || isSaveFileV10(value) || isSaveFileV11(value);
  const hasTrafficData = isSaveFileV8(value) || isSaveFileV9(value) || isSaveFileV10(value) || isSaveFileV11(value);
  const hasServiceData = isSaveFileV9(value) || isSaveFileV10(value) || isSaveFileV11(value);
  const hasTransitData = isSaveFileV10(value) || isSaveFileV11(value);
  let save: SaveFileV11;
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
    economy: structuredClone(save.economy),
    traffic: structuredClone(save.traffic),
    services: structuredClone(save.services),
    transit: structuredClone(save.transit),
    water: structuredClone(save.water),
    hasLotData,
    hasPopulationData,
    hasEconomyData,
    hasTrafficData,
    hasServiceData,
    hasTransitData,
  };
};
