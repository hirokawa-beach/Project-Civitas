import type { LaneId, RoadLineageId, RoadNodeId, RoadSegmentId } from '../shared/ids';
import type { Vec2 } from '../world/types';

export type RoadGeometryKind = 'straight' | 'curve' | 'polyline';

export interface RoadGeometry {
  kind: RoadGeometryKind;
  points: Vec2[];
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
}

export interface RoadGraphSnapshot {
  nodes: RoadNode[];
  segments: RoadSegment[];
  lanes: Lane[];
}

export interface BuildRoadInput {
  geometry: RoadGeometry;
  roadTypeId: string;
  endpointIntents?: {
    start: RoadEndpointIntent;
    end: RoadEndpointIntent;
  };
}

export type RoadEndpointIntent =
  | { kind: 'free'; position: Vec2 }
  | { kind: 'node'; nodeId: RoadNodeId; position: Vec2 }
  | { kind: 'segment'; segmentId: RoadSegmentId; position: Vec2 };
