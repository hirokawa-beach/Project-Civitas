import type { Vec2 } from '../world/types';

export const SERVICE_TYPES = ['electricity', 'water', 'garbage', 'fire', 'police', 'healthcare', 'education', 'parks'] as const;
export type ServiceType = typeof SERVICE_TYPES[number];

export interface ServiceDefinition {
  type: ServiceType;
  label: string;
  buildingName: string;
  width: number;
  depth: number;
  height: number;
  assetPath: string | null;
  capacity: number;
  rangeMeters: number;
  maintenancePerCycle: number;
  constructionCost: number;
}

export interface ServiceFacility {
  id: string;
  type: ServiceType;
  /** Center of the dedicated service lot, never the road centerline. */
  position: Vec2;
  roadAccessPoint: Vec2;
  lot: {
    id: string;
    width: number;
    depth: number;
    rotation: number;
    corners: [Vec2, Vec2, Vec2, Vec2];
    baseElevation: number;
    slope: number;
  };
  building: { id: string; definitionId: string; state: 'Operating' };
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
