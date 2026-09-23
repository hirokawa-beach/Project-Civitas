import type { RoadNodeId, RoadSegmentId } from '../shared/ids';
import type { Vec2 } from '../world/types';

export type TripPurpose = 'home-work' | 'work-home' | 'home-commercial' | 'commercial-home' | 'outside-city' | 'city-outside';
export type TripMode = 'car';
export type RouteState = 'routed' | 'unreachable';

export interface TripEndpoint {
  kind: 'building' | 'outside';
  id: string;
  roadSegmentId?: RoadSegmentId;
  roadNodeId?: RoadNodeId;
  position: Vec2;
}

export interface RouteLeg {
  segmentId: RoadSegmentId;
  direction: 'forward' | 'backward';
  fromAlong: number;
  toAlong: number;
}

export interface LogicalTrip {
  id: string;
  origin: TripEndpoint;
  destination: TripEndpoint;
  purpose: TripPurpose;
  departureGameSeconds: number;
  mode: TripMode;
  routeState: RouteState;
  route: RouteLeg[];
  progressMeters: number;
  vehicleCount: number;
}

export interface OutsideConnection {
  id: string;
  nodeId: RoadNodeId;
  position: Vec2;
}

export interface LaneTraffic {
  laneId: string;
  direction: 'forward' | 'backward';
  currentVolume: number;
  capacity: number;
  averageSpeed: number;
  congestionRatio: number;
}

export interface SegmentTraffic {
  segmentId: RoadSegmentId;
  currentVolume: number;
  capacity: number;
  averageSpeed: number;
  congestionRatio: number;
  lanes: LaneTraffic[];
}

export interface VisibleVehicleCandidate {
  tripId: string;
  segmentId: RoadSegmentId;
  direction: 'forward' | 'backward';
  along: number;
}

export interface TrafficConfig {
  version: 1;
  generationIntervalGameSeconds: number;
  trafficIntervalGameSeconds: number;
  capacityPerLane: number;
  congestionPenalty: number;
  minimumSpeedFactor: number;
  intersectionDelayGameSeconds: number;
  maxActiveTrips: number;
  maxNewTripsPerGeneration: number;
  maxVisibleVehicles: number;
  visibleRadiusMeters: number;
  vehicleSpeedScale: number;
}

export interface TrafficSaveState {
  config: TrafficConfig;
  outsideConnections: OutsideConnection[];
  trips: LogicalTrip[];
  nextTripSerial: number;
  nextGenerationAtGameSeconds: number;
  nextTrafficAtGameSeconds: number;
  generatorCursor: number;
}

export interface TrafficSnapshot {
  revision: number;
  activeTrips: number;
  logicalVehicles: number;
  averageRoadSpeed: number;
  congestedSegmentCount: number;
  outsideConnections: OutsideConnection[];
  segments: SegmentTraffic[];
  visibleCandidates: VisibleVehicleCandidate[];
  maxVisibleVehicles: number;
  visibleRadiusMeters: number;
}
