import type { LaneId, RoadLineageId, RoadNodeId, RoadSegmentId } from '../shared/ids';
import type { Vec2 } from '../world/types';
import type { Vec3 } from '../terrain/heightmap';

export type RoadStructureType = 'ground' | 'elevated' | 'bridge' | 'tunnel';

export type RoadGeometryKind = 'straight' | 'curve' | 'polyline';

export interface RoadGeometry {
  kind: RoadGeometryKind;
  points: Vec2[];
  /** Authoritative deck/centerline elevations; same X/Z route as points, sampled for grade. */
  centerline?: Vec3[];
}

export interface RoadNode {
  id: RoadNodeId;
  position: Vec2;
}

export interface RoadSegment {
  id: RoadSegmentId;
  startNodeId: RoadNodeId;
  endNodeId: RoadNodeId;
  geometry: RoadGeometry;
  roadTypeId: string;
  width: number;
  speedLimit: number;
  laneIds: LaneId[];
  zoningAllowed: boolean;
  structureType?: RoadStructureType;
  /** Positive vertical offset from the entry terrain to the deck or tunnel bore. */
  targetElevation?: number;
  /** Stable across segment splits; used to preserve road-relative zoning phase. */
  zoningLineageId?: RoadLineageId;
  /** Distance in metres from the lineage origin to this segment's start. */
  zoningStartOffset?: number;
}

export interface Lane {
  id: LaneId;
  roadSegmentId: RoadSegmentId;
  direction: 'forward' | 'backward';
  index: number;
}

export interface RoadTypeDefinition {
  id: string;
  label: string;
  width: number;
  speedLimit: number;
  minimumCurveRadius: number;
  lanes: ReadonlyArray<{ direction: Lane['direction']; index: number }>;
  zoningAllowed: boolean;
  constructionCostPerMeter: number;
  maintenanceCostPerMeter: number;
  maximumGrade: number;
  minimumVerticalClearance: number;
  structureTransitionLength: number;
}

export interface RoadGraphSnapshot {
  nodes: RoadNode[];
  segments: RoadSegment[];
  lanes: Lane[];
}

export interface BuildRoadInput {
  geometry: RoadGeometry;
  roadTypeId: string;
  structureType?: RoadStructureType;
  targetElevation?: number;
  endpointIntents?: {
    start: RoadEndpointIntent;
    end: RoadEndpointIntent;
  };
}

export type RoadEndpointIntent =
  | { kind: 'free'; position: Vec2 }
  | { kind: 'node'; nodeId: RoadNodeId; position: Vec2 }
  | { kind: 'segment'; segmentId: RoadSegmentId; position: Vec2 };
