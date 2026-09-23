import type { RoadSegmentId, ZoningCellId } from '../shared/ids';
import type { Vec2 } from '../world/types';

export type ZoneType = 'residential' | 'commercial' | 'industrial' | 'office';
export type ZoneBrush = ZoneType | null;

export const ZONE_TYPES: readonly ZoneType[] = ['residential', 'commercial', 'industrial', 'office'];

export const isZoneType = (value: unknown): value is ZoneType =>
  typeof value === 'string' && ZONE_TYPES.includes(value as ZoneType);

export interface ZoneAssignment {
  cellId: ZoningCellId;
  zoneType: ZoneType;
}

export interface ZoningCell {
  id: ZoningCellId;
  roadSegmentId: RoadSegmentId;
  center: Vec2;
  corners: [Vec2, Vec2, Vec2, Vec2];
  angle: number;
  depth: number;
  side: -1 | 1;
  size: 8;
  /** Derived from the authoritative terrain; never part of the stable cell ID. */
  terrainHeight?: number;
  /** False when local terrain is too steep or uneven to use as a zone cell. */
  terrainSuitable?: boolean;
  zoneType?: ZoneType;
}
