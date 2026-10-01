import type { Vec2 } from '../world/types';

export interface TrackType {
  id: string; name: string; gauge: number; speedLimit: number; minimumCurveRadius: number;
  maxGrade: number; electrification: 'none' | 'placeholder';
}
export const TRACK_TYPES: readonly TrackType[] = [
  { id: 'standard', name: 'Standard gauge', gauge: 1.435, speedLimit: 80, minimumCurveRadius: 80, maxGrade: .04, electrification: 'placeholder' },
  { id: 'narrow', name: 'Narrow gauge', gauge: 1.067, speedLimit: 60, minimumCurveRadius: 40, maxGrade: .04, electrification: 'placeholder' },
];
export interface TrackNode { id: string; position: Vec2 }
export interface TrackSegment { id: string; startNodeId: string; endNodeId: string; trackTypeId: string; points: Vec2[]; length: number }
export interface Junction { id: string; nodeId: string; segmentIds: string[]; selectedRoute: [string, string] | null }
export interface PlatformFace { platformFaceId: string; trackSegmentId: string; offset: number; direction: 'both' | 'forward' | 'reverse'; side: 'left' | 'right' }
export interface Platform { platformId: string; length: number; faces: PlatformFace[]; outline: Vec2[] }
export interface Station { stationId: string; name: string; platforms: Platform[]; connectedTrackIds: string[]; boundary: Vec2[] }
export interface Depot { id: string; name: string; connectedTrackId: string; capacity: number; position: Vec2 }
export interface RailBlock { id: string; occupancyOwner: string | null; reservationOwner: string | null }
export interface RailwaySave {
  operations?: import('./operationsTypes').RailOperationsSave;
  version: 1; nextId: number; nodes: TrackNode[]; segments: TrackSegment[]; junctions: Junction[];
  stations: Station[]; depots: Depot[]; blocks: RailBlock[];
}
export interface RailwaySnapshot extends RailwaySave { revision: number; networkRevision: number }
export type TrackMode = 'straight' | 'one-curve' | 'two-curve' | 'continuous';
export interface BuildTrackInput { points: Vec2[]; trackTypeId: string }
export type StationTemplate = 'single' | 'double' | 'island';
export type RailCommandData =
  | { type: 'build-track'; input: BuildTrackInput }
  | { type: 'place-station'; trackSegmentId: string; offset: number; name: string; template: StationTemplate; length: number }
  | { type: 'place-depot'; trackSegmentId: string; name: string; capacity: number }
  | { type: 'remove-railway'; kind: 'track' | 'station' | 'depot'; id: string }
  | { type: 'set-rail-switch'; junctionId: string; route: [string, string] | null };
export interface RailCommandResult { type: 'railway'; ids: string[] }
