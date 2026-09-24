import type { Vec2 } from '../world/types';

export const SERVICE_TYPES = ['electricity', 'water', 'garbage', 'fire', 'police', 'healthcare', 'education', 'parks'] as const;
export type ServiceType = typeof SERVICE_TYPES[number];

export interface ServiceDefinition {
  type: ServiceType;
  label: string;
  capacity: number;
  rangeMeters: number;
  maintenancePerCycle: number;
  constructionCost: number;
}

export interface ServiceFacility {
  id: string;
  type: ServiceType;
  position: Vec2;
}

export interface ServiceCoverage {
  demand: number;
  supplied: number;
  percent: number;
  capacity: number;
  facilities: number;
  activeFacilities: number;
}

export interface ServiceSnapshot {
  revision: number;
  facilities: ServiceFacility[];
  coverage: Record<ServiceType, ServiceCoverage>;
  buildingCoverage: Record<string, Partial<Record<ServiceType, number>>>;
  maintenancePerCycle: number;
}

export interface ServiceSaveState { facilities: ServiceFacility[]; nextFacilitySerial: number }
