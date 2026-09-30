import type { BuildingId } from '../lots/types';
import type { HouseholdId } from '../population/types';
import type { Vec2 } from '../world/types';

export interface CitizenPlace { id: string; label: string; position: Vec2; nodeId: string; buildingId?: BuildingId }
export type CitizenActivity = 'home' | 'work' | 'shopping' | 'stroll' | 'returning-home';
export interface CitizenJourney {
  mode: 'walk' | 'car' | 'transit';
  origin: CitizenPlace;
  destination: CitizenPlace;
  activity: CitizenActivity;
  departedAt: number;
  route: Vec2[];
  length: number;
  speed: number;
  tripId?: string;
}
export interface Citizen {
  id: string;
  name: string;
  householdId: HouseholdId;
  member: number;
  homeBuildingId: BuildingId;
  workBuildingId?: BuildingId;
  location: CitizenPlace;
  activity: CitizenActivity;
  nextDepartureAt: number;
  journeysCompleted: number;
  journey?: CitizenJourney;
}
export interface CitizenSaveState { version: 1; residents: Citizen[] }
export interface CitizenCandidate {
  id: string;
  name: string;
  homeBuildingId: BuildingId;
  workBuildingId?: BuildingId;
  activity: CitizenActivity;
  origin: CitizenPlace;
  destination: CitizenPlace;
  route: Vec2[];
  length: number;
  speed: number;
  departedAt: number;
}
export interface AgentDetails {
  id: string;
  name: string;
  kind: 'citizen' | 'vehicle';
  activity: string;
  origin: string;
  destination: string;
  home?: string;
  work?: string;
  vehicleId?: string;
}
