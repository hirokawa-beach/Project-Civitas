import type { BuildingId } from '../lots/types';
import type { ZoneType } from '../zoning/types';

export type HouseholdId = `household-${number}`;
export type HouseholdState = 'Housed' | 'MovingOut';

export interface Household {
  id: HouseholdId;
  homeBuildingId: BuildingId;
  householdSize: number;
  employedCount: number;
  unemployedCount: number;
  state: HouseholdState;
}

export interface BuildingOccupancy {
  buildingId: BuildingId;
  zoneType: ZoneType;
  active: boolean;
  householdCapacity: number;
  populationCapacity: number;
  currentHouseholds: number;
  currentPopulation: number;
  totalJobs: number;
  filledJobs: number;
  availableJobs: number;
  commercialCapacity: number;
}

export interface PopulationTotals {
  population: number;
  households: number;
  employed: number;
  unemployed: number;
  laborForce: number;
  totalJobs: number;
  availableJobs: number;
  residentialCapacity: number;
  commercialCapacity: number;
  jobsByZone: Record<'commercial' | 'industrial' | 'office', number>;
  availableJobsByZone: Record<'commercial' | 'industrial' | 'office', number>;
  emptyBuildingsByZone: Record<'commercial' | 'industrial' | 'office', number>;
  occupiedBuildingsByZone: Record<'commercial' | 'industrial' | 'office', number>;
}

export interface DemandState {
  values: Record<ZoneType, number>;
  /** Signed contributions in demand points, before the 0–100 clamp. */
  factors: Record<ZoneType, Record<string, number>>;
  calculatedAt: number;
}

export interface PopulationSnapshot {
  revision: number;
  totals: PopulationTotals;
  occupancies: BuildingOccupancy[];
  demand: DemandState;
}

export interface PopulationSaveState {
  households: Household[];
  occupancies: BuildingOccupancy[];
  nextHouseholdSerial: number;
  nextMoveInAt: number;
  nextEmploymentAt: number;
  nextDemandAt: number;
  demand: DemandState;
}
