import type { Vec2 } from '../world/types';
export interface RailLine { id: string; name: string; color: string; stationIds: string[] }
export interface ServiceType { id: string; name: string; kind: 'local' | 'rapid' | 'express' | 'limited-express' | 'deadhead' | 'other' }
export const RAIL_SERVICE_TYPES: readonly ServiceType[] = [
  { id: 'local', name: 'Local', kind: 'local' }, { id: 'rapid', name: 'Rapid', kind: 'rapid' }, { id: 'express', name: 'Express', kind: 'express' },
  { id: 'limited-express', name: 'Limited Express', kind: 'limited-express' }, { id: 'deadhead', name: 'Deadhead', kind: 'deadhead' },
];
export interface StopCall { stationId: string; platformFaceId: string; arrivalTime: number; departureTime: number; stopType: 'stop' | 'pass'; sequence: number }
export interface TrainService { id: string; trainNumber: string; lineId: string; serviceTypeId: string; passengerService: boolean; origin: string; destination: string; stopCalls: StopCall[] }
export interface FormationType { id: string; name: string; cars: number; length: number; capacity: number; maxSpeed: number; gauge: number }
export const FORMATION_TYPES: readonly FormationType[] = [
  { id: 'commuter-2', name: '2-car commuter', cars: 2, length: 40, capacity: 160, maxSpeed: 80, gauge: 1.435 },
  { id: 'commuter-6', name: '6-car commuter', cars: 6, length: 120, capacity: 480, maxSpeed: 100, gauge: 1.435 },
  { id: 'narrow-2', name: '2-car narrow gauge', cars: 2, length: 40, capacity: 140, maxSpeed: 60, gauge: 1.067 },
];
export interface Formation { formationId: string; formationTypeId: string; depotId: string; state: 'depot' | 'waiting' | 'running' | 'turnback'; currentServiceId?: string; currentFaceId?: string }
export interface Operation { operationId: string; operationNumber: string; trainServiceIds: string[]; assignedFormationId: string }
export interface RailTimetable { lines: RailLine[]; serviceTypes: ServiceType[]; formationTypes: FormationType[]; services: TrainService[]; formations: Formation[]; operations: Operation[] }
export interface RailRouteSection { segmentId: string; from: number; to: number; startDistance: number; length: number; duration: number }
export interface RailRoute { points: Vec2[]; length: number; duration: number; resources: string[]; sections: RailRouteSection[] }
export interface RailLeg { route: RailRoute; startAt: number; endAt: number }
export interface RailPassengerGroup { id: string; lineId: string; origin: string; destination: string; count: number }
export interface RailServiceProgress { serviceId: string; status: 'waiting' | 'dwelling' | 'running' | 'turnback' | 'completed'; delay: number; actualCalls: Array<{ sequence: number; arrivalTime?: number; departureTime?: number; passTime?: number }> }
export interface ActiveRailTrain { formationId: string; operationId: string; serviceId: string; callIndex: number; state: 'waiting' | 'dwelling' | 'running' | 'turnback'; delay: number; faceId: string; resources: string[]; leg?: RailLeg; onboard: Array<{ destination: string; count: number }>; dwellUntil: number }
export interface RailEvent { id: number; at: number; type: 'activate' | 'departure' | 'arrival' | 'dwell-complete' | 'route-request'; operationId: string; serviceIndex: number; callIndex: number }
export interface RailWait { key: string; event: RailEvent; resources: string[] }
export interface RailOperationsSave extends RailTimetable { version: 1; now: number; nextEventId: number; events: RailEvent[]; waits: RailWait[]; activeTrains: ActiveRailTrain[]; serviceStates: RailServiceProgress[]; passengers: RailPassengerGroup[]; arrivedPassengers: number; leftBehind: number; processedEvents: number }
export interface RailRuntimeSnapshot { revision: number; gameSeconds: number; activeTrains: ActiveRailTrain[]; serviceStates: RailServiceProgress[]; ownedBlocks: import('./types').RailBlock[]; waitingPassengers: number; arrivedPassengers: number; leftBehind: number; processedEvents: number; nextEventAt?: number }
export interface FrequencyInput { name: string; color: string; start: number; end: number; frequency: number; faceIds: string[]; stopTypes?: Array<'stop' | 'pass'>; formationTypeId: string; depotId: string; serviceTypeId: string; returnService: boolean }
export type RailOperationCommand = { type: 'create-rail-frequency'; input: FrequencyInput }
  | { type: 'set-rail-timetable'; timetable: RailTimetable }
  | { type: 'clear-rail-operations' }
  | { type: 'extend-rail-dwell'; formationId: string; seconds: number }
  | { type: 'add-rail-passengers'; group: RailPassengerGroup };
