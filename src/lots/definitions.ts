import type { ZoneType } from '../zoning/types';
import type { BuildingDefinition } from './types';

const zoneHeights: Record<ZoneType, number> = {
  residential: 10, commercial: 15, industrial: 8, office: 18,
};

export const LOT_SIZES = [
  [4, 4], [3, 3], [2, 3], [3, 2], [2, 2], [1, 2], [2, 1], [1, 1],
] as const;

/** All prototype definitions are data, independent of their Babylon representation. */
export const BUILDING_DEFINITIONS: readonly BuildingDefinition[] = (
  ['residential', 'commercial', 'industrial', 'office'] as const
).flatMap((zoneType) => LOT_SIZES.map(([lotWidthCells, lotDepthCells]) => ({
  id: `prototype-${zoneType}-${lotWidthCells}x${lotDepthCells}`,
  name: `${zoneType} prototype ${lotWidthCells}×${lotDepthCells}`,
  zoneType,
  lotWidthCells,
  lotDepthCells,
  minSlope: 0,
  maxSlope: 0.5,
  height: zoneHeights[zoneType] + Math.min(lotWidthCells, lotDepthCells) * 2,
  assetPath: null,
  level: 1,
  householdsPerCell: zoneType === 'residential' ? 2 : 0,
  jobsPerCell: { residential: 0, commercial: 3, industrial: 4, office: 5 }[zoneType],
  commercialCapacityPerCell: zoneType === 'commercial' ? 20 : 0,
}))) satisfies BuildingDefinition[];

const definitionsById = new Map(BUILDING_DEFINITIONS.map((definition) => [definition.id, definition]));
export const buildingDefinition = (id: string): BuildingDefinition | undefined => definitionsById.get(id);
export const definitionForLot = (zoneType: ZoneType, widthCells: number, depthCells: number): BuildingDefinition | undefined =>
  definitionsById.get(`prototype-${zoneType}-${widthCells}x${depthCells}`);
