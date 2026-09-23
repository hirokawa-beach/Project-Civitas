import type { RoadSegmentId, ZoningCellId } from '../shared/ids';
import type { Vec2 } from '../world/types';
import type { ZoneType } from '../zoning/types';

export type LotId = `lot-${string}`;
export type BuildingId = `building-${string}`;
export type BuildingGrowthState = 'Empty' | 'Planned' | 'Constructing' | 'Occupied';

export interface RoadAccess {
  roadSegmentId: RoadSegmentId;
  frontage: [Vec2, Vec2];
}

export interface Lot {
  id: LotId;
  zoneType: ZoneType;
  zoneCellIds: ZoningCellId[];
  roadAccess: RoadAccess;
  widthCells: number;
  depthCells: number;
  width: number;
  depth: number;
  position: Vec2;
  rotation: number;
  corners: [Vec2, Vec2, Vec2, Vec2];
  averageElevation: number;
  minElevation: number;
  maxElevation: number;
  baseElevation: number;
  slope: number;
  buildable: boolean;
  buildingId?: BuildingId;
}

export interface BuildingDefinition {
  id: string;
  name: string;
  zoneType: ZoneType;
  lotWidthCells: number;
  lotDepthCells: number;
  minSlope: number;
  maxSlope: number;
  height: number;
  assetPath: string | null;
  level: number;
}

export interface Building {
  id: BuildingId;
  lotId: LotId;
  definitionId: string;
  state: BuildingGrowthState;
  stateEnteredAt: number;
  nextTransitionAt: number | null;
}
