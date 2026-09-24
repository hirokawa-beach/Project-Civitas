import type { LaneId, RoadLineageId, RoadSegmentId } from '../shared/ids';
import type { RouteLeg } from '../traffic/types';
import type { Vec2 } from '../world/types';

export interface TransitStop {
  id: string;
  name: string;
  position: Vec2;
  roadSegmentId: RoadSegmentId;
  laneId: LaneId;
  direction: 'forward' | 'backward';
  along: number;
  lineageId?: RoadLineageId;
  lineageAlong?: number;
}

export interface TransitLine {
  id: string;
  name: string;
  stopIds: string[];
  routeId: string;
  serviceStartSeconds: number;
  serviceEndSeconds: number;
  frequencySeconds: number;
  vehicleTypeId: string;
  color: string;
}

/** Road/lane path, rebuilt independently of the player's ordered line definition. */
export interface TransitRoute {
  id: string;
  lineId: string;
  legs: RouteLeg[];
  stopOffsetsMeters: number[];
  lengthMeters: number;
}

export interface TransitVehicleType {
  id: string;
  name: string;
  capacity: number;
  maxSpeedKmH: number;
  assetPath: string | null;
}

export interface TransitVehicle {
  id: string;
  lineId: string;
  routeId: string;
  vehicleTypeId: string;
  departedAtGameSeconds: number;
  progressMeters: number;
  nextStopIndex: number;
  onboard: Array<{ destinationStopId: string; count: number; transferLineId?: string; finalStopId?: string }>;
}

export interface TransitWaitingGroup {
  id: string;
  lineId: string;
  originStopId: string;
  destinationStopId: string;
  count: number;
  requestedAtGameSeconds: number;
  transferLineId?: string;
  finalStopId?: string;
}

export interface TransitStopMetrics {
  stopId: string;
  waiting: number;
  boarded: number;
  alighted: number;
}

export interface TransitServiceConfig {
  version: 1;
  operationIntervalGameSeconds: number;
  stopAccessDistanceMeters: number;
  walkingSpeedMetersPerSecond: number;
  parkingPenaltyGameSeconds: number;
  transferPenaltyGameSeconds: number;
  maxActiveVehicles: number;
  maxDeparturesPerTick: number;
}

export interface TransitGraphEdge { fromStopId: string; toStopId: string; lineId: string; routeMeters: number }
export interface TransitGraph { stopIds: string[]; edges: TransitGraphEdge[]; transferStopIds: string[] }

export interface TransitSaveState {
  config: TransitServiceConfig;
  stops: TransitStop[];
  lines: TransitLine[];
  vehicles: TransitVehicle[];
  waitingGroups: TransitWaitingGroup[];
  stopMetrics: TransitStopMetrics[];
  nextStopSerial: number;
  nextLineSerial: number;
  nextVehicleSerial: number;
  nextGroupSerial: number;
  nextDepartures: Array<{ lineId: string; gameSeconds: number }>;
  nextOperationAtGameSeconds: number;
  lastOperationAtGameSeconds: number;
  ridership: number;
}

export interface TransitSnapshot {
  revision: number;
  stops: TransitStop[];
  lines: TransitLine[];
  routes: TransitRoute[];
  vehicles: TransitVehicle[];
  stopMetrics: TransitStopMetrics[];
  activeVehicles: number;
  waitingPassengers: number;
  ridership: number;
  routeCacheSize: number;
  graph: TransitGraph;
}

export interface TransitLineInput {
  name: string;
  stopIds: string[];
  serviceStartSeconds: number;
  serviceEndSeconds: number;
  frequencySeconds: number;
  vehicleTypeId: string;
  color?: string;
}
